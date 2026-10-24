// Run with `npx tsx lib/deliveryTicketRequest.test.ts`. The ticket request builder: every guard of the contract, with no IO.
import assert from "node:assert/strict";
import {
  buildTicketRequest, delayDescription, disputeDescription, DLV_DELAY, DLV_DISPUTE, DESCRIPTION_MAX, PRIORITY, REQUEST_WINDOW_DAYS,
  type TicketOrder, type TicketCtx, type TicketLive,
} from "@late/deliveryTicketRequest";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

const NOW = Date.parse("2026-10-18T09:00:00Z");
const NDR = new Set(["EOD-11", "EOD-6", "EOD-74"]);
const MAXED = new Set(["EOD-999"]);
const ctx = (over: Partial<TicketCtx> = {}): TicketCtx => ({ now: NOW, openTicketAwbs: new Set(), activeRequestAwbs: new Set(), recentRequests: new Set(), ndrCodes: NDR, maxedCodes: MAXED, ...over });
const dlv = (over: Partial<TicketOrder> = {}): TicketOrder => ({ id: "AJUKI710036", awb: "60000000000007", courierName: "Delhivery", shiprocketOrderId: null, status: "undelivered", adminNotes: "", ...over });
const sfx = (over: Partial<TicketOrder> = {}): TicketOrder => ({ id: "AJUKI710015", awb: "SF00000000013", courierName: "Shadowfax", shiprocketOrderId: null, status: "undelivered", adminNotes: "", ...over });
const track = (over: Record<string, unknown> = {}) => ({ status: "Pending", statusType: "UD", statusCode: "DTUP-203", statusDateTime: "2026-10-15T22:34:10.438", promisedDate: "2026-10-15T23:59:59", ...over });
const liveD = (t: ReturnType<typeof track> | null): TicketLive => ({ delhivery: t as never, shadowfaxStatus: null });
const liveS = (s: string | null): TicketLive => ({ delhivery: null, shadowfaxStatus: s });
const refusal = (b: ReturnType<typeof buildTicketRequest>) => (b.ok ? null : { to: b.to, reason: b.reason });

// ── Delhivery: a stalled parcel is judged by Delhivery's state, not by our `undelivered` ──────────────────────────────────────────────
{
  const b = buildTicketRequest(dlv(), { trigger: "stalled", caseId: "7" }, liveD(track()), ctx());
  ok("AJUKI710036: undelivered on our side, In Transit at Delhivery, promised date passed: a request", b.ok);
  if (b.ok) {
    const r = b.request;
    eq("kind, courier, source, priority, case", [r.kind, r.courier, r.source, r.priority, r.caseId], ["stalled", "delhivery", "delivery_agent", 1, "7"]);
    eq("the delay category pair", [r.ticket.category, r.ticket.subCategory], [DLV_DELAY.category, DLV_DELAY.subCategory]);
    ok("the text names the promised day and the last scan, and asks for a call first", /\(15 Oct\)/.test(r.ticket.description!) && /DTUP-203 on 15 Oct/.test(r.ticket.description!) && /call to the consignee first/.test(r.ticket.description!));
    ok("within the portal's 300 characters", r.ticket.description!.length <= DESCRIPTION_MAX);
    eq("evidence: days late and the scan", [r.evidence.daysLate, r.evidence.promisedDate, r.evidence.lastScanAt?.slice(0, 10), r.evidence.fellBackFromDispute], [3, "2026-10-15", "2026-10-15", false]);
  }
}
eq("a plain delay has the lowest priority", buildTicketRequest(dlv(), { trigger: "delay" }, liveD(track()), ctx()).ok && (buildTicketRequest(dlv(), { trigger: "delay" }, liveD(track()), ctx()) as { ok: true; request: { priority: number } }).request.priority, 2);
eq("priorities: dispute, stall, delay", [PRIORITY.disputed_attempt, PRIORITY.stalled, PRIORITY.delay], [0, 1, 2]);
eq("promised date not yet passed: wait", refusal(buildTicketRequest(dlv(), { trigger: "stalled" }, liveD(track({ promisedDate: "2026-10-18T23:59:59" })), ctx()))?.to, "wait");
eq("no promised date from Delhivery: a person", refusal(buildTicketRequest(dlv(), { trigger: "stalled" }, liveD(track({ promisedDate: null })), ctx()))?.to, "person");
eq("out for delivery today: wait", refusal(buildTicketRequest(dlv(), { trigger: "stalled" }, liveD(track({ status: "Out for delivery", statusCode: "X" })), ctx()))?.to, "wait");
eq("Delhivery shows delivered: nothing to do", refusal(buildTicketRequest(dlv(), { trigger: "stalled" }, liveD(track({ status: "Delivered", statusType: "DL" })), ctx()))?.to, "none");
eq("Delhivery shows a return: nothing to do", refusal(buildTicketRequest(dlv(), { trigger: "stalled" }, liveD(track({ statusType: "RT" })), ctx()))?.to, "none");
eq("a failed attempt that waits on the customer is not a courier delay: a person", refusal(buildTicketRequest(dlv(), { trigger: "stalled" }, liveD(track({ statusCode: "EOD-11", status: "Consignee Unavailable" })), ctx()))?.to, "person");
eq("tracking unreadable: wait", refusal(buildTicketRequest(dlv(), { trigger: "stalled" }, liveD(null), ctx()))?.to, "wait");
eq("a pending delivery-detail edit: wait", refusal(buildTicketRequest(dlv({ pendingCourierEdit: true }), { trigger: "stalled" }, liveD(track()), ctx()))?.to, "wait");

