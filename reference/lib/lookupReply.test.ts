import assert from "node:assert/strict";
import { greetingReply, orderLookupReply, bareOrderId, barePhone, GREETING_REPLY } from "@/lib/lookupReply";
import { LATE_REPLY } from "@/lib/lateDeliveryReply";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const d = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const has = (name: string, got: string | null | undefined, sub: string) => { assert.ok(got?.includes(sub), `${name}: expected to contain "${sub}", got "${got}"`); passed++; };

// greeting
for (const m of ["Hi, I have a question about AJUKI", "hi I have a question about ajuki!", "I have a question about AJUKI"]) eq(`prefilled: ${m}`, greetingReply({ message: m, lastOutAt: d(0), now: NOW }), GREETING_REPLY);
eq("bare hi, first touch", greetingReply({ message: "Hi", now: NOW }), GREETING_REPLY);
eq("bare hello, last spoke yesterday", greetingReply({ message: "Hello", lastOutAt: d(-1), now: NOW }), GREETING_REPLY);
eq("bare hello right after we spoke -> not a greeting", greetingReply({ message: "Hello??", lastOutAt: new Date(NOW - 3_600_000).toISOString(), now: NOW }), null);
eq("hi plus a question", greetingReply({ message: "Hi where is my order", now: NOW }), null);

// extraction
eq("bare id", bareOrderId("AJUKI710031"), "AJUKI710031");
eq("id with words", bareOrderId("my order id is AJUKI710031"), null);
eq("id with label", bareOrderId("order id: ajuki710031"), "AJUKI710031");
eq("not an id", bareOrderId("where is AJUKI710031"), null);
eq("phone", barePhone("9876543210"), "9876543210");
eq("phone +91", barePhone("+91 98765 43210"), "9876543210");
eq("short number", barePhone("12345"), null);

const shipped = { id: "AJUKI710009", status: "shipped", estimated_delivery: d(2), tracking_url: "https://track.example/1" };
const prep = { id: "AJUKI710018", status: "confirmed", estimated_delivery: d(5) };
const done = { id: "AJUKI710030", status: "delivered", delivered_at: d(-3) };
const late = { id: "AJUKI710041", status: "shipped", estimated_delivery: d(-5), tracking_url: "https://track.example/4" };
const base = { senderPhone: "9876543210", mentionedOrders: [] as never[], now: NOW };

const r1 = orderLookupReply({ ...base, message: "AJUKI710009", ownOrders: [shipped] })!;
has("own shipped", r1.text, "Order AJUKI710009 is on its way."); has("own shipped eta", r1.text, "Expected around"); has("own shipped track is always our own page", r1.text, "Track it at www.ajuki.in/track."); eq("never the courier link", r1.text.includes("track.example"), false); eq("no escalate", r1.escalate, false);
has("own prep", orderLookupReply({ ...base, message: "AJUKI710018", ownOrders: [prep] })!.text, "is being prepared for dispatch");
has("own delivered", orderLookupReply({ ...base, message: "AJUKI710030", ownOrders: [done] })!.text, "was delivered on");
const r2 = orderLookupReply({ ...base, message: "AJUKI710041", ownOrders: [late] })!;
has("overdue gets the flag line", r2.text, LATE_REPLY); eq("overdue escalates", r2.escalate, true); assert.ok(!r2.text.includes("Expected around")); passed++;
const r3 = orderLookupReply({ ...base, message: "AJUKI710009", ownOrders: [], mentionedOrders: [shipped] })!;
has("typed id, not theirs: status", r3.text, "is on its way"); assert.ok(!r3.text.includes("track.example") && !r3.text.includes("Expected")); passed++;
has("unknown id", orderLookupReply({ ...base, message: "AJUKI710092", ownOrders: [] })!.text, "couldn't find that order");
const r4 = orderLookupReply({ ...base, message: "9876543210", ownOrders: [shipped, prep, done, late] })!;
has("own number lists orders", r4.text, "Your recent orders:"); assert.equal(r4.text.split("•").length - 1, 3); passed++;
has("other number reveals nothing", orderLookupReply({ ...base, message: "9000000000", ownOrders: [shipped] })!.text, "For privacy");
has("own number, no orders", orderLookupReply({ ...base, message: "9876543210", ownOrders: [] })!.text, "couldn't find an order on this number");
const wrong = orderLookupReply({ ...base, message: "AJUKI710027", ownOrders: [shipped, prep] })!;
has("wrong id, own orders exist: says so", wrong.text, "couldn't find an order with that ID");
has("wrong id: lists their orders", wrong.text, "AJUKI710009"); has("wrong id: lists their orders", wrong.text, "AJUKI710018");
has("wrong id: asks which", wrong.text, "Which of these are you asking about?");
eq("wrong id: does not escalate", wrong.escalate, false);
assert.ok(!wrong.text.includes("track.example")); passed++; // the list carries no tracking link
eq("not a bare id or number", orderLookupReply({ ...base, message: "where is my order", ownOrders: [shipped] }), null);
// 25 Oct (founder): one day past the date is not "overdue", but the date is no longer an expectation
{
  const at = (daysAfterEstimate: number) => ({ id: "AJUKI710013", status: "shipped", estimated_delivery: "2026-10-23" , _now: Date.parse("2026-10-23T00:00:00Z") + daysAfterEstimate * 86_400_000 + 6 * 3_600_000 });
  const lk = (days: number) => { const o = at(days); return orderLookupReply({ message: "AJUKI710013", senderPhone: "9000000001", ownOrders: [o], mentionedOrders: [], now: o._now }); };
  const same = lk(0), one = lk(1), two = lk(2);
  has("on the day: still expected", same?.text, "Expected around 23 Oct.");
  has("one day late: was expected, running late", one?.text, "It was expected around 23 Oct and is running a little late.");
  has("one day late: the 18 Oct reassurance", one?.text, "working to get it delivered as soon as possible, so there is no need to worry.");
  eq("one day late: no escalation, no 'overdue'", [one?.escalate, /overdue|escalat/i.test(one?.text ?? "")], [false, false]);
  eq("two days late: the existing late handling", [two?.escalate, /expected around/i.test(two?.text ?? "")], [true, false]);
  eq("before the date: unchanged", /Expected around 23 Oct\./.test(lk(-2)?.text ?? ""), true);
}
console.log(`${passed} passed, 0 failed`);
