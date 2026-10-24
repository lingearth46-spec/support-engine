// Run with `npx tsx lib/deliveryMovement.test.ts`. The proactive movement update decision: every rule, no IO.
import assert from "node:assert/strict";
import { decideMovement, updateText, MOVEMENT_MAX_UPDATES, MOVEMENT_MIN_GAP_HOURS, MOVEMENT_SAME_STAGE_HOURS, UPDATE_TEMPLATE, UPDATE_TEMPLATE_BODY, UPDATE_TEMPLATE_EXAMPLE, COVERED_BY_LIFECYCLE, type MovementInput } from "@/lib/deliveryMovement";
import { buildTimeline, type DeliveryScan } from "@/lib/deliveryCaseState";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

const NOW = Date.parse("2026-10-18T09:00:00Z");
const H = 3_600_000;
const ago = (h: number) => new Date(NOW - h * H).toISOString();
const scan = (h: number, event: string): DeliveryScan => ({ event, raw_status: event, remark: null, location: "Hub", scanned_at: ago(h) });
const tl = (scans: DeliveryScan[], status: string | null = "shipped") => buildTimeline(scans, NOW, status);
const input = (over: Partial<MovementInput> & { scans?: DeliveryScan[]; orderStatus?: string | null }): MovementInput => {
  const { scans, orderStatus, ...rest } = over;
  return { c: { lastScanAt: NOW - 30 * H, meta: { lastEvent: "in_transit", updatesSent: 0, lastUpdateAt: null } }, timeline: tl(scans ?? [scan(30, "in_transit"), scan(2, "at_facility")], orderStatus ?? "shipped"), orderId: "AJUKI1", now: NOW, windowOpen: true, optedOut: false, ...rest };
};

// ── a send ──
{
  const d = decideMovement(input({}));
  ok("a new scan at a new stage is told", d.kind === "send");
  if (d.kind === "send") {
    eq("the line is D1, in words, with the tracking page, and no phone number", [d.replyId, d.text], ["D1", "Update on your order AJUKI1: the latest status is in transit. We are working to get it to you as soon as possible. You can follow it at www.ajuki.in/track."]);
    eq("free text inside the 24 hour window; the template after it", [d.viaTemplate, decideMovement(input({ windowOpen: false })).kind === "send" && (decideMovement(input({ windowOpen: false })) as { viaTemplate: boolean }).viaTemplate], [false, true]);
    eq("the template and its two variables, neither first nor last in the body", [d.template.name, d.template.variables], [UPDATE_TEMPLATE, ["AJUKI1", "in transit"]]);
    eq("the new baseline: the scan told, its stage, one update, the time", [d.patch.lastScanAt, d.patch.lastEvent, d.patch.updatesSent, d.patch.lastUpdateAt], [NOW - 2 * H, "at_facility", 1, NOW]);
    ok("the promise it keeps is only about movement: no time, no date promised", !/\b(today|tomorrow|by|within|hours?|days?)\b/i.test(d.text));
  }
  eq("updateText is the one place the sentence is built", updateText("A9", "in transit"), "Update on your order A9: the latest status is in transit. We are working to get it to you as soon as possible. You can follow it at www.ajuki.in/track.");
}

// ── nothing to say ──
eq("the same scan as before is a re-poll: no movement", decideMovement(input({ c: { lastScanAt: NOW - 2 * H, meta: null } })), { kind: "skip", reason: "no_movement" });
eq("a scan older than the baseline is no movement either", decideMovement(input({ c: { lastScanAt: NOW - H, meta: null } })).kind === "skip", true);
{
  const d = decideMovement(input({ c: { lastScanAt: null, meta: null } }));
  eq("first sight of the parcel: remembered, nothing sent", [d.kind, d.kind === "skip" && d.reason, d.kind === "skip" && d.baseline?.lastScanAt], ["skip", "baseline", NOW - 2 * H]);
}
eq("no scans yet", decideMovement(input({ scans: [] })), { kind: "skip", reason: "no_scans" });
eq("a customer who opted out gets nothing, and the baseline moves so it is not re-evaluated every hour", (() => { const d = decideMovement(input({ optedOut: true })); return [d.kind, d.kind === "skip" && d.reason, d.kind === "skip" && !!d.baseline]; })(), ["skip", "opted_out", true]);

