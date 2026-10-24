// A customer who tapped "Update address" and then says the address is fine ("Same address", "Yahi address hai", "Sorry", "Ok") is not sending an address. Pure.
//
// 22-23 Oct: 11 of the 14 customers who got "a team member will confirm the updated address with you" had written a short reply that kept their address (or declined the order); each
// pinged the team for nothing and was told an address was being updated when none was. Strict on purpose: only a short message, with no pincode, that clearly keeps the address and
// does not decline, change or call it wrong. "Don't conform tha order" and "On edit" stay with a person.

const KEEP = /\b(?:same|yahi|yehi|wahi|sahi|correct|right|theek|thik|ok(?:ay)?|okk|no change|no need|not needed|sorry|by mistake|galti)\b/i;
const NOT_A_KEEP = /\b(?:don'?t|do not|dont|nahi|nhi|never)\b.{0,15}\b(?:confirm|conform|want|need|order)\b|\bcancel\b|\bnot\b.{0,8}\b(?:right|correct|same|sahi)\b|\bwrong\b|\bgalat\b|\b(?:want|wish|need|like)\s+to\s+change\b|\bchange\s+(?:the|my|it|this|address)\b/i;
const PINCODE = /(?<!\d)\d{6}(?!\d)/;

export function keepsAddress(text: string | null | undefined): boolean {
  const t = String(text ?? "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  if (!t || t.length > 60 || PINCODE.test(t) || NOT_A_KEEP.test(t)) return false;
  return KEEP.test(t);
}

/** What the customer is told: the address stays. Before dispatch the order still needs its Confirm; after it, there is nothing to confirm. */
export const KEEP_ADDRESS_REPLY = "No problem, I have left your address as it is.";
export const KEEP_ADDRESS_CONFIRM = " If you would like us to go ahead with your order, please tap Confirm on the order message.";
