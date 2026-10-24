// A customer who writes the number to deliver to in plain words ("9000100003 new mobile no.", "my correct number is 9876543210") is asking for the same thing as the Update phone button
// on a failed-delivery message. On 21 Oct such a message was read as an address change and the customer was asked for an address. Pure.
//
// Deliberately strict: a bare ten-digit number is NOT a phone change (it can be the number someone looks an order up by), so BOTH a word about a phone and a word about changing it must be
// there, there must be exactly one mobile number, and a six-digit pincode beside it means it is an address.

const MOBILE = /(?<!\d)(?:\+?91[\s-]?)?([6-9]\d{9})(?!\d)/g;
const PHONE_WORDS = /\b(?:mobile|phone|contact|whatsapp|number|no\.?|nmbr|num)\b/i;
const CHANGE_WORDS = /\b(?:new|updated?|correct|changed?|change|another|alternate|different|wrong|instead)\b/i;
const PINCODE = /(?<!\d)[1-9]\d{5}(?!\d)/;

/** The ten-digit number the customer wants the courier to use, or null when the message is not a phone change. */
export function phoneChangeNumber(message: string | null | undefined): string | null {
  const m = String(message ?? "").replace(/[‘’]/g, "'").trim();
  if (!m || m.length > 140) return null;
  const found = [...m.matchAll(MOBILE)].map((x) => x[1]);
  if (found.length !== 1) return null;
  const rest = m.replace(MOBILE, " ");
  if (PINCODE.test(rest) || !PHONE_WORDS.test(rest) || !CHANGE_WORDS.test(rest)) return null;
  return found[0];
}
