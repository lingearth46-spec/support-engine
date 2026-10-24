import assert from "node:assert/strict";
import { lateEscalation } from "@/lib/lateEscalate";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const NOW = Date.parse("2026-10-24T08:00:00Z");
const U = { id: "AJUKI710054", status: "undelivered", estimated_delivery: "2026-10-21" };

// 24 Oct, ..2290: undelivered since 15 Oct, due 21 Oct
eq("angry, undelivered", typeof lateEscalation({ message: "You guys were unfit for this. If you are not capable stop doing all these", orders: [U], now: NOW }), "string");
eq("rider never came", typeof lateEscalation({ message: "Again it was showing attempted but no one came here to deliver", orders: [U], now: NOW }), "string");
eq("nobody called", typeof lateEscalation({ message: "nobody called me", orders: [U], now: NOW }), "string");
// ..3200: disputes the attempts on a parcel that is returning
eq("disputes attempts on an RTO", typeof lateEscalation({ message: "it was only once the delivery was attempted", orders: [{ id: "A", status: "rto" }], now: NOW }), "string");
eq("an RTO and just unhappy: nothing (it is a settled line)", lateEscalation({ message: "this is useless", orders: [{ id: "A", status: "rto" }], now: NOW }), null);
// shipped parcels: only when well past the date
eq("shipped, 5 days past, unhappy", typeof lateEscalation({ message: "worst service ever", orders: [{ id: "B", status: "shipped", estimated_delivery: "2026-10-19" }], now: NOW }), "string");
eq("shipped, 1 day past, unhappy", lateEscalation({ message: "worst service ever", orders: [{ id: "B", status: "shipped", estimated_delivery: "2026-10-23" }], now: NOW }), null);
eq("shipped, on time", lateEscalation({ message: "worst service ever", orders: [{ id: "B", status: "shipped", estimated_delivery: "2026-10-28" }], now: NOW }), null);
// a calm question is not this
eq("calm chaser", lateEscalation({ message: "where is my order?", orders: [U], now: NOW }), null);
eq("delivered order", lateEscalation({ message: "worst service ever", orders: [{ id: "C", status: "delivered" }], now: NOW }), null);
eq("no orders", lateEscalation({ message: "worst service ever", orders: [], now: NOW }), null);
eq("no date on a shipped order", lateEscalation({ message: "worst service ever", orders: [{ id: "D", status: "shipped" }], now: NOW }), null);
console.log(`${passed} passed, 0 failed`);
