// Does this message, sent on a thread that is already escalated, ask for something NEW?
//
// An escalation is acknowledged once and the thread then goes quiet while the team is told about every follow-up
// (lib/waBurst.ts alreadyAcknowledged). That is right for a chaser ("any update?") and wrong for an instruction: on 9 Oct a
// customer whose parcel had failed delivery wrote "I want the order, I can't collect it because I wasn't available" and then
// "Please reschedule my order", and got only the same "customer chasing" note as everyone else — the team's alert did not tell
// anyone that something was being asked for, and nothing happened for the rest of the day.
//
// This only decides how the TEAM is told (a separate, louder alert naming what was asked). It never changes what the customer
// is sent and never acts on the request. Deliberately generous: a false yes costs one extra, differently worded alert, a false no
// is the silence this exists to remove. Pure, so every rule is unit-tested.

export type NewRequestKind = "reschedule delivery" | "change address" | "change phone number" | "cancel" | "call me" | "still wants the order" | "refund";

const RULES: [NewRequestKind, RegExp][] = [
  ["reschedule delivery", /\b(re-?schedul\w*|re-?attempt\w*|deliver(?:y)?\s+(?:it\s+)?(?:again|tomorrow|today|on\b|by\b|after|before)|try\s+again|come\s+again|send\s+(?:it\s+)?again|ship\s+again)\b/i],
  ["change address", /\b(?:change|update|correct|fix|new|wrong)\b.{0,25}\b(?:address|adress|pincode|pin code|landmark)\b|\b(?:address|adress)\b.{0,15}\b(?:change|wrong|incorrect|update)\b/i],
  ["change phone number", /\b(?:change|update|correct|new|different)\b.{0,15}\b(?:phone|number|mobile|contact|no\.)\b|\bcall\b.{0,10}\bon\b.{0,6}\d{10}/i],
  ["cancel", /\bcancel(?:l?ation|led)?\b/i],
  ["call me", /\b(?:call me|give me a call|phone call|call back|ring me|contact me|please call|call once|raise a (?:phone )?call)\b/i],
  ["still wants the order", /\bi (?:still |really )?(?:want|need) (?:the |my |this )?(?:order|parcel|product|item|delivery)\b|\bplease (?:send|deliver)\b/i],
  ["refund", /\b(?:refund|money back|return my money)\b/i],
];

/** The first thing asked for, or null when the message reads as a chaser or a reaction. */
export function newRequestKind(message: string | null | undefined): NewRequestKind | null {
  const t = (message ?? "").replace(/[‘’]/g, "'").trim();
  if (t.length < 4) return null;
  for (const [kind, re] of RULES) if (re.test(t)) return kind;
  return null;
}
