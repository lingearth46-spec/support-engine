// Run with `npx tsx lib/deliveryCaseState.test.ts`. The state-aware core of the late-delivery agent, scenario by scenario.
import assert from "node:assert/strict";
import {
  buildTimeline, namedDay, intentFromText, mergeIntent, decideDelivery, deliveryGate, pickDeliveryOrder, emptyState, STALL_HOURS, REPEAT_LIMIT,
  type DeliveryScan, type DeliveryOrder, type CaseState, type DeliveryIntent, type Decision, type OrderView,
} from "@late/deliveryCaseState";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

const H = 3_600_000;
const T0 = Date.parse("2026-10-12T06:30:00Z");
const at = (h: number) => new Date(T0 + h * H).toISOString();
const sc = (h: number, event: string, remark: string | null = null, raw: string | null = null): DeliveryScan => ({ event, raw_status: raw, remark, scanned_at: at(h) });
const order = (courier: DeliveryOrder["courier"], extra: Partial<DeliveryOrder> = {}): DeliveryOrder => ({ id: "AJUKI710009", courier, pincode: "560001", ...extra });

// ── timeline ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const scans = [sc(0, "picked_up"), sc(10, "out_for_delivery"), sc(14, "failed_attempt", "Customer not contactable", "Not Contactable"), sc(20, "in_transit")];
  const t = buildTimeline(scans, T0 + 30 * H);
  eq("attempts counted from the whole history", t.attempts, 1);
  eq("hours since the last scan", Math.round(t.hoursSinceMovement ?? -1), 10);
  eq("the cause comes from the last failed attempt, even after a later in-transit scan", t.cause, "customer_side");
  eq("...and says the parcel has moved since", t.movedSinceFailure, true);
  eq("phase is the last scan", t.phase, "in_transit");
  eq("remarks are kept verbatim", t.remarks, ["Customer not contactable"]);
  eq("an unsorted list is sorted", buildTimeline([...scans].reverse(), T0 + 30 * H).lastEvent, "in_transit");
  eq("no scans: nothing known", [buildTimeline([], T0).phase, buildTimeline([], T0).hoursSinceMovement], ["none", null]);
  eq("the order status adds rto", buildTimeline(scans, T0 + 30 * H, "rto").phase, "rto");
  eq("a courier-side remark", buildTimeline([sc(1, "failed_attempt", "Vehicle breakdown", "Not Attempted")], T0 + 5 * H).cause, "courier_side");
  eq("max attempts", buildTimeline([sc(1, "failed_attempt", "Max attempt ndr marked due to open ticket", "Reattempt Delivery")], T0 + 5 * H).cause, "max_attempts");
  eq("delivered", buildTimeline([sc(1, "delivered")], T0 + 5 * H).phase, "delivered");
}

// ── reading the message ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
for (const [m, want] of [
  ["where is my order", "chase"], ["any update", "chase"], ["", "chase"], ["The courier boy havent call me", "dispute"], ["I call him more than 10 times but no answer", "dispute"],
  ["his phone was switched off", "dispute"], ["give me the delivery boy's number", "rider_number"], ["Update address", "address_change"], ["Call me once", "call_me"],
  ["Deliver tomorrow", "date_request"], ["when will it come today or tomorrow?", "chase"], ["How can I contact support", "contact_info"], ["9000100002", "phone_given"],
  ["please change this no to 9000100025", "phone_given"], ["I want a refund", "needs_human"], ["this is a scam", "needs_human"], ["[photo]", "needs_human"],
  ["Please don't send it with shadowfax again", "needs_human"], ["Help me with this", "chase"], ["not received my order, it shows delivered", "not_received"],
] as [string, DeliveryIntent][]) eq(`pattern intent: ${JSON.stringify(m)}`, intentFromText(m, null), want);
eq("in context: a day after we asked which day", intentFromText("tomorrow", "date"), "date_answer");
eq("in context: a bare no after we asked whether the rider called", intentFromText("No", "rider_answer"), "dispute");
eq("in context: yes after the same question", intentFromText("yes he called", "rider_answer"), "rider_yes");
eq("in context: an address after we asked for it", intentFromText("Flat 4, Green Park, Delhi 110016", "address"), "address_given");

