// Fixed-wording replies for a customer whose return is PENDING or REJECTED.
//
// The founder wants these two states to say exactly the same thing every time,
// and a model prompted with a sentence still drifts around it (an apology, a few
// extra words, the appeal line plus the "already working" line). So the wording
// lives here, in code, and lib/waSupport.ts swaps it in for the model's text.
// Approved returns are NOT handled here: those answers depend on the pickup,
// courier and refund facts, which only the model composes.
//
// Pure on purpose (no db, no network) so every branch is unit-tested.

import { day } from "@engine/orderLines";
import type { OrderRow } from "@engine/orderLines";
import { hasReturnIntent } from "@engine/supportGuardrails";
import { daysLeftToReturn } from "@policy/returnPolicy";
import { isLateFirstText, isLateInsistText } from "@engine/lateDeliveryReply";

/** "I don't want the order", "no longer want this order", "not interested": about a parcel still on its way, not a return. */
const NO_LONGER_WANTED = /\b(?:don'?t|do not|no longer|dont) want (?:the |this |my |that )?(?:order|parcel|product)\b|\bnot interested\b/i;

export const SENIOR_SUPPORT_EMAIL = "ajukisupport@gmail.com";

export const PENDING_REPLY =
  "Your return request is with our returns team. Please wait until they decide on it — they will update you here.";

export const CHASING_REPLY =
  "Our Senior Support Team is already working on your issue. Please wait for their reply.";

/** They are still chasing after we already said "please wait for their reply" (founder, 11 Oct): do not say it a second time. Pipeline fixes only. */
export const CHASING_AGAIN_REPLY =
  "Our team is already on your case. If you would like, you can also write to us by email at ajukisupport@gmail.com.";

export const RETURN_PAGE_REPLY =
  "You can raise a return at www.ajuki.in/returns/start with your order number and the phone number you ordered with.";

/** A return is asked for after the return window has closed. The website form would refuse it, so a person decides:
 *  the bot sends them to email and never quotes the window itself. */
export const WINDOW_CLOSED_EMAIL_REPLY =
  `Please email our Senior Support Team at ${SENIOR_SUPPORT_EMAIL} with your order number and details of the issue.`;

export const NO_RETURN_EMAIL_REPLY =
  `If you still need help with this, please email our Senior Support Team at ${SENIOR_SUPPORT_EMAIL} with your order number and what you need.`;

export const EXCHANGE_EMAIL_REPLY =
  `Exchanges are handled by email. Please email our Senior Support Team at ${SENIOR_SUPPORT_EMAIL} with your order number, what is wrong with the item, and the item or size you would like instead.`;

export const REFUND_WORD = /\b(refund\w*|money back)\b/i;
/** Hinglish: "paise wapas kab milenge", "mera refund nahi aaya", "paisa kab aayega". */
export const REFUND_WORD_HI = /\b(?:paise|paisa|paisay|rupay|rupaye|amount|money)\b[^.?!]{0,25}\b(?:wapas|vapas|back|milega|milenge|aayega|aayenge|credit|nahi|nhi)\b|\b(?:wapas|vapas)\b[^.?!]{0,20}\b(?:paise|paisa|amount|money)\b/i;
export const REFUND_CHASE_HI = /\b(?:kab|kb|kitne din|kitna time|kitni der|nahi|nhi|nahin|abhi tak|aaya|mila|milega|aayega|hua)\b/i;
export const REFUND_CHASE = /\b(promised|still|not (?:yet )?(?:been )?(?:received|credited|got|reflect\w*)|haven'?t (?:received|got)|no refund|waiting|pending|when will|where(?:'s| is)|status|any update|days)\b/i;

/** An exchange (or swap / change of size or colour), as opposed to a return. */
export const EXCHANGE = /\b(exchange|exchanged|exchanging|swap|swapped)\b|\bchange\b.{0,20}\b(size|colou?r|piece|item)\b/i;

/** Said once, before the first rejection line (founder, 14 Oct). */
export const REJECTED_SORRY = "I am sorry this is not the answer you were hoping for.";
/** The short form for a customer who has already been told: the appeal route and nothing else. */
export const REJECTED_APPEAL_SHORT = `To appeal, email our Senior Support Team at ${SENIOR_SUPPORT_EMAIL} with your order number and photos.`;

