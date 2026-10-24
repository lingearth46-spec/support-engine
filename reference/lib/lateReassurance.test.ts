// Run with `npx tsx lib/lateReassurance.test.ts`. The reassurance every late-parcel reply carries (founder, 18 Oct 2026): the courier may be blamed, we are working to deliver as
// soon as possible, no need to worry. Every place it appears, and every place it must not.
import assert from "node:assert/strict";
import { isHinglish, contradictsAssurance, LATE_REASSURE, COURIER_BLAME, LATE_EFFORT, reassurance, withLateReassurance, hasAssurance, lateTurnOf, assuranceDue, lateNote } from "@/lib/lateReassurance";
import { FIXED_TEXTS } from "@/lib/replyValidate";
import { withoutApprovedLines } from "@/lib/replyVerifier";
import { lateFirstText, LATE_INSIST_REPLY, isLateFirstText, isLateInsistText } from "@/lib/lateDeliveryReply";
import { groundingViolations } from "@/lib/replyGrounding";
import { rateReply } from "@/lib/replyRating";
import { BUSINESS_TRUTHS } from "@/lib/businessTruths";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

// ── the words ──
eq("the founder's three ideas, in one sentence each", [LATE_REASSURE, COURIER_BLAME, LATE_EFFORT], [
  "We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry.",
  "The delay is on the courier's side.",
  "We are working to get it to you as soon as possible.",
]);
ok("no delivery date, time or window is promised ('as soon as possible' is not one)", ![LATE_REASSURE, COURIER_BLAME, LATE_EFFORT].some((t) => /\b(today|tomorrow|\d+\s*(hours?|days?)|by \w+day|within|guarantee)\b/i.test(t)));
ok("none of them quotes a scan or the courier's own reason", ![LATE_REASSURE, COURIER_BLAME, LATE_EFFORT].some((t) => /consignee|not contactable|unavailable|manifest|scan|EOD-|vehicle|breakdown/i.test(t)));
eq("reassurance(blame)", [reassurance(false), reassurance(true)], [LATE_REASSURE, `${COURIER_BLAME} ${LATE_REASSURE}`]);

// ── they are approved lines: the verifier and the ruler do not judge them as claims ──
ok("all three are approved fixed text", [LATE_REASSURE, COURIER_BLAME, LATE_EFFORT].every((t) => FIXED_TEXTS.has(t)));
eq("withoutApprovedLines strips them from a reply (so the judge never sees them)", withoutApprovedLines(`Your order A1 is delayed. ${COURIER_BLAME} ${LATE_REASSURE} Track it at www.ajuki.in/track.`), "Your order A1 is delayed. Track it at www.ajuki.in/track.");
{
  const sources = [BUSINESS_TRUTHS, "AJUKI1 · shipped · expected around 10 Oct · OVERDUE"];
  const reply = `Your order AJUKI1 is delayed; you can track it at www.ajuki.in/track. ${COURIER_BLAME} ${LATE_REASSURE}`;
  const r = rateReply({ reply, message: "where is my order", sources, handedOff: false });
  ok("the rating ruler does not call the reassurance an irreparable claim", r.tier !== "irreparable");
}

// ── the fixed late lines carry it, and are still recognised in a thread ──
ok("the first late line carries the reassurance, after the escalation and before the link", /I have escalated this to the team\. We are doing everything we can[^.]*no need to worry\. You can track it/.test(lateFirstText({ id: "A1", status: "undelivered" })));
ok("the second line too", /escalated this to the team again\. We are doing everything we can/.test(LATE_INSIST_REPLY));
ok("neither line names the courier (the cause is not known there)", !/courier/i.test(lateFirstText({ id: "A1", status: "undelivered" })) && !/courier/i.test(LATE_INSIST_REPLY));
eq("today's lines are recognised as ours", [isLateFirstText(lateFirstText({ id: "A1", status: "undelivered" })), isLateInsistText(LATE_INSIST_REPLY)], [true, true]);

