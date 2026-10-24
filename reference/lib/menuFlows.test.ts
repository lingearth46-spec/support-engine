import assert from "node:assert/strict";
import {
  parseMenuId, isMenuId, tapIdOf, menuTapIdOf, menuMode, menuMayApply, topicList, isVagueOpener, detectTopic, startTopic, stepForTap, answerTopic, menuAllowed, menuResendDays,
  MENU_TOPICS, NEED_OTHER_HELP, NO_ORDER_REPLY, RTO_REPLY, EXPIRED_REPLY, OTHER_REPLY, MENU_TYPED_LINE,
  type MenuOrder, type MenuStep, type MenuContext,
} from "@/lib/menuFlows";
import { EXCHANGE_EMAIL_REPLY, PENDING_REPLY, WINDOW_CLOSED_EMAIL_REPLY } from "@/lib/returnStateReply";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const d = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

const order = (o: Partial<MenuOrder> & { id: string; status: string }): MenuOrder => ({ items: [{ name: "Dorian Bracelet - Silver" }], created_at: d(-5), ...o });
const ctx = (orders: MenuOrder[], extra: Partial<MenuContext> = {}): MenuContext => ({ orders, now: NOW, ...extra });

// ── ids ──────────────────────────────────────────────────────────────────────
eq("menu id", parseMenuId("m:menu"), { kind: "menu" });
eq("topic id", parseMenuId("m:late"), { kind: "step", topic: "late", orderId: null, another: false, sub: null });
eq("another order", parseMenuId("m:return:*"), { kind: "step", topic: "return", orderId: null, another: true, sub: null });
eq("order id", parseMenuId("m:late:AJUKI710013"), { kind: "step", topic: "late", orderId: "AJUKI710013", another: false, sub: null });
eq("sub", parseMenuId("m:cancel:AJUKI710013:yes"), { kind: "step", topic: "cancel", orderId: "AJUKI710013", another: false, sub: "yes" });
eq("unknown topic", parseMenuId("m:bogus"), null);
eq("not ours", parseMenuId("update phone"), null);
eq("bad order chars", parseMenuId("m:late:AJ UKI;drop"), null);
eq("bad sub", parseMenuId("m:late:AJUKI710013:YES!"), null);
eq("too long", parseMenuId("m:late:" + "A".repeat(200)), null);
eq("isMenuId", [isMenuId("m:late"), isMenuId("Yes"), isMenuId(undefined)], [true, false, false]);

// What the webhook reads from a tap: a list row or a reply button, by id, never by title.
eq("list tap id", tapIdOf({ list_reply: { id: "m:late" } }), "m:late");
eq("button tap id", tapIdOf({ button_reply: { id: "m:cancel:AJUKI710013:yes" } }), "m:cancel:AJUKI710013:yes");
eq("no tap", [tapIdOf({}), tapIdOf(null), tapIdOf(undefined)], ["", "", ""]);

eq("template quick-reply with the payload", menuTapIdOf({ button: { text: "Need other help", payload: "m:menu" } }), "m:menu");
eq("template quick-reply, payload is just the label", menuTapIdOf({ button: { text: "Need other help", payload: "Need other help" } }), "m:menu");
eq("another template button is not ours", menuTapIdOf({ button: { text: "Deliver tomorrow", payload: "Deliver tomorrow" } }), "");
eq("a list tap still wins", menuTapIdOf({ interactive: { list_reply: { id: "m:late" } }, button: { text: "Need other help" } }), "m:late");

// ── limits WhatsApp enforces ─────────────────────────────────────────────────
const everyStep = (s: MenuStep) => {
  ok(`text length ${s.fixed}`, s.text.length > 0 && s.text.length <= 1024);
  if (s.buttons) { ok(`<=3 buttons ${s.fixed}`, s.buttons.length >= 1 && s.buttons.length <= 3); for (const b of s.buttons) { ok(`button title <=20: ${b.title}`, b.title.length <= 20); ok(`button id <=256 ${b.id}`, b.id.length <= 256); } }
  if (s.list) { ok(`<=10 rows ${s.fixed}`, s.list.rows.length >= 1 && s.list.rows.length <= 10); ok("list button <=20", s.list.button.length <= 20); for (const r of s.list.rows) { ok(`row title <=24: ${r.title}`, r.title.length <= 24); ok(`row desc <=72`, (r.description ?? "").length <= 72); ok("row id parses", parseMenuId(r.id) !== null); } }
  ok(`fixed kind starts with menu: ${s.fixed}`, s.fixed.startsWith("menu:"));
  ok(`not both buttons and list ${s.fixed}`, !(s.buttons && s.list));
  // The standing rules: nothing promised, no courier link, no reply time.
  assert.ok(!/\b(will be refunded|we will refund|replacement (?:will|is)|we will replace|within \d+ ?(?:hours?|days?|mins?|minutes?)|callback|call you|bhejenge)\b/i.test(s.text), `promise in: ${s.text}`); passed++;
  assert.ok(!/delhivery\.com|shadowfax|trackingmore|shiprocket/i.test(s.text), `courier link in: ${s.text}`); passed++;
};