export function rejectedReply(resolvedAt?: string | null, opts: { repeat?: boolean } = {}): string {
  if (opts.repeat) return REJECTED_APPEAL_SHORT;
  return (
    `${REJECTED_SORRY} ` +
    `Your return request was reviewed and rejected${resolvedAt ? ` on ${day(resolvedAt)}` : ""}. ` +
    `If you would like to appeal, please email our Senior Support Team at ${SENIOR_SUPPORT_EMAIL} ` +
    `with your order number and any photos or video showing the issue.`
  );
}

/** Did we already send the rejection line (today's or the earlier wording)? */
export const wasRejectedLine = (t: string | null | undefined): boolean =>
  !!t && (t.includes("Your return request was reviewed and rejected") || t.startsWith(REJECTED_APPEAL_SHORT.slice(0, 30)));

export const APPROVED_APPEAL_REPLY =
  `If you would like to appeal this outcome, please email our Senior Support Team at ${SENIOR_SUPPORT_EMAIL} ` +
  `with your order number and what you would like instead.`;

/** Asking to swap an approved outcome for a refund. "When will I get my refund?" is NOT this — that is a
 *  status question the model answers from the order facts. */
const WANTS_DIFFERENT_OUTCOME =
  /(refund|money back|cash back).*\b(instead|rather)\b|\b(instead|rather)\b.*(refund|money back)|\b(want|need|give me|get me)\b.{0,20}(a )?(refund|money back)|can i (get|have|ask for) (a )?refund|how.{0,25}(get|claim|ask for|request).{0,10}refund|(don'?t|do not|no) (want|need).{0,20}(replacement|exchange)|cancel.{0,15}(the )?(replacement|exchange)/i;

export const CANCEL_RETURN_REPLY =
  `To cancel your return request, please email our Senior Support Team at ${SENIOR_SUPPORT_EMAIL} with your order number.`;

/** Withdrawing a return that is already filed: "cancel the return", "stop the pickup", "I'll keep the item". */
const CANCEL_THE_RETURN =
  /\b(cancel|withdraw|stop|drop|call off|revoke)\b.{0,20}\b(the |my |this )?(return|pick ?up|request)\b|\b(don'?t|do not|no longer)\b.{0,15}\b(want|need|wish)\b.{0,15}\b(to return|the return|a return)\b|\b(want to|will|going to|let me|can i) keep (the|it|this|my)\b/i;

/** "How much should I wait?", "kitna wait karna hai" — a question about how long the wait is: a chase on whatever we last said. */
export const WAIT_QUESTION = /\b(?:how (?:much|long)|how many (?:days|hours)|until when|till when|when)\b.{0,25}\bwait\w*\b|\bwait\w*\b.{0,20}\b(?:how (?:much|long)|how many|until when|till when)\b|\bkitna\b.{0,12}\bwait/i;

/** "I emailed", "no one replied", "where is the reply" — chasing, not asking about the decision. */
const CHASING = /(e-?mail|mailed|repl(y|ied|ies)|respon(d|se|ded)|no ?one|nobody|still waiting|not heard|contact(ed)?)/i;

/** Tags that are about the return itself. Anything else is left to the model unless the message
 *  is clearly about the return or continues the canned exchange. */
const RETURNISH = new Set(["return", "exchange", "replacement", "refund", "complaint", "sizing", "other"]);

/** A fault, sizing or quality complaint about a delivered item: the same conversation as a return, handled
 *  by the same state (wait / returns page / appeal email). Deliberately wording-based, not tag-based — the
 *  model tags these as sizing, complaint, product_info or order_status depending on the day. */
export const FAULT =
  /\b(wrong (item|product|colou?r|size|piece)|order (is )?wrong|damag(e|ed)|broken|defect(ive)?|faulty|not working|stopped working|too (big|small|long|short|loose|tight|large)|doesn'?t fit|does not fit|size (issue|problem)|poor quality|bad quality|quality|rust(ed|y)?|missing|hook)\b|colou?r.{0,15}(came off|faded|fading|gone)/i;

/** Tags that mean the complaint is about a parcel that has not arrived, a cancellation, an address or a price — not about a
 *  delivered item — so a word like "missing" there is not a fault claim. */
const NOT_A_FAULT_TAG = new Set(["order_status", "late_delivery", "cancellation", "address_change", "payment_cod", "offer_discount", "product_info"]);
const isFault = (o: { message: string; tag: string }) => FAULT.test(o.message) && !NOT_A_FAULT_TAG.has(o.tag);

const OTHER_TOPIC_TAGS = new Set(["late_delivery", "cancellation", "address_change"]);

export const ALL_CANNED = [PENDING_REPLY, CHASING_REPLY, CHASING_AGAIN_REPLY, RETURN_PAGE_REPLY, NO_RETURN_EMAIL_REPLY, WINDOW_CLOSED_EMAIL_REPLY, EXCHANGE_EMAIL_REPLY, "Your return request was reviewed and rejected"];

export function isCanned(body: string): boolean {
  return ALL_CANNED.some((c) => body.startsWith(c.slice(0, 40)));
}

/**
 * The fixed reply for this message, or null to let the model's own reply stand.
 *
 * Applies only when the customer has exactly ONE order with a return filed and it
 * is pending or rejected, and the message is about that return: the model tagged
 * it return-ish, the text itself reads like a return, it is chasing a reply, or it
 * continues our own previous canned line ("Hello??" after we answered).
 */
export function returnStateReply(opts: {
  ownOrders: Pick<OrderRow, "id" | "return_request" | "status" | "delivered_at">[];
  message: string;
  tag: string;
  lastBotReply?: string | null;
  /** A refund is already on record for one of their orders (a cancelled prepaid order, say) — a refund question
   *  is then about that refund, not a missing return, and belongs to the model. */
  hasRefundRecord?: boolean;
  /** SUPPORT_PIPELINE_V2 (lib/pipelineV2.ts): a customer chasing a refund they were promised is not sent to the returns page. */
  v2?: boolean;
}): string | null {
  const withReturn = opts.ownOrders.filter((o) => o.return_request);
  // No return on record anywhere: a customer asking to return something is sent to the returns page, and if they
  // come back still asking, to the Senior Support Team by email. Only for someone with a delivered order — a
  // parcel still in transit or coming back is a different conversation.
  if (withReturn.length === 0) {
    // 10 Oct: "it has been 3 days since I was promised a full refund … I have still not received it" was answered "You can raise a
    // return at www.ajuki.in/returns/start". They had already been through that; they are asking where the money is, and that is
    // a question about the refund's state, which the model answers from the order's refund line (or hands to the team).
    // Asking where the money is, in English or Hinglish, is a question about the refund's state, which the model answers from the order's refund line.
    if (REFUND_CHASE.test(opts.message) && REFUND_WORD.test(opts.message)) return null;
    if ((REFUND_WORD.test(opts.message) && REFUND_CHASE_HI.test(opts.message)) || (REFUND_WORD_HI.test(opts.message) && (REFUND_CHASE_HI.test(opts.message) || REFUND_CHASE.test(opts.message)))) return null;
    if (opts.hasRefundRecord || !opts.ownOrders.some((o) => (o as { status?: string }).status === "delivered")) return null;
    const last = opts.lastBotReply ?? "";
    // A parcel that never arrived is not a return: after our late-parcel line, or when they say they no longer want an order that is still on its
    // way, the returns page is the wrong answer (15 Oct: "I don't want the order, I just need the refund" on a parcel delayed since 3 Oct).
    // The model answers from the order record and hands it to the team.
    const inFlight = opts.ownOrders.some((o) => ["confirmed", "processing", "manifested", "shipped", "dispatched", "in_transit", "out_for_delivery", "undelivered"].includes(String((o as { status?: string }).status)));
    if (inFlight && (isLateFirstText(last) || isLateInsistText(last) || NO_LONGER_WANTED.test(opts.message))) return null;
    // An exchange goes straight to email — there is no page to send them to.
    if (opts.tag === "exchange" || EXCHANGE.test(opts.message)) return EXCHANGE_EMAIL_REPLY;
    const wantsReturn = hasReturnIntent(opts.message) || opts.tag === "return" || opts.tag === "sizing" || isFault(opts);
    // The 7-day window: open if ANY delivered order still has days left. A delivered order with no delivery date is
    // treated as closed — a person looks at it, as the order line already says.
    const windowOpen = opts.ownOrders.some((o) => o.status === "delivered" && !!o.delivered_at && (daysLeftToReturn(o.delivered_at) ?? 0) > 0);
    const returnLine = windowOpen ? RETURN_PAGE_REPLY : WINDOW_CLOSED_EMAIL_REPLY;
    // After the exchange email, a request to RETURN something is a new topic and gets the returns page first;
    // only chasing or other follow-ups on the exchange itself go back to email.
    const afterExchange = last.startsWith(EXCHANGE_EMAIL_REPLY.slice(0, 40));
    const insisting = (last.startsWith(RETURN_PAGE_REPLY.slice(0, 40)) || last.startsWith(NO_RETURN_EMAIL_REPLY.slice(0, 40)) || last.startsWith(WINDOW_CLOSED_EMAIL_REPLY.slice(0, 40)) || afterExchange)
      && (wantsReturn || RETURNISH.has(opts.tag) || CHASING.test(opts.message))
      && !(afterExchange && wantsReturn && !CHASING.test(opts.message));
    // "Where do I do that?" / "what link?" is a question about the page we just gave, not insisting.
    const asksWhere = last.startsWith(RETURN_PAGE_REPLY.slice(0, 40)) && /\b(where|how|which|link|website|page)\b/i.test(opts.message);
    if (asksWhere) return RETURN_PAGE_REPLY;
    if (insisting) return NO_RETURN_EMAIL_REPLY;
    return wantsReturn ? returnLine : null;
  }
  if (withReturn.length !== 1) return null;
  const rr = withReturn[0].return_request!;
  // An approved return is the model's to answer — except a request to change the outcome, which is an
  // appeal and goes to email, exactly like a rejection.
  if (rr.status === "approved") {
    if (CANCEL_THE_RETURN.test(opts.message)) return CANCEL_RETURN_REPLY;
    return WANTS_DIFFERENT_OUTCOME.test(opts.message) ? APPROVED_APPEAL_REPLY : null;
  }
  if (rr.status !== "pending" && rr.status !== "rejected") return null;
  // An exchange request is not a question about this return, and the pending line answers a different question (14 Oct, #2).
  if (rr.status === "pending" && EXCHANGE.test(opts.message) && !/\breturn/i.test(opts.message) && !CHASING.test(opts.message)) return EXCHANGE_EMAIL_REPLY;
  // Withdrawing a pending return is a human's job, so it goes to email. Checked ahead of the topic guard below,
  // because the model tags "cancel the return" as a cancellation. (A rejected return has nothing left to cancel.)
  if (rr.status === "pending" && CANCEL_THE_RETURN.test(opts.message)) return CANCEL_RETURN_REPLY;

  // A message plainly about something else — a late parcel, a cancellation, an address — is not about this
  // return, even if it chases a reply ("no response from the delivery agent"). Left to the rules and the model
  // that own it; the return wording wins only when the message itself talks about the return.
  if (OTHER_TOPIC_TAGS.has(opts.tag) && !hasReturnIntent(opts.message) && !isFault(opts)) return null;

  // With the pipeline fixes on, "how long should I wait?" is a chase too, and a chase that comes after we already said "please wait for
  // their reply" gets the second line instead of the same sentence again.
  const chasing = CHASING.test(opts.message) || (!!opts.v2 && WAIT_QUESTION.test(opts.message));
  const continues = !!opts.lastBotReply && isCanned(opts.lastBotReply);
  const about =
    RETURNISH.has(opts.tag) || hasReturnIntent(opts.message) || isFault(opts) || chasing || continues;
  if (!about) return null;

  if (rr.status === "pending") return PENDING_REPLY;
  if (!chasing) return rejectedReply(rr.resolved_at, { repeat: wasRejectedLine(opts.lastBotReply) });
  return (opts.lastBotReply ?? "").startsWith(CHASING_REPLY.slice(0, 40)) ? CHASING_AGAIN_REPLY : CHASING_REPLY;
}

/**
 * Does this message touch the return / exchange / refund / cancel-the-return flow at all? Used to keep the early,
 * model-free pass away from anything the return rules own: when it says yes, the message takes the long way round.
 * Deliberately generous — a false yes only costs one model call, a false no would answer a return question with a topic line.
 */
export function touchesReturnFlow(message: string): boolean {
  const m = message ?? "";
  return hasReturnIntent(m) || EXCHANGE.test(m) || FAULT.test(m) || CANCEL_THE_RETURN.test(m) || WANTS_DIFFERENT_OUTCOME.test(m) || CHASING.test(m);
}
