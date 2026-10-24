import assert from "node:assert/strict";
import { lateDeliveryReply, combineReturnAndLate, LATE_REPLY, LATE_INSIST_REPLY, LATE_INSIST_TRACK_REPLY, isOverdue, lateFirstText, isLateFirstText, isLateInsistText, LEGACY_LATE_REPLY, LEGACY_LATE_INSIST_REPLY, PREVIOUS_LATE_INSIST_REPLY } from "@/lib/lateDeliveryReply";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const late = [{ id: "A1", status: "shipped", estimated_delivery: day(-4) }];
const onTime = [{ id: "A2", status: "shipped", estimated_delivery: day(2) }];
let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };

eq("overdue 4 days", isOverdue(late[0], NOW), true);
eq("one day past is slippage", isOverdue({ id: "x", status: "shipped", estimated_delivery: day(-1) }, NOW), false);
eq("failed attempt counts", isOverdue({ id: "x", status: "undelivered" }, NOW), true);
eq("delivered never late", isOverdue({ id: "x", status: "delivered", estimated_delivery: day(-9) }, NOW), false);
eq("rto never late", isOverdue({ id: "x", status: "rto", estimated_delivery: day(-9) }, NOW), false);

for (const [msg, tag] of [["Hum multiple times call kiye delivery agent ko but no response", "late_delivery"], ["why my order is still not delivered", "order_status"], ["where is my order", "late_delivery"]] as const) {
  eq(`first: ${msg}`, lateDeliveryReply({ ownOrders: late, message: msg, tag, now: NOW }), { text: lateFirstText(late[0]), kind: "first" });
}
eq("insists -> already on it", lateDeliveryReply({ ownOrders: late, message: "??", tag: "other", lastBotReply: lateFirstText(late[0]), now: NOW }), { text: LATE_INSIST_REPLY, kind: "insist" });
eq("keeps insisting", lateDeliveryReply({ ownOrders: late, message: "please reply", tag: "late_delivery", lastBotReply: LATE_INSIST_REPLY, now: NOW }), { text: LATE_INSIST_REPLY, kind: "insist" });
eq("on time -> model", lateDeliveryReply({ ownOrders: onTime, message: "where is my order", tag: "order_status", now: NOW }), null);
eq("late but unrelated message", lateDeliveryReply({ ownOrders: late, message: "Do you have a gold chain?", tag: "product_info", now: NOW }), null);
eq("no orders", lateDeliveryReply({ ownOrders: [], message: "where is my order", tag: "late_delivery", now: NOW }), null);
eq("both asked -> return line then late line", combineReturnAndLate("RETURN LINE", { text: lateFirstText(late[0]), kind: "first" }), `RETURN LINE

${lateFirstText(late[0])}`);
eq("insist line is not bolted on", combineReturnAndLate("RETURN LINE", { text: LATE_INSIST_REPLY, kind: "insist" }), "RETURN LINE");
eq("no late part", combineReturnAndLate("RETURN LINE", null), "RETURN LINE");
eq("a message asking both is recognised as late too", lateDeliveryReply({ ownOrders: late, message: "I want to return the bracelet and where is my other order", tag: "return", now: NOW }), { text: lateFirstText(late[0]), kind: "first" });
// ── 11 Oct, founder: the "already on it" line carries where to track the parcel (V2 only) ──
eq("v2: insist line with the tracking sentence", lateDeliveryReply({ ownOrders: late, message: "??", tag: "other", lastBotReply: lateFirstText(late[0]), now: NOW, v2: true }),
  { text: LATE_INSIST_TRACK_REPLY, kind: "insist" });
eq("the second reply names the tracking page, with or without the pipeline switch", [LATE_INSIST_TRACK_REPLY === LATE_INSIST_REPLY, LATE_INSIST_REPLY.includes("www.ajuki.in/track")], [true, true]);
eq("flag off: unchanged", lateDeliveryReply({ ownOrders: late, message: "??", tag: "other", lastBotReply: lateFirstText(late[0]), now: NOW }), { text: LATE_INSIST_REPLY, kind: "insist" });
eq("v2: the first flag is unchanged", lateDeliveryReply({ ownOrders: late, message: "where is my order", tag: "late_delivery", now: NOW, v2: true }), { text: lateFirstText(late[0]), kind: "first" });
eq("v2: the track line is recognised as ours when they push again", lateDeliveryReply({ ownOrders: late, message: "??", tag: "other", lastBotReply: LATE_INSIST_TRACK_REPLY, now: NOW, v2: true }),
  { text: LATE_INSIST_TRACK_REPLY, kind: "insist" });

