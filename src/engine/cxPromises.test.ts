import { isMissingTable, promiseDueAt } from "@engine/cxPromises";

let passed = 0, failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const a = JSON.stringify(got), e = JSON.stringify(want);
  a === e ? passed++ : (failed++, console.error(`FAIL ${label}: got ${a}, want ${e}`));
};

// isMissingTable — the "table not migrated yet, degrade silently" guard.
eq("42P01 code", isMissingTable({ code: "42P01" }), true);
eq("relation-does-not-exist message", isMissingTable({ message: 'relation "public.cx_promises" does not exist' }), true);
eq("unrelated error is real", isMissingTable({ code: "23505", message: "duplicate key" }), false);
eq("null is not missing-table", isMissingTable(null), false);

// promiseDueAt — calendar days by kind.
const T0 = new Date("2026-09-06T00:00:00Z");
eq("refund +5d", promiseDueAt("refund", T0).toISOString(), "2026-09-11T00:00:00.000Z");
eq("replacement +5d", promiseDueAt("replacement", T0).toISOString(), "2026-09-11T00:00:00.000Z");
eq("pickup +3d", promiseDueAt("pickup", T0).toISOString(), "2026-09-09T00:00:00.000Z");
eq("callback +1d", promiseDueAt("callback", T0).toISOString(), "2026-09-07T00:00:00.000Z");
eq("other +3d", promiseDueAt("other", T0).toISOString(), "2026-09-09T00:00:00.000Z");

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
