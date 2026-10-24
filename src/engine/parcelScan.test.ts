// The Delhivery / Shadowfax scan → ParcelEvent mappers, and scanContextLine.
// No database. Run with `npx tsx lib/parcelScan.test.ts`.

import {
  normalizeDelhiveryScan,
  normalizeShadowfaxScan,
  normalizeDtdcScan,
  dtdcOrderStatus,
  scanContextLine,
  scanAgeHours,
  lateParcelVerdict,
  parseScanInstant,
  SCAN_STALE_HOURS,
  AT_RISK_EVENTS,
} from "@engine/parcelScan";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { passed++; return; }
  failed++;
  console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};

// ── Delhivery ────────────────────────────────────────────────────────────────

eq("dl: delivered", normalizeDelhiveryScan({ rawStatus: "Delivered", statusType: "DL" }).event, "delivered");
eq("dl: RTO in transit", normalizeDelhiveryScan({ rawStatus: "RTO", statusType: "RT" }).event, "rto_in_transit");
eq("dl: RTO delivered back", normalizeDelhiveryScan({ rawStatus: "RTO", statusType: "DL" }).event, "rto_delivered");
eq("dl: return leg is rto whatever the string", normalizeDelhiveryScan({ rawStatus: "In Transit", statusType: "RT" }).event, "rto_in_transit");
eq("dl: manifested", normalizeDelhiveryScan({ rawStatus: "Manifested", statusType: "UD" }).event, "manifested");
eq("dl: in transit", normalizeDelhiveryScan({ rawStatus: "In Transit", statusType: "UD" }).event, "in_transit");
eq("dl: dispatched = out for delivery", normalizeDelhiveryScan({ rawStatus: "Dispatched", statusType: "UD" }).event, "out_for_delivery");
eq("dl: pending + NDR wording = failed attempt",
  normalizeDelhiveryScan({ rawStatus: "Pending", statusType: "UD", instructions: "Consignee refused to accept" }).event, "failed_attempt");
eq("dl: pending + hub scan is NOT a failed attempt",
  normalizeDelhiveryScan({ rawStatus: "Pending", statusType: "UD", instructions: "Shipment Received at Facility" }).event, "at_facility");
eq("dl: re-route wording",
  normalizeDelhiveryScan({ rawStatus: "In Transit", statusType: "UD", instructions: "Shipment is getting re-routed to your nearest hub" }).event, "rerouting");
eq("dl: pincode update",
  normalizeDelhiveryScan({ rawStatus: "In Transit", statusType: "UD", instructions: "Pin code of the destination updated to 422501" }).event, "address_updated");
eq("dl: on hold", normalizeDelhiveryScan({ rawStatus: "Pending", statusType: "UD", instructions: "Shipment on hold at origin" }).event, "on_hold");
eq("dl: location passes through",
  normalizeDelhiveryScan({ rawStatus: "In Transit", statusType: "UD", location: "Bhiwandi_Mankoli_H (Maharashtra)" }).location,
  "Bhiwandi_Mankoli_H (Maharashtra)");
eq("dl: unrecognised → unknown, raw kept",
  normalizeDelhiveryScan({ rawStatus: "Weird New Status", statusType: "XX", instructions: "" }),
  { event: "unknown", location: null, remark: null, scannedAt: null });

// ── Shadowfax ────────────────────────────────────────────────────────────────

eq("sfx: delivered", normalizeShadowfaxScan({ event: "delivered" }).event, "delivered");
eq("sfx: rts = rto in transit", normalizeShadowfaxScan({ event: "rts_intransit" }).event, "rto_in_transit");
eq("sfx: NDR event code", normalizeShadowfaxScan({ event: "nc", comments: "Customer not contactable" }).event, "failed_attempt");
eq("sfx: ofd", normalizeShadowfaxScan({ event: "ofd" }).event, "out_for_delivery");
eq("sfx: fwd hub receipt", normalizeShadowfaxScan({ event: "recd_at_fwd_hub" }).event, "at_facility");
eq("sfx: on_hold", normalizeShadowfaxScan({ event: "on_hold" }).event, "on_hold");
eq("sfx: reroute in the comment text",
  normalizeShadowfaxScan({ event: "in_transit", comments: "Shipment is getting re-routed to your nearest hub" }).event, "rerouting");
eq("sfx: picked", normalizeShadowfaxScan({ event: "picked" }).event, "picked_up");
eq("sfx: unknown event with text → in_transit fallback", normalizeShadowfaxScan({ event: "some_new_event" }).event, "in_transit");
eq("sfx: empty → unknown", normalizeShadowfaxScan({ event: "" }).event, "unknown");
eq("sfx: remark captured from comments",
  normalizeShadowfaxScan({ event: "nc", comments: "Customer not answering" }).remark, "Customer not answering");

