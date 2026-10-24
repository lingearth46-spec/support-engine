// The three things the support bot may do, rather than only explain.
//
// Everything here is gated on one fact: the order has no AWB. That is what
// "before manifested" means in practice, and it is what makes these safe. Once a
// parcel is booked, changing it means telling the courier as well — and today
// proved how that goes wrong: `cod_amount` is frozen at booking, Shadowfax
// answers "Request accepted." for changes it never makes, and a customer who
// paid ₹244 online was still set to be charged ₹299 at the door. An unbooked
// order is only a row, and a row can simply be edited.
//
// So the rule is not "before pickup" but the stricter, checkable "nothing is
// booked". Status can lag reality; an AWB cannot appear without a booking.

import { type Order, type OrderStatus } from "@/lib/orders";
import { normalizePhone, samePhone } from "@/lib/phone";

export const ACTION_KINDS = ["cancel_order", "change_address", "update_phone"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type ActionRefusal =
  | "not_found"      // no such order in what we resolved for this customer
  | "not_owner"      // resolved by a typed id, not by their own number
  | "booked"         // an AWB exists; the courier would have to be told
  | "settled"        // delivered, cancelled or come back
  | "zone_change"    // a new pincode, which moves freight and can change courier
  | "too_old"        // bot only: placed more than 24 hours ago, past the cancellation promise
  | "no_change"      // what they asked for is already what is stored
  | "invalid";       // the value itself does not stand up

/**
 * The statuses an order passes through before it is handed to a courier.
 *
 * Listed rather than derived from STATUS_RANK, because `packed` and `manifested`
 * share rank 2 and those two are precisely the ones this has to tell apart —
 * packed is a box on a table, manifested is a parcel with an AWB.
 */
const PRE_MANIFEST: OrderStatus[] = ["processing", "call_1", "call_2", "on_hold", "confirmed", "packed"];

/** Orders where nothing can be changed, whatever the AWB says. */
const SETTLED: OrderStatus[] = ["delivered", "cancelled", "wa_cancelled", "returned", "rto"];

export type ActionOrder = Pick<Order, "id" | "status" | "awb_code"> & {
  created_at?: string | null;
  address?: Order["address"] | null;
};

/**
 * Whoever is asking. A plain string is a phone (every existing WhatsApp call
 * site, unchanged) — the object form is what email uses, since its identity
 * is an address, not a number. Never both trusted at once for one check: the
 * caller passes whichever one the channel actually verified.
 */
export type SenderIdentity = string | { phone?: string | null; email?: string | null };

/**
 * Is this order the customer's own?
 *
 * The support audit found two order ids typed into WhatsApp by people who were
 * not that order's customer, and `formatOrders` already withholds the address on
 * anything found by a typed id for exactly that reason. An action is a far
 * stronger thing than reading an address back, so it inherits the same rule:
 * only orders matched to the identity we are actually talking to — phone for
 * WhatsApp, email for email, exact match only, same as everywhere else in
 * this codebase (orderOwnership.ts, customerIdentity.ts).
 */
export function ownsOrder(order: ActionOrder, sender: SenderIdentity): boolean {
  const { phone: senderPhone, email: senderEmail } = typeof sender === "string" ? { phone: sender, email: undefined } : sender;

  const phone = normalizePhone(senderPhone);
  if (phone.length === 10 && (samePhone(order.address?.phone, phone) || samePhone(order.address?.altPhone, phone))) return true;

  const email = (senderEmail ?? "").trim().toLowerCase();
  if (email && (order.address?.email ?? "").trim().toLowerCase() === email) return true;

  return false;
}

/**
 * Whether this order can be changed at all right now — independent of who is
 * asking. The single source of truth for "has this been handed to a
 * courier": pulled out on its own because it used to be re-implemented,
 * differently, on the account-page cancel route (lib/policyEngine.ts's
 * decideCancellation is what that route calls now instead).
 */
export function cancellationAllowed(
  order: Pick<ActionOrder, "status" | "awb_code">,
): { ok: true } | { ok: false; reason: ActionRefusal } {
  if (SETTLED.includes(order.status)) return { ok: false, reason: "settled" };
  // The line that carries the whole design. An AWB means a courier is holding
  // instructions we would also have to change, and that is a human's call.
  if (order.awb_code) return { ok: false, reason: "booked" };
  // And the status, independently, because an AWB can be missing on a row that
  // has moved on. Spelled out rather than compared by rank: `packed` and
  // `manifested` share rank 2, and they are the exact pair this has to separate.
  if (!PRE_MANIFEST.includes(order.status)) return { ok: false, reason: "booked" };
  return { ok: true };
}

/** The window we promise for cancelling. */
export const CANCEL_WINDOW_HOURS = 24;

/**
 * Whether an order may be CANCELLED: nothing booked, nothing settled (cancellationAllowed) AND placed within the last
 * 24 hours — the promise made to customers on the product page, the FAQ and the Terms. This is the one rule for every
 * customer-facing cancellation: the support bot, the website's cancel button, and the COD confirmation reply.
 * Address and phone edits deliberately do NOT use it (they stay possible until the courier has the parcel), which is why
 * cancellationAllowed is kept separate. A missing created_at skips the age test rather than refusing, so an order read
 * without it behaves as it did before.
 */
export function cancellationAllowedInWindow(
  order: Pick<ActionOrder, "status" | "awb_code" | "created_at">,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: ActionRefusal } {
  const base = cancellationAllowed(order);
  if (!base.ok) return base;
  if (order.created_at && now - Date.parse(order.created_at) > CANCEL_WINDOW_HOURS * 3_600_000) return { ok: false, reason: "too_old" };
  return { ok: true };
}

/**
 * May the bot act on this order at all?
 *
 * Checked before the specific action, because these three refusals are about
 * the parcel rather than about what was asked for.
 */
export function canAct(
  order: ActionOrder | null | undefined,
  sender: SenderIdentity,
): { ok: true } | { ok: false; reason: ActionRefusal } {
  if (!order) return { ok: false, reason: "not_found" };
  if (!ownsOrder(order, sender)) return { ok: false, reason: "not_owner" };
  return cancellationAllowed(order);
}

// ── The individual actions ───────────────────────────────────────────────────

export type AddressPatch = { line1?: string; line2?: string; city?: string; pincode?: string };

/**
 * A requested address change, checked against what is stored.
 *
 * A pincode change is refused rather than applied. It moves the parcel between
 * courier zones, which changes freight and can change who carries it — and
 * Shadowfax refuses inter-city pincode edits outright anyway ("Intercity pincode
 * updates are not allowed"). Correcting a house number is a different thing from
 * redirecting a parcel to another city, and only the first is safe to do without
 * a person looking.
 */
export function checkAddress(
  order: ActionOrder,
  patch: AddressPatch,
): { ok: true; next: Record<string, unknown> } | { ok: false; reason: ActionRefusal } {
  const current = order.address ?? ({} as NonNullable<ActionOrder["address"]>);
  const clean = (s: string | undefined) => (s ?? "").trim();

  const pin = clean(patch.pincode).replace(/\D/g, "");
  if (pin && pin !== String(current.pincode ?? "")) return { ok: false, reason: "zone_change" };
  if (pin && pin.length !== 6) return { ok: false, reason: "invalid" };

  const next: Record<string, unknown> = { ...current };
  let changed = false;
  for (const field of ["line1", "line2", "city"] as const) {
    const value = clean(patch[field]);
    if (!value) continue;
    // A line1 of two characters is a typo, not an address.
    if (field === "line1" && value.length < 5) return { ok: false, reason: "invalid" };
    if (value !== clean(current[field] as string | undefined)) { next[field] = value; changed = true; }
  }
  if (!changed) return { ok: false, reason: "no_change" };
  return { ok: true, next };
}

/**
 * A requested phone change.
 *
 * The number is replaced, never appended: `altPhone` is Razorpay's second,
 * OTP-verified number and overwriting it would lose the one contact that
 * actually answered. The delivery contact is what the rider calls, and that is
 * what a customer asking to "change my number" means.
 */
export function checkPhone(
  order: ActionOrder,
  phone: string,
): { ok: true; next: Record<string, unknown> } | { ok: false; reason: ActionRefusal } {
  const clean = normalizePhone(phone);
  if (clean.length !== 10) return { ok: false, reason: "invalid" };
  const current = order.address ?? ({} as NonNullable<ActionOrder["address"]>);
  if (samePhone(current.phone, clean)) return { ok: false, reason: "no_change" };
  return { ok: true, next: { ...current, phone: clean } };
}

/** A cancellation needs nothing beyond canAct — there is no value to validate,
 *  and an unbooked order has nothing to withdraw from a courier. */
export function checkCancel(order: ActionOrder): { ok: true } | { ok: false; reason: ActionRefusal } {
  return cancellationAllowedInWindow(order);
}

/** What a refusal should sound like to the customer. Never the enum, and never
 *  an apology for a rule that protects them. */
export const REFUSAL_TEXT: Record<ActionRefusal, string> = {
  not_found: "I couldn't find that order on your number.",
  not_owner: "I can only make changes to orders placed with this number.",
  booked: "This order has already been handed to the courier, so I can't change it myself — a colleague will sort it out for you.",
  settled: "This order is already closed, so there's nothing to change.",
  zone_change: "That's a different pincode, so a colleague needs to check the delivery before we move it.",
  too_old: "Orders can only be cancelled within 24 hours of placing them, and this one is past that.",
  no_change: "That's already what we have on the order.",
  invalid: "That doesn't look quite right — could you send it again?",
};
