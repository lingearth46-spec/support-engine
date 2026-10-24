// The WhatsApp wording for each order event, mirroring the emails in
// customerEmails.ts so a customer gets the same story on either channel.
//
// Written short and plain on purpose. These arrive on a phone, from a shop, and
// the useful part — the order number, where the parcel is, what to do next —
// has to survive being read in two seconds on a lock screen.

import { signTrackLink } from "@/lib/trackLink";
import type { TemplateMessage } from "@/lib/whatsapp";
import type { ReturnResolution } from "@/lib/orders";
import { canClearCod } from "@/lib/courierCod";
import { isCodOrder } from "@/lib/partialCod";
import { returnedGoodsAmount, type SettlementOrder } from "@/lib/returnSettlement";

const SITE = "https://www.ajuki.in";

/** Deliberately loose, and matching what the dispatcher actually holds: these
 *  rows are selected for notifications, not fully hydrated orders. */
type OrderLike = {
  id: string;
  total?: number | null;
  items?: Array<{ name?: string; quantity?: number }> | null;
  address?: {
    name?: string;
    line1?: string; line2?: string; city?: string; state?: string; pincode?: string;
  } | null;
  awb_code?: string | null;
  courier_name?: string | null;
  tracking_url?: string | null;
  payment_id?: string | null;
  shipping_method?: string | null;
  /** What the courier said went wrong on a failed delivery attempt. */
  ndr_reason?: string | null;
  /** Partial COD: what the rider actually collects. Null on ordinary orders. */
  cod_due?: number | null;
  /** Partial COD: what was already captured online. */
  amount_paid_online?: number | null;
};

/**
 * What the customer must hand over at the door.
 *
 * `total` is wrong on a partial COD order by exactly the amount already paid —
 * telling someone who has paid ₹49 to keep ₹799 ready is how a parcel gets
 * refused by a customer holding a receipt. `cod_due` is null everywhere else,
 * so ordinary orders are unaffected.
 */
function dueAtDoor(o: OrderLike): number {
  return o.cod_due != null ? Number(o.cod_due) : Number(o.total ?? 0);
}

function firstName(o: OrderLike): string {
  const name = (o.address?.name ?? "").trim();
  return name ? name.split(/\s+/)[0] : "there";
}

function itemLines(o: OrderLike): string {
  const items = Array.isArray(o.items) ? o.items : [];
  if (!items.length) return "";
  return items.map((i) => `• ${i.name}${(i.quantity ?? 1) > 1 ? ` × ${i.quantity}` : ""}`).join("\n");
}

/** Items on one line for the compact v2 confirmation body —
 *  "Cube Chain × 2, Rope Bracelet". A newline inside a template variable reads
 *  badly after "• Items: " and Meta is fussy about them, so this stays flat. */
function itemsInline(o: OrderLike): string {
  const items = Array.isArray(o.items) ? o.items : [];
  return items.map((i) => `${i.name}${(i.quantity ?? 1) > 1 ? ` × ${i.quantity}` : ""}`).join(", ");
}

/** A short "where it's going" line — house/street, city, pincode — so the
 *  customer catches a wrong address on the confirmation, before we pack it. A
 *  wrong delivery address is a top RTO cause and this is the message they are
 *  already reading. */
function addressSnippet(o: OrderLike): string {
  const a = o.address ?? {};
  const s = [a.line1, a.city, a.pincode].map((v) => String(v ?? "").trim()).filter(Boolean).join(", ");
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
}

/**
 * A first address line of two words or fewer ("304", "Lg-27", "Block-71 Room-842") is the
 * strongest address-side warning we have: among 3,890 settled COD orders (17 Aug to 15 Oct
 * 2026), 625 had one and 56% were returned, against 41% when the line ran to six words or more.
 */
export function isWeakAddress(o: OrderLike): boolean {
  const line1 = String(o.address?.line1 ?? "");
  if (!line1.trim()) return false;
  return (line1.match(/[A-Za-z0-9]+/g) ?? []).length <= 2;
}

const money = (n: number) => `₹${n.toLocaleString("en-IN")}`;

// ── Templates ────────────────────────────────────────────────────────────────
//
// Anything sent to a customer who has not messaged us in the last 24 hours must
// be a template Meta has approved, so these return a name and the values for its
// {{1}}, {{2}}… placeholders rather than finished text. **The order of the
// variables is the contract** — it has to match what was submitted for approval,
// and changing the wording of an approved template means submitting a new one.
//
// The approved wording lives in WhatsApp Manager, not here. What each one says
// is in the commit that created them; what matters at this end is only that the
// right values go into the right slots.

// One definition, in lib/whatsapp.ts, imported rather than restated.
//
// There used to be a second copy here without urlButtonParam, and it silently
// disagreed with the sender's: shippedTemplate only compiled because a
// conditional spread evades excess-property checking, so the mismatch stayed
// hidden until a template set the field outright. Re-exported so anything that
// was importing the type from this module still can.
export type { TemplateMessage };

