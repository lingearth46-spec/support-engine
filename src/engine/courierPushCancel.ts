// A customer who is NOT asking to cancel but telling us the rider wants them to, or that they refuse to. Pure.
//
// 22 Oct: "The courier guy wants me to cancel my order but I don't want to cancel it" was answered "Orders cannot be cancelled once they have been dispatched", because the word "cancel"
// (and "want to cancel", inside "don't want to cancel") read as a request. It is a complaint about the courier. Used by the cancel-state rule (to leave it alone) and the late-delivery
// agent (to read it as a dispute: a person and a ticket), not by either on its own.

const REFUSES = /\b(?:don'?t|do not|dont|never|not)\s+(?:want|wish|need|like)\s+to\s+cancel\b/i;
const COURIER_PUSHES = /\b(?:courier|delivery\s+(?:boy|guy|partner|person|agent)|rider|agent|shadowfax|delhivery|dtdc)\b.{0,40}\b(?:want|wants|asking|asked|telling|told|says?|said|forc\w*|pressur\w*)\b.{0,30}\bcancel/i;

export function courierPushesCancel(message: string | null | undefined): boolean {
  const t = String(message ?? "").replace(/[‘’]/g, "'");
  return REFUSES.test(t) || COURIER_PUSHES.test(t);
}