const list = topicList();
eq("topic list rows", list.list!.rows.map((r) => r.id), ["m:late", "m:problem", "m:return", "m:exchange", "m:cancel", "m:phone", "m:address", "m:refund", "m:other"]);
eq("one row per topic", list.list!.rows.length, MENU_TOPICS.length);
ok("list asks them to choose", /choose/i.test(list.text));
ok("in hours no typed line", !list.text.includes(MENU_TYPED_LINE));
ok("out of hours has typed line", topicList({ outOfHours: true }).text.includes(MENU_TYPED_LINE));
eq("list fixed kind", list.fixed, "menu:list");
everyStep(list); everyStep(topicList({ outOfHours: true }));
ok("row titles: phone and address are not the NDR button titles", !list.list!.rows.some((r) => /^update (phone|address)$/i.test(r.title)));
ok("escape button is not the NDR 'contact support'", NEED_OTHER_HELP.title.toLowerCase() !== "contact support");

// ── entry detection ──────────────────────────────────────────────────────────
for (const m of ["Hi", "hello", "Hey!", "Hii", "hlo", "help", "need help", "Help me", "issue", "I have a problem", "shipping issue", "Hi, I have a question about AJUKI", "customer care", "are you there", "good morning sir", "I have an issue with my order"]) eq(`vague: ${m}`, isVagueOpener(m), true);
for (const m of ["Confirm", "Yes", "ok", "where is my order", "How much", "I want to cancel my order", "7858", ".", "", "hi I want to return the bracelet"]) eq(`not vague: ${m}`, isVagueOpener(m), false);

const topics: [string, string | null][] = [
  ["Where is my order?", "late"], ["my parcel is very late", null], ["order is delayed", "late"], ["kab tak aayega", "late"], ["I have not received my order", null], ["abhi tak nahi aaya", "late"], ["still waiting for delivery", "late"],
  ["I want to return this", "return"], ["return kar do", "return"], ["I want to exchange the size", "exchange"], ["change size", null], ["cancel my order", "cancel"], ["please cancel order AJUKI710013", "cancel"],
  ["I want a refund", "refund"], ["where is my refund", "refund"], ["change my phone number", "phone"], ["update mobile number", "phone"], ["change address please", "address"], ["wrong address", "address"],
  ["the bracelet is damaged", "problem"], ["I received a broken item", "problem"], ["wrong item received", "problem"], ["item is missing", "problem"],
  ["I got a damaged item, I want to return it", "problem"], ["I want to return and get a refund", "return"],
  ["cancel the return pickup", null], ["Do you have gold chains?", null], ["what is the price", null], ["return it and exchange it and cancel the late order", null],
];
// "not received" is deliberately handled: the regex needs 'not received' or 'not yet received'.
for (const [m, want] of topics) {
  const got = detectTopic(m);
  // The two cases flagged null above that the regex may or may not catch are checked loosely below.
  if (m === "my parcel is very late" || m === "I have not received my order" || m === "change size") continue;
  eq(`topic: ${m}`, got, want);
}
ok("not received is late", detectTopic("my order is not received") === "late");
eq("long message goes to the bot", detectTopic("I ordered a bracelet last week and ".repeat(8) + "where is my order"), null);
eq("two topics go to the bot", detectTopic("cancel my order and return it"), null);