// ── duplicates and windows ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("an open ticket: wait", refusal(buildTicketRequest(dlv(), { trigger: "stalled" }, liveD(track()), ctx({ openTicketAwbs: new Set(["60000000000007"]) })))?.to, "wait");
eq("an active request: wait", refusal(buildTicketRequest(dlv(), { trigger: "stalled" }, liveD(track()), ctx({ activeRequestAwbs: new Set(["60000000000007"]) })))?.to, "wait");
eq("the same kind asked within the window: wait", refusal(buildTicketRequest(dlv(), { trigger: "stalled" }, liveD(track()), ctx({ recentRequests: new Set(["60000000000007|stalled"]) })))?.to, "wait");
ok("a different kind in the window does not block", buildTicketRequest(dlv(), { trigger: "stalled" }, liveD(track()), ctx({ recentRequests: new Set(["60000000000007|delay"]) })).ok);
eq("the window is fourteen days", REQUEST_WINDOW_DAYS, 14);

// ── order and courier guards ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
for (const s of ["delivered", "rto", "returned", "cancelled", "wa_cancelled"]) eq(`order ${s}: nothing to do`, refusal(buildTicketRequest(dlv({ status: s }), { trigger: "stalled" }, liveD(track()), ctx()))?.to, "none");
eq("no AWB: nothing to do", refusal(buildTicketRequest(dlv({ awb: null }), { trigger: "stalled" }, liveD(track()), ctx()))?.to, "none");
eq("a Shiprocket-assigned parcel: a person", refusal(buildTicketRequest(dlv({ shiprocketOrderId: "123" }), { trigger: "stalled" }, liveD(track()), ctx()))?.to, "person");
eq("DTDC has no ticket route: a person", refusal(buildTicketRequest(dlv({ courierName: "DTDC", awb: "7X121426160" }), { trigger: "stalled" }, liveD(track()), ctx()))?.to, "person");
eq("a Delhivery AWB must be digits", refusal(buildTicketRequest(dlv({ awb: "SF1234" }), { trigger: "stalled" }, liveD(track()), ctx()))?.to, "person");

// ── Delhivery: a disputed attempt ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const failed = track({ status: "Pending", statusCode: "EOD-11", instructions: "Consignee Unavailable", statusDateTime: "2026-10-17T11:53:00" });
  const b = buildTicketRequest(dlv(), { trigger: "disputed_attempt", claim: "no_call" }, liveD(failed), ctx());
  ok("Delhivery shows a failed delivery: the dispute category is requested", b.ok);
  if (b.ok) {
    eq("the 'Fake remark' pair, kind and priority", [b.request.ticket.category, b.request.ticket.subCategory, b.request.kind, b.request.priority], [DLV_DISPUTE.category, DLV_DISPUTE.subCategory, "disputed_attempt", 0]);
    ok("the text carries the scan and the date and asks for proof of attempt", /was scanned 'Consignee Unavailable' on 17 Oct/.test(b.request.ticket.description!) && /proof of attempt/.test(b.request.ticket.description!));
    eq("the claim is a code, never the customer's words", b.request.evidence.claim, "no_call");
  }
  const maxed = buildTicketRequest(dlv(), { trigger: "disputed_attempt" }, liveD(track({ statusCode: "EOD-999", instructions: "Attempts exhausted" })), ctx());
  ok("attempts exhausted counts as a failed delivery state", maxed.ok && maxed.request.kind === "disputed_attempt");
  const transit = buildTicketRequest(dlv(), { trigger: "disputed_attempt", claim: "no_attempt" }, liveD(track()), ctx());
  ok("in transit with the promised date passed: falls back to the delay ticket, and says so", transit.ok && transit.request.kind === "delay" && transit.request.evidence.fellBackFromDispute && transit.request.evidence.trigger === "disputed_attempt" && transit.notes.length === 1);
  eq("the fallback uses the delay pair, not the dispute pair", transit.ok && [transit.request.ticket.category, transit.request.ticket.subCategory], [DLV_DELAY.category, DLV_DELAY.subCategory]);
  const early = refusal(buildTicketRequest(dlv(), { trigger: "disputed_attempt" }, liveD(track({ promisedDate: "2026-10-18T23:59:59" })), ctx()));
  ok("in transit and not late yet: a person, and the reason says the category would be refused", early?.to === "person" && /would be refused/.test(early.reason));
}

