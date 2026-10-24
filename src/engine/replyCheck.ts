// The last thing between the model and the customer.
//
// Two replies in the first eleven days went out carrying the model's own scratch
// text: "You can track its journey here: [no tracking link available in provided
// data]." Nothing failed. The schema was satisfied, the JSON parsed, the tag was
// right, and a customer was shown the inside of the prompt.
//
// No wording in the persona prevents that, because the persona is advice and this
// is a fact about the string. So the string is checked. A rejected reply is not
// patched up and sent — a reply we cannot vouch for is escalated, and the customer
// gets the holding line and a person, which is the same degrade every other
// failure in gemini.ts takes.
//
// Deliberately three rules and no more. Every one of them is a defect we have
// actually shipped, and each is decidable by looking at the text alone. Judgements
// that need to read the conversation — did it promise a refund, did it ask for a
// photo on the wrong channel — belong in the persona and the eval set, not here:
// a fuzzy rule enforced as a hard block turns a slightly-off reply into no reply.

export type ReplyRejection = { rule: "placeholder" | "script" | "empty"; detail: string };

/**
 * An unfilled slot the model left in its own output.
 *
 * Three bracket styles, because all three are template syntax the model has seen
 * a great deal of and will reproduce under pressure: `[no tracking link...]` is
 * what we caught in the wild, `{{name}}` is what our own WhatsApp templates look
 * like, and `<first name>` is literally quoted in the email persona as the
 * salutation to write — so the one thing it must never do is copy it verbatim.
 *
 * The whitespace requirement is what keeps this from firing on real prose:
 * "[1]" or "(a)" are punctuation, while a bracketed *phrase* in a support reply
 * is, in every example we have, the model talking to itself.
 */
const PLACEHOLDER = /\[[^\]]*\s[^\]]*\]|\{\{[^}]*\}\}|<[a-z][^>]*\s[^>]*>/i;

/**
 * Devanagari, which the persona forbids absolutely.
 *
 * Five replies went out in Hindi on 26-27 July, before the rule was written. It
 * has held since, and this is the belt to that braces: the instruction is one
 * line in a 6 KB prompt, and a prompt is a request rather than a guarantee.
 *
 * Note this is about the script, not the language. Hinglish in Latin letters is
 * fine and common — 20 inbound messages are written that way — and reads
 * perfectly on every handset. It is the rendering of Devanagari that was the
 * problem, so that is what is tested.
 */
const DEVANAGARI = /[ऀ-ॿ]/;

/**
 * What is wrong with this reply, or null if nothing is.
 *
 * Order matters only for which rule gets reported; any one of them is fatal.
 */
export function checkReply(text: string | null | undefined): ReplyRejection | null {
  const t = (text ?? "").trim();
  if (!t) return { rule: "empty", detail: "" };

  const ph = t.match(PLACEHOLDER);
  if (ph) return { rule: "placeholder", detail: ph[0].slice(0, 80) };

  const dv = t.match(DEVANAGARI);
  if (dv) return { rule: "script", detail: dv[0] };

  return null;
}