/** order_placed_prepaid — {{1}} name, {{2}} order id, {{3}} items, {{4}} total */
export function placedTemplate(o: OrderLike): TemplateMessage {
  return {
    template: "order_placed_prepaid",
    variables: [firstName(o), o.id, itemLines(o), String(dueAtDoor(o))],
  };
}

/**
 * order_placed_partial_cod — {{1}} name, {{2}} order id, {{3}} amount paid
 * online, {{4}} balance due on delivery. No buttons — a plain notice, not an
 * ask.
 *
 * Deliberately its own template rather than reusing placedTemplate or
 * confirmTemplate. placedTemplate's single amount slot would show the door
 * balance as if it were the order's full price, which reads as wrong to a
 * customer who watched Razorpay charge them ₹49 a moment ago. confirmTemplate
 * carries Yes/No buttons built for an order with nothing paid yet — a "No"
 * tap parks a partial-COD order as wa_cancelled with its online advance still
 * captured and nothing refunding it until someone notices. A partial-COD
 * customer already committed real money, a stronger signal than an
 * unconfirmed full-COD order, so they get told what happened rather than
 * asked to confirm it.
 */
export function partialCodPlacedTemplate(o: OrderLike): TemplateMessage {
  return {
    template: "order_placed_partial_cod",
    variables: [firstName(o), o.id, money(Number(o.amount_paid_online ?? 0)), money(dueAtDoor(o))],
  };
}

/**
 * order_confirm_cod — {{1}} name, {{2}} order id, {{3}} items, {{4}} total.
 * Carries two quick-reply buttons, Yes and No.
 *
 * A COD order comes back 41.7% of the time against 6.9% for prepaid, and 81% of
 * those returns are the customer refusing the parcel at the door after being
 * reached and verified. Every one of those was a decision made before the
 * courier arrived, and we paid freight both ways to find out about it. Asking
 * here costs a message; finding out on the doorstep costs a round trip.
 *
 * The buttons are the upgrade the Cloud API bought us. The old relay could only
 * ask people to type "1", which the reply parser still accepts — but a tap has
 * no spelling, no language, and nothing to misread.
 *
 * The wording does not mention that silence eventually confirms the order. That
 * would read as a threat, and it would train customers to ignore the message.
 */
/**
 * order_confirm_cod_v2 — APPROVED by Meta on 2026-09-05 (id 2519503288488149)
 * but abandoned before activation: it showed the delivery address up front, and
 * the founder wants the address held back until the customer has already
 * confirmed, not used as a condition of confirming. Never flipped on. Do NOT
 * delete it (deleting a template locks the name for 4 weeks) and do NOT reuse
 * the name — it is simply dormant, superseded by v3 below.
 */

/**
 * order_confirm_cod_v3 — {{1}} name, {{2}} order id, {{3}} items inline, {{4}}
 * amount due. Emoji in the body, no address (that moved to
 * confirmedReplyMessage, sent once Confirm is tapped). Two quick-reply
 * buttons — Confirm, Cancel — plain text, no emoji: Meta rejects a
 * QUICK_REPLY button that carries one outright (HTTP 400, error_subcode
 * 2388060), found submitting "✅ Confirm" / "❌ Cancel" for this template.
 *
 * Only two buttons, unlike v2's three: there is no "Edit Address" button here,
 * so an address correction goes through the ordinary conversational flow
 * instead of the dedicated parkConfirmAddrEdit()/applyConfirmAddressEdit() path
 * in the webhook. That path only ever fires from v2's exact button text, and v2
 * is permanently dormant — it is left in place rather than removed, in case a
 * future template variant brings the button back.
 *
 * Stays false until Meta approves it — an unapproved template fails the whole
 * send and the customer hears nothing, so v1 keeps going until the switch is
 * flipped by hand. Submit with scripts/create-order-confirm-cod-v3-template.mts.
 */
const CONFIRM_TEMPLATE_V3 = true;

export function confirmTemplate(o: OrderLike, v3 = CONFIRM_TEMPLATE_V3): TemplateMessage {
  if (v3) {
    return {
      template: "order_confirm_cod_v3",
      variables: [firstName(o), o.id, itemsInline(o), dueAtDoor(o).toLocaleString("en-IN")],
    };
  }
  return {
    template: "order_confirm_cod",
    variables: [firstName(o), o.id, itemLines(o), String(dueAtDoor(o))],
  };
}

/** order_shipped — {{1}} name, {{2}} order id, {{3}} courier, {{4}} awb, {{5}} window */
/**
 * Which shipped template is live.
 *
 * order_shipped_v2 adds a "Track order" button onto our own /track page.
 * Submitted and APPROVED on 29 Jul 2026, and live from that date.
 *
 * The switch stays rather than being deleted: sending an unapproved template
 * fails the entire message and the customer hears nothing at all, so if Meta
 * ever pauses v2 over quality this reverts to the plain approved template in
 * one line rather than leaving shipped notifications silently undelivered.
 *
 * The button links to ajuki.in rather than the courier because a template's URL
 * prefix is fixed at approval time and parcels leave on three different
 * couriers' domains. Ours resolves whichever it turned out to be.
 */
