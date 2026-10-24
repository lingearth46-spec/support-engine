// "Pay online now and we'll take ₹55 off" — the offer on order_shipped_v3.
//
// The point is not the ₹55. COD comes back 41.7% of the time against 6.9% for
// prepaid, on a 90% COD order mix, and an RTO costs freight both ways plus the
// ad spend that bought the order. Converting one COD parcel to prepaid is worth
// far more than the discount, which is why the discount can afford to be real.
//
// ── The hazard this is built around ─────────────────────────────────────────
//
// `cod_amount` is fixed when the shipment is created — all three couriers read
// codAmountFor(order) at booking — and this message goes out AFTER booking, at
// `shipped` or at `manifested` plus a twelve-hour grace (trackingWaDue). Zeroing
// cod_due afterwards changes nothing the rider is holding.
//
// So unless the courier is told, a customer who pays through this link is
// charged again at the door. That is not hypothetical: the note in
// lib/partialCodOffer.ts records it happening on a live order, where an advance
// paid online was collected a second time because the courier was never told.
//
// lib/courierCod.ts is the answer, and it is only a partial one:
//
//   Shadowfax  yes — order_update with cod_amount 0, verified on a live parcel
//   Delhivery  yes — /api/p/edit with pt and cod, verified on a live parcel
//   Ekart      no endpoint of any kind; no longer booked with as of Aug 2026
//
// canOffer refuses anything we cannot clear, so an Ekart parcel is never offered
// the switch at all. A missed conversion is a bad day; a double charge is a
// customer standing at their door having paid twice.
//
// Live since 6 Aug 2026, after exactly that end-to-end run on one parcel per
// courier: paid online, then read back from the courier to confirm the cash
// collection was really gone.

import type { OrderStatus } from "@/lib/orders";
import { codAmountFor } from "@/lib/partialCod";
import { canClearCod } from "@/lib/courierCod";

/**
 * The switch. On since 6 Aug 2026.
 *
 * Turned on only after the whole path was run end to end on two live parcels,
 * one per courier — offer minted, page opened, ₹444 paid through Razorpay, and
 * the parcel then read back from the courier to confirm it had actually stopped
 * collecting cash. Nothing here was trusted to a 200 response.
 *
 * If it is ever turned off again, tokens already minted keep working: offerState
 * deliberately does not consult this, so a customer holding a link from
 * yesterday's message can still settle their order.
 */
export const PREPAID_OFFER_ENABLED = true;

/** What we knock off for paying online. Matches the PREPAID55 coupon. */
export const PREPAID_OFFER_DISCOUNT = 55;

/**
 * The least we will take online, in rupees.
 *
 * Razorpay refuses anything under ₹1, and an order small enough that ₹55 leaves
 * almost nothing is not worth converting — the discount would be most of the
 * basket. Below this the offer is simply not made.
 */
export const MIN_ONLINE_AMOUNT = 50;

export type OfferOrder = {
  id: string;
  status: OrderStatus;
  payment_id?: string | null;
  total?: number | null;
  cod_due?: number | null;
  amount_paid_online?: number | null;
  /** Any discount already on the order. The prepaid discount is added to this,
   *  never substituted for it — an order can arrive carrying a coupon. */
  discount?: number | null;
  subtotal?: number | null;
  // Needed to answer the only question that really gates this: can we tell the
  // courier to stop collecting cash on this particular parcel?
  awb_code?: string | null;
  courier_name?: string | null;
  shiprocket_order_id?: string | null;
};

/** Statuses where the parcel's fate is already settled, one way or the other. */
const SETTLED: OrderStatus[] = ["delivered", "cancelled", "wa_cancelled", "returned", "rto"];

/** Cash is still owed at the door on this order. */
export function isCodOrder(o: OfferOrder): boolean {
  return codAmountFor(o) > 0;
}

/**
 * What the customer pays if they take the offer.
 *
 * Off the amount still owed at the door, not off the order total — on a partial
 * COD order some of it has already been paid, and discounting the total would
 * hand back money twice. codAmountFor is the single place that knows which is
 * which.
 */
