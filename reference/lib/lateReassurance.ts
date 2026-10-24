// The reassurance every reply about a late parcel carries (founder, 18 Oct 2026): the bot may say the delay is on the courier's side, and it must always say that we are
// working to get the parcel delivered as soon as possible and that there is no need to worry. PURE, imports nothing.
//
// TWO KINDS OF REPLY, TWO WAYS (founder, 18 Oct: "I hope that has not been put as a fixed line"):
//   - A FIXED line (the old late_first / late_insist, the agent's own lines) is fixed text by nature, so it carries the sentences below.
//   - A reply the MODEL writes is NOT given a fixed sentence. The writer is told to say it in its own words, in the customer's language, fitted to what they asked
//     (lateNote); code only CHECKS that both ideas are there (hasAssurance), asks once more if they are not, and only if the model still leaves it out does it fall back to the
//     fixed sentence below, so "always" holds without every reply ending the same way.
//
// This REVERSES a rule of 14 Oct, when "We are already on it, there is no need to worry." was dropped as a brush-off. What makes it different now: it is never the whole reply. It
// follows what is true about the parcel (where it stands, that it was escalated, where to follow it). The fixed sentences are approved lines (lib/replyValidate.ts FIXED_TEXTS):
// the verifier and the ruler do not judge them as claims. A model's own natural wording passes the same gate and ruler as any other sentence.
//
// What it does NOT do: it promises no delivery date or time ("as soon as possible" is not one), and it never quotes a scan or the courier's own reason. The courier is named as the
// source of the delay only where the parcel is in the courier's hands and has stopped moving; a failed attempt that waits on the customer is not blamed on the courier.

/** Always, on a late-parcel reply. */
export const LATE_REASSURE = "We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry.";
/** Where the parcel is in the courier's hands and has stopped moving (the courier-side cause, or a stalled parcel in transit). */
export const COURIER_BLAME = "The delay is on the courier's side.";
/** The short form for a movement update, where the parcel is already moving and "no need to worry" would be out of place. */
export const LATE_EFFORT = "We are working to get it to you as soon as possible.";

/** The reassurance for a reply, with the courier named when `blame` is true. */
export const reassurance = (blame = false): string => (blame ? `${COURIER_BLAME} ${LATE_REASSURE}` : LATE_REASSURE);

/** What the writer is told on a late-parcel turn. It states the intent and the limits, not the words. */
export function lateNote(blame: boolean): string {
  return "THIS PARCEL IS LATE. In your OWN words, in the customer's language and fitted to what they asked (not a stock sentence, and not at the same place in every reply), say both: " +
    (blame ? "that the delay is on the courier's side (never quote the courier's note or a scan), " : "") +
    "that we are doing everything we can to get the parcel delivered as soon as possible, and that there is no need to worry. Keep it to one natural sentence or two short clauses. " +
    "Never give a delivery date or time for it, and never say we have done something the record does not show.";
}

/** Does this reply say BOTH ideas: that we are working to get it delivered as soon as possible, and that there is no need to worry? English and Hinglish. */
const EFFORT_IDEA = /as soon as (?:possible|we can)|at the earliest|asap|jaldi(?: se jaldi)?|doing (?:everything|all|our best)|everything we can|all we can|our best|working (?:hard )?(?:to|on getting)|trying (?:our best |hard )?to|poori koshish|koshish kar|sab kuch kar rahe|taaki .{0,30}jaldi/i;
const WORRY_IDEA = /no need to worry|not to worry|nothing to worry|don'?t worry|do not worry|please be assured|rest assured|chinta (?:mat|na|karne)|chinta ki (?:koi )?(?:zaroorat|baat)|tension (?:mat|na|lene|lijiye)|koi tension|fikar (?:mat|na|karne)|worry (?:not|about)|zaroorat nahi/i;
export const hasAssurance = (text: string | null | undefined): boolean => EFFORT_IDEA.test(String(text ?? "")) && WORRY_IDEA.test(String(text ?? ""));