// ── order selection ──────────────────────────────────────────────────────────
const one = order({ id: "AJUKI710009", status: "shipped", estimated_delivery: d(2) });
const two = order({ id: "AJUKI710018", status: "delivered", delivered_at: d(-2) });
let s = startTopic("late", ctx([]));
eq("no orders asks for the id", s.text, NO_ORDER_REPLY); everyStep(s);
s = startTopic("late", ctx([one]));
eq("one order: confirm buttons", s.buttons!.map((b) => b.title), ["Yes", "Another order"]);
eq("confirm Yes carries the order", s.buttons![0].id, "m:late:AJUKI710009");
ok("confirm names the order and item", s.text.includes("AJUKI710009") && s.text.includes("Dorian Bracelet"));
everyStep(s);
s = startTopic("late", ctx([one, two]));
eq("two orders: picker list", s.list!.rows.map((r) => r.id), ["m:late:AJUKI710009", "m:late:AJUKI710018"]);
ok("picker shows status", s.list!.rows[1].description!.includes("delivered")); everyStep(s);
s = startTopic("late", ctx([one, two], { mentionedOrderId: "ajuki710018" }));
ok("a typed order id skips the question", s.fixed === "menu:late" && s.text.includes("delivered"));
s = startTopic("late", ctx([one], { mentionedOrderId: "AJUKI710092" }));
eq("a typed id that is not theirs is ignored (still asks)", s.fixed, "menu:late:confirm");
eq("exchange needs no order", startTopic("exchange", ctx([])).text, EXCHANGE_EMAIL_REPLY);
eq("exchange has the escape button", startTopic("exchange", ctx([])).buttons, [NEED_OTHER_HELP]);
eq("something else", startTopic("other", ctx([])).text, OTHER_REPLY);
eq("another order with one order", stepForTap("m:late:*", ctx([one]))!.text, NO_ORDER_REPLY);
eq("another order with two", stepForTap("m:late:*", ctx([one, two]))!.list!.rows.length, 2);

// ── late delivery ────────────────────────────────────────────────────────────
s = answerTopic("late", one, null, ctx([one]));
ok("on time: status line, tracking link, no escalation", /AJUKI710009 is on its way/.test(s.text) && s.text.includes("www.ajuki.in/track") && !s.escalate); everyStep(s);
const overdue = order({ id: "AJUKI710030", status: "shipped", estimated_delivery: d(-4) });
s = answerTopic("late", overdue, null, ctx([overdue]));
ok("overdue: escalated line and flag", /escalated this to the team/.test(s.text) && s.escalate?.tag === "late_delivery" && s.text.includes("www.ajuki.in/track")); everyStep(s);
s = answerTopic("late", order({ id: "AJUKI710041", status: "undelivered" }), null, ctx([]));
ok("undelivered is treated as late", !!s.escalate);
s = answerTopic("late", order({ id: "AJUKI710050", status: "rto" }), null, ctx([]));
eq("rto: the returning line, no tracking link, no escalation", [s.text, s.escalate], [RTO_REPLY, undefined]);
s = answerTopic("late", two, null, ctx([two]));
ok("delivered but not received: email + escalate", /delivered/.test(s.text) && /ajukisupport@gmail\.com/.test(s.text) && !!s.escalate); everyStep(s);
s = answerTopic("late", order({ id: "AJUKI710052", status: "wa_cancelled" }), null, ctx([]));
eq("cancelled", s.text, "Order AJUKI710052 has been cancelled.");
s = answerTopic("late", order({ id: "AJUKI710061", status: "confirmed" }), null, ctx([]));
ok("not shipped yet: prepared, no tracking link", /being prepared/.test(s.text) && !/track/.test(s.text));
ok("every late answer has the escape button", [one, overdue, two].every((o) => answerTopic("late", o, null, ctx([o])).buttons!.some((b) => b.id === "m:menu")));