// ── DTDC ─────────────────────────────────────────────────────────────────────
// The only confirmed real values (lib/dtdc.ts's comment on DtdcTracking.status,
// from a live probe): "pickup_awaited", "pickup_scheduled", "reachedathub".
// Everything else here is a best guess at DTDC's/Shipsy's wording, unverified
// against a real live parcel — see the doc comment on normalizeDtdcScan.

eq("dtdc: pickup awaited → manifested", normalizeDtdcScan({ status: "pickup_awaited" }).event, "manifested");
eq("dtdc: pickup scheduled → manifested", normalizeDtdcScan({ status: "pickup_scheduled" }).event, "manifested");
eq("dtdc: reachedathub (no separators) → at_facility", normalizeDtdcScan({ status: "reachedathub" }).event, "at_facility");
eq("dtdc: delivered", normalizeDtdcScan({ status: "delivered" }).event, "delivered");
eq("dtdc: out for delivery is not delivered",
  normalizeDtdcScan({ status: "out_for_delivery" }).event, "out_for_delivery");
eq("dtdc: rto in transit", normalizeDtdcScan({ status: "rto_in_transit" }).event, "rto_in_transit");
eq("dtdc: rto delivered back", normalizeDtdcScan({ status: "rto", eventType: "delivered" }).event, "rto_delivered");
eq("dtdc: a failure reason on the event outranks a vague status",
  normalizeDtdcScan({ status: "in_transit", failureReason: "consignee not available" }).event, "failed_attempt");
eq("dtdc: NDR wording without a failure_reason field still catches",
  normalizeDtdcScan({ status: "undelivered", update: "consignee refused to accept" }).event, "failed_attempt");
eq("dtdc: on hold", normalizeDtdcScan({ status: "on_hold" }).event, "on_hold");
eq("dtdc: reroute wording",
  normalizeDtdcScan({ status: "in_transit", update: "shipment re-routed to nearest hub" }).event, "rerouting");
eq("dtdc: pincode update",
  normalizeDtdcScan({ status: "in_transit", update: "pin code of the destination updated" }).event, "address_updated");
eq("dtdc: picked up", normalizeDtdcScan({ status: "picked_up" }).event, "picked_up");
// Regression, confirmed live 2026-09-29 against DTDC's own export: "Not Picked
// Up" / "Not Picked" matched /pick(ed)?\s*up/ as a substring and was read as
// the opposite of what happened — 28 of 48 real parcels were affected.
eq("dtdc: 'Not Picked Up' is NOT picked_up", normalizeDtdcScan({ status: "Not Picked Up" }).event, "manifested");
eq("dtdc: DTDC's own portal wording 'Not Picked'", normalizeDtdcScan({ status: "Not Picked" }).event, "manifested");
eq("dtdc: not-picked in the update field too", normalizeDtdcScan({ status: "pending", update: "Not Picked Up" }).event, "manifested");
eq("dtdc: plain in transit", normalizeDtdcScan({ status: "in_transit" }).event, "in_transit");
eq("dtdc: unrecognised → unknown, raw kept",
  normalizeDtdcScan({ status: "some weird new status" }),
  { event: "unknown", location: null, remark: null, scannedAt: null });
eq("dtdc: failure reason becomes the remark",
  normalizeDtdcScan({ status: "undelivered", failureReason: "office closed" }).remark, "office closed");
eq("dtdc: hub passes through as location",
  normalizeDtdcScan({ status: "in_transit", location: "Kurla West Hub" }).location, "Kurla West Hub");

// ── DTDC's order-status promotion (dtdc-tracking-sync is its only source) ────
// Narrow on purpose, matching Delhivery's own precedent: only a clear failed
// attempt moves orders.status. on_hold/rerouting/address_updated stay in
// courier_status only.

eq("dtdc status: picked up → shipped", dtdcOrderStatus("picked_up"), "shipped");
eq("dtdc status: in transit → shipped", dtdcOrderStatus("in_transit"), "shipped");
eq("dtdc status: at facility → shipped", dtdcOrderStatus("at_facility"), "shipped");
eq("dtdc status: out for delivery → shipped", dtdcOrderStatus("out_for_delivery"), "shipped");
eq("dtdc status: failed attempt → undelivered", dtdcOrderStatus("failed_attempt"), "undelivered");
eq("dtdc status: on hold does NOT move the order", dtdcOrderStatus("on_hold"), null);
eq("dtdc status: rerouting does NOT move the order", dtdcOrderStatus("rerouting"), null);
eq("dtdc status: address update does NOT move the order", dtdcOrderStatus("address_updated"), null);
eq("dtdc status: rto in transit → rto (not returned)", dtdcOrderStatus("rto_in_transit"), "rto");
eq("dtdc status: rto delivered back is still just rto", dtdcOrderStatus("rto_delivered"), "rto");
eq("dtdc status: delivered → delivered", dtdcOrderStatus("delivered"), "delivered");
eq("dtdc status: manifested is a no-op (already there)", dtdcOrderStatus("manifested"), null);
eq("dtdc status: lost does not move the order", dtdcOrderStatus("lost"), null);
eq("dtdc status: unknown does not move the order", dtdcOrderStatus("unknown"), null);