const SHIPPED_TEMPLATE_V2 = true;

/**
 * order_shipped_v3 adds a second button — "Pay Now" — offering ₹55 off to
 * settle a COD order online before it arrives. APPROVED as UTILITY on 6 Aug 2026.
 *
 * `cod_amount` is fixed when the shipment is booked and this message goes out
 * after booking, so the offer is only safe where the courier will then stop
 * collecting cash. Delhivery and Shadowfax both will, each verified end to end
 * on a live parcel on 6 Aug 2026 — paid online, COD confirmed gone. Ekart never
 * could, and is no longer booked with. See lib/courierCod.ts.
 *
 * Two switches, deliberately: this one decides which template is sent,
 * PREPAID_OFFER_ENABLED decides whether a payment token is minted. Turning this
 * one on alone is safe — v3Eligible needs a token too, so every message would
 * simply fall back to v2 rather than arriving with a Pay Now button pointing at
 * nothing. Both went on together on 6 Aug 2026.
 */
const SHIPPED_TEMPLATE_V3 = true;

/**
 * Does this parcel get v3, with the Pay Now offer, or plain v2?
 *
 * Three conditions, and the third is the one that matters.
 *
 * v3 needs both buttons filled or Meta refuses the whole message, so a missing
 * token falls back to v2 rather than sending nothing — a customer with no
 * tracking notification is a support ticket; a customer with no offer is simply
 * a customer.
 *
 * And the offer is only made on a parcel whose courier will let us take COD off
 * afterwards. Delhivery and Shadowfax will, both verified against live parcels.
 * Ekart has no such endpoint at all, so a customer who paid online would be
 * asked for cash at the door anyway. Ekart gets v2, and so does anything routed
 * through Shiprocket, whose parcels are Shiprocket's to amend rather than ours.
 *
 * `enabled` is a parameter so the routing can be tested while the feature is
 * off. Without it every test would read "not v3" and prove nothing about *why*.
 */
export function v3Eligible(o: OrderLike, payToken?: string, enabled = SHIPPED_TEMPLATE_V3): boolean {
  return enabled && Boolean(payToken) && canClearCod(o).ok;
}

export function shippedTemplate(
  o: OrderLike,
  recipientPhone?: string,
  /** The prepaid-offer token for this order — v3's Pay Now button. Minting it is
   *  the caller's job because it writes a row; this module stays pure. */
  payToken?: string,
): TemplateMessage {
  const v3 = v3Eligible(o, payToken);
  // A signed link for this number (lib/trackLink), not the bare number: /track
  // is gated, and the signature is what lets the button skip the OTP without
  // letting anyone edit the link onto somebody else's parcels.
  const phoneTail = recipientPhone ? signTrackLink(recipientPhone) : undefined;

  if (v3 && phoneTail) {
    return {
      template: "order_shipped_v3",
      // Order matches the approved template exactly: 0 is Pay Now, 1 is Track.
      urlButtonParam: [payToken, phoneTail],
      variables: shippedVariables(o),
    };
  }

  return {
    template: SHIPPED_TEMPLATE_V2 ? "order_shipped_v2" : "order_shipped",
    // The button's dynamic tail is the recipient's own number, passed in by the
    // dispatcher rather than re-derived here — it has to be the number we are
    // actually messaging, or the link opens onto somebody else's orders. /track
    // keys on phone, so this lands them straight on their parcels with nothing
    // to type, and it is their number going to their own handset.
    //
    // Normalised to bare digits because the stored value is free text from the
    // checkout: "+91 90001 00017" would put a space inside the button's URL and
    // arrive at /track as a number that matches nobody. Done here rather than at
    // the call site so no caller can forget.
    ...(SHIPPED_TEMPLATE_V2 && phoneTail ? { urlButtonParam: phoneTail } : {}),
    variables: shippedVariables(o),
  };
}

/**
 * The body variables, identical across all three shipped templates.
 *
 * v3 changed the wording and added a button; it did not change what the message
 * says about the parcel. Shared so a courier name formatted one way in v2 cannot
 * drift into being formatted another way in v3.
 */
function shippedVariables(o: OrderLike): string[] {
  return [
    firstName(o),
    o.id,
    o.courier_name || "our courier partner",
    o.awb_code || "-",
    o.shipping_method === "express" ? "3-4 business days" : "5-7 business days",
  ];
}

/**
 * cart_recovery_offer — {{1}} name, {{2}} what they left, {{3}} discount, {{4}} code.
 *
 * The only MARKETING template here; every other one is utility. That difference
 * is not cosmetic — marketing requires an opt-in on record, costs more per
 * message, and is what a recipient reports as spam when it is unwanted. So this
 * must only ever be sent to a cart whose wa_optin is true.
 *
 * The URL button's dynamic tail is the abandoned_carts row id, which /cart reads
 * as ?recover= and uses to put the cart back. That matters more than it looks:
 * the message is opened in WhatsApp's in-app browser, which has its own
 * localStorage, so without the token "your cart is still saved" lands the
 * customer on an empty cart — at the exact moment we finally persuaded them to
 * return. The token reveals nothing but what they were already buying; the
 * recover endpoint never returns their phone or email.
 */