eq("model reading is used when confident", mergeIntent("where is it", null, { intent: "status_question", confidence: "high" }), "chase");
eq("a complaint from the model goes to a person", mergeIntent("he is useless", null, { intent: "courier_complaint", confidence: "high" }), "needs_human");
eq("the veto wins over the model", mergeIntent("I want a refund, where is my order", null, { intent: "status_question", confidence: "high" }), "needs_human");
eq("no reading, a long message: a person", mergeIntent("a long rambling message about many things that is more than forty characters", null, null), "other");
eq("no reading, a short message: a chase", mergeIntent("Confirm", null, null), "chase");
eq("low confidence, short: a chase", mergeIntent("Help me with this", null, { intent: "other", confidence: "low" }), "chase");
eq("low confidence, long: a person", mergeIntent("this is a long message that the model could not place at all, honestly", null, { intent: "other", confidence: "low" }), "other");
eq("an acknowledgement is silent", mergeIntent("thanks", null, { intent: "acknowledgement", confidence: "high" }), "ack");
eq("an unknown model label goes to a person", mergeIntent("hello there my friend how are you doing", null, { intent: "weird_label", confidence: "high" }), "needs_human");

// ── the machine ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const run = (o: DeliveryOrder, scans: DeliveryScan[], message: string, hNow: number, state: CaseState | null, intent?: DeliveryIntent, status?: string): Decision =>
  decideDelivery({ order: o, timeline: buildTimeline(scans, T0 + hNow * H, status), message, intent: intent ?? intentFromText(message, state?.awaiting ?? null), state, now: T0 + hNow * H });

