// Run with `npm run test:courier-candidates`.
import { evaluateDelhiveryCandidate, byStalest, byPriorityThenStalest, promisedDay, istDate, type GuardContext, type OrderFacts, type TrackFacts } from "./candidates";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

const NOW = Date.parse("2026-10-17T00:00:00Z"); // 05:30 IST on 17 Oct
const order = (o: Partial<OrderFacts> = {}): OrderFacts => ({ id: "AJUKI1", awb: "6000", status: "shipped", ndrReason: null, pendingCourierEdit: false, ...o });
const track = (t: Partial<TrackFacts> = {}): TrackFacts => ({ status: "In Transit", statusType: "UD", statusCode: "X-PPOM", promisedDate: "2026-10-11T23:59:00", statusDateTime: "2026-10-12 10:00:00", ...t });
const ctx = (c: Partial<GuardContext> = {}): GuardContext => ({
  openTicketAwbs: new Set(), activeRequestAwbs: new Set(), unverifiedNdrOrderIds: new Set(), ndrCodes: new Set(["EOD-104", "EOD-11"]), maxedCodes: new Set(["ST-108"]), ...c,
});
const why = (v: ReturnType<typeof evaluateDelhiveryCandidate>) => (v.ok ? "OK" : v.why);

eq("promised date long passed → eligible", evaluateDelhiveryCandidate(order(), track(), ctx(), NOW).ok, true);
{
  const v = evaluateDelhiveryCandidate(order(), track(), ctx(), NOW);
  eq("…6 days late, last scan stored as an instant", v.ok && [v.daysLate, v.lastScanAt], [6, "2026-10-12T04:30:00.000Z"]);
}
eq("promised today → NOT late yet", why(evaluateDelhiveryCandidate(order(), track({ promisedDate: "2026-10-17" }), ctx(), NOW)), "promised date 2026-10-17 has not passed");
eq("promised tomorrow → not late", evaluateDelhiveryCandidate(order(), track({ promisedDate: "2026-10-18" }), ctx(), NOW).ok, false);
eq("promised yesterday (IST) → late", evaluateDelhiveryCandidate(order(), track({ promisedDate: "2026-10-16" }), ctx(), NOW).ok, true);
eq("IST rollover: 18:30 UTC on the 16th is already the 17th in IST", evaluateDelhiveryCandidate(order(), track({ promisedDate: "2026-10-16" }), ctx(), Date.parse("2026-10-16T18:30:00Z")).ok, true);
eq("no promised date → skipped, never guessed", why(evaluateDelhiveryCandidate(order(), track({ promisedDate: null }), ctx(), NOW)), "Delhivery gave no promised date");
eq("no tracking → skipped", why(evaluateDelhiveryCandidate(order(), null, ctx(), NOW)), "no live tracking answer");

for (const s of ["delivered", "rto", "returned", "cancelled", "wa_cancelled", "undelivered"]) {
  eq(`order ${s} → skipped`, evaluateDelhiveryCandidate(order({ status: s }), track(), ctx(), NOW).ok, false);
}
eq("failed delivery open (ndr_reason) → NDR owns it", evaluateDelhiveryCandidate(order({ ndrReason: "Customer not available" }), track(), ctx(), NOW).ok, false);
eq("pending courier edit → skipped", evaluateDelhiveryCandidate(order({ pendingCourierEdit: true }), track(), ctx(), NOW).ok, false);
eq("unverified NDR request → skipped", evaluateDelhiveryCandidate(order(), track(), ctx({ unverifiedNdrOrderIds: new Set(["AJUKI1"]) }), NOW).ok, false);
eq("open ticket exists → skipped", why(evaluateDelhiveryCandidate(order(), track(), ctx({ openTicketAwbs: new Set(["6000"]) }), NOW)), "an open ticket already exists");
eq("active request exists → skipped", evaluateDelhiveryCandidate(order(), track(), ctx({ activeRequestAwbs: new Set(["6000"]) }), NOW).ok, false);
eq("consignee-to-collect scan → customer side", why(evaluateDelhiveryCandidate(order(), track({ instructions: "Consignee to collect from branch" }), ctx(), NOW)), "waiting on the customer, not a courier delay");
eq("NDR status code → customer side", evaluateDelhiveryCandidate(order(), track({ statusCode: "EOD-104" }), ctx(), NOW).ok, false);
eq("max attempts (ST-108) → chase the KAM, not a ticket", evaluateDelhiveryCandidate(order(), track({ statusCode: "ST-108" }), ctx(), NOW).ok, false);
eq("delivered by tracking though order not updated → skipped", evaluateDelhiveryCandidate(order(), track({ status: "Delivered", statusType: "DL" }), ctx(), NOW).ok, false);
eq("RTO by tracking → skipped", evaluateDelhiveryCandidate(order(), track({ statusType: "RT" }), ctx(), NOW).ok, false);
eq("out for delivery → skipped", evaluateDelhiveryCandidate(order(), track({ status: "Out for delivery" }), ctx(), NOW).ok, false);

eq("promisedDay parses with or without a time", [promisedDay("2026-10-11T23:59:00"), promisedDay("2026-10-11"), promisedDay("soon"), promisedDay(null)], ["2026-10-11", "2026-10-11", null, null]);
eq("istDate", istDate(Date.parse("2026-10-16T19:00:00Z")), "2026-10-17");
eq("stalest first, then most days late", byStalest([
  { id: "a", lastScanAt: "2026-10-14T00:00:00Z", daysLate: 2 }, { id: "b", lastScanAt: "2026-10-10T00:00:00Z", daysLate: 3 }, { id: "c", lastScanAt: "2026-10-10T00:00:00Z", daysLate: 9 },
]).map((x) => (x as { id: string }).id), ["c", "b", "a"]);

// 18 Oct: the send order when the nightly cap is shared with the late-delivery agent's requests.
{
  const row = (id: string, priority: number | null | undefined, lastScanAt: string | null, daysLate: number) => ({ id, priority, lastScanAt, daysLate });
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);
  eq("a disputed attempt, then a stalled parcel, then the rest; the stalest first inside each", ids(byPriorityThenStalest([
    row("plain-old", null, "2026-10-01T00:00:00Z", 9), row("delay-new", 2, "2026-10-14T00:00:00Z", 2), row("stalled-b", 1, "2026-10-12T00:00:00Z", 3), row("dispute-new", 0, "2026-10-16T00:00:00Z", 1),
    row("stalled-a", 1, "2026-10-10T00:00:00Z", 6), row("dispute-old", 0, "2026-10-13T00:00:00Z", 1),
  ])), ["dispute-old", "dispute-new", "stalled-a", "stalled-b", "plain-old", "delay-new"]);
  eq("a missing, null or unknown priority counts as a plain delay", ids(byPriorityThenStalest([row("x", undefined, "2026-10-02T00:00:00Z", 1), row("y", 7, "2026-10-01T00:00:00Z", 1), row("z", 1, "2026-10-09T00:00:00Z", 1)])), ["z", "y", "x"]);
  eq("nothing in, nothing out; one in, one out", [byPriorityThenStalest([]).length, ids(byPriorityThenStalest([row("only", 0, null, 0)]))], [0, ["only"]]);
  const rows = [row("a", 2, "2026-10-01T00:00:00Z", 5), row("b", 0, "2026-10-15T00:00:00Z", 1)];
  const before = JSON.stringify(rows); byPriorityThenStalest(rows);
  eq("the input is not reordered in place", JSON.stringify(rows), before);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