// ── Shadowfax: the category is the whole message ─────────────────────────────────────────────────────────────────────────────────────────
{
  const d = buildTicketRequest(sfx(), { trigger: "disputed_attempt", claim: "no_call" }, liveS("ofd"), ctx());
  ok("a disputed attempt: status_mismatch, no text", d.ok && d.request.ticket.shadowfaxCategory === "status_mismatch" && d.request.ticket.description === undefined && d.request.ticket.category === undefined);
  eq("…priority 0, and the note says how it is filed", d.ok && [d.request.priority, /Fake status/.test(d.notes[0])], [0, true]);
  const s = buildTicketRequest(sfx(), { trigger: "stalled" }, liveS("in_transit"), ctx());
  ok("a stalled parcel: delayed_delivery", s.ok && s.request.ticket.shadowfaxCategory === "delayed_delivery" && /My shipment is delayed/.test(s.notes[0]));
  eq("one issue per parcel, ever: a marked parcel goes to a person", refusal(buildTicketRequest(sfx({ adminNotes: "x\n[sfx-escalated 2026-10-18] delayed delivery" }), { trigger: "stalled" }, liveS("in_transit"), ctx()))?.to, "person");
  eq("a failed attempt is an NDR, not a delay issue: a person", refusal(buildTicketRequest(sfx(), { trigger: "stalled" }, liveS("nc"), ctx()))?.to, "person");
  eq("a hold: a person", refusal(buildTicketRequest(sfx(), { trigger: "stalled" }, liveS("on_hold"), ctx()))?.to, "person");
  eq("out for delivery: wait", refusal(buildTicketRequest(sfx(), { trigger: "stalled" }, liveS("ofd"), ctx()))?.to, "wait");
  eq("returning: nothing to do", refusal(buildTicketRequest(sfx(), { trigger: "stalled" }, liveS("rto_initiated"), ctx()))?.to, "none");
  eq("status unreadable: wait", refusal(buildTicketRequest(sfx(), { trigger: "stalled" }, liveS(null), ctx()))?.to, "wait");
  const dd = refusal(buildTicketRequest(sfx({ status: "shipped" }), { trigger: "disputed_attempt" }, liveS("delivered"), ctx()));
  ok("delivered at Shadowfax and disputed: a person until delivery_dispute is verified", dd?.to === "person" && /not been verified/.test(dd.reason));
  eq("a direct-booking check: a Shiprocket parcel is not ours to raise", refusal(buildTicketRequest(sfx({ shiprocketOrderId: "9" }), { trigger: "stalled" }, liveS("in_transit"), ctx()))?.to, "person");
}

// ── the text is built from the AWB, a scan code and dates only ───────────────────────────────────────────────────────────────────────────
{
  const dirty = track({ statusCode: "EOD-11", instructions: `<b>Consignee</b> not reachable on +91 98765 43210 "quoted" ${"very long remark ".repeat(20)}` });
  const b = buildTicketRequest(dlv(), { trigger: "disputed_attempt" }, liveD(dirty), ctx());
  const t = b.ok ? b.request.ticket.description! : "";
  ok("no tag, no phone number, no double quote, and within 300", b.ok && !/<|>/.test(t) && !/\d{10}/.test(t.replace(/60000000000007/, "")) && !/"/.test(t) && t.length <= DESCRIPTION_MAX);
  ok("delayDescription is capped even for an absurd scan code", delayDescription({ promised: "2026-10-15", lastCode: "X".repeat(400), lastOn: "15 Oct" }).length <= DESCRIPTION_MAX);
  ok("disputeDescription without a remark still reads", /shows a failed delivery attempt/.test(disputeDescription({ awb: "60000000000007", remark: null, scannedOn: null })));
  eq("delayDescription without a last scan or promised date is the plain ask", delayDescription({ promised: null, lastCode: null, lastOn: null }).startsWith("Parcel is delayed beyond the promised delivery date."), true);
}

console.log(`deliveryTicketRequest: ${passed} assertions passed`);
