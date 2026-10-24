// fmtIST is a fixed-table date formatter (no ICU), so it is worth pinning: the
// whole reason it exists is that toLocaleString gives "Sep" on one runtime and
// "Sept" on another, and every message body should read the same.

import { fmtIST } from "@adapters/notifier/telegram";

let passed = 0;
let failed = 0;
const eq = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${e}, got ${a}`); }
};

// 2026-09-06 09:00 UTC → 14:30 IST
eq("afternoon", fmtIST("2026-09-06T09:00:00Z"), "6 Sep, 14:30");

// Crosses midnight into the next day in IST: 2026-01-31 20:00 UTC → 01:30 on 1 Feb
eq("rolls the date and the month", fmtIST("2026-01-31T20:00:00Z"), "1 Feb, 01:30");

// Pads both fields
eq("zero-pads h and m", fmtIST("2026-03-04T00:35:00Z"), "4 Mar, 06:05");

// Accepts a Date and an epoch, same result
eq("Date arg", fmtIST(new Date("2026-12-25T12:00:00Z")), "25 Dec, 17:30");
eq("epoch arg", fmtIST(Date.parse("2026-12-25T12:00:00Z")), "25 Dec, 17:30");

// Year end
eq("Dec 31 late IST stays in Dec", fmtIST("2026-12-31T10:00:00Z"), "31 Dec, 15:30");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
