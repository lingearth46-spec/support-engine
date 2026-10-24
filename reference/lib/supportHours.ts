// When the support bot is allowed to auto-reply.
//
// Split out so the boundary check can be tested without a clock, a database or
// a channel — mirrors istDay/istDayStartUtc in lib/adsDigest.ts, which do the
// same IST-offset trick for day boundaries rather than time-of-day.
//
// Hour granularity only. The business runs 11 AM to 7 PM, not 11:00:00 to
// 19:00:00 to the second, and a boundary check precise to the minute would
// invite bugs precise to the minute nobody asked for.

const IST_OFFSET_MIN = 330;

export const SUPPORT_HOURS_START = 11; // 11:00 AM IST
export const SUPPORT_HOURS_END = 19;   // 7:00 PM IST — the hour it stops, not the last hour it runs

// Sunday is the one day the support desk is dark. Public holidays are
// deliberately NOT modelled — the founder works them, and a holiday table would
// need maintaining every year to stay honest (Batch 2 P0 safety fix).
const IST_SUNDAY = 0;

export const OUT_OF_HOURS_MESSAGE =
  "Thanks for reaching out! Our support team is available Monday to Saturday, " +
  "11:00 AM to 7:00 PM IST.";

/** The wording before 2026-10-09, which promised a reply at opening. Still matched when looking for a notice already sent. */
export const OUT_OF_HOURS_MESSAGE_LEGACY =
  "Thanks for reaching out! Our support team is available Monday to Saturday, " +
  "11:00 AM to 7:00 PM IST. We'll get back to you as soon as we're open again.";

/** The current hour in IST, 0-23. */
export function istHourNow(now: Date = new Date()): number {
  const shifted = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  return shifted.getUTCHours();
}

/** The current day of week in IST, 0 = Sunday — same +330-min shift as
 *  istHourNow, then getUTCDay() so the boundary is correct across the date
 *  line (Sunday 1 AM IST is still Saturday in UTC). */
export function istDayNow(now: Date = new Date()): number {
  const shifted = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  return shifted.getUTCDay();
}

export function isWithinSupportHours(now: Date = new Date()): boolean {
  if (istDayNow(now) === IST_SUNDAY) return false;
  const hour = istHourNow(now);
  return hour >= SUPPORT_HOURS_START && hour < SUPPORT_HOURS_END;
}

/**
 * When a message sent at `t` starts to count as waiting: `t` itself inside support hours, otherwise the next opening (11:00 IST on the next
 * day that is not a Sunday). A message sent at 2 AM is not "slow" at 11:00 for having waited the night — nobody was meant to answer it.
 * Used by the Bot tab's reply-delay counter (lib/botMetrics.ts).
 */
export function waitingStartsAt(t: Date): Date {
  if (isWithinSupportHours(t)) return t;
  const shifted = new Date(t.getTime() + IST_OFFSET_MIN * 60_000);
  // Midnight IST of that day, expressed as a UTC instant.
  const dayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST_OFFSET_MIN * 60_000;
  const todayOpen = new Date(dayStart + SUPPORT_HOURS_START * 3_600_000);
  // Before today's opening and today is a working day: today's opening. Otherwise step to the next working day's opening.
  let open = todayOpen;
  if (t.getTime() >= todayOpen.getTime() || istDayNow(todayOpen) === IST_SUNDAY) open = new Date(todayOpen.getTime() + 86_400_000);
  while (istDayNow(open) === IST_SUNDAY) open = new Date(open.getTime() + 86_400_000);
  return open;
}