// ── At-risk set ──────────────────────────────────────────────────────────────

eq("at-risk set", [...AT_RISK_EVENTS].sort(), ["address_updated", "failed_attempt", "on_hold", "rerouting"]);

// ── scanContextLine ──────────────────────────────────────────────────────────

const NOW = new Date("2026-09-01T12:00:00Z");
eq("ctx: none when no scan", scanContextLine({ status: "shipped" }, NOW), null);
eq("ctx: none when delivered", scanContextLine({
  status: "delivered", courier_status: "delivered", courier_status_at: "2026-09-01T09:00:00Z",
}, NOW), null);
eq("ctx: hub + hours",
  scanContextLine({
    status: "shipped", courier_status: "rerouting",
    courier_status_detail: "getting re-routed to your nearest hub",
    courier_status_location: "Pune_Hub", courier_status_at: "2026-09-01T09:00:00Z",
  }, NOW),
  `last courier scan 3h ago at Pune_Hub: "getting re-routed to your nearest hub"`);
eq("ctx: days when old",
  scanContextLine({
    status: "undelivered", courier_status: "failed_attempt", courier_status_detail: "Consignee unavailable",
    courier_status_location: null, courier_status_at: "2026-08-29T12:00:00Z",
  }, NOW),
  `last courier scan 3d ago: "Consignee unavailable"`);

// ── scanAgeHours / lateParcelVerdict ─────────────────────────────────────────

eq("age: null when no scan", scanAgeHours({ courier_status: null, courier_status_at: null }, NOW), null);
eq("age: null when no timestamp", scanAgeHours({ courier_status: "in_transit", courier_status_at: null }, NOW), null);
eq("age: 3h", scanAgeHours({ courier_status: "in_transit", courier_status_at: "2026-09-01T09:00:00Z" }, NOW), 3);
eq("age: clamps negative to 0", scanAgeHours({ courier_status: "in_transit", courier_status_at: "2026-09-01T13:00:00Z" }, NOW), 0);

eq("verdict: dark with no scan", lateParcelVerdict({ courier_status: null, courier_status_at: null }, NOW), "dark");
eq("verdict: moving at 3h", lateParcelVerdict({ courier_status: "in_transit", courier_status_at: "2026-09-01T09:00:00Z" }, NOW), "moving");
eq("verdict: moving exactly at the 48h boundary",
  lateParcelVerdict({ courier_status: "in_transit", courier_status_at: "2026-08-30T12:00:00Z" }, NOW), "moving");
eq("verdict: stuck just past 48h",
  lateParcelVerdict({ courier_status: "in_transit", courier_status_at: "2026-08-30T11:00:00Z" }, NOW), "stuck");
eq("verdict: stuck at 5 days",
  lateParcelVerdict({ courier_status: "at_facility", courier_status_at: "2026-08-27T12:00:00Z" }, NOW), "stuck");
eq("verdict: attention — fresh failed_attempt",
  lateParcelVerdict({ courier_status: "failed_attempt", courier_status_at: "2026-09-01T09:00:00Z" }, NOW), "attention");
eq("verdict: attention — fresh on_hold",
  lateParcelVerdict({ courier_status: "on_hold", courier_status_at: "2026-09-01T20:00:00Z" }, NOW), "attention");
eq("verdict: a STALE failed_attempt is stuck, not attention",
  lateParcelVerdict({ courier_status: "failed_attempt", courier_status_at: "2026-08-28T00:00:00Z" }, NOW), "stuck");
eq("SCAN_STALE_HOURS is 48", SCAN_STALE_HOURS, 48);

// ── parseScanInstant ─────────────────────────────────────────────────────────

eq("instant: null on empty", parseScanInstant(""), null);
eq("instant: null on junk", parseScanInstant("not a date"), null);
eq("instant: tz-less treated as IST (Delhivery StatusDateTime)",
  parseScanInstant("2026-09-01T09:38:00"), "2026-09-01T04:08:00.000Z");
eq("instant: space-separated tz-less as IST",
  parseScanInstant("2026-09-01 09:38:00"), "2026-09-01T04:08:00.000Z");
eq("instant: explicit Z kept (Shadowfax created)",
  parseScanInstant("2026-08-27T05:57:29Z"), "2026-08-27T05:57:29.000Z");
eq("instant: explicit offset kept",
  parseScanInstant("2026-09-01T16:31:51.611+05:30"), "2026-09-01T11:01:51.611Z");

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
