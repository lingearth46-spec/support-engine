import assert from "node:assert/strict";
import { cancelStateReply, CANCEL_REPLY, CANCEL_INSIST_REPLY, CANCEL_TOO_OLD_REPLY } from "@/lib/cancelStateReply";

const shipped = [{ id: "A1", status: "shipped" as never, awb_code: "123" }];
const NOW = Date.parse("2026-10-09T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const confirmed = [{ id: "A2", status: "confirmed" as never, awb_code: undefined, created_at: ago(5) }];
const oldConfirmed = [{ id: "A4", status: "confirmed" as never, awb_code: undefined, created_at: ago(30) }];
const delivered = [{ id: "A3", status: "delivered" as never, awb_code: "9" }];
let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.equal(got, want, name); passed++; };

for (const msg of ["Can I cancel my order now?", "Cancel my order", "I don't want this order anymore", "cancel plz"]) {
  eq(`dispatched: ${msg}`, cancelStateReply({ ownOrders: shipped, message: msg, tag: "cancellation" }), CANCEL_REPLY);
}
eq("insists -> email", cancelStateReply({ ownOrders: shipped, message: "Please cancel it", tag: "cancellation", lastBotReply: CANCEL_REPLY }), CANCEL_INSIST_REPLY);
eq("chases without saying cancel", cancelStateReply({ ownOrders: shipped, message: "Please reply", tag: "other", lastBotReply: CANCEL_REPLY }), CANCEL_INSIST_REPLY);
eq("keeps insisting -> same refuse line", cancelStateReply({ ownOrders: shipped, message: "cancel it now", tag: "cancellation", lastBotReply: CANCEL_INSIST_REPLY }), CANCEL_INSIST_REPLY);
eq("still cancellable -> model", cancelStateReply({ ownOrders: confirmed, message: "Cancel my order", tag: "cancellation", now: NOW }), null);
eq("one dispatched, one cancellable -> model", cancelStateReply({ ownOrders: [...shipped, ...confirmed], message: "Cancel my order", tag: "cancellation", now: NOW }), null);
eq("only a delivered order -> model", cancelStateReply({ ownOrders: delivered, message: "Cancel my order", tag: "cancellation" }), null);
eq("bare Ok tagged cancellation stays quiet", cancelStateReply({ ownOrders: shipped, message: "Ok", tag: "cancellation" }), null);
eq("not about cancelling", cancelStateReply({ ownOrders: shipped, message: "Where is my parcel?", tag: "order_status" }), null);
eq("no orders", cancelStateReply({ ownOrders: [], message: "Cancel my order", tag: "cancellation" }), null);
eq("inside 24h, nothing booked -> model cancels", cancelStateReply({ ownOrders: confirmed, message: "Cancel my order", tag: "cancellation", now: NOW }), null);
eq("past 24h but not dispatched -> 24-hour line", cancelStateReply({ ownOrders: oldConfirmed, message: "Cancel my order", tag: "cancellation", now: NOW }), CANCEL_TOO_OLD_REPLY);
eq("past 24h, insists -> email", cancelStateReply({ ownOrders: oldConfirmed, message: "please cancel it", tag: "cancellation", lastBotReply: CANCEL_TOO_OLD_REPLY, now: NOW }), CANCEL_INSIST_REPLY);
eq("dispatched beats too old", cancelStateReply({ ownOrders: [...shipped, ...oldConfirmed], message: "Cancel my order", tag: "cancellation", now: NOW }), CANCEL_REPLY);
// 12 Oct review: a message that TALKS ABOUT a cancellation is not a request, and a cancel after complaints is not a policy question.
eq("'my order got cancelled by your delivery partner' is not a cancel request", cancelStateReply({ ownOrders: shipped, message: "Last time you said same and my order got cancelled by your delivery partner", tag: "cancellation", now: NOW }), null);
eq("'cancel' as a request still gets the rule", cancelStateReply({ ownOrders: shipped, message: "Cancel", tag: "cancellation", now: NOW }), CANCEL_REPLY);
eq("'ok then cancel the order' after complaining about the wait goes to the model, not the bare refusal", cancelStateReply({ ownOrders: shipped, message: "Ok then cancel the order", tag: "cancellation", now: NOW, recentCustomer: ["Kurla is away from my home is 30 minute why take time 7 days"] }), null);
eq("the same request with no complaint before it still gets the rule", cancelStateReply({ ownOrders: shipped, message: "Ok then cancel the order", tag: "cancellation", now: NOW, recentCustomer: ["hi"] }), CANCEL_REPLY);
console.log(`${passed} passed, 0 failed`);