// ── a model-written reply: when it is added, and when it is not ──
const RECORD_LATE = "#AJUKI1 · shipped · expected around 10 Oct · OVERDUE · STUCK (no courier scan in over 48h)";
const base = "Your order AJUKI1 is delayed; you can track it at www.ajuki.in/track.";
eq("a late-delivery turn: the reassurance is added at the end", withLateReassurance(base, { tag: "late_delivery", record: "#AJUKI1 · shipped" }), `${base} ${LATE_REASSURE}`);
eq("a stuck parcel: the courier is named, then the reassurance", withLateReassurance(base, { tag: "late_delivery", record: RECORD_LATE }), `${base} ${COURIER_BLAME} ${LATE_REASSURE}`);
eq("an order-status question on an overdue parcel counts as a late turn", withLateReassurance(base, { tag: "order_status", record: RECORD_LATE }).endsWith(LATE_REASSURE), true);
eq("an order-status question on an ordinary parcel does not", withLateReassurance("Your order AJUKI1 is shipped.", { tag: "order_status", record: "#AJUKI1 · shipped · expected around 21 Oct" }), "Your order AJUKI1 is shipped.");
eq("a failed attempt that waits on the customer is not blamed on the courier", withLateReassurance(base, { tag: "late_delivery", record: `${RECORD_LATE} · courier note: customer not contactable` }), `${base} ${LATE_REASSURE}`);
eq("never twice", withLateReassurance(`${base} ${LATE_REASSURE}`, { tag: "late_delivery", record: RECORD_LATE }), `${base} ${LATE_REASSURE}`);
eq("never when the reply already says there is no need to worry", withLateReassurance("It will reach you; there is no need to worry.", { tag: "late_delivery", record: RECORD_LATE }), "It will reach you; there is no need to worry.");
for (const t of ["Your order AJUKI1 is on its way back to us and cannot be delivered again.", "Your parcel is returning to our warehouse (RTO).", "Your order AJUKI1 was delivered on 9 Oct."]) eq(`never on a parcel with nothing left to deliver: ${t.slice(0, 40)}`, withLateReassurance(t, { tag: "late_delivery", record: RECORD_LATE }), t);
eq("never on the fixed flag line", withLateReassurance("I do not have that information. I have escalated this to the team.", { tag: "late_delivery", record: RECORD_LATE }), "I do not have that information. I have escalated this to the team.");
eq("not on another topic's reply", withLateReassurance("Your refund of ₹449 was completed on 7 Oct.", { tag: "refund", record: RECORD_LATE }), "Your refund of ₹449 was completed on 7 Oct.");
eq("an empty reply stays empty", [withLateReassurance("", { tag: "late_delivery" }), withLateReassurance(null, { tag: "late_delivery" })], ["", ""]);

// ── it adds nothing the mechanical gate would refuse ──
{
  const record = RECORD_LATE;
  const text = withLateReassurance(base, { tag: "late_delivery", record });
  const v = groundingViolations(withoutApprovedLines(text), [BUSINESS_TRUTHS, record], []);
  ok("with the approved sentences stripped, the reply passes the gate as before", !v.some((x) => x.rule === "delivery_promise" || x.rule === "reply_time" || x.rule === "callback"));
}

// ── a model's OWN words count (founder, 18 Oct: not a fixed line); the check is for both ideas, in English or Hinglish ──
for (const t of [
  "Sorry for the delay: it is on the courier's side, but we are doing everything we can to get it delivered as soon as possible, so there is no need to worry.",
  "We are trying our best to get it to you as soon as possible, please don't worry.",
  "The courier has held it up; we are working to get it to you at the earliest and there is nothing to worry about.",
  "Courier ki taraf se deri hui hai, hum jaldi se jaldi pahunchane ki poori koshish kar rahe hain, aap chinta mat kijiye.",
]) ok(`recognised: ${t.slice(0, 50)}`, hasAssurance(t));
for (const t of [
  "Your order AJUKI1 is delayed; you can track it at www.ajuki.in/track.",
  "There is no need to worry.",
  "We are doing everything we can to get it delivered as soon as possible.",
  "Sorry for the delay, the courier has held it up.",
]) eq(`one idea is not enough: ${t.slice(0, 50)}`, hasAssurance(t), false);
eq("hasAssurance of nothing", [hasAssurance(null), hasAssurance(undefined), hasAssurance("")], [false, false, false]);

