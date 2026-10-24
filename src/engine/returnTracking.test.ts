// Where a collection is, and when someone needs to hear.
//
// Two ways to get this wrong, both expensive. Stay silent and an exchange never
// ships, because nobody learns the returned item arrived. Shout every hour and
// the alerts get muted, which is the same outcome a week later.

import {
  shadowfaxReverseStage, delhiveryReverseStage, advanceTracking,
  NOT_COLLECTED_HOURS, NO_MOVEMENT_HOURS, type PickupTracking,
} from "@engine/returnTracking";

let passed = 0;
let failed = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else { failed++; console.error(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

const H = 3_600_000;
const NOW = new Date("2026-09-13T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * H).toISOString();

// ── Shadowfax ────────────────────────────────────────────────────────────────
eq("sfx New", shadowfaxReverseStage("New"), "scheduled");
eq("sfx Out For Pickup", shadowfaxReverseStage("Out For Pickup"), "out_for_pickup");
eq("sfx Picked", shadowfaxReverseStage("Picked"), "picked_up");
// "Received" means the HUB got it, not us — treating it as delivered would ship
// an exchange replacement for an item still in a Shadowfax facility.
eq("sfx Received is NOT back with us", shadowfaxReverseStage("Received"), "in_transit");
eq("sfx Returned To Client is", shadowfaxReverseStage("Returned To Client"), "delivered");
eq("sfx Not Contactable", shadowfaxReverseStage("Not Contactable"), "attempt_failed");
eq("sfx Lost", shadowfaxReverseStage("Lost"), "exception");
eq("sfx unknown wording", shadowfaxReverseStage("Something New"), null);

// ── Delhivery (shapes observed live 2026-09-13) ───────────────────────────────
eq("dlv Scheduled PP", delhiveryReverseStage({ status: "Scheduled", statusType: "PP" }), "scheduled");
eq("dlv In Transit PU", delhiveryReverseStage({ status: "In Transit", statusType: "PU" }), "in_transit");
eq("dlv delivered DL", delhiveryReverseStage({ status: "Delivered", statusType: "DL" }), "delivered");
eq("dlv cancelled CN", delhiveryReverseStage({ status: "Pickup Cancelled", statusType: "CN" }), "cancelled");
eq("dlv failed attempt", delhiveryReverseStage({ status: "Not Picked", statusType: "PP" }), "attempt_failed");

// ── Alerts ───────────────────────────────────────────────────────────────────
{
  const { tracking, alerts } = advanceTracking(null, { stage: "scheduled", raw: "New" }, ago(1), NOW);
  eq("a fresh booking says nothing", alerts, []);
  eq("and starts its clock now", tracking.changed_at, NOW.toISOString());
}

// Arrival is THE alert — for an exchange it is what ships the replacement.
{
  const prev: PickupTracking = { stage: "in_transit", raw: "In Transit", checked_at: ago(1), changed_at: ago(5), alerted: [] };
  const { tracking, alerts } = advanceTracking(prev, { stage: "delivered", raw: "Returned To Client" }, ago(80), NOW);
  eq("arrival alerts", alerts.map((a) => a.kind), ["delivered"]);
  eq("and records when", tracking.delivered_at, NOW.toISOString());

  // ...exactly once. The next hourly run must not repeat it.
  const again = advanceTracking(tracking, { stage: "delivered", raw: "Returned To Client" }, ago(80), new Date(NOW.getTime() + H));
  eq("arrival never alerts twice", again.alerts, []);
}

// Not collected: measured from booking, not from the last check.
{
  const prev: PickupTracking = { stage: "scheduled", raw: "New", checked_at: ago(1), changed_at: ago(NOT_COLLECTED_HOURS + 5), alerted: [] };
  const { alerts } = advanceTracking(prev, { stage: "scheduled", raw: "New" }, ago(NOT_COLLECTED_HOURS + 5), NOW);
  eq("uncollected past the limit alerts", alerts.map((a) => a.kind), ["not_collected"]);
}
{
  const { alerts } = advanceTracking(null, { stage: "scheduled", raw: "New" }, ago(NOT_COLLECTED_HOURS - 5), NOW);
  eq("uncollected inside the limit is quiet", alerts, []);
}

// THE BUG THIS WAS WRITTEN TO AVOID. A parcel in transit gets scan after scan
// while its stage stays in_transit. Measuring from the stage change would call
// an ordinary journey stuck; a new scan must reset the clock.
{
  const prev: PickupTracking = {
    stage: "in_transit", raw: "In Transit · Vehicle Departed · Indore", checked_at: ago(1),
    changed_at: ago(NO_MOVEMENT_HOURS + 10), alerted: [],
  };
  const moved = advanceTracking(prev, { stage: "in_transit", raw: "In Transit · Shipment Received · Mumbai" }, ago(100), NOW);
  eq("a new scan is movement, even at the same stage", moved.alerts, []);
  eq("and resets the clock", moved.tracking.changed_at, NOW.toISOString());

  const still = advanceTracking(prev, { stage: "in_transit", raw: "In Transit · Vehicle Departed · Indore" }, ago(100), NOW);
  eq("the same scan for 72h+ is stuck", still.alerts.map((a) => a.kind), ["no_movement"]);
}

// A failed attempt alerts per distinct failure, not every hour.
{
  const first = advanceTracking(null, { stage: "attempt_failed", raw: "Cid" }, ago(10), NOW);
  eq("first failure alerts", first.alerts.map((a) => a.kind), ["attempt_failed"]);
  const same = advanceTracking(first.tracking, { stage: "attempt_failed", raw: "Cid" }, ago(10), new Date(NOW.getTime() + H));
  eq("the same failure again is quiet", same.alerts, []);
  const next = advanceTracking(same.tracking, { stage: "attempt_failed", raw: "Not Contactable" }, ago(10), new Date(NOW.getTime() + 2 * H));
  eq("a different failure is news", next.alerts.map((a) => a.kind), ["attempt_failed"]);
}

// THE AJUKI710080 DUPLICATE. Same status, courier reworded the sentence.
{
  const prev: PickupTracking = {
    stage: "attempt_failed", raw: "Not Contactable · Customer not reachable · TRV_Chirayinkeezhu",
    checked_at: ago(1), changed_at: ago(1), alerted: ["attempt_failed:Not Contactable · Customer not reachable · TRV_Chirayinkeezhu"],
  };
  const reworded = advanceTracking(prev, { stage: "attempt_failed", raw: "Not Contactable · Item Customer_not_contactable at TRV_Chirayinkeezhu · TRV_Chirayinkeezhu" }, ago(10), NOW);
  eq("a reworded failure is quiet", reworded.alerts, []);

  // But the rider comes back and fails again: that is a new attempt.
  const retry = advanceTracking(reworded.tracking, { stage: "out_for_pickup", raw: "Out For Pickup · Item Out For Pickup" }, ago(10), new Date(NOW.getTime() + 20 * H));
  const again = advanceTracking(retry.tracking, { stage: "attempt_failed", raw: "Not Contactable · Customer not reachable" }, ago(10), new Date(NOW.getTime() + 24 * H));
  eq("failing again after a new attempt alerts", again.alerts.map((a) => a.kind), ["attempt_failed"]);
}

// An unrecognised status keeps the stage but still shows the courier's words.
{
  const prev: PickupTracking = { stage: "picked_up", raw: "Picked", checked_at: ago(1), changed_at: ago(2), alerted: [] };
  const { tracking } = advanceTracking(prev, { stage: null, raw: "Some New Courier Status" }, ago(10), NOW);
  eq("unknown status keeps the stage", tracking.stage, "picked_up");
  eq("but records the wording", tracking.raw, "Some New Courier Status");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