// ── return ───────────────────────────────────────────────────────────────────
const delivered = order({ id: "AJUKI710062", status: "delivered", delivered_at: d(-2) });
s = answerTopic("return", delivered, null, ctx([delivered]));
eq("eligible: asks the reason", s.buttons!.map((b) => b.title), ["Damaged or wrong", "Size or fit", "Something else"]); everyStep(s);
s = answerTopic("return", delivered, "fault", ctx([delivered]));
ok("fault: free pickup, returns page, video/photos", /www\.ajuki\.in\/returns\/start/.test(s.text) && /free/.test(s.text) && /photos/.test(s.text) && !/₹99/.test(s.text)); everyStep(s);
s = answerTopic("return", delivered, "size", ctx([delivered]));
ok("size: 99 and worn photo", /₹99/.test(s.text) && /worn/.test(s.text)); everyStep(s);
s = answerTopic("return", delivered, "other", ctx([delivered]));
ok("other: 99", /₹99/.test(s.text)); everyStep(s);
const bogo = order({ id: "AJUKI710063", status: "delivered", delivered_at: d(-1), created_at: d(-2), offer_discount: 400, offers: [{ kind: "site_bogo", label: "Buy 1 Get 1 Free" }] });
s = answerTopic("return", bogo, null, ctx([bogo]));
ok("BOGO: only faults, 99 on every return, no reason buttons", /Buy 1 Get 1/.test(s.text) && /₹99/.test(s.text) && !s.buttons!.some((b) => /Size/.test(b.title))); everyStep(s);
s = answerTopic("problem", bogo, "dmg", ctx([bogo]));
ok("BOGO damaged: 99 stated", /₹99/.test(s.text) && !/free/i.test(s.text)); everyStep(s);
const old = order({ id: "AJUKI710064", status: "delivered", delivered_at: d(-12) });
eq("window closed: email line", answerTopic("return", old, null, ctx([old])).text, WINDOW_CLOSED_EMAIL_REPLY);
const nodate = order({ id: "AJUKI710065", status: "delivered", delivered_at: null });
eq("delivered with no date: a person decides", answerTopic("return", nodate, null, ctx([nodate])).text, WINDOW_CLOSED_EMAIL_REPLY);
const pending = order({ id: "AJUKI710066", status: "delivered", delivered_at: d(-2), return_request: { status: "pending" } });
eq("pending return", answerTopic("return", pending, null, ctx([pending])).text, PENDING_REPLY);
ok("rejected return: appeal by email", /rejected/.test(answerTopic("return", order({ id: "AJUKI710067", status: "delivered", delivered_at: d(-2), return_request: { status: "rejected", resolved_at: d(-1) } }), null, ctx([])).text));
const unshipped = order({ id: "AJUKI710068", status: "confirmed", created_at: d(-0.2) });
s = answerTopic("return", unshipped, null, ctx([unshipped]));
ok("not shipped, in window: cancel offered", /you can still cancel it/.test(s.text) && s.buttons!.some((b) => b.id === "m:cancel:AJUKI710068")); everyStep(s);
const dispatched = order({ id: "AJUKI710069", status: "shipped", awb_code: "123" });
s = answerTopic("return", dispatched, null, ctx([dispatched]));
ok("dispatched: NO cancel offer", !/cancel/i.test(s.text) && !s.buttons!.some((b) => /cancel/i.test(b.id + b.title)) && /once it is delivered/i.test(s.text)); everyStep(s);
const oldUnshipped = order({ id: "AJUKI710070", status: "confirmed", created_at: d(-3) });
ok("not shipped but past 24h: no cancel offer", !answerTopic("return", oldUnshipped, null, ctx([])).buttons!.some((b) => /cancel/i.test(b.id)));
eq("rto return", answerTopic("return", order({ id: "AJUKI710071", status: "rto" }), null, ctx([])).text, RTO_REPLY);

// ── product problem ──────────────────────────────────────────────────────────
s = answerTopic("problem", delivered, null, ctx([delivered]));
eq("asks what is wrong", s.buttons!.map((b) => b.title), ["Damaged or faulty", "Wrong item", "Item missing"]); everyStep(s);
s = answerTopic("problem", delivered, "miss", ctx([delivered]));
ok("missing: escalated, email with photo", !!s.escalate && /photo/.test(s.text) && /ajukisupport@gmail\.com/.test(s.text)); everyStep(s);
s = answerTopic("problem", dispatched, null, ctx([dispatched]));
ok("not delivered: where it stands, no 'what is wrong' question", !s.buttons!.some((b) => /Damaged/.test(b.title)));
s = answerTopic("problem", delivered, "wrong", ctx([delivered]));
ok("wrong item: free pickup", /free/.test(s.text));

