// A message that only acknowledges — "Ok", "Thanks", "thank you so much", a thumbs-up, an emoji, a WhatsApp
// reaction — gets no reply at all. The founder's call: answering a bare "Ok" invited the model to guess what it
// meant (it once restarted an old pendant thread) and a reply to a reaction re-explained a refund.
//
// Deliberately narrow: EVERY word must be an acknowledgement word, so "ok but where is my order", "no thanks"
// and "thank you for the update, when will it arrive" all still get answered. "Yes", "No" and "Fine" are not
// here — those can be answers to a question we just asked. Pure, unit-tested.

const ACK_WORDS = new Set([
  "ok", "okay", "okk", "okkk", "okey", "oke", "okie", "k", "kk", "okie", "oky", "okhy", "okhay", "okh", "ohk", "okya",
  "thanks", "thank", "thankyou", "thanku", "thx", "tnx", "ty", "thnx", "thanx",
  "you", "so", "much", "very", "a", "lot", "sir", "mam", "maam", "madam", "ji",
  "thik", "theek", "hai", "ho", "gaya", "done", "got", "it", "noted", "alright", "great", "nice", "good",
  "too", "cool", "super", "perfect", "acha", "accha", "achha", "hmm", "hm", "welcome", "bro",
  // Devanagari: "ओके" (ok), "ठीक है" (theek hai), "धन्यवाद" / "शुक्रिया" (thanks), "थैंक्स" / "थैंक यू", "जी", "अच्छा", "बढ़िया" (17 Oct: "ओके" got an answer).
  "ओके", "ठीक", "है", "धन्यवाद", "शुक्रिया", "थैंक्स", "थैंक", "यू", "जी", "अच्छा", "बढ़िया", "बहुत",
]);

/** Words that are an acknowledgement only beside another one: "Sure thanks" is thanks, but a bare "Sure" can answer a question we just asked ("Do you want...?"). */
const NEEDS_COMPANY = new Set(["sure"]);

/**
 * Our last message was a courtesy close ("You're welcome — if you need anything later, just message us here."): nothing was asked, so a bare "sure" answers nothing and gets no reply.
 * Without this, "sure!" after a thank-you was read as a customer chasing the same answer and opened a case (21 Oct). A bare "sure" after a question of ours is still an answer.
 */
const COURTESY_CLOSE = /you'?re welcome|you are welcome|just message us here|if you need anything|anything (?:else|later)|happy to help/i;
export function isAckAfterClose(message: string, lastBotMessage: string | null | undefined): boolean {
  if (!lastBotMessage || /[?？]/.test(lastBotMessage) || !COURTESY_CLOSE.test(lastBotMessage)) return false;
  const words = (message ?? "").toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.every((w) => NEEDS_COMPANY.has(w) || ACK_WORDS.has(w));
}

/** The placeholder lib/whatsapp stores for a message type it cannot read as text. */
const REACTION = /^\[unhandled message type: reaction\]$/i;

/** A sound of understanding or surprise ("Oohh", "Ahh", "Hmmm", "Ohhk", "Achaa"): one word, no question, nothing to answer. 13 Oct: "Oohh" got a paragraph. */
const INTERJECTION = /^(?:o+h+k*|a+h+|a+a+h+|h+m+|u+h+m+|o+o+h+|oh+o*|wow+|a+c+h+a+|accha+|ohh?o)$/;

/** The "All good" button on the on-its-way message (order_arrival_headsup_v1): nothing was asked, so nothing is answered. 24 Oct: five taps after hours got the opening-hours notice. */
const ALL_GOOD = /^all good[\s.!]*$/i;

export function isAckOnly(message: string): boolean {
  const raw = (message ?? "").trim();
  if (!raw) return false;
  if (ALL_GOOD.test(raw)) return true;
  if (REACTION.test(raw)) return true;
  // Letters and digits only, split into words. Emoji and punctuation drop out.
  // \p{M} keeps the vowel signs of Devanagari words together; the emoji selectors are stripped first so "❤️" still reduces to nothing.
  const words = raw.toLowerCase().replace(/[︎️‍⃣]/g, "").replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  // Nothing left but emoji / punctuation: a thumbs-up, a heart, "🙏".
  // Punctuation only ("." "..." "!" "-"): nothing was asked, so nothing is answered (13 Oct: a lone "." got the pending-return line). A "?" is
  // the one exception: "??" is a customer chasing us, and is answered.
  if (words.length === 0) return /\p{Extended_Pictographic}/u.test(raw) || !/[?？]/.test(raw);
  if (words.length > 6) return false;
  // Stretched spellings ("muchh", "thankuuu", "thanksss") count as the word: runs of 3+ collapse to one letter, a doubled last letter to one.
  const plain = (w: string) => w.replace(/(.)\1{2,}/g, "$1").replace(/(.)\1$/, "$1");
  const isAck = (w: string) => ACK_WORDS.has(w) || ACK_WORDS.has(plain(w)) || INTERJECTION.test(w) || NEEDS_COMPANY.has(w);
  return words.every(isAck) && words.some((w) => !NEEDS_COMPANY.has(w));
}