// ── what the order lifecycle already says ──
eq("the stages the lifecycle covers", [...COVERED_BY_LIFECYCLE].sort(), ["failed_attempt", "on_hold", "out_for_delivery"]);
for (const [stage, why] of [["out_for_delivery", "order_out_for_delivery"], ["failed_attempt", "delivery_attempt_failed_v2"], ["on_hold", "a hold"]] as const) {
  const d = decideMovement(input({ scans: [scan(30, "in_transit"), scan(1, stage)] }));
  eq(`${stage} (${why}): the baseline moves, nothing is sent`, [d.kind, d.kind === "skip" && d.reason, d.kind === "skip" && d.baseline?.lastEvent], ["skip", "covered_by_lifecycle", stage]);
}
eq("delivered closes the case, sends nothing (order_delivered_v2 covers it)", decideMovement(input({ scans: [scan(30, "in_transit"), scan(1, "delivered")] })), { kind: "close", reason: "delivered" });
eq("a return to origin closes it too", decideMovement(input({ scans: [scan(30, "in_transit"), scan(1, "rto_initiated")] })), { kind: "close", reason: "returning_to_us" });
eq("an order the system marks rto closes it even if the last scan does not say so", decideMovement(input({ orderStatus: "rto" })), { kind: "close", reason: "returning_to_us" });

// ── caps and gaps ──
eq("three updates are the most one case gets", MOVEMENT_MAX_UPDATES, 3);
eq("at the cap: nothing, the baseline moves", (() => { const d = decideMovement(input({ c: { lastScanAt: NOW - 30 * H, meta: { lastEvent: "in_transit", updatesSent: 3, lastUpdateAt: NOW - 100 * H } } })); return [d.kind, d.kind === "skip" && d.reason, d.kind === "skip" && !!d.baseline]; })(), ["skip", "cap", true]);
eq("less than six hours since the last update: wait, the baseline is NOT moved (it is reconsidered after the gap)", (() => { const d = decideMovement(input({ c: { lastScanAt: NOW - 30 * H, meta: { lastEvent: "in_transit", updatesSent: 1, lastUpdateAt: NOW - 3 * H } } })); return [d.kind, d.kind === "skip" && d.reason, d.kind === "skip" && d.baseline]; })(), ["skip", "too_soon", undefined]);
eq("the gap and the same-stage hold", [MOVEMENT_MIN_GAP_HOURS, MOVEMENT_SAME_STAGE_HOURS], [6, 12]);
{
  const sameStageScans = [scan(30, "in_transit"), scan(2, "in_transit")];
  const held = decideMovement(input({ scans: sameStageScans, c: { lastScanAt: NOW - 30 * H, meta: { lastEvent: "in_transit", updatesSent: 1, lastUpdateAt: NOW - 8 * H } } }));
  eq("the same stage again within 12 hours: not told, the baseline moves", [held.kind, held.kind === "skip" && held.reason], ["skip", "same_stage"]);
  const later = decideMovement(input({ scans: sameStageScans, c: { lastScanAt: NOW - 30 * H, meta: { lastEvent: "in_transit", updatesSent: 1, lastUpdateAt: NOW - 13 * H } } }));
  // 20 Oct: the same words ("in transit") twice, six hours apart, told the customer nothing; a day must pass first.
  eq("the same words within a day: not told, and not advanced (reconsidered each hour)", [later.kind, later.kind === "skip" && later.reason, later.kind === "skip" && !!later.baseline], ["skip", "same_words", false]);
  const nextDay = decideMovement(input({ scans: sameStageScans, c: { lastScanAt: NOW - 30 * H, meta: { lastEvent: "in_transit", updatesSent: 1, lastUpdateAt: NOW - 25 * H } } }));
  eq("the same words after a day is told", nextDay.kind, "send");
}
ok("a stalled parcel that moves again is exactly what this is for", (() => { const d = decideMovement(input({ scans: [scan(80, "in_transit"), scan(1, "in_transit")], c: { lastScanAt: NOW - 80 * H, meta: { lastEvent: "in_transit", updatesSent: 0, lastUpdateAt: null } } })); return d.kind === "send"; })());

// ── the template says the same words as the free text, and obeys Meta's rules ──
{
  const [a, b] = UPDATE_TEMPLATE_EXAMPLE;
  eq("the template body rendered with its two variables is exactly the free text", UPDATE_TEMPLATE_BODY.replace("{{1}}", a).replace("{{2}}", b), updateText(a, b));
  ok("neither variable is the first or the last thing in the body (Meta refuses that)", !/^\s*\{\{/.test(UPDATE_TEMPLATE_BODY) && !/\{\{\d+\}\}\s*[.!?]?\s*$/.test(UPDATE_TEMPLATE_BODY));
  eq("exactly two variables, in order", [...UPDATE_TEMPLATE_BODY.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]), ["1", "2"]);
  ok("no newline or tab in an example value, and the body is plain English", !/[\n\t]/.test(UPDATE_TEMPLATE_EXAMPLE.join("")) && /^[\x20-\x7E]+$/.test(UPDATE_TEMPLATE_BODY));
  ok("it names the tracking page as www.ajuki.in/track, like every approved line", /www\.ajuki\.in\/track/.test(UPDATE_TEMPLATE_BODY));
}

console.log(`deliveryMovement: ${passed} assertions passed`);