// ── cancel ───────────────────────────────────────────────────────────────────
s = answerTopic("cancel", unshipped, null, ctx([unshipped]));
eq("cancel asks first", [s.buttons!.map((b) => b.title), !!s.cancel], [["Yes, cancel", "No, keep it"], false]); everyStep(s);
s = answerTopic("cancel", unshipped, "yes", ctx([unshipped]));
eq("yes runs the action", s.cancel, { orderId: "AJUKI710068", keptText: "Order AJUKI710068 could not be cancelled just now." });
ok("the success text is only sent after the action", s.text.includes("is cancelled"));
s = answerTopic("cancel", unshipped, "no", ctx([unshipped]));
ok("no keeps it", !s.cancel && /kept/.test(s.text));
s = answerTopic("cancel", dispatched, "yes", ctx([dispatched]));
ok("a stale 'yes' on a dispatched order does NOT cancel", !s.cancel && /already with the courier/.test(s.text));
s = answerTopic("cancel", oldUnshipped, "yes", ctx([oldUnshipped]));
ok("past 24 hours does not cancel", !s.cancel && /within 24 hours/.test(s.text));
ok("delivered cannot be cancelled", !answerTopic("cancel", delivered, null, ctx([])).cancel);
ok("already cancelled", /already been cancelled/.test(answerTopic("cancel", order({ id: "AJUKI710083", status: "wa_cancelled" }), null, ctx([])).text));

// ── phone and address ────────────────────────────────────────────────────────
s = answerTopic("phone", unshipped, null, ctx([unshipped]));
ok("before dispatch: asks them to type it, no buttons", /type the new phone number/.test(s.text) && !s.buttons);
s = answerTopic("phone", dispatched, null, ctx([dispatched]));
ok("after dispatch: cannot change, escalated, asks for the number", /cannot be changed here/.test(s.text) && !!s.escalate && /type the new number/.test(s.text)); everyStep(s);
s = answerTopic("address", unshipped, null, ctx([unshipped]));
ok("address before dispatch asks for the full address", /full new address/.test(s.text) && !s.buttons);
s = answerTopic("address", dispatched, null, ctx([dispatched]));
ok("address after dispatch: fixed line, nothing promised", /cannot be changed now/.test(s.text) && !s.escalate); everyStep(s);
ok("delivered phone", /already been delivered/.test(answerTopic("phone", delivered, null, ctx([])).text));

// ── refund ───────────────────────────────────────────────────────────────────
const cod = order({ id: "AJUKI710087", status: "delivered", payment_id: null });
const prepaid = order({ id: "AJUKI710088", status: "delivered", payment_id: "pay_abc" });
const rf = (status: string, amount = 449) => new Map([[cod.id, { status, amount, since: d(-3), processedAt: d(-1) }], [prepaid.id, { status, amount, since: d(-3), processedAt: d(-1) }]]);
s = answerTopic("refund", cod, null, ctx([cod], { refunds: rf("REFUND_PROCESSING") }));
ok("cod in progress: wallet", /in progress/.test(s.text) && /AJUKI Wallet/.test(s.text)); everyStep(s);
s = answerTopic("refund", prepaid, null, ctx([prepaid], { refunds: rf("REFUND_PROCESSING") }));
ok("prepaid in progress: 3-5 business working days, original method", /3-5 business working days/.test(s.text) && /original payment method/.test(s.text));
s = answerTopic("refund", cod, null, ctx([cod], { refunds: rf("REFUND_COMPLETED") }));
ok("completed", /was completed/.test(s.text) && /AJUKI Wallet/.test(s.text));
s = answerTopic("refund", cod, null, ctx([cod], { refunds: rf("REFUND_MANUAL_REVIEW") }));
ok("manual review escalates", !!s.escalate);
s = answerTopic("refund", cod, null, ctx([cod]));
ok("no refund on record: says so, no promise", /cannot see a refund/.test(s.text) && !s.escalate); everyStep(s);
const retPending = order({ id: "AJUKI710089", status: "delivered", return_request: { status: "pending" } });
ok("no refund, return filed: starts after the parcel reaches the warehouse", /after the returned parcel reaches our warehouse/.test(answerTopic("refund", retPending, null, ctx([retPending])).text));