export function cartRecoveryTemplate(
  o: { name?: string | null; items: Array<{ name?: string; quantity?: number; price?: number; image?: string | null }> },
  recoveryToken: string,
  discount: string,
  code: string,
): TemplateMessage {
  const items = Array.isArray(o.items) ? o.items : [];

  /**
   * The item the message leads with.
   *
   * The template has one header slot and one name to put in the body, so a
   * multi-item cart has to be represented by a single product — and taking
   * items[0] meant whatever was added first. A cart holding a ₹199 stud and a
   * ₹2,999 chain would show the stud, which is the weaker reason to come back.
   * The most expensive piece is both the better picture and the bigger thing
   * they are walking away from.
   *
   * Unit price, not line total: two cheap pairs are not a more compelling
   * photograph than one expensive chain.
   */
  const lead = items.reduce<(typeof items)[number] | undefined>((best, item) => {
    const price = Number(item?.price) || 0;
    return !best || price > (Number(best.price) || 0) ? item : best;
  }, undefined);

  // "Your Snake Pipe Bracelet is still saved" for one, and "Your Snake Pipe
  // Bracelet and 2 more are still saved" for several — so the words match the
  // photograph above them instead of the vaguer "3 items", which left the
  // picture unexplained.
  const leadName = String(lead?.name ?? "").trim();
  const others = items.length - 1;
  const what = !leadName
    ? `${items.length} item${items.length === 1 ? "" : "s"}`
    : others > 0
      ? `${leadName} and ${others} more`
      : leadName;

  const first = (o.name ?? "").trim().split(/\s+/)[0];

  const header = whatsAppImageUrl(lead?.image);

  return {
    // The image variant when we have a picture, the original text-only template
    // when we do not. Both are approved, and sending the image template with an
    // empty header is a hard failure rather than a degraded message.
    template: header ? "cart_recovery_offer_image" : "cart_recovery_offer",
    // Carts captured from Razorpay before the address step carry a phone and
    // nothing else, so a name is often genuinely unknown — "there" is the same
    // fallback the other templates use rather than an empty greeting.
    variables: [first || "there", what, discount, code],
    urlButtonParam: recoveryToken,
    ...(header ? { headerImageUrl: header } : {}),
  };
}

/**
 * cancellation_winback — {{1}} name, {{2}} what they ordered, {{3}} discount,
 * {{4}} code. Body: "changed your mind about {{2}}? … here's {{3}} off. Use code
 * {{4}} …". URL button tail is an abandoned_carts row id, exactly like
 * cartRecoveryTemplate — the cron writes the cancelled order's items into that
 * row so /cart?recover= rebuilds the basket.
 *
 * MARKETING, like cart recovery. Same send discipline (opt-out checked, once
 * only, daily cap) lives in the cron, not here.
 *
 * No image variant: the approved template has no header. {{2}} reads after the
 * word "about", so a single item becomes "the Royal Clover Bracelet" and
 * anything else becomes "your order" rather than an awkward item list.
 */
export function cancellationWinbackTemplate(
  o: OrderLike,
  recoveryToken: string,
  discount: string,
  code: string,
): TemplateMessage {
  const items = Array.isArray(o.items) ? o.items : [];
  const onlyName = items.length === 1 ? String(items[0]?.name ?? "").trim() : "";
  const what = onlyName ? `the ${onlyName}` : "your order";

  return {
    template: "cancellation_winback",
    variables: [firstName(o), what, discount, code],
    urlButtonParam: recoveryToken,
  };
}

/**
 * A product image WhatsApp will actually accept.
 *
 * Sanity serves WebP by content negotiation and **WhatsApp rejects WebP
 * headers outright**, so the format has to be forced rather than hoped for.
 * `?fm=jpg&w=800` returns a JPEG around 30-40KB, which is well inside Meta's
 * 5MB header limit and loads fast on a phone.
 *
 * Anything that is not a Sanity CDN https URL returns null: an image we cannot
 * vouch for would fail at send time and take the whole message with it, and a
 * text-only recovery message is much better than none.
 */
export function whatsAppImageUrl(raw?: string | null): string | undefined {
  const url = String(raw ?? "").trim();
  if (!url.startsWith("https://cdn.sanity.io/")) return undefined;
  const [base] = url.split("?");
  if (!/\.(webp|jpe?g|png)$/i.test(base)) return undefined;
  return `${base}?fm=jpg&w=800&q=80`;
}

/**
 * order_out_for_delivery — {{1}} name, {{2}} order id, {{3}} courier, {{4}} payment.
 *
 * The message that most reduces failed attempts on a COD shop: the single
 * commonest reason a parcel comes back is nobody at the address, and this is
 * the only warning the customer gets on the morning it matters.
 *
 * {{4}} carries the payment line so one approved template serves both payment
 * types — Meta has no optional variables, so a COD-only template would have
 * meant a second submission and a second review for prepaid. Saying the amount
 * out loud is the point on COD: "keep ₹359 ready" is what stops the doorstep
 * conversation that ends in a refusal.
 */