export function offerAmount(o: OfferOrder, discount: number = PREPAID_OFFER_DISCOUNT): number {
  return Math.max(0, codAmountFor(o) - discount);
}

// ── Prepayment required, before anything is booked ──────────────────────────
//
// A different thing from the offer above, and deliberately a different function
// rather than a flag on it.
//
// The offer is a bribe: take ₹55 off a parcel already with a courier, because a
// converted COD is worth more than the discount. Every rule it has exists to
// avoid ONE failure — taking money for a parcel we cannot then tell the courier
// to stop collecting cash on. That is why it refuses `no_awb` and refuses Ekart.
//
// This is a condition, asked BEFORE anything is booked, of a number that has had
// two or more parcels come back. There is no rider holding a cash amount, so the
// double-charge hazard does not exist and the courier gate is meaningless here —
// `no_awb` is not a refusal, it is the precondition. And there is no discount:
// the founder's call (24 Sep 2026) is that this is a condition of sale, not an
// incentive, and paying ₹55 for it would reward the history that caused it.
//
// Replaces the outright COD refusal that used to sit at checkout. That block was
// right about the risk and wrong about the moment: on Magic Checkout the order
// was already placed by the time it fired, so the customer got a confirmation
// screen for an order that was then thrown away. Nobody was told anything.

/** How little we will ask for online. Razorpay refuses under ₹1; this is a
 *  floor with room to spare, and an order below it is not worth the friction. */
export const MIN_PREPAY_AMOUNT = 50;

/** How long they get to pay before the order is cancelled. Founder call,
 *  24 Sep 2026: long enough to cover a night and a working day, short enough
 *  that stock is not held for a week on an order nobody intends to pay. */
export const PREPAY_DEADLINE_HOURS = 48;

/** Where the pay page lives. The token is the whole of the path. */
export function prepayUrl(token: string): string {
  return `https://www.ajuki.in/pay/${token}`;
}

/**
 * The template that asks for the money. Approved 25 Sep 2026.
 *
 * Its own template rather than order_update_flexible_v1 for one reason: a real
 * "Pay now" BUTTON instead of a link buried mid-paragraph. This is the single
 * message in the flow where a tap is the whole point — if they do not tap, the
 * order is cancelled in 48 hours — and a button converts far better than an
 * autolinked URL.
 *
 * Variables: {{1}} first name · {{2}} order id · {{3}} amount in rupees.
 * The button carries the token as its dynamic tail; the /pay/ prefix was
 * already approved on order_shipped_v3, which is why this went through cleanly.
 */
export const PREPAY_TEMPLATE = "order_prepay_required_v1";

/**
 * What the customer is told, and why. Mirrors the approved body exactly, so the
 * thread log and the admin panel show what was actually delivered.
 *
 * Says the reason out loud. The founder's call was "name it plainly but kindly"
 * — a customer who is not told why cannot correct us when we have it wrong, and
 * we will sometimes have it wrong: a reused number, a family member, an address
 * the courier could never find. So the reason is stated and the door is left
 * open in the last sentence.
 *
 * No count of RTOs in the wording. "Two" today is "three" next month, and a
 * number invites an argument about the number rather than a reply about the
 * order. No blame, no policy language, no threat about the deadline — they are
 * told what to do and that we will pack it.
 */
export function prepayMessage(name: string, orderId: string, amount: number): string {
  return (
    `Hi ${name}, about your AJUKI order #${orderId}.\n\n` +
    `Earlier orders to this number came back to us undelivered, so we can only send this one as a prepaid order.\n\n` +
    `Tap below to pay ₹${Math.round(amount)} and we will pack it today. ` +
    `If that does not sound right, just reply here and we will sort it out.\n\n` +
    `— Team AJUKI`
  );
}

/**
 * May this order be held for prepayment?
 *
 * Every clause is "is there still a decision to make here" — an order already
 * paid, already settled, or already on its way to the customer is past the
 * point where asking for money online means anything.
 */