// ── 14 Oct (founder): the first reply says where the parcel stands; the second apologises and escalates again ──
eq("failed attempt: states it, escalates, names the page", lateFirstText({ id: "A9", status: "undelivered" }), "Your order A9 had a delivery attempt that did not complete. I have escalated this to the team. We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry. You can track it at www.ajuki.in/track.");
eq("overdue with a date", /^Your order A1 was expected around \d{1,2} [A-Z][a-z]{2} and is delayed\. I have escalated this to the team\. We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry\. You can track it at www\.ajuki\.in\/track\.$/.test(lateFirstText(late[0])), true);
eq("overdue with no date on record", lateFirstText({ id: "A8", status: "shipped" }), "Your order A8 is delayed. I have escalated this to the team. We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry. You can track it at www.ajuki.in/track.");
eq("the first reply names no courier reason and no time or date ('as soon as possible' is not one); 18 Oct: it now carries the reassurance", [/customer not|consignee|vehicle|within|hours|by tomorrow|working on it/i.test(lateFirstText({ id: "A9", status: "undelivered" })), /as soon as possible, so there is no need to worry/.test(lateFirstText({ id: "A9", status: "undelivered" }))], [false, true]);
eq("the second reply apologises, escalates again, names the page, and (18 Oct, founder) reassures", [/sorry/i.test(LATE_INSIST_REPLY), /escalated this to the team again/.test(LATE_INSIST_REPLY), /no need to worry/i.test(LATE_INSIST_REPLY), /www\.ajuki\.in\/track/.test(LATE_INSIST_REPLY)], [true, true, true, true]);
eq("the previous second line is still recognised in a thread", [isLateInsistText(PREVIOUS_LATE_INSIST_REPLY), isLateInsistText(LATE_INSIST_REPLY)], [true, true]);
eq("the previous first line (no reassurance) is still recognised as ours", isLateFirstText("Your order A9 had a delivery attempt that did not complete. I have escalated this to the team. You can track it at www.ajuki.in/track."), true);
eq("today's first reply is recognised as ours", [isLateFirstText(lateFirstText(late[0])), isLateFirstText(lateFirstText({ id: "A9", status: "undelivered" })), isLateFirstText("Where is my order?")], [true, true, false]);
eq("the old first line is still recognised in a thread", isLateFirstText(LEGACY_LATE_REPLY), true);
eq("the old second line is still recognised in a thread", isLateInsistText(LEGACY_LATE_INSIST_REPLY), true);
eq("after the OLD first line, a push gets the new second line", lateDeliveryReply({ ownOrders: late, message: "any update", tag: "other", lastBotReply: LEGACY_LATE_REPLY, now: NOW }), { text: LATE_INSIST_REPLY, kind: "insist" });
eq("after the old second line, a push gets the new second line", lateDeliveryReply({ ownOrders: late, message: "any update", tag: "other", lastBotReply: LEGACY_LATE_INSIST_REPLY, now: NOW }), { text: LATE_INSIST_REPLY, kind: "insist" });
eq("the same customer pushing a third time still gets the second line (never the first again)", lateDeliveryReply({ ownOrders: late, message: "when will it be delivered again?", tag: "other", lastBotReply: LATE_INSIST_REPLY, now: NOW }), { text: LATE_INSIST_REPLY, kind: "insist" });
eq("with two overdue parcels the first one named is the first overdue", lateDeliveryReply({ ownOrders: [late[0], { id: "A7", status: "undelivered" }], message: "where is my order", tag: "late_delivery", now: NOW })?.text.startsWith("Your order A1 "), true);

console.log(`${passed} passed, 0 failed`);
