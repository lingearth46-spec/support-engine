// Telling a note someone wrote from a note the system stamped.
//
// admin_notes is one text column doing two jobs. A human types "Escalate this to
// the courier" — an open task, and the reason a single view of notes is worth
// having. The combine route appends its own bookkeeping to the same column:
//
//   admin_notes: [primary.admin_notes, mergeNote].filter(Boolean).join("\n")
//
// so the two live in one string, separated by newlines, and an order can carry
// both. Listing them together unsorted is how a three-week-old "escalate this"
// ends up buried under a stack of "Merged into #…" lines that need no action —
// which is exactly what had happened to AJUKI710043.
//
// The split is per line, never per note, because of that join.

/**
 * Lines written by us rather than by a person.
 *
 * Deliberately anchored and exact. A loose match here silently reclassifies a
 * real task as bookkeeping and hides it from the only list that would have
 * surfaced it, so anything unrecognised is treated as human — the safe way to be
 * wrong. Both patterns mirror app/api/admin/orders/combine/route.ts; if that
 * route's wording changes, these have to change with it.
 */
const SYSTEM_NOTE_PATTERNS: RegExp[] = [
  // `Combined with #AJUKI710047, #AJUKI0001 on 2026-07-26.`
  /^combined with (?:#\S+)(?:,\s*#\S+)* on \d{4}-\d{2}-\d{2}\.$/i,
  // `Merged into #AJUKI710038.`
  /^merged into #\S+\.$/i,
  // A bulk NDR-eligibility sweep (10-11 Aug) wrote a boilerplate line to every
  // undelivered order it checked, whether or not there was anything to do —
  // ~30 of them, each turning into an open, unactioned ticket alongside real
  // customer complaints. Only the two closed-loop endings are matched: a
  // queued reattempt with nothing left to decide, and a status the customer
  // already resolved themselves. A line ending "Needs a call" or "Needs a
  // look" is a real task and must NOT match — same anchored-and-exact
  // discipline as the two patterns above, for the same reason.
  //
  // `[2026-08-11] Delhivery reattempt requested via NDR Package Action API
  // (live tracking confirmed eligible status EOD-11). Request UPL... accepted
  // (queued). Not yet confirmed complete — async action, re-check tracking
  // before assuming it worked.`
  /^\[\d{4}-\d{2}-\d{2}\] delhivery reattempt requested via ndr package action api \(.*re-check tracking before assuming it worked\.$/i,
  // `[2026-08-11] Delhivery reattempt NOT requested — live tracking shows
  // "Delivery Rescheduled by Customer" (EOD-3), due today 2026-08-11. Customer
  // already rescheduled it themselves; nothing to do.`
  /^\[\d{4}-\d{2}-\d{2}\] delhivery reattempt not requested( again)? — .*nothing to do\.$/i,
  // The Shiprocket path's receipt, and the single commonest line in the column:
  // 40 of 107 on 15 Aug 2026. It records that the nightly cron asked and what
  // the status was at the time. There is no verdict in it and nothing left
  // outstanding, so it is a log entry that had been manufacturing a ticket every
  // night. Anchored at both ends: a line that opens the same way and ends with a
  // verdict is not this.
  //
  // `NDR reattempt requested 2026-08-14 — live status was "Pending" (ST-108).`
  /^ndr reattempt requested \d{4}-\d{2}-\d{2} — live status was ".*"(\s*\([^)]*\))?\.$/i,
];

/**
 * Lines the courier crons write when they could *not* settle something.
 *
 * Not system notes: every one of these is a real job. "a genuine refusal. Needs
 * a call", "Needs a look, not a reattempt", "tried twice, both failed", "no
 * longer trackable", and the one that noticed we had marked a parcel undelivered
 * before the courier ever attempted it. They are the most useful thing the
 * nightly run produces, because they are exactly the cases automation gave up
 * on.
 *
 * They are separated from typed notes only so the queue can put them in their
 * own lane. Eleven of them arriving overnight, mixed into the same list as a
 * customer complaint somebody wrote by hand, is how both stop being read.
 */
const COURIER_NOTE_PATTERNS: RegExp[] = [
  // `[2026-08-11] Delhivery reattempt NOT requested — live tracking shows "…"`
  // `[2026-08-11] Delhivery reattempt NOT requested again — still "…"`
  /^\[\d{4}-\d{2}-\d{2}\] delhivery reattempt not requested( again)? [—-]/i,
  // `[2026-08-09] Delhivery-style Shadowfax reattempt (reopen_ndr) tried twice …`
  /^\[\d{4}-\d{2}-\d{2}\] delhivery-style \w+ reattempt /i,
  // `[2026-08-12] Shadowfax now answers "…" for SF… — no longer trackable …`
  /^\[\d{4}-\d{2}-\d{2}\] \w+ now answers /i,
];

export type NoteLine = { text: string; system: boolean };

/** Is this single line one of ours? Blank lines count as neither. */
export function isSystemNoteLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return SYSTEM_NOTE_PATTERNS.some((re) => re.test(t));
}

/** A courier cron reporting something it could not finish. */
export function isCourierNoteLine(line: string): boolean {
  const t = line.trim();
  if (!t || isSystemNoteLine(t)) return false;
  return COURIER_NOTE_PATTERNS.some((re) => re.test(t));
}

/**
 * Everything a person still has to deal with here came from a courier cron.
 *
 * False when there is nothing to deal with at all, and false the moment one
 * typed line is mixed in: an order carrying both a cron report and someone's
 * own note belongs in the main queue, where the typed line will be read.
 */
export function isCourierOnlyNote(note: string | null | undefined): boolean {
  const outstanding = splitNote(note).filter((l) => !l.system);
  return outstanding.length > 0 && outstanding.every((l) => isCourierNoteLine(l.text));
}

/** A note broken into its lines, each marked as written or stamped. */
export function splitNote(note: string | null | undefined): NoteLine[] {
  return (note ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text) => ({ text, system: isSystemNoteLine(text) }));
}

/** Just the lines a person wrote, rejoined. Empty when the note is all ours. */
export function humanNote(note: string | null | undefined): string {
  return splitNote(note).filter((l) => !l.system).map((l) => l.text).join("\n");
}

/**
 * Does this order carry something a person still has to deal with?
 *
 * The question the notes list is really sorted by: an order whose note is purely
 * a merge record needs nobody's attention, and one with a typed line probably
 * does.
 */
export function hasHumanNote(note: string | null | undefined): boolean {
  return splitNote(note).some((l) => !l.system);
}

/** Any note at all, of either kind. */
export function hasNote(note: string | null | undefined): boolean {
  return splitNote(note).length > 0;
}

/** Whole days since `iso`, or null if it is unusable. Used to age a task. */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}
