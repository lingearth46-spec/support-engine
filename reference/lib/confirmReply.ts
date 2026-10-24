// Reading a customer's answer to the order-confirmation message.
//
// The message asks for "1" or "2", and most people send exactly that. The rest
// answer like people: "yes", "haan", "ok bhai", "no need", "cancel it". So this
// accepts words as well as digits, in the languages our customers actually use.
//
// The bias throughout is toward doing nothing. A reply we are not sure about is
// handed to a human rather than guessed at, because both wrong guesses are
// expensive: cancelling an order someone wanted loses a sale outright, and
// confirming one they were trying to cancel books freight in both directions —
// the exact outcome this whole flow exists to prevent.

export type ConfirmIntent = "confirm" | "cancel" | "unclear";

/** Strips emoji, punctuation and spacing so "✅ yes!!" and "yes" read alike. */
function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Idioms whose "no" does not mean no.
 *
 * "no problem, send it" is agreement, and matching the bare "no" read it as a
 * cancellation — throwing away an order the customer had just confirmed, which
 * is the most expensive mistake this file can make. The phrase is removed before
 * matching so only the rest of the sentence is judged.
 */
const FALSE_NEGATIVES = /\bno (problem|problems|issue|issues|worries|worry|tension|probs)\b/g;

// Whole words only, so "no" does not match inside "now" and — the one that
// actually matters — "1" does not match inside a phone number or a pincode.
//
// Only words that are an *answer*. "send", "deliver" and "proceed" were in here
// and had to come out: "can you deliver on saturday instead" was being read as a
// yes, which would dispatch immediately against a customer who was asking to
// reschedule — manufacturing the exact refusal this flow exists to prevent.
// "correct" and "right" went for the same reason ("is the address right?").
// Losing "send it" as an auto-confirm costs one message of human attention;
// getting the reschedule wrong costs a round trip.
const CONFIRM = /\b(1|yes|yeah|yep|ya|yah|y|ok|okay|okey|sure|confirm|confirmed|haan|han|ha|haa|thik|theek|sahi|accha|acha)\b/;
const CANCEL = /\b(2|no|nope|nah|n|cancel|cancelled|dont|do not|stop|remove|nahi|nai|nahin|mat|reject|refuse|not required|not needed|no need)\b/;

/**
 * What the customer meant, or "unclear" when it cannot be read confidently.
 *
 * Length matters as much as content. "yes" is an answer; "yes but can you make
 * it the gold one instead" is a conversation, and treating it as a plain
 * confirmation would ship the wrong bracelet. Anything beyond a short phrase is
 * therefore left for a human even when it starts with a word we recognise.
 */
export function readConfirmReply(raw: string): ConfirmIntent {
  // A question is never an answer. Cheap to check and it catches the whole class
  // of "ok?", "is it silver?", "can I get it by friday?" that keyword matching
  // would otherwise read as agreement.
  if (raw.includes("?")) return "unclear";

  const text = normalise(raw).replace(FALSE_NEGATIVES, " ").replace(/\s+/g, " ").trim();
  if (!text) return "unclear";

  // Longer than a handful of words is a request, not an answer.
  if (text.split(" ").length > 6) return "unclear";

  const saysYes = CONFIRM.test(text);
  const saysNo = CANCEL.test(text);

  // "no problem, send it" contains both. So does "yes cancel it". Neither can be
  // resolved from keywords alone.
  if (saysYes === saysNo) return "unclear";
  return saysYes ? "confirm" : "cancel";
}