const RETURNING = /\b(?:on its way back|way back to (?:us|our)|cannot be delivered again|returning to (?:us|our warehouse)|returned to (?:us|our warehouse)|wapas (?:aa|hamare|warehouse)|\brto\b)\b/i;
const DELIVERED = /\b(?:was delivered|is delivered|shows as delivered|marked delivered|recorded as delivered|delivered on|delivered to your|deliver ho chuka|delivered hai)\b/i;
/** A reply that is about something other than the delay: a cancellation, a payment, an address, a price. The reassurance is for a reply about the parcel being late. */
const OFF_TOPIC = /\b(?:cannot be cancelled|can(?:no|')?t be cancelled|cancel(?:led|lation)?|cash on delivery|\bcod\b|refund|price|₹\s?\d)\b/i;
const FLAG = /^I do not have that information\./;

/**
 * The LAST RESORT for a model-written reply: the fixed reassurance added at the end, only when the writer left it out even after being asked again (lib/generalLive.ts). Added only when
 * the turn IS about a late parcel (the tag, or an order-status question on a parcel the record shows OVERDUE / STUCK / undelivered), never twice, never on a parcel that is returning to
 * us or already delivered (there is nothing left to deliver), and never on the fixed "I do not have that information" flag line. Pure.
 */
export function withLateReassurance(text: string | null | undefined, o: { tag?: string | null; record?: string | null }): string {
  const t = String(text ?? "").trim();
  const turn = lateTurnOf(o);
  if (!assuranceDue(t, turn)) return t;
  return `${t} ${reassurance(turn.blame)}`;
}

export interface LateTurn { late: boolean; blame: boolean }
/** Is this turn about a late parcel, and may the courier be named as the source of the delay? The courier is named only where the record says the parcel has stopped moving in its hands, never for a failed attempt that waits on the customer. */
export function lateTurnOf(o: { tag?: string | null; record?: string | null }): LateTurn {
  const rec = String(o.record ?? "");
  // A record that shows the parcel delivered, or on its way back, is not a late parcel whatever the tag says (replay of 17 Oct: a delivered parcel was reassured).
  const settled = /· (?:delivered|rto|returned)\b/i.test(rec) && !/\b(?:OVERDUE|STUCK)\b/.test(rec);
  const late = !settled && (o.tag === "late_delivery" || (o.tag === "order_status" && /\b(?:OVERDUE|STUCK|undelivered)\b/.test(rec)));
  const blame = late && /\bSTUCK\b/.test(rec) && !/not contactable|consignee unavailable|customer unavailable|refused|wrong address/i.test(rec);
  return { late, blame };
}

/** Does this reply still OWE the reassurance: a late-parcel turn, a real reply, not the flag line, not a returning or delivered parcel, and not already saying it. */
export function assuranceDue(text: string | null | undefined, turn: LateTurn): boolean {
  const t = String(text ?? "").trim();
  return turn.late && !!t && !FLAG.test(t) && !RETURNING.test(t) && !DELIVERED.test(t) && !OFF_TOPIC.test(t) && !/no need to worry/i.test(t) && !hasAssurance(t);
}

/** Is this reply (mostly) Hinglish in Latin letters? The fixed English fallback is not stapled on to one: it is asked for again, and left out if it still is not there. */
const HINGLISH = /\b(?:aapka|aapke|aap|hai|hain|hum|nahi|kar|karein|kijiye|ke liye|ki|ko|mein|se|hua|ho)\b/gi;
export const isHinglish = (t: string | null | undefined): boolean => (String(t ?? "").match(HINGLISH) ?? []).length >= 3;

/** Does the reply TELL the customer something is delivered / returning / about a cancellation, so that a reassurance about delivery would contradict it? Used on the writer's own text. */
export function contradictsAssurance(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  return RETURNING.test(t) || DELIVERED.test(t) || OFF_TOPIC.test(t);
}