// ── which turns owe it ──
eq("lateTurnOf: the tag, or an overdue / stuck / undelivered record on a status question", [lateTurnOf({ tag: "late_delivery" }).late, lateTurnOf({ tag: "order_status", record: RECORD_LATE }).late, lateTurnOf({ tag: "order_status", record: "#A1 · shipped" }).late, lateTurnOf({ tag: "refund", record: RECORD_LATE }).late], [true, true, false, false]);
eq("the courier may be blamed only for a stuck parcel, not a failed attempt that waits on the customer", [lateTurnOf({ tag: "late_delivery", record: RECORD_LATE }).blame, lateTurnOf({ tag: "late_delivery", record: `${RECORD_LATE} · courier note: customer not contactable` }).blame, lateTurnOf({ tag: "late_delivery", record: "#A1 · shipped" }).blame], [true, false, false]);
eq("assuranceDue: a late reply without it; not when it has it, not on a returning parcel, not on the flag line", [
  assuranceDue("Your order is delayed.", { late: true, blame: false }),
  assuranceDue("We are doing everything we can to get it there as soon as possible, so there is no need to worry.", { late: true, blame: false }),
  assuranceDue("Your order is on its way back to us.", { late: true, blame: false }),
  assuranceDue("I do not have that information. I have escalated this to the team.", { late: true, blame: false }),
  assuranceDue("Your order is delayed.", { late: false, blame: false }),
], [true, false, false, false, false]);
ok("the writer's instruction asks for its own words and gives the limits", /OWN words/.test(lateNote(false)) && /courier's side/.test(lateNote(true)) && !/courier's side/.test(lateNote(false)) && /Never give a delivery date or time/.test(lateNote(true)));

// ── the 17 Oct replay: five faults, each pinned ──
eq("Hinglish assurance in the model's words is recognised (it was missed and the English sentence was stapled on)", hasAssurance("Hum sab kuch kar rahe hain taaki parcel jaldi deliver ho aur chinta karne ki zaroorat nahi hai."), true);
eq("isHinglish", [isHinglish("Aapka order shipped hai aur hum jaldi deliver karenge"), isHinglish("Your order is shipped and expected around 21 Oct")], [true, false]);
eq("a record that shows the parcel delivered is not a late turn, whatever the tag", lateTurnOf({ tag: "late_delivery", record: "#AJUKI1 · delivered · 18 Oct" }).late, false);
eq("…but an overdue parcel still is", lateTurnOf({ tag: "late_delivery", record: RECORD_LATE }).late, true);
eq("a record that says rto is not a late turn", lateTurnOf({ tag: "late_delivery", record: "#AJUKI1 · rto · returning" }).late, false);
for (const t of ["The order has already been dispatched and cannot be cancelled here; please email ajukisupport@gmail.com.", "Your orders are all COD, ₹499 due on delivery."]) eq(`no reassurance owed on a reply about something else: ${t.slice(0, 40)}`, assuranceDue(t, { late: true, blame: false }), false);
for (const t of ["Your order is on its way back to us (RTO) after 8 attempts.", "Your order was delivered on 18 Oct.", "Order is recorded as delivered on 18 Oct."]) eq(`contradicts a delivery reassurance: ${t.slice(0, 40)}`, contradictsAssurance(t), true);
eq("a plain late reply does not contradict it", contradictsAssurance("Your order is delayed with the courier; track it at www.ajuki.in/track."), false);

console.log(`lateReassurance: ${passed} assertions passed`);