export function canRequirePrepayment(
  o: OfferOrder,
): { ok: true; amount: number } | { ok: false; reason: OfferRefusal } {
  if (SETTLED.includes(o.status)) return { ok: false, reason: "settled" };
  if (!isCodOrder(o)) return { ok: false, reason: "not_cod" };
  // Nothing may be in flight. If a parcel has been booked this is the other
  // function's job, discount, courier gate and all.
  if (o.awb_code) return { ok: false, reason: "already_booked" };
  const amount = codAmountFor(o);
  if (amount < MIN_PREPAY_AMOUNT) return { ok: false, reason: "too_small" };
  return { ok: true, amount };
}

export type OfferRefusal =
  | "disabled"        // the switch above
  | "not_cod"         // already paid online
  | "settled"         // delivered, cancelled, returned or come back
  | "too_small"       // the discount would be most of the basket
  | "no_awb"          // nothing booked, so nothing to amend
  | "unsupported"     // this courier has no way to stop collecting cash
  | "already_booked"; // pre-dispatch only: the parcel has already gone out

/**
 * May this order be offered the switch to prepaid?
 *
 * Returns the reason on refusal rather than a bare false, because the reasons
 * are the funnel: "how many parcels were eligible" and "why the rest were not"
 * is the first thing anyone will ask of this feature.
 *
 * `enabled` is a parameter rather than a straight read of the constant so the
 * rules can be tested while the feature is off. A test that reimplemented them
 * to get around the switch would be testing its own copy, and would go on
 * passing after the real ones changed.
 */
export function canOffer(
  o: OfferOrder,
  enabled: boolean = PREPAID_OFFER_ENABLED,
): { ok: true } | { ok: false; reason: OfferRefusal } {
  if (!enabled) return { ok: false, reason: "disabled" };
  if (SETTLED.includes(o.status)) return { ok: false, reason: "settled" };
  if (!isCodOrder(o)) return { ok: false, reason: "not_cod" };
  if (offerAmount(o) < MIN_ONLINE_AMOUNT) return { ok: false, reason: "too_small" };
  // The gate that matters. Never offer to take money for a parcel we cannot then
  // tell the courier to stop collecting cash on — that is the double charge, and
  // it is far worse than a missed conversion. Ekart has no edit endpoint at all,
  // so its parcels are refused here; we have stopped booking with them, but the
  // ones already in flight still have to be handled correctly.
  const courier = canClearCod(o);
  if (!courier.ok) return { ok: false, reason: courier.reason };
  return { ok: true };
}

export type OfferRow = {
  token: string;
  order_id: string;
  /** Frozen at mint time, so changing the discount never rewrites what someone
   *  was promised in a message they can still scroll back to. */
  discount: number;
  amount_due: number;
  offered_at: string;
  clicked_at: string | null;
  paid_at: string | null;
  /** Asked before anything was booked (the repeat-RTO hold and the RTO journey), so
   *  the pay page must not say the parcel is on its way. Absent on older rows. */
  pre_dispatch?: boolean | null;
};

/**
 * What the customer sees when they open the link — and, read across every row,
 * the conversion funnel: offered → opened → paid.
 *
 * `stale` is the case worth naming separately. A parcel can be delivered between
 * the message going out and the link being opened, and at that point the
 * customer has already paid the rider. Showing them a payment page then is how
 * you take the money twice, so it is refused on the way in as well as at mint.
 */
export type OfferState = "open" | "paid" | "stale";

export function offerState(offer: Pick<OfferRow, "paid_at">, order: OfferOrder): OfferState {
  if (offer.paid_at) return "paid";
  // Deliberately not canOffer(): that answers "should we send this offer", and
  // includes the global switch. This answers "is this specific link still good",
  // which must keep working for a token minted before the switch was turned off.
  if (SETTLED.includes(order.status)) return "stale";
  if (!isCodOrder(order)) return "stale";
  return "open";
}
