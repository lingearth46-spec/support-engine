// The support-hours boundary — hour-precise, IST, and correct across the UTC
// date line (11 PM IST is still "today" in India while UTC has already moved
// on, same trap istDay.test.ts exists to catch for day boundaries).

import { isWithinSupportHours, istHourNow, istDayNow, SUPPORT_HOURS_START, SUPPORT_HOURS_END, waitingStartsAt } from "./supportHours";

let passed = 0;
let failed = 0;
const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual === expected) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
};

eq("hours start at 11", SUPPORT_HOURS_START, 11);
eq("hours end at 19 (7 PM)", SUPPORT_HOURS_END, 19);

// 11:00 AM IST = 05:30 UTC
eq("just before opening (10:59 IST) is outside", isWithinSupportHours(new Date("2026-08-04T05:29:00Z")), false);
eq("opening instant (11:00 IST) is within", isWithinSupportHours(new Date("2026-08-04T05:30:00Z")), true);

// 3:00 PM IST = 09:30 UTC
eq("mid-afternoon (3 PM IST) is within", isWithinSupportHours(new Date("2026-08-04T09:30:00Z")), true);

// 7:00 PM IST = 13:30 UTC
eq("last minute before closing (6:59 PM IST) is within", isWithinSupportHours(new Date("2026-08-04T13:29:00Z")), true);
eq("closing instant (7:00 PM IST) is outside", isWithinSupportHours(new Date("2026-08-04T13:30:00Z")), false);

// 11:00 PM IST = 17:30 UTC
eq("late night (11 PM IST) is outside", isWithinSupportHours(new Date("2026-08-04T17:30:00Z")), false);

// Midnight IST is 18:30 UTC the day before — the boundary that trips a naive
// UTC-hour check, same one istDay's tests exist for.
eq("midnight IST, already tomorrow in UTC-hour terms, is outside", isWithinSupportHours(new Date("2026-08-04T18:30:00Z")), false);
eq("istHourNow reads midnight correctly across the date line", istHourNow(new Date("2026-08-04T18:30:00Z")), 0);

// Sunday is closed all day, even at 3 PM IST — 2026-08-02 is a Sunday, the day
// before the Monday before the Tuesday (2026-08-04) every test above relies on.
// 09:30 UTC = 15:00 IST, squarely inside 11–19.
eq("Sunday mid-afternoon (3 PM IST) is outside — closed all day", isWithinSupportHours(new Date("2026-08-02T09:30:00Z")), false);
eq("Saturday mid-afternoon (3 PM IST) is still within", isWithinSupportHours(new Date("2026-08-01T09:30:00Z")), true);
eq("Tuesday mid-afternoon (3 PM IST) unchanged — still within", isWithinSupportHours(new Date("2026-08-04T09:30:00Z")), true);
eq("istDayNow reads Sunday as 0", istDayNow(new Date("2026-08-02T09:30:00Z")), 0);
// Sunday 1 AM IST = Saturday 19:30 UTC — the day-line trap: a naive getUTCDay()
// on the raw instant would read Saturday (6) and wrongly open the desk.
eq("Sunday 1 AM IST (Saturday in raw UTC) still reads Sunday", istDayNow(new Date("2026-08-01T19:30:00Z")), 0);


// waitingStartsAt: when a message starts to count as waiting.
const w = (iso: string) => waitingStartsAt(new Date(iso)).toISOString();
eq("inside hours: the message's own time", w("2026-10-06T07:00:00Z"), "2026-10-06T07:00:00.000Z");
eq("2 AM IST Tuesday: that day's 11:00 IST", w("2026-10-05T20:30:00Z"), "2026-10-06T05:30:00.000Z");
eq("8 PM IST Tuesday: Wednesday 11:00 IST", w("2026-10-06T14:30:00Z"), "2026-10-07T05:30:00.000Z");
eq("8 PM IST Saturday: skips Sunday, Monday 11:00 IST", w("2026-10-10T14:30:00Z"), "2026-10-12T05:30:00.000Z");
eq("a Sunday noon: Monday 11:00 IST", w("2026-10-11T06:30:00Z"), "2026-10-12T05:30:00.000Z");
eq("exactly 19:00 IST is after hours", w("2026-10-06T13:30:00Z"), "2026-10-07T05:30:00.000Z");
eq("exactly 11:00 IST is open", w("2026-10-06T05:30:00Z"), "2026-10-06T05:30:00.000Z");

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
