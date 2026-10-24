import assert from "node:assert/strict";
import { phoneAnyHour } from "@/lib/phoneAnyHour";
import { PHONE_ASK_REPLY } from "@/lib/topicReplies";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const booked = [{ id: "AJUKI1", status: "shipped", awb_code: "SF123" }];
const unbooked = [{ id: "AJUKI2", status: "confirmed", awb_code: null }];
const rto = [{ id: "AJUKI3", status: "rto", awb_code: "SF9" }];

eq("the title, parcel with the courier", phoneAnyHour({ message: "Update phone", lastBotReply: null, ownOrders: booked }), true);
eq("typed with a full stop", phoneAnyHour({ message: " update phone. ", lastBotReply: null, ownOrders: booked }), true);
eq("the title, nothing dispatched: the model can do it, in hours", phoneAnyHour({ message: "Update phone", lastBotReply: null, ownOrders: unbooked }), false);
eq("the title, parcel returning: a settled line, in hours", phoneAnyHour({ message: "Update phone", lastBotReply: null, ownOrders: rto }), false);
eq("the title, no orders", phoneAnyHour({ message: "Update phone", lastBotReply: null, ownOrders: [] }), false);
eq("the number after our ask", phoneAnyHour({ message: "9000100021", lastBotReply: PHONE_ASK_REPLY, ownOrders: booked }), true);
eq("a number with no ask before it", phoneAnyHour({ message: "9000100021", lastBotReply: "Your order is on its way.", ownOrders: booked }), false);
eq("something else after our ask", phoneAnyHour({ message: "where is my parcel", lastBotReply: PHONE_ASK_REPLY, ownOrders: booked }), false);
eq("other messages", phoneAnyHour({ message: "Update phone number please call me", lastBotReply: null, ownOrders: booked }), false);
eq("All good", phoneAnyHour({ message: "All good", lastBotReply: null, ownOrders: booked }), false);
console.log(`${passed} passed, 0 failed`);
