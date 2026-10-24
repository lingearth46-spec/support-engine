// Reading "stop sending me this" out of a WhatsApp reply.
//
// Our privacy policy tells customers they can reply to any message asking us to
// stop, so this has to actually work before a single marketing message goes
// out. It is also what protects the number itself: on WhatsApp, people who
// cannot opt out block instead, and blocks are what drive a quality rating down
// and eventually cost you the ability to send order notifications at all.
//
// The hard part is that "stop" is already meaningful elsewhere. The order
// confirmation flow reads "stop" as a cancellation — `CANCEL` in
// lib/confirmReply.ts lists it — and a customer with an unconfirmed order who
// types "stop" almost certainly means "cancel this order", not "never send me
// an offer again". Getting that backwards would silently leave a real order
// live while quietly muting the customer.
//
// So this matches only phrases that cannot mean anything else. A bare "stop" is
// deliberately NOT one of them: it stays with the confirmation flow, and if
// that flow does not claim it, the support bot answers as a human would.

/**
 * Unambiguous opt-out phrases.
 *
 * Every entry here has to be something nobody would send about a single order.
 * "unsubscribe" and "opt out" carry no other meaning; "stop messages",
 * "stop offers" and their Hindi equivalents are explicit about scope.
 */
const OPT_OUT =
  /\b(unsubscribe|unsubscribed|opt ?out|opted ?out|stop (all |the )?(messages?|msgs?|offers?|promotions?|promos?|marketing|ads?|advertis\w*)|no more (messages?|msgs?|offers?|promotions?|promos?)|don'?t (send|message|msg|text) (me )?(any ?more|again|offers?|promotions?)|do not (send|message|msg|text) (me )?(any ?more|again|offers?|promotions?)|remove me|delete my number|message mat (bhejo|karo)|msg mat (bhejo|karo)|band karo)\b/i;

/** Strips emoji and punctuation so "STOP MESSAGES!!" reads like "stop messages". */
function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the customer is asking to stop receiving promotional messages.
 *
 * A question is never a request: "how do I unsubscribe?" is someone asking, and
 * answering it is the support bot's job. Acting on it would opt them out before
 * they decided to.
 */
export function isOptOutRequest(raw: string): boolean {
  if (!raw) return false;
  if (raw.includes("?")) return false;

  const text = normalise(raw);
  if (!text) return false;

  // Long messages are conversations that happen to contain the words. "I did
  // not opt out of anything, where is my order" must not mute the customer.
  if (text.split(" ").length > 8) return false;

  return OPT_OUT.test(text);
}

/** What we send back. Short, warm, and clear about what does NOT stop. */
export function optOutConfirmation(): string {
  return (
    "Done — you won't get any more offers or reminders from us on WhatsApp. 🙏\n\n" +
    "You'll still get updates about orders you've placed, since we need those to deliver them.\n\n" +
    "Changed your mind? Just reply START."
  );
}

/** The counterpart, so an opt-out is never a one-way door. */
const OPT_IN = /\b(start|resume|subscribe|resubscribe|opt ?in)\b/i;

export function isOptInRequest(raw: string): boolean {
  if (!raw || raw.includes("?")) return false;
  const text = normalise(raw);
  // Strictly a one-word instruction: "start" inside a sentence is usually
  // "when will you start shipping", not a request to resume marketing.
  return text.split(" ").length <= 2 && OPT_IN.test(text);
}

export function optInConfirmation(): string {
  return "You're back on the list 🎉 We'll let you know about offers and reminders again.";
}