export function ofdTemplate(o: OrderLike, recipientPhone?: string): TemplateMessage {
  // isCodOrder also catches a partial-COD order — dueAtDoor already computes
  // the right balance for one via cod_due, but that's wasted if this stays a
  // literal payment_id check: it would tell a partial-COD customer "already
  // paid, nothing to collect" while cash is still due.
  const isCod = isCodOrder(o);
  const amount = dueAtDoor(o);
  return {
    template: "order_out_for_delivery",
    variables: [
      firstName(o),
      o.id,
      o.courier_name || "our courier partner",
      isCod && amount > 0
        ? `${money(amount)} in cash`
        : "Already paid, nothing to collect",
    ],
    // Signed /track link (lib/trackLink): the page is gated, and this lets the
    // button skip the OTP for this number only.
    ...(recipientPhone && signTrackLink(recipientPhone)
      ? { urlButtonParam: signTrackLink(recipientPhone) }
      : {}),
  };
}

/**
 * Which failed-delivery template is live.
 *
 * delivery_attempt_failed_v2 (APPROVED, UTILITY, en) replaces v1's one-way "reply
 * here" message with four QUICK_REPLY buttons — Deliver tomorrow · Update phone ·
 * Update address · Contact support — each wired to a real courier NDR action in
 * lib/ndrButtonReply.ts (Delhivery DEFER_DLV / EDIT_DETAILS; Shadowfax
 * order_update + escalation). v2 drops the reason variable entirely: v1's {{3}}
 * showed the courier's disputed "Consignee Unavailable" verbatim, and that line
 * was doing more harm than good.
 *
 * The switch stays, like SHIPPED_TEMPLATE_V2, so a Meta quality pause on v2 is a
 * one-line revert rather than silent non-delivery of the shop's most valuable
 * message. Do NOT delete the v1 template at Meta while this can still flip back.
 */
const MISSED_TEMPLATE_V2 = true;

/**
 * delivery_attempt_failed / delivery_attempt_failed_v2.
 *
 *   v1 — {{1}} first name, {{2}} order id, {{3}} reason. Plus a /track URL button.
 *   v2 — {{1}} first name, {{2}} order id. Four quick-reply buttons, no URL
 *        button, no reason variable.
 *
 * A failed attempt is one step from an RTO, and on COD an RTO costs freight in
 * both directions and returns stock that has been round the country. Reaching
 * the customer while the parcel is still at the local hub is the only cheap
 * moment to fix it — v2 turns that message from "tell us" into "tap what helps".
 */
export function missedTemplate(o: OrderLike, recipientPhone?: string): TemplateMessage {
  if (MISSED_TEMPLATE_V2) {
    // No urlButtonParam — v2's buttons are all QUICK_REPLY, which carry no
    // dynamic parameter. No reason var. The tap is handled inbound by
    // lib/ndrButtonReply.ts via the WhatsApp webhook.
    return { template: "delivery_attempt_failed_v2", variables: [firstName(o), o.id] };
  }

  const reason = String(o.ndr_reason ?? "").trim();
  return {
    template: "delivery_attempt_failed",
    variables: [
      firstName(o),
      o.id,
      reason || "The courier could not complete the delivery",
    ],
    // Same signed /track link as the shipped message, and the same reasoning:
    // their own number, signed, so the button lands on their parcels and cannot
    // be edited onto somebody else's.
    ...(recipientPhone && signTrackLink(recipientPhone)
      ? { urlButtonParam: signTrackLink(recipientPhone) }
      : {}),
  };
}

/**
 * order_delivered_v2 — approved by Meta 2026-08-20. Same body as v1 plus one
 * "Write a Review" button — see scripts/create-order-delivered-v2-template.mts
 * for the exact submitted wording.
 *
 * Exported so the dispatcher can skip minting a review token entirely while
 * this is off, rather than writing a row nobody's message will ever use.
 */
export const DELIVERED_TEMPLATE_V2 = true;

/**
 * order_delivered / order_delivered_v2 — {{1}} order id.
 *
 * v2's button needs a review token or Meta refuses the whole message, so a
 * missing token falls back to plain v1 rather than sending nothing — same
 * reasoning as v3Eligible above. Minting the token is the caller's job
 * because it writes a row; this module stays pure.
 */
export function deliveredTemplate(o: OrderLike, reviewToken?: string): TemplateMessage {
  if (DELIVERED_TEMPLATE_V2 && reviewToken) {
    return { template: "order_delivered_v2", variables: [o.id], urlButtonParam: reviewToken };
  }
  return { template: "order_delivered", variables: [o.id] };
}

