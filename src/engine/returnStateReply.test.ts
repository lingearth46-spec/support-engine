import assert from "node:assert/strict";
import { returnStateReply, CHASING_AGAIN_REPLY, isCanned, PENDING_REPLY, CHASING_REPLY, APPROVED_APPEAL_REPLY, rejectedReply, CANCEL_RETURN_REPLY, WINDOW_CLOSED_EMAIL_REPLY, RETURN_PAGE_REPLY, NO_RETURN_EMAIL_REPLY, EXCHANGE_EMAIL_REPLY } from "@engine/returnStateReply";

const RECENT = new Date(Date.now() - 2 * 86_400_000).toISOString();
const OLD = new Date(Date.now() - 20 * 86_400_000).toISOString();
const o = (status: string, resolved_at?: string) => [{ id: "AJUKI1", status: "delivered" as never, delivered_at: RECENT, return_request: { status, resolved_at } as never }];
const none = [{ id: "AJUKI1", status: "delivered" as never, delivered_at: RECENT, return_request: null }];
let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.equal(got, want, name); passed++; };

// pending: always the same line, whatever they ask
for (const msg of ["What is the status of my return?", "It's been days, approve fast", "Can I get my refund now?", "Hello??"]) {
  eq(`pending: ${msg}`, returnStateReply({ ownOrders: o("pending"), message: msg, tag: "return" }), PENDING_REPLY);
}
// rejected: appeal line with the date, the same every time
const rej = rejectedReply("2026-10-07T10:00:00Z");
eq("rejected why", returnStateReply({ ownOrders: o("rejected", "2026-10-07T10:00:00Z"), message: "Why was my return rejected?", tag: "return" }), rej);
eq("rejected exchange", returnStateReply({ ownOrders: o("rejected", "2026-10-07T10:00:00Z"), message: "Can I exchange it for another colour?", tag: "exchange" }), rej);
eq("rejected has email", rej.includes("ajukisupport@gmail.com") && rej.includes("Senior Support Team"), true);
// rejected + chasing → the Senior Support line
for (const msg of ["I already emailed, no one replied", "Where is the reply to my email??", "Hello? Reply!!"]) {
  eq(`chasing: ${msg}`, returnStateReply({ ownOrders: o("rejected", "2026-10-07T10:00:00Z"), message: msg, tag: "complaint" }), CHASING_REPLY);
}
// not touched
for (const msg of ["Can I get a refund instead?", "I want a refund, not a replacement", "I don't want the replacement", "give me my money back", "How to get a refund?"]) {
  eq(`approved wants different outcome: ${msg}`, returnStateReply({ ownOrders: o("approved"), message: msg, tag: "refund" }), APPROVED_APPEAL_REPLY);
}
eq("approved refund STATUS stays with the model", returnStateReply({ ownOrders: o("approved"), message: "When will I get my refund?", tag: "refund" }), null);
eq("approved is the model's", returnStateReply({ ownOrders: o("approved"), message: "Where is my pickup?", tag: "return" }), null);
eq("no return filed, not about returns", returnStateReply({ ownOrders: none, message: "Where is my order?", tag: "order_status" }), null);
eq("no return on record -> returns page", returnStateReply({ ownOrders: none, message: "I want to return my order", tag: "return" }), RETURN_PAGE_REPLY);
eq("insists -> email", returnStateReply({ ownOrders: none, message: "I want to return it, please help", tag: "return", lastBotReply: RETURN_PAGE_REPLY }), NO_RETURN_EMAIL_REPLY);
for (const msg of ["I want to exchange this bracelet", "Can I swap it for a bigger size?", "please change the size of my bracelet"]) {
  eq(`exchange straight to email: ${msg}`, returnStateReply({ ownOrders: none, message: msg, tag: "exchange" }), EXCHANGE_EMAIL_REPLY);
}
eq("exchange detected from text even if tagged return", returnStateReply({ ownOrders: none, message: "I want to exchange it", tag: "return" }), EXCHANGE_EMAIL_REPLY);
eq("after the exchange email, insisting -> email", returnStateReply({ ownOrders: none, message: "Hello?? reply", tag: "other", lastBotReply: EXCHANGE_EMAIL_REPLY }), NO_RETURN_EMAIL_REPLY);
eq("return request after the exchange email -> returns page", returnStateReply({ ownOrders: none, message: "I want to return my order", tag: "return", lastBotReply: EXCHANGE_EMAIL_REPLY }), RETURN_PAGE_REPLY);
eq("chasing after the exchange email -> email", returnStateReply({ ownOrders: none, message: "I emailed, no reply", tag: "other", lastBotReply: EXCHANGE_EMAIL_REPLY }), NO_RETURN_EMAIL_REPLY);
for (const [msg, tag] of [["Order wrong, I want white colour", "complaint"], ["the bracelet is too big", "sizing"], ["the hook is broken", "complaint"], ["Cheap quality, colour came off", "complaint"]] as const) {
  eq(`fault, no return filed -> returns page: ${msg}`, returnStateReply({ ownOrders: none, message: msg, tag }), RETURN_PAGE_REPLY);
}
eq("fault, pending -> wait", returnStateReply({ ownOrders: o("pending"), message: "the bracelet is too big", tag: "sizing" }), PENDING_REPLY);
eq("fault, rejected -> appeal", returnStateReply({ ownOrders: o("rejected", "2026-10-07T10:00:00Z"), message: "it arrived damaged", tag: "complaint" }), rej);
eq("fault, approved -> the model (automatic workflow)", returnStateReply({ ownOrders: o("approved"), message: "the bracelet is too big", tag: "sizing" }), null);
eq("'missing' on a late parcel is not a fault", returnStateReply({ ownOrders: none, message: "my parcel is missing", tag: "late_delivery" }), null);
eq("rejected return + a separate late parcel -> not the return line", returnStateReply({ ownOrders: o("rejected", "2026-10-07T10:00:00Z"), message: "my other order is still not delivered, no response from the agent", tag: "late_delivery" }), null);
eq("pending return + a cancellation -> not the return line", returnStateReply({ ownOrders: o("pending"), message: "cancel my other order", tag: "cancellation" }), null);
for (const msg of ["cancel the return please", "Can I cancel the return and keep the item?", "I want to withdraw my return request", "stop the pickup", "I don't want to return it anymore", "I will keep the item"]) {
  eq(`pending, cancel the return -> email: ${msg}`, returnStateReply({ ownOrders: o("pending"), message: msg, tag: "cancellation" }), CANCEL_RETURN_REPLY);
}
eq("approved, cancel the return -> email", returnStateReply({ ownOrders: o("approved"), message: "Please cancel my return", tag: "cancellation" }), CANCEL_RETURN_REPLY);
eq("pending, 'cancel my other order' is not a return cancel", returnStateReply({ ownOrders: o("pending"), message: "cancel my other order", tag: "cancellation" }), null);
eq("rejected, nothing left to cancel", returnStateReply({ ownOrders: o("rejected", "2026-10-07T10:00:00Z"), message: "cancel the return", tag: "cancellation" }), rej);
// ── return window closed -> email, never the form ──
const oldNone = [{ id: "AJUKI1", status: "delivered" as never, delivered_at: OLD, return_request: null }];
const noDate = [{ id: "AJUKI1", status: "delivered" as never, delivered_at: null, return_request: null }];
eq("closed window -> email", returnStateReply({ ownOrders: oldNone, message: "I want to return my order", tag: "return" }), WINDOW_CLOSED_EMAIL_REPLY);
eq("closed window, fault claim -> email", returnStateReply({ ownOrders: oldNone, message: "the bracelet is too big", tag: "sizing" }), WINDOW_CLOSED_EMAIL_REPLY);
eq("no delivery date on record -> email (a person looks)", returnStateReply({ ownOrders: noDate, message: "I want to return my order", tag: "return" }), WINDOW_CLOSED_EMAIL_REPLY);
eq("one order open, one closed -> the form", returnStateReply({ ownOrders: [...oldNone, ...none], message: "I want to return my order", tag: "return" }), RETURN_PAGE_REPLY);
eq("the reply never mentions the window", WINDOW_CLOSED_EMAIL_REPLY.toLowerCase().includes("window") || WINDOW_CLOSED_EMAIL_REPLY.toLowerCase().includes("7"), false);
eq("closed window, insists -> the email line", returnStateReply({ ownOrders: oldNone, message: "please help me return it", tag: "return", lastBotReply: WINDOW_CLOSED_EMAIL_REPLY }), NO_RETURN_EMAIL_REPLY);
eq("asks where -> page again", returnStateReply({ ownOrders: none, message: "Where do I return it?", tag: "return", lastBotReply: RETURN_PAGE_REPLY }), RETURN_PAGE_REPLY);
eq("keeps insisting -> email again", returnStateReply({ ownOrders: none, message: "Hello?? reply", tag: "other", lastBotReply: NO_RETURN_EMAIL_REPLY }), NO_RETURN_EMAIL_REPLY);
eq("refund already on record -> model", returnStateReply({ ownOrders: none, message: "I want my refund", tag: "refund", hasRefundRecord: true }), null);
eq("order not delivered -> model", returnStateReply({ ownOrders: [{ id: "A", status: "shipped" as never, return_request: null }], message: "I want to return my order", tag: "return" }), null);
eq("two returns", returnStateReply({ ownOrders: [...o("pending"), { id: "AJUKI2", status: "delivered" as never, delivered_at: RECENT, return_request: { status: "rejected" } as never }], message: "status?", tag: "return" }), null);
eq("other topic on a rejected return", returnStateReply({ ownOrders: o("rejected"), message: "Do you have a gold chain in stock?", tag: "product_info" }), null);
eq("continuing our canned line", returnStateReply({ ownOrders: o("pending"), message: "Ok", tag: "order_status", lastBotReply: PENDING_REPLY }), PENDING_REPLY);