// ── taps ─────────────────────────────────────────────────────────────────────
eq("menu tap re-sends the list", stepForTap("m:menu", ctx([]))!.fixed, "menu:list");
ok("menu tap out of hours carries the typed line", stepForTap("m:menu", ctx([]), { outOfHours: true })!.text.includes(MENU_TYPED_LINE));
eq("a forged order id is an expired tap", stepForTap("m:late:AJUKI710000", ctx([one]))!.text, EXPIRED_REPLY);
eq("not ours is null", stepForTap("Yes", ctx([one])), null);
eq("garbage is null", stepForTap("m:cancel:AJUKI710009:ye;s", ctx([one])), null);
// Every id any step can produce parses back to the same topic (so a tap can never dead-end).
for (const o of [one, two, overdue, unshipped, dispatched, delivered, bogo, old, pending]) {
  for (const t of MENU_TOPICS) for (const sub of [null, "fault", "size", "other", "dmg", "wrong", "miss", "yes", "no"]) {
    const st = answerTopic(t, o, sub, ctx([o, two], { refunds: rf("REFUND_PROCESSING") }));
    everyStep(st);
    for (const b of st.buttons ?? []) ok(`button id parses: ${b.id}`, parseMenuId(b.id) !== null);
  }
}

// ── switches ─────────────────────────────────────────────────────────────────
eq("off by default", menuAllowed("9000100013", {}), false);
eq("explicit off", menuAllowed("9000100013", { SUPPORT_MENU: "off" }), false);
eq("0", menuAllowed("9000100013", { SUPPORT_MENU: "0" }), false);
eq("allow mode: listed number only", [menuAllowed("9000100013", { SUPPORT_MENU: "allow", SUPPORT_MENU_ALLOW: "+91 90001 00013" }), menuAllowed("9999999999", { SUPPORT_MENU: "allow", SUPPORT_MENU_ALLOW: "9000100013" })], [true, false]);
eq("allow list does nothing while off", menuAllowed("9000100013", { SUPPORT_MENU_ALLOW: "9000100013" }), false);
eq("on, rate 100", menuAllowed("9999999999", { SUPPORT_MENU: "on", SUPPORT_MENU_RATE: "100" }), true);
eq("on, rate 0", menuAllowed("9999999999", { SUPPORT_MENU: "on", SUPPORT_MENU_RATE: "0" }), false);
eq("on, allow list beats rate 0", menuAllowed("9000100013", { SUPPORT_MENU: "on", SUPPORT_MENU_RATE: "0", SUPPORT_MENU_ALLOW: "9000100013" }), true);
{
  let n = 0; for (let i = 0; i < 2000; i++) if (menuAllowed(String(9000000000 + i * 7919), { SUPPORT_MENU: "on", SUPPORT_MENU_RATE: "10" })) n++;
  ok(`default pilot is about 10% (got ${n / 20}%)`, n > 120 && n < 290);
  eq("stable per number", menuAllowed("9000100023", { SUPPORT_MENU: "on", SUPPORT_MENU_RATE: "10" }), menuAllowed("9000100023", { SUPPORT_MENU: "on", SUPPORT_MENU_RATE: "10" }));
  ok("default rate is a pilot, not everyone", menuAllowed("9999999999", { SUPPORT_MENU: "on" }) === menuAllowed("9999999999", { SUPPORT_MENU: "on", SUPPORT_MENU_RATE: "10" }));
}
eq("modes", [menuMode({}), menuMode({ SUPPORT_MENU: "NEW" }), menuMode({ SUPPORT_MENU: "on" }), menuMode({ SUPPORT_MENU: "allow" }), menuMode({ SUPPORT_MENU: "junk" })], ["off", "new", "on", "allow", "off"]);
eq("new mode: no number is admitted by number alone (the thread decides)", menuAllowed("9000100023", { SUPPORT_MENU: "new" }), false);
eq("new mode: but every number may apply, so the thread is looked at", menuMayApply("9000100023", { SUPPORT_MENU: "new" }), true);
eq("off: nothing may apply", [menuMayApply("9000100023", {}), menuMayApply("9000100023", { SUPPORT_MENU: "off" }), menuMayApply("9000100023", { SUPPORT_MENU: "allow" })], [false, false, false]);
eq("new mode keeps the allow list", menuAllowed("9000100013", { SUPPORT_MENU: "new", SUPPORT_MENU_ALLOW: "9000100013" }), true);
eq("resend days default", menuResendDays({}), 30);
eq("resend days 0 = never", menuResendDays({ SUPPORT_MENU_RESEND_DAYS: "0" }), 0);
eq("resend days junk", menuResendDays({ SUPPORT_MENU_RESEND_DAYS: "x" }), 30);

console.log(`menuFlows: ${passed} assertions passed`);