// ── Cancellation / return lifecycle ─────────────────────────────────────────
//
// Submitted for Meta review 13 Aug 2026 — control-plane "one source of truth
// for returns" work. Until approved, these calls fail exactly like calling
// any other unapproved template does (send() returns false, logged, nothing
// thrown) — safe to leave wired in now so there is nothing left to do the
// moment approval lands. See app/api/orders/[id]/route.ts (cancel, return
// request) and app/api/admin/orders/route.ts (approve/reject) and
// app/api/admin/returns/email/route.ts (the remaining lifecycle steps) for
// where these are actually called.

/** order_cancelled — {{1}} first name, {{2}} order id, {{3}} refund note */
export function cancelledTemplate(o: OrderLike): TemplateMessage {
  const refundNote = o.payment_id && o.payment_id !== "COD"
    ? "If you paid online, your refund will be processed within 3–5 business days."
    : "Thank you for shopping with us — we'd love to see you again.";
  return { template: "order_cancelled", variables: [firstName(o), o.id, refundNote] };
}

/** return_request_received — {{1}} first name, {{2}} order id */
export function returnRequestReceivedTemplate(o: OrderLike): TemplateMessage {
  return { template: "return_request_received", variables: [firstName(o), o.id] };
}

/** return_approved — {{1}} first name, {{2}} order id, {{3}} the pickup-or-
 *  keep-item paragraph, matching exactly what app/admin/returns/page.tsx's
 *  buildReturnWA already sends by hand today — same wording, now reliable. */
export function returnApprovedTemplate(
  o: OrderLike,
  resolution: ReturnResolution,
  /**
   * The outcome line computed by lib/returnApproval.ts settleApprovedReturn.
   *
   * Preferred whenever present, because it is the only place that knows the
   * real refund (the returned items, discount prorated, no shipping or fees),
   * whether a ₹99 pickup link was issued, and whether the money goes back to a
   * card or into the wallet. The fallbacks below quote `o.total` and promise a
   * free pickup to everyone — kept only for callers that have not moved over.
   */
  detailOverride?: string | null,
): TemplateMessage {
  if (detailOverride) {
    return { template: "return_approved", variables: [firstName(o), o.id, detailOverride] };
  }
  const amount = money(Number(o.total ?? 0));
  // Rides the existing return_approved template rather than needing a new one
  // approved by Meta: {{3}} is already free text describing the outcome, so a
  // replacement is a different sentence in the same slot. Worth knowing if a
  // dedicated template is ever wanted, the seam is here, not at Meta.
  const detail =
    resolution === "keep_item"
      ? `No need to send it back, please keep the item, no pickup needed. Your refund of ${amount} will be processed within 3–5 business days.`
      : resolution === "replacement"
        // Says nothing about a refund and nothing about a pickup. A replacement
        // ends in a parcel going out: someone told to expect money as well will
        // chase what was never coming, and someone told to keep the item ready
        // will wait in for a courier who is never booked.
        ? `No need to send anything back, please keep the original. A replacement is being dispatched and you'll get fresh tracking for it shortly.`
        : `We'll arrange a free pickup within 2–3 business days, please keep the item in its original packaging. Once we receive it, your refund of ${amount} will be processed within 3–5 business days.`;
  return { template: "return_approved", variables: [firstName(o), o.id, detail] };
}

/** return_rejected — {{1}} first name, {{2}} order id, {{3}} the reason, or a
 *  generic invitation to ask again when no note was given. */
export function returnRejectedTemplate(o: OrderLike, adminNote?: string | null): TemplateMessage {
  const note = adminNote?.trim() || "If you believe this is a mistake, just message us and we'll take another look.";
  return { template: "return_rejected", variables: [firstName(o), o.id, note] };
}

/**
 * The refund a return template quotes: the returned items only, discount
 * prorated — the same figure lib/returnEmails.ts and the refund row use.
 *
 * These builders quoted `o.total`, so a customer returning one bracelet of two
 * was told on WhatsApp they would get the whole order back, delivery included,
 * while the email for the same return said the smaller, correct number.
 */
type ReturnOrderLike = OrderLike & Pick<SettlementOrder, "items" | "discount" | "offer_discount" | "subtotal" | "shipping" | "cod_fee" | "gift_wrap"> & {
  return_request?: { item_indexes?: number[] | null } | null;
};
const returnAmount = (o: ReturnOrderLike) =>
  money(returnedGoodsAmount({ ...o, items: o.items ?? [] }, o.return_request?.item_indexes));

/** return_pickup_scheduled — {{1}} first name, {{2}} order id, {{3}} refund amount */
export function returnPickupScheduledTemplate(o: ReturnOrderLike): TemplateMessage {
  return { template: "return_pickup_scheduled", variables: [firstName(o), o.id, returnAmount(o)] };
}

/** return_item_received — {{1}} first name, {{2}} order id, {{3}} refund amount */
export function returnItemReceivedTemplate(o: ReturnOrderLike): TemplateMessage {
  return { template: "return_item_received", variables: [firstName(o), o.id, returnAmount(o)] };
}