// ── 11 Oct, founder: a chase after "please wait for their reply" gets a second line; "how long should I wait" is a chase (V2 only) ──
{
  const rej2 = o("rejected", "2026-10-07T10:00:00Z");
  eq("v2: chasing again after the first chase line", returnStateReply({ ownOrders: rej2, message: "I have emailed, still no reply", tag: "other", lastBotReply: CHASING_REPLY, v2: true }), CHASING_AGAIN_REPLY);
  eq("the second chase gets the softer line without any switch (founder agreed 14 Oct)", returnStateReply({ ownOrders: rej2, message: "I have emailed, still no reply", tag: "other", lastBotReply: CHASING_REPLY }), CHASING_AGAIN_REPLY);
  eq("v2: the first chase still gets the first line", returnStateReply({ ownOrders: rej2, message: "I have emailed, no reply", tag: "other", lastBotReply: rejectedReply("2026-10-07T10:00:00Z"), v2: true }), CHASING_REPLY);
  eq("v2: 'how much should I wait?' is a chase", returnStateReply({ ownOrders: rej2, message: "How much should I wait?", tag: "other", lastBotReply: rejectedReply("2026-10-07T10:00:00Z"), v2: true }), CHASING_REPLY);
  eq("flag off: it is not a chase, so it gets the rejection line again, in its short form now that they were told (14 Oct)", returnStateReply({ ownOrders: rej2, message: "How much should I wait?", tag: "other", lastBotReply: rejectedReply("2026-10-07T10:00:00Z") }), rejectedReply("2026-10-07T10:00:00Z", { repeat: true }));
  eq("v2: and again after the first line gets the second", returnStateReply({ ownOrders: rej2, message: "How much should I wait?", tag: "other", lastBotReply: CHASING_REPLY, v2: true }), CHASING_AGAIN_REPLY);
  eq("v2: a non-chase after the chase line is the rejection line", returnStateReply({ ownOrders: rej2, message: "ok", tag: "other", lastBotReply: CHASING_REPLY, v2: true }), rejectedReply("2026-10-07T10:00:00Z"));
  eq("the second line is a canned line (a reply that continues it is recognised)", isCanned(CHASING_AGAIN_REPLY), true);
  eq("the second line names the support email and promises nothing timed", CHASING_AGAIN_REPLY.includes("ajukisupport@gmail.com") && !/\b(hours?|days?|within|soon)\b/i.test(CHASING_AGAIN_REPLY), true);
}