// a customer-side failure on Shadowfax: ask whether the rider called, then the dispute branch
{
  const o = order("shadowfax"); const scans = [sc(0, "out_for_delivery"), sc(4, "failed_attempt", "Customer not contactable", "Not Contactable")];
  const d1 = run(o, scans, "where is my order", 6, null);
  eq("first contact, customer-side failure: ask whether the rider called", [d1.replyId, d1.escalate, d1.state.awaiting], ["A1", "none", "rider_answer"]);
  const d2 = run(o, scans, "No", 7, d1.state);
  eq("'No' in context is the dispute; Shadowfax gets an issue raised", [d2.replyId, d2.action?.name, d2.action?.allowed], ["B3", "SHADOWFAX_ISSUE", true]);
}
// the same on Delhivery: dispute, ask the date, then defer (never a bare re-attempt)
{
  const o = order("delhivery"); const scans = [sc(0, "out_for_delivery"), sc(4, "failed_attempt", "Consignee Unavailable", "Pending")];
  const d1 = run(o, scans, "where is my order", 6, null); eq("Delhivery first contact", d1.replyId, "A1");
  const d2 = run(o, scans, "he never called me", 7, d1.state);
  eq("the dispute prompts a person once (a prepared complaint) and asks for the day", [d2.replyId, d2.escalate, d2.state.awaiting], ["B1", "dispute_manual", "date"]);
  const d3 = run(o, scans, "tomorrow", 8, d2.state);
  eq("the day is answered with a deferral, which is allowed on this code", [d3.replyId, d3.action?.name, d3.action?.allowed], ["B2", "DEFER_DLV", true]);
  const d4 = run(o, scans, "he still did not call", 9, d2.state);
  eq("a second dispute does not prompt a person again", d4.escalate, "none");
}
// repeat chasing: the same reply is never a new escalation; one prompt on the third; one on a stall
{
  const o = order("shadowfax"); const scans = [sc(0, "in_transit")];
  let st: CaseState | null = null; const seq: string[] = [];
  for (const h of [1, 3, 5, 7]) { const d = run(o, scans, "any update", h, st); st = d.state; seq.push(`${d.replyId}/${d.escalate}`); }
  eq("first reply is a status, then 'no newer update', then ONE prompt on the third chase, then quiet", seq, ["A2s/none", "C1/none", "E2/repeat_chase", "C1/none"]);
}
{
  const o = order("delhivery"); const scans = [sc(0, "in_transit")];
  const d1 = run(o, scans, "where is my order", 60, null);
  eq("first contact on a parcel stalled 60 h: one prompt", [d1.replyId, d1.escalate], ["E1", "stall_48h"]);
  const d2 = run(o, scans, "where is my order", 62, d1.state);
  eq("the next chase on the same stall does not escalate again", d2.escalate, "none");
  const d3 = run(o, [...scans, sc(65, "in_transit")], "where is my order", 66, d2.state);
  eq("a new scan is movement: an update, ledger and chase count reset", [d3.replyId, d3.moved, d3.state.chases, d3.state.ledger.stall], ["D1", true, 1, false]);
  const d4 = run(o, [...scans, sc(65, "in_transit")], "any update", 120, d3.state);
  eq("a second stall after the movement escalates once more", [d4.replyId, d4.escalate], ["E1", "stall_48h"]);
  eq("the stall threshold is 48 h", STALL_HOURS, 48);
  eq("the repeat limit is 3", REPEAT_LIMIT, 3);
}
// two failed attempts
{
  const o = order("delhivery"); const scans = [sc(0, "failed_attempt", "Consignee Unavailable"), sc(20, "failed_attempt", "Consignee Unavailable")];
  const d1 = run(o, scans, "where is my order", 22, null);
  eq("two failed attempts: a person is prompted once", [d1.replyId, d1.escalate], ["A5", "two_failed"]);
  eq("not again for the same count", run(o, scans, "where is it", 23, d1.state).escalate, "none");
}
// no lever
eq("DTDC: no API, so a person", [run(order("dtdc"), [sc(0, "in_transit")], "where is my order", 5, null).replyId, run(order("dtdc"), [sc(0, "in_transit")], "where is my order", 5, null).escalate], ["A2", "no_lever"]);
eq("Shadowfax cannot schedule a date", [run(order("shadowfax"), [sc(0, "failed_attempt", "Customer not contactable")], "deliver tomorrow", 5, null).replyId, run(order("shadowfax"), [sc(0, "failed_attempt", "Customer not contactable")], "deliver tomorrow", 5, null).escalate], ["F2", "no_lever"]);
eq("Delhivery customer-side: a date request is deferred without a person", [run(order("delhivery"), [sc(0, "failed_attempt", "Consignee Unavailable")], "deliver tomorrow", 5, null).replyId, run(order("delhivery"), [sc(0, "failed_attempt", "Consignee Unavailable")], "deliver tomorrow", 5, null).escalate], ["B2", "none"]);
eq("max attempts: no action accepted", [run(order("delhivery"), [sc(0, "failed_attempt", "Max attempt ndr marked due to open ticket")], "where is my order", 5, null).replyId, run(order("delhivery"), [sc(0, "failed_attempt", "Max attempt ndr marked due to open ticket")], "where is my order", 5, null).escalate], ["A2", "no_lever"]);
// requests
eq("rider's number: cannot share, the rider will contact", run(order("shadowfax"), [sc(0, "in_transit")], "give me his number", 5, null).text, "I cannot share the rider's number. The rider will contact you before delivery.");
eq("a call request on a parcel out for delivery", run(order("shadowfax"), [sc(0, "out_for_delivery")], "call me", 5, null).replyId, "F1b");
eq("a call request otherwise goes to a person", [run(order("shadowfax"), [sc(0, "in_transit")], "call me", 5, null).replyId, run(order("shadowfax"), [sc(0, "in_transit")], "call me", 5, null).escalate], ["F4", "no_lever"]);
eq("contact info", run(order("shadowfax"), [sc(0, "in_transit")], "how can I contact support", 5, null).replyId, "F5");
eq("a thank-you gets silence", run(order("shadowfax"), [sc(0, "in_transit")], "thanks", 5, null, "ack").text, "");
eq("a complaint goes to a person, never a status line", [run(order("shadowfax"), [sc(0, "in_transit")], "he is useless", 5, null, "needs_human").replyId, run(order("shadowfax"), [sc(0, "in_transit")], "he is useless", 5, null, "needs_human").escalate], ["H1", "needs_human"]);
// address after dispatch
{
  const o = order("delhivery"); const scans = [sc(0, "failed_attempt", "Consignee Unavailable")];
  const d1 = run(o, scans, "Update address", 3, null);
  eq("address change: ask for the address, same pincode", [d1.replyId, d1.state.awaiting], ["F3a", "address"]);
  eq("same pincode: the courier is asked", run(o, scans, "Flat 4, Green Park 560001", 4, d1.state).replyId, "F3b");
  eq("a different pincode goes to a person", [run(o, scans, "Flat 4, Green Park 110016", 4, d1.state).replyId, run(o, scans, "Flat 4, Green Park 110016", 4, d1.state).escalate], ["F3c", "no_lever"]);
  eq("Delhivery outside the failed-delivery window: a person, not a courier edit", [run(o, [sc(0, "in_transit")], "Update address", 3, null).replyId, run(o, [sc(0, "in_transit")], "Update address", 3, null).escalate], ["F3c", "no_lever"]);
  eq("Delhivery after the parcel moved on from the failure: a date cannot be deferred", run(o, [sc(0, "failed_attempt", "Consignee Unavailable"), sc(8, "in_transit")], "deliver tomorrow", 12, null).replyId, "F2");
}
// terminal states
eq("delivered: no escalation", [run(order("delhivery"), [sc(0, "delivered")], "where is my order", 5, null).replyId, run(order("delhivery"), [sc(0, "delivered")], "where is my order", 5, null).escalate], ["D3", "none"]);
eq("delivered but not received goes to Senior Support", run(order("delhivery"), [sc(0, "delivered")], "I did not receive my parcel", 5, null).escalate, "not_received");
eq("'not received' on a parcel still travelling is an ordinary chase", run(order("delhivery"), [sc(0, "in_transit")], "I did not receive my parcel", 5, null, "not_received").escalate, "none");
eq("returning to us", run(order("shadowfax"), [sc(0, "in_transit")], "where is it", 5, null, undefined, "rto").replyId, "D4");