/** return_refund_processed — {{1}} first name, {{2}} refund amount, {{3}} order id */
export function returnRefundProcessedTemplate(o: ReturnOrderLike): TemplateMessage {
  return { template: "return_refund_processed", variables: [firstName(o), returnAmount(o), o.id] };
}

/** return_refund_details_request — {{1}} first name, {{2}} order id, {{3}} refund amount */
export function returnRefundDetailsRequestTemplate(o: ReturnOrderLike): TemplateMessage {
  return { template: "return_refund_details_request", variables: [firstName(o), o.id, returnAmount(o)] };
}

/** return_keep_as_gift — {{1}} first name, {{2}} order id, {{3}} refund amount */
export function returnKeepAsGiftTemplate(o: ReturnOrderLike): TemplateMessage {
  return { template: "return_keep_as_gift", variables: [firstName(o), o.id, returnAmount(o)] };
}

/**
 * Sent the moment a customer replies "1".
 *
 * Deliberately does not say the order is on its way. Nothing has moved — the
 * parcel is still on our shelf and the courier has not seen it. Saying otherwise
 * is a claim the customer can check, and the one that follows in trackingMessage
 * would then read as a repeat rather than news. Same reasoning as trackingWaDue.
 *
 * It carries the cash reminder instead. That line used to live in the order
 * confirmation, which is days before anyone needs it; here it lands on someone
 * who has just actively said yes to a cash payment.
 *
 * It also carries the delivery address — v3 of the confirmation template no
 * longer shows it up front, so this is the first place the customer sees it,
 * and the one chance left to catch a wrong one before the parcel is packed.
 * Falls back silently to no address line when addressSnippet() has nothing to
 * show, rather than printing an empty "shipped to ." (missing address).
 */
export function confirmedReplyMessage(o: OrderLike): string {
  const address = addressSnippet(o);
  const ship = address ? `, and will be shipped to ${address}` : "";
  const cash = dueAtDoor(o) > 0
    ? `\n\nPlease keep ${money(dueAtDoor(o))} ready for the delivery agent.`
    : "";
  // The tap is only offered when there is an address to be wrong: the webhook
  // sends this with an "Edit address" reply button when the text carries the line.
  // A short first line gets a firmer ask: a courier cannot find "304" on its own.
  const fix = !address ? "" : isWeakAddress(o)
    ? `

Your address looks a bit short. To make sure your parcel reaches you, please tap "Edit address" below and send the full address — house/flat number, building, street and a nearby landmark.`
    : `

If the address isn't right, tap "Edit address" below.`;
  return (
    `Thank you! Your pieces are being handpicked and securely packed${ship}. ` +
    `We will send tracking updates once dispatched via our courier partner.` +
    cash +
    fix
  );
}

/** The prompt sent when a customer taps "Edit Address" on the confirmation. */
export function addressEditPromptMessage(): string {
  return (
    `Please reply with your updated full address (including Flat/Building, ` +
    `Street, Landmark, City, and Pincode), and we will update your shipment.`
  );
}

/** Sent once the customer's replacement address has been applied and the order
 *  confirmed. */
export function addressUpdatedMessage(o: OrderLike): string {
  return (
    `Thank you! Your delivery address for order #${o.id} has been updated and ` +
    `your order is confirmed. We will send tracking updates once it is dispatched.`
  );
}

/**
 * Sent when a customer tries to cancel an order they already confirmed, after
 * the two-hour change-of-mind window has passed.
 *
 * Nothing is promised and nothing is refused — the decision is a human's now,
 * because the parcel may be packed or booked. It hands over warmly. What it must
 * never do is say "cancelled" (the order is still live), and it must not quote a
 * cancellation window: it used to say "orders can be cancelled within 2 hours of
 * being placed", but that is the CANCEL_WINDOW_MS confirmation-reversal rule,
 * not the cancellation policy — which allows cancelling until the courier is
 * booked (~24h). A customer inside that real window was being told, wrongly,
 * that they were too late.
 */
export function lateCancelMessage(o: OrderLike): string {
  return (
    `I hear you, ${firstName(o)} 🙏\n\n` +
    `*Order #${o.id}* is already being processed, so I can't stop it from here. ` +
    `I've passed your request to our team, who'll check where your parcel is and ` +
    `get back to you.`
  );
}

/**
 * Sent the moment a customer replies "2".
 *
 * No guilt, no "are you sure", no attempt to win it back. They did us a real
 * favour — telling us now costs nothing, where the same decision at the door
 * costs freight in both directions — and the only thing worth protecting is
 * whether they come back. A parting message that argues is how you lose that.
 */
export function cancelledReplyMessage(o: OrderLike): string {
  return (
    `Your order #${o.id} has been cancelled. If this was a mistake, feel free ` +
    `to visit us again anytime at ${SITE}.`
  );
}

