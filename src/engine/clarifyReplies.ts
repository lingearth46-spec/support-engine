// Three replies that replace a guess with a clarifying line or a pointer. Used only with SUPPORT_PIPELINE_V2 on (lib/pipelineV2.ts).
//
// Each one is a case from 10 Oct where the model (or the fast path) GUESSED:
//
//  · "You know bengali ?"  The persona says reply in English, or Hinglish in Latin letters, and nothing else. That rule is in the
//                          persona, not in the evidence the judge reads, so every honest draft ("I can help in English and
//                          Hinglish") was blocked as an unsupported claim and the customer got "flagged to the team". The answer
//                          is fixed text, so it never needs verifying.
//  · "Confirm"             Sent to an order that was moved to prepaid-only, in answer to our own payment message. The model asked
//                          "cancel, or keep it as COD?" — COD had just been taken away — and promised "I'll do it". The only thing
//                          "Confirm" can mean there is "yes, I will pay": point them back at the payment button.
//  · "Sunday"              One word, after an address and a COD confirmation. The model read it as "are you open on Sunday?" and
//                          answered "We're closed on Sundays". A fragment with no clear meaning is asked about, not interpreted.
//
// WORDING IS PROPOSED, NOT APPROVED. Every constant below is customer-facing text and needs the founder's go before the flag is on.
// Pure, so every rule is unit-tested.

const n = (s: string | undefined) => (s ?? "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

// ── language ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const LANGUAGE_REPLY =
  "I can reply in English, or in Hinglish (Hindi written in English letters). Please write to me in either and I'll help.";

const UNSUPPORTED_LANGUAGE =
  "bengali|bangla|tamil|telugu|kannada|malayalam|marathi|gujarati|punjabi|odia|oriya|urdu|assamese|nepali|sindhi|konkani|bhojpuri|maithili|kashmiri|arabic|french|spanish|german";

const LANGUAGE_QUESTION = new RegExp(
  `\\b(?:know|speak|talk|understand|reply|write|chat|baat|bol(?:te|ta|na|o)?|aati|aata|janta|jante|use)\\b[^.?!]{0,25}\\b(?:${UNSUPPORTED_LANGUAGE})\\b` +
  `|\\b(?:${UNSUPPORTED_LANGUAGE})\\b[^.?!]{0,25}\\b(?:know|speak|come|aati|aata|janta|jante|me|mein|mai|bol|language|bhasha)\\b`,
  "i",
);

/** A question about whether we speak a language we do not reply in. Short messages only: a long one that happens to contain
 *  "Bengali" (a street, a name) is about something else. */
export function languageReply(message: string): { text: string; kind: "language" } | null {
  const m = n(message);
  if (!m || m.split(" ").length > 9) return null;
  return LANGUAGE_QUESTION.test(m) ? { text: LANGUAGE_REPLY, kind: "language" } : null;
}

// ── "Confirm" on a prepaid-only order ───────────────────────────────────────────────────────────────────────────────────────

export const PAY_LINK_REPLY =
  "To go ahead with this order, please complete the payment using the payment button in our earlier message. Once it is paid, we will pack it.";

const AFFIRM = /^(?:confirm(?:ed)?|yes|yep|yeah|ok(?:ay)?|done|sure|haan|han|ha|theek hai|thik hai|kar do|kardo|proceed|go ahead|i confirm|confirm it|confirmed order)[.!\s]*$/i;

/** Our own prepaid-only payment message: the template says the order can only go prepaid and carries a pay button. */
const PREPAID_PROMPT = /only send this one as a prepaid order|tap below to pay|pay now|pay ₹|complete the payment|prepaid order/i;

/**
 * "Confirm" (or yes / ok / done) as the answer to our payment message. `recentOut` is our last few outbound lines, newest last.
 * Applies only when one of THEM was the prepaid prompt and nothing after it was a customer-facing answer to something else.
 */
export function payLinkConfirmReply(o: { message: string; recentOut: string[]; orderStatus?: string | null }): { text: string; kind: "pay_link" } | null {
  if (!AFFIRM.test(n(o.message))) return null;
  const last = o.recentOut.slice(-2);
  if (!last.some((b) => PREPAID_PROMPT.test(b ?? ""))) return null;
  // The order must still be waiting for payment. A status we do not know is not enough to point at a button that may be gone.
  if (o.orderStatus && !["on_hold", "processing", "call_1", "call_2"].includes(o.orderStatus)) return null;
  return { text: PAY_LINK_REPLY, kind: "pay_link" };
}

// ── a fragment with no clear meaning ───────────────────────────────────────────────────────────────────────────────────────────

export const AMBIGUOUS_REPLY =
  "Sorry, I didn't quite follow. Could you tell me a little more about what you need help with? You can also send your order ID.";

const DAYWORD = /^(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?$|^(?:today|tomorrow|tonight|kal|aaj|parso|abhi|morning|evening|afternoon|night|weekend)$/i;

/** Words that carry an intent or are handled elsewhere. A fragment containing one is not "unclear". */
const KNOWN =
  /\b(cancel\w*|refund\w*|return\w*|exchange\w*|replace\w*|order\w*|track\w*|status|deliver\w*|address|adress|pincode|change|update|phone|number|help|support|agent|team|call|price|cost|size|payment|pay|cod|damag\w*|broken|wrong|missing|complain\w*|urgent|where|when|why|how|what|which|who|hi+|hello+|hey+|hii+|namaste|thanks?|thank|thx|ok(?:ay)?|okk+|yes|no|nope|yep|haan|han|nahi|nahin|confirm\w*|stop|start|link|website|photo|image|video|invoice|bill|ajuki\d*)\b/i;

/**
 * A one- or two-word message that says nothing we can act on, so a guess would be a guess. The day-word case ("Sunday", "tomorrow")
 * is deliberately included: on its own it is a delivery wish, an opening-hours question or a reply to something else.
 *
 * Never when a flow owns the thread, a photo came with it, or an order id is present — the caller checks those.
 */
export function ambiguousFragmentReply(message: string): { text: string; kind: "clarify" } | null {
  const m = n(message).replace(/[?!.…,]+$/g, "").trim();
  if (!m || m.length > 24 || /\d/.test(m)) return null;
  const words = m.split(" ").filter(Boolean);
  if (words.length > 2) return null;
  if (!words.every((w) => /^[\p{L}'’]+$/u.test(w))) return null;
  if (words.length === 1 && DAYWORD.test(words[0])) return { text: AMBIGUOUS_REPLY, kind: "clarify" };
  if (KNOWN.test(m)) return null;
  // A single very short token ("Gh", "k", "hmm") is as likely a mis-tap as a message; it is asked about the same way.
  return { text: AMBIGUOUS_REPLY, kind: "clarify" };
}
