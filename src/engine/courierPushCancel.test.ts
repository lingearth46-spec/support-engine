// Run with `npx tsx lib/courierPushCancel.test.ts`.
import assert from "node:assert/strict";
import { courierPushesCancel } from "@engine/courierPushCancel";
import { cancelStateReply, CANCEL_REPLY } from "@engine/cancelStateReply";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };

for (const m of [
  "The courier guy want's me to cancel my order but I don't want to cancel it",
  "delivery boy is asking me to cancel the order",
  "rider told me to cancel",
  "I do not want to cancel",
  "Shadowfax says cancel it and reorder",
]) eq(`not a request: ${m}`, courierPushesCancel(m), true);
for (const m of ["cancel my order", "please cancel", "I want to cancel", "Order cancel now", "Immediately first order now", "ok then cancel the order", "my order got cancelled by the courier"]) eq(`a request or unrelated: ${m}`, courierPushesCancel(m), false);

// the cancel-state rule leaves the first one alone, and still answers a real request
const booked = [{ id: "AJUKI1", status: "undelivered", awb_code: "SF123", created_at: "2026-10-10T00:00:00Z" }];
eq("the dispatch rule is not the answer to a refusal", cancelStateReply({ ownOrders: booked, message: "The courier guy want's me to cancel my order but I don't want to cancel it", tag: "cancellation" }), null);
eq("a plain request still gets it", cancelStateReply({ ownOrders: booked, message: "Cancel my order", tag: "cancellation" }), CANCEL_REPLY);
console.log(`courierPushCancel: ${passed} assertions passed`);