// ── Not yet templates ────────────────────────────────────────────────────────
//
// These two are switched off in WHATSAPP_EVENTS and have no approved template,
// so they cannot currently be sent to anyone outside a 24-hour window. The
// wording is kept because it is the hard part and was written against real
// cases — but turning either back on means submitting a template to Meta first.
//
// missedMessage is the one worth the trouble: a failed attempt is usually an
// unanswered phone, and a parcel that fails twice more comes back to us with
// freight paid both ways. One attempt ends in RTO 12% of the time, two 30%,
// three 67%.

export function ofdMessage(o: OrderLike): string {
  const cod = isCodOrder(o);
  return (
    `${firstName(o)}, your AJUKI order is out for delivery today 🚚\n\n` +
    `*Order #${o.id}*\n` +
    (o.awb_code ? `AWB: ${o.awb_code}\n` : "") +
    `\nPlease keep your phone nearby` +
    (cod ? ` and ${money(dueAtDoor(o))} ready in cash.` : ".")
  );
}

export function missedMessage(o: OrderLike): string {
  return (
    `Hi ${firstName(o)}, we tried to deliver your AJUKI order today but couldn't reach you 📦\n\n` +
    `*Order #${o.id}*\n` +
    (o.courier_name ? `Courier: ${o.courier_name}\n` : "") +
    (o.awb_code ? `AWB: ${o.awb_code}\n` : "") +
    `\nThe courier will try again. To make sure it reaches you:\n` +
    `• Keep your phone reachable\n` +
    `• Reply here if the address needs correcting\n` +
    `• Reply here if a different day suits you better\n\n` +
    `If we don't hear back the parcel returns to us, and we'd rather it reached you, just reply to this message and we'll sort it out.`
  );
}

/**
 * parcel_status_alert_v1 — the proactive shipment-health alert (APPROVED as
 * UTILITY, 2026-09-09).
 *
 * {{1}} first name, {{2}} order id, {{3}} the situation line, {{4}} the
 * next-step line. Both free-text lines come from lib/proactiveOutreach.ts, so
 * the "returning" and "stuck" variants ride this one Meta submission.
 *
 * Two buttons: [0] "Help me with this" is a quick reply and carries no
 * parameter, [1] "Track order" is a dynamic URL whose tail is the recipient's
 * own number. The null at index 0 is load-bearing — sendTemplate counts button
 * params by position, so dropping it would send the phone number to the quick
 * reply and leave the URL button empty, which Meta rejects outright.
 */
export function parcelStatusAlertTemplate(
  variables: string[],
  recipientPhone: string,
): TemplateMessage {
  const tail = signTrackLink(recipientPhone);
  return {
    template: "parcel_status_alert_v1",
    variables,
    urlButtonParam: [null, tail],
  };
}

// ── The thank-you reward (lib/orderRewards.ts) ────────────────────────────────────────
//
// Three MARKETING templates, none submitted to Meta yet (the sender in lib/rewardMessages.ts
// checks for approval on every run and does nothing until each is APPROVED, and is switched
// off in code besides). Create them under exactly these names, and edit an approved one in
// place rather than deleting it: a deleted template name stays locked for four weeks.

export const REWARD_TEMPLATES = {
  pending: "reward_pending_v1",
  credited: "reward_credited_v1",
  expiring: "reward_expiring_v1",
} as const;

/**
 * reward_pending_v1 — {{1}} name, {{2}} order id. Button "Track my order": the same signed
 * /track?phone={{1}} tail the shipped templates use, so it needs no new link scheme. Returns
 * null for a number that cannot be signed: the button must be filled or Meta rejects the
 * whole message.
 *
 *   Congratulations, {{1}}! You've earned ₹55 AJUKI Wallet credit with order {{2}}. It's added
 *   to your wallet once your order is delivered, and you'll have 7 days after that to use it
 *   on your next order. Track your order anytime below.
 */
export function rewardPendingTemplate(o: OrderLike, recipientPhone: string): TemplateMessage | null {
  const tail = signTrackLink(recipientPhone);
  if (!tail) return null;
  return { template: REWARD_TEMPLATES.pending, variables: [firstName(o), o.id], urlButtonParam: tail };
}

/**
 * reward_credited_v1 — {{1}} name, {{2}} the day it runs out ("27 Oct"). Button "View my
 * wallet" is a fixed link to /account, so there is nothing to fill.
 *
 *   Something extra for you, {{1}}: your ₹55 AJUKI Wallet credit is ready. Use it on your next
 *   order. It's valid until {{2}}. Sign in with your phone number to see it.
 */
export function rewardCreditedTemplate(o: OrderLike, expiryLabel: string): TemplateMessage {
  return { template: REWARD_TEMPLATES.credited, variables: [firstName(o), expiryLabel] };
}

/**
 * reward_expiring_v1 — {{1}} name, {{2}} the day it runs out. Button "Shop now" is a fixed link
 * to /collections.
 *
 *   {{1}}, your ₹55 AJUKI Wallet credit expires on {{2}}. Use it on your next order before then.
 */
export function rewardExpiringTemplate(o: OrderLike, expiryLabel: string): TemplateMessage {
  return { template: REWARD_TEMPLATES.expiring, variables: [firstName(o), expiryLabel] };
}