// ── 14 Oct (founder: Agree on Return pending, Return rejected, Chasing a decision) ──
import { REJECTED_SORRY, REJECTED_APPEAL_SHORT, wasRejectedLine } from "@engine/returnStateReply";
const eqd = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; }; // this file's eq compares with ==, which is not enough for arrays
const first = rejectedReply("2026-10-07T10:00:00Z");
eqd("rejected, first time: an apology, then the date and the appeal route", [first.startsWith(REJECTED_SORRY), first.includes("rejected on 7 Oct"), first.includes("ajukisupport@gmail.com")], [true, true, true]);
eq("rejected, told before: only the appeal route", rejectedReply("2026-10-07T10:00:00Z", { repeat: true }), REJECTED_APPEAL_SHORT);
eq("the short form says nothing but the way to appeal", /sorry|rejected/i.test(REJECTED_APPEAL_SHORT), false);
eqd("we recognise the first line and the short one as already said", [wasRejectedLine(first), wasRejectedLine(REJECTED_APPEAL_SHORT), wasRejectedLine("Hello"), wasRejectedLine(null)], [true, true, false, false]);
eq("asked about a rejected return after being told: the short form", returnStateReply({ ownOrders: o("rejected", "2026-10-07T10:00:00Z"), message: "why was it rejected", tag: "return", lastBotReply: first }), REJECTED_APPEAL_SHORT);
eq("an old-wording rejection line in the thread counts as told too", returnStateReply({ ownOrders: o("rejected", "2026-10-07T10:00:00Z"), message: "why was it rejected", tag: "return", lastBotReply: "Your return request was reviewed and rejected on 7 Oct. If you would like to appeal, please email our Senior Support Team at ajukisupport@gmail.com with your order number and any photos or video showing the issue." }), REJECTED_APPEAL_SHORT);
eq("a pending return is not the answer to an exchange request", returnStateReply({ ownOrders: o("pending"), message: "Exchange this product", tag: "exchange" }), EXCHANGE_EMAIL_REPLY);
eq("but a question about the pending return still gets the pending line", returnStateReply({ ownOrders: o("pending"), message: "what about my return and exchange", tag: "return" }), PENDING_REPLY);
eq("and chasing the pending return is not an exchange", returnStateReply({ ownOrders: o("pending"), message: "no reply to my exchange email", tag: "exchange" }), PENDING_REPLY);
console.log(`${passed} passed, 0 failed`);