// ── no wording promises what it must not ────────────────────────────────────────────────────────────────────────────────────────────────
{
  const lines: string[] = [];
  const o = order("delhivery"); const scans = [sc(0, "failed_attempt", "Consignee Unavailable")];
  for (const m of ["where is my order", "he never called", "deliver tomorrow", "Update address", "give me his number", "call me", "any update", "9000100002"]) lines.push(run(o, scans, m, 60, null).text);
  ok("no line promises a time, a refund or a replacement, or says 'don't worry'", !lines.some((l) => /refund|replace|discount|within \d|by tomorrow|don'?t worry|no need to worry/i.test(l)));
  ok("every tracking link is www.ajuki.in/track", lines.filter((l) => /www\./.test(l)).every((l) => !/www\.(?!ajuki\.in)/.test(l)));
  ok("'asked the courier' appears only where an action is attached", ["deliver tomorrow", "Update address"].every((m) => { const d = run(o, scans, m, 5, null); return !/asked the courier/.test(d.text) || d.action !== null; }));
}

// ── the gate and the order choice ───────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const mk = (id: string, scans: DeliveryScan[], extra: Partial<DeliveryOrder> = {}, created = 0): OrderView => ({ order: { id, courier: "shadowfax", ...extra }, scans, createdAt: T0 + created * H });
  const failing = mk("AJUKI710001", [sc(0, "failed_attempt", "Customer not contactable")]);
  const fine = mk("AJUKI710002", [sc(50, "in_transit")], {}, 5);
  const done = mk("AJUKI710003", [sc(0, "delivered")]);
  ok("gate: a failed attempt opens it", deliveryGate([failing], "hello", T0 + 5 * H));
  ok("gate: a delivered parcel with a chatty message does not", !deliveryGate([done], "where is my order", T0 + 5 * H));
  ok("gate: no orders, no gate", !deliveryGate([], "where is my order", T0));
  ok("gate: late words on a moving parcel", deliveryGate([fine], "where is my order", T0 + 55 * H));
  eq("pick: a named order wins", pickDeliveryOrder([failing, fine], "about AJUKI710002", T0 + 60 * H)?.order.id, "AJUKI710002");
  eq("pick: otherwise the one with a failed attempt", pickDeliveryOrder([fine, failing], "where is it", T0 + 60 * H)?.order.id, "AJUKI710001");
  eq("pick: a delivered parcel is not chosen over an open one", pickDeliveryOrder([done, fine], "where is it", T0 + 60 * H)?.order.id, "AJUKI710002");
  eq("pick: nothing open, nothing chosen", pickDeliveryOrder([done], "where is it", T0 + 60 * H), null);
}
eq("an empty state is a first contact", emptyState().chases, 0);

// ── 19 Oct: being packed, the customer-unavailable flow, the chat before the case ──
{
  const NOW = T0 + 30 * H;
  // never "not picked up": every pre-pickup scan shape reads as being packed
  for (const [label, scans] of [
    ["Delhivery manifested", [sc(2, "manifested", "Manifest uploaded", "Manifested")]],
    ["Shadowfax out for pickup", [sc(2, "manifested", null, "Assigned For Pickup"), sc(20, "manifested", null, "Out For Pickup")]],
    ["Shadowfax New (tagged in_transit)", [sc(2, "in_transit", null, "New")]],
    ["Shadowfax seller-initiated delay", [sc(2, "manifested", null, "Out For Pickup"), sc(6, "in_transit", "Seller Initiated Delay", "Cid")]],
    ["DTDC pickup not done", [sc(2, "manifested", null, "pickup_scheduled"), sc(8, "picked_up", null, "not_picked_up")]],
  ] as const) {
    const t = buildTimeline([...scans], NOW);
    ok(`${label}: pre-pickup`, t.prePickup);
    const d = decideDelivery({ order: order("shadowfax"), timeline: t, message: "where is my order", intent: "chase", state: null, now: NOW });
    eq(`${label}: the packing line, no person`, [d.replyId, d.escalate], ["P1", "none"]);
    ok(`${label}: being packed, shipped as soon as possible, no need to worry, never picked up / in transit`, /being packed/.test(d.text) && /shipped as soon as possible/.test(d.text) && /no need to worry/.test(d.text) && !/picked up|in transit|courier/i.test(d.text));
  }
  ok("a real pickup is not pre-pickup", !buildTimeline([sc(2, "manifested", null, "Manifested"), sc(8, "picked_up", null, "Picked")], NOW).prePickup);
  ok("Delhivery Shipment picked up (in transit) is not pre-pickup", !buildTimeline([sc(2, "manifested", null, "Manifested"), sc(8, "in_transit", "Shipment picked up", "In Transit")], NOW).prePickup);
  const stuck = decideDelivery({ order: order("shadowfax"), timeline: buildTimeline([sc(-40, "manifested", null, "Assigned For Pickup")], NOW), message: "where is my order", intent: "chase", state: null, now: NOW });
  eq("packing for 48 hours or more: a person is prompted, the wording is still packing", [stuck.replyId, stuck.escalate, /being packed/.test(stuck.text), /escalated/.test(stuck.text)], ["P2", "no_lever", true, true]);
}
{
  // the customer was unavailable: tell them, offer a later time, ask if anyone called; the answers branch
  const NOW = T0 + 30 * H;
  const scans = [sc(0, "out_for_delivery"), sc(5, "failed_attempt", "Consignee Unavailable", "Pending")];
  const t = buildTimeline(scans, NOW);
  const d1 = decideDelivery({ order: order("delhivery"), timeline: t, message: "where is my order", intent: "chase", state: null, now: NOW });
  eq("A1 asks, and waits for the answer", [d1.replyId, d1.escalate, d1.state.awaiting], ["A1", "none", "rider_answer"]);
  ok("it says the courier reports the customer was not available, and offers both options", /courier reports that you were not available/.test(d1.text) && /delivered at a later time/.test(d1.text) && /nobody called or came/.test(d1.text));
  ok("it does not blame the courier", !/courier's side|courier.s fault/i.test(d1.text));
  eq("a day is read as the answer", intentFromText("tomorrow", "rider_answer"), "date_answer");
  eq("a named day too", intentFromText("Thursday please", "rider_answer"), "date_answer");
  eq("nobody called is a dispute even when it contains today", intentFromText("no one called me today", "rider_answer"), "dispute");
  eq("no is a dispute", intentFromText("no", "rider_answer"), "dispute");
  const d2 = decideDelivery({ order: order("delhivery"), timeline: t, message: "tomorrow", intent: "date_answer", state: d1.state, now: NOW + H });
  ok("a day on a Delhivery customer-side failure becomes the defer request", d2.replyId === "B2" && d2.action?.name === "DEFER_DLV" && d2.action.allowed);
  const dd = decideDelivery({ order: order("delhivery"), timeline: t, message: "no one called me", intent: "dispute", state: d1.state, now: NOW + H });
  eq("nobody called or came: a person is prompted once (the ticket follows) and the day is asked", [dd.replyId, dd.escalate, dd.state.awaiting], ["B1", "dispute_manual", "date"]);
  ok("it says escalated, not reported to the courier", /escalated this to the team/.test(dd.text) && !/reported to the courier/.test(dd.text));
  const sf = decideDelivery({ order: order("shadowfax"), timeline: t, message: "no one called me", intent: "dispute", state: { ...d1.state }, now: NOW + H });
  eq("Shadowfax: a person is prompted (it said escalated) and the ticket follows", [sf.replyId, sf.escalate], ["B3", "dispute_manual"]);
  const sf2 = decideDelivery({ order: order("shadowfax"), timeline: t, message: "no one called me", intent: "dispute", state: { ...sf.state, ledger: { ...sf.state.ledger } }, now: NOW + 2 * H });
  eq("...once: the second complaint does not prompt again", sf2.escalate, "none");
  const two = buildTimeline([sc(0, "out_for_delivery"), sc(5, "failed_attempt", "Consignee Unavailable", "Pending"), sc(10, "out_for_delivery"), sc(12, "failed_attempt", "Consignee Unavailable", "Pending")], NOW);
  const a5 = decideDelivery({ order: order("delhivery"), timeline: two, message: "when will it come", intent: "chase", state: null, now: NOW });
  eq("A5: a person is prompted and the answer is awaited", [a5.replyId, a5.escalate, a5.state.awaiting], ["A5", "two_failed", "rider_answer"]);
  ok("A5 says the courier reports the customer was not available and offers the options", /courier reports that you were not available/.test(a5.text) && /later time/.test(a5.text));
  const maxed = buildTimeline([sc(0, "out_for_delivery"), sc(5, "failed_attempt", "Consignee Unavailable", "Pending"), sc(8, "out_for_delivery"), sc(10, "failed_attempt", "Consignee Unavailable", "Pending"), sc(11, "unknown", "Maximum attempts reached", "Pending")], NOW);
  eq("Maximum attempts reached after the last failure is the cause", maxed.cause, "max_attempts");
  const a5m = decideDelivery({ order: order("delhivery"), timeline: maxed, message: "update", intent: "chase", state: null, now: NOW });
  ok("with attempts used up there is no later-time offer", a5m.replyId === "A5" && !/later time/.test(a5m.text));
}
{
  // the whole chat is read: earlier chases make the next ask an escalation even with no case yet
  const NOW = T0 + 30 * H;
  const t = buildTimeline([sc(0, "picked_up"), sc(2, "in_transit")], NOW);
  const run = (priorChases: number, state: CaseState | null = null, now = NOW) => decideDelivery({ order: order("delhivery"), timeline: t, message: "where is my order", intent: "chase", state, now, priorChases });
  eq("a first ask is a status line", [run(0).replyId, run(0).escalate], ["A2s", "none"]);
  eq("a second ask is still a status line", run(1).escalate, "none");
  const many = run(4);
  eq("after earlier chases in the chat the reply prompts a person and requests the delay ticket", [many.replyId, many.escalate, many.state.chases], ["E2", "repeat_chase", 5]);
  ok("once escalated it does not prompt again on the next message", run(4, many.state, NOW + H).escalate === "none");
}

// ── 20 Oct review: status in the nothing-newer line, F2 without a date, the Delhivery admin scans after a failed attempt ──
{
  const NOW = T0 + 30 * H;
  // C1 states the status (the customer of AJUKI710090 was out for delivery and was told only that nothing was newer)
  const ofd = buildTimeline([sc(0, "in_transit"), sc(20, "out_for_delivery")], NOW);
  const s1 = decideDelivery({ order: order("delhivery"), timeline: ofd, message: "where is my order", intent: "chase", state: null, now: NOW });
  const c1 = decideDelivery({ order: order("delhivery"), timeline: ofd, message: "is it out for delivery", intent: "chase", state: s1.state, now: NOW + H });
  eq("C1", c1.replyId, "C1");
  ok("it says what the status is, then that nothing is newer", /is out for delivery, and the courier has not added anything newer since/.test(c1.text));
  // 24 Oct (..5282): "Date?" on a parcel that is out for delivery escalated; the rider is on it
  {
    const ofd = buildTimeline([sc(0, "in_transit"), sc(2, "out_for_delivery")], NOW);
    const d = decideDelivery({ order: order("delhivery"), timeline: ofd, message: "Order deliver date?", intent: "date_request", state: null, now: NOW });
    eq("out for delivery, no day named: no person, rider line", [d.replyId, d.escalate, /out for delivery/.test(d.text), /rider will contact you/.test(d.text), /escalated/.test(d.text)], ["F2", "none", true, true, false]);
    const named = decideDelivery({ order: order("shadowfax"), timeline: ofd, message: "Reschedule delivery date it's 25", intent: "date_request", state: null, now: NOW });
    eq("out for delivery, a day named: unchanged, a person", [named.replyId, named.escalate], ["F2", "no_lever"]);
  }
  // F2: "Today delivery available?" is a status question, not a date
  const stuck = buildTimeline([sc(0, "in_transit"), sc(2, "at_facility")], NOW);
  const f2 = (message: string, intent: DeliveryIntent) => decideDelivery({ order: order("shadowfax"), timeline: stuck, message, intent, state: null, now: NOW });
  const noDate = f2("Today delivery available?", "date_request");
  eq("no day named: a person is prompted, the status is given", [noDate.replyId, noDate.escalate], ["F2", "no_lever"]);
  ok("it does not say that date, and it promises no time", !/that date/.test(noDate.text) && /is in transit/.test(noDate.text) && /cannot promise a delivery time/.test(noDate.text));
  for (const m of ["Reschedule delivery date it's 25", "deliver on 25 oct", "deliver tomorrow", "send it on Friday"]) ok(`a named day keeps the date wording: ${m}`, /that date/.test(f2(m, "date_request").text));
  // Delhivery: failed attempt (customer unavailable), then only admin scans with event unknown
  const ndr = [sc(0, "out_for_delivery"), sc(5, "failed_attempt", "Consignee Unavailable", "Pending"), sc(8, "unknown", "NTD Updated", "Pending"), sc(8, "unknown", "Deferred Date has been set", "Pending")];
  const t = buildTimeline(ndr, NOW);
  ok("the last real movement is the customer-side failure: awaiting a retry", t.awaitingRetry && t.cause === "customer_side");
  ok("a later real scan ends the wait", !buildTimeline([...ndr, sc(12, "in_transit")], NOW).awaitingRetry && !buildTimeline([...ndr, sc(12, "out_for_delivery")], NOW).awaitingRetry);
  ok("a courier-side failure is not awaiting the customer", !buildTimeline([sc(0, "out_for_delivery"), sc(5, "failed_attempt", "Vehicle breakdown", "Not Attempted"), sc(8, "unknown", "NTD Updated")], NOW).awaitingRetry);
  ok("attempts used up is not awaiting a retry", !buildTimeline([...ndr, sc(9, "unknown", "Maximum attempts reached")], NOW).awaitingRetry);
  const first = decideDelivery({ order: order("delhivery"), timeline: t, message: "when will I get the product", intent: "chase", state: null, now: NOW });
  eq("first contact: the unavailable question, not in transit", [first.replyId, first.state.awaiting], ["A1", "rider_answer"]);
  ok("it offers the options", /courier reports that you were not available/.test(first.text) && /later time/.test(first.text));
  // a case that already exists (an earlier status reply) still gets the question once
  const prior = decideDelivery({ order: order("delhivery"), timeline: buildTimeline([sc(0, "picked_up")], NOW), message: "update", intent: "chase", state: null, now: NOW - 20 * H });
  const withCase = decideDelivery({ order: order("delhivery"), timeline: t, message: "when will I get the product", intent: "chase", state: { ...prior.state, lastScanAt: t.lastAt }, now: NOW });
  eq("an existing case asks once", [withCase.replyId, withCase.state.awaiting], ["A1", "rider_answer"]);
  const again = decideDelivery({ order: order("delhivery"), timeline: t, message: "any news", intent: "chase", state: { ...withCase.state, awaiting: null }, now: NOW + H });
  ok("and not again for the same failed attempt", again.replyId !== "A1");
  // the defer works from the waiting state
  const dd = decideDelivery({ order: order("delhivery"), timeline: t, message: "tomorrow", intent: "date_answer", state: first.state, now: NOW + H });
  ok("a day while waiting for a retry becomes the defer request", dd.replyId === "B2" && dd.action?.name === "DEFER_DLV" && dd.action.allowed);
}

// ── 21 Oct review: today beside tomorrow, F2 after a failed attempt, an already-escalated request, the unavailable question first, B3 awaits nothing ──
{
  const NOW = T0 + 30 * H;
  ok("tomorrow alone names a day", namedDay("deliver tomorrow"));
  ok("today with tomorrow as context is not a named day (..6895)", !namedDay("But try to make it deliver today cause tomorrow I will be busy and might can't take the order."));
  ok("a weekday or a date still names one", namedDay("send it on Friday") && namedDay("deliver on 25 oct") && namedDay("Reschedule delivery date it's 25"));
  ok("today alone is not one", !namedDay("Today give me parcel") && !namedDay("what about today?"));
  const failed = buildTimeline([sc(0, "out_for_delivery"), sc(5, "failed_attempt", "Customer not contactable", "Not Contactable")], NOW);
  const stuck = buildTimeline([sc(0, "in_transit"), sc(2, "at_facility")], NOW);
  const dec = (tl: ReturnType<typeof buildTimeline>, message: string, intent: DeliveryIntent, state: CaseState | null = null, courier: DeliveryOrder["courier"] = "shadowfax") => decideDelivery({ order: order(courier), timeline: tl, message, intent, state, now: NOW });
  // the unavailable question first
  const first = dec(failed, "Can you please confirm me the delivery date", "date_request");
  eq("a failed attempt the customer-side, no day named: the unavailable question, not F2 (..1494)", [first.replyId, first.escalate, first.state.awaiting], ["A1", "none", "rider_answer"]);
  const second = dec(failed, "what about today?", "date_request", first.state);
  eq("asked again, F2 with the failed attempt said properly", [second.replyId, second.escalate], ["F2", "no_lever"]);
  ok("it says what happened, not that the order is delivery attempted (..3220)", /had a delivery attempt that did not complete/.test(second.text) && !/delivery attempted/.test(second.text) && /cannot promise a delivery time/.test(second.text));
  const third = dec(failed, "pls deliver today", "date_request", second.state);
  eq("the team already has it: said once, no second escalation (..6895: twice in eight minutes)", [third.replyId, third.escalate, /already with the team/.test(third.text)], ["F2", "none", true]);
  ok("it does not say escalated again", !/I have escalated/.test(third.text));
  // not a failed attempt: the status, then the same dedupe
  const t1 = dec(stuck, "Today delivery available?", "date_request");
  ok("a parcel in transit: its status, never 'delivery attempted'", t1.replyId === "F2" && /is in transit\./.test(t1.text));
  const t2 = dec(stuck, "But try to make it deliver today cause tomorrow I will be busy", "date_request", t1.state);
  eq("today with tomorrow as context is not 'that date'; and not escalated twice", [/that date/.test(t2.text), t2.escalate, /already with the team/.test(t2.text)], [false, "none", true]);
  const named = dec(stuck, "Reschedule delivery date it's 25", "date_request");
  ok("a named day keeps the date wording", /that date/.test(named.text) && named.escalate === "no_lever");
  const named2 = dec(stuck, "make it 26 oct", "date_request", named.state);
  ok("and says once that it is already with the team", /already with the team/.test(named2.text) && named2.escalate === "none");
  // B3: Shadowfax cannot schedule and the reply asks for no day
  const b3 = dec(failed, "no one called me", "dispute", null);
  eq("B3 prompts a person and awaits no day", [b3.replyId, b3.escalate, b3.state.awaiting], ["B3", "dispute_manual", null]);
  const b1 = dec(failed, "no one called me", "dispute", null, "delhivery");
  eq("B1 (Delhivery) asks for a day, so it awaits one", [b1.replyId, b1.state.awaiting], ["B1", "date"]);
}

// ── 23 Oct review: the rider who wants the customer to cancel ──
{
  const m = "The courier guy want's me to cancel my order but I don't want to cancel it";
  eq("read as a dispute by the patterns", intentFromText(m, null), "dispute");
  eq("and when the model reads it", mergeIntent(m, null, { intent: "refund_or_cancel", confidence: "high" }), "dispute");
  eq("a plain cancellation still goes to a person", intentFromText("please cancel my order and refund", null), "needs_human");
  eq("so does a model reading of one", mergeIntent("cancel it", null, { intent: "refund_or_cancel", confidence: "high" }), "needs_human");
}

// 23 Oct: "my flight is on Saturday" was answered "your request for that date"; a day named only to say when they are away is not a delivery day
{
  eq("away: flight", namedDay("my flight is on Saturday"), false);
  eq("away: travelling tomorrow", namedDay("I am travelling tomorrow"), false);
  eq("away but asking for a delivery day", namedDay("I am away on Saturday, please deliver on Monday"), true);
  eq("a plain day", namedDay("deliver it on Saturday"), true);
  eq("tomorrow", namedDay("deliver tomorrow"), true);
  eq("not at home that day, come on 25th oct", namedDay("not at home saturday, come on 25 oct"), true);
}

console.log(`deliveryCaseState: ${passed} assertions passed`);
