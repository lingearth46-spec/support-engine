import assert from "node:assert/strict";

// The decisions that matter most: who is shown the topic list, and who is left alone. Fake database, stubbed WhatsApp.
process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ??= "testproj"; // importing the support handler builds a Sanity client at load
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-key";
process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.SUPPORT_MENU = "on";
process.env.SUPPORT_MENU_RATE = "100";
delete process.env.SUPPORT_MENU_RESEND_DAYS;

const sent: { to: string; type: string; interactive?: { type: string; body: { text: string }; action: { buttons?: unknown[]; sections?: { rows: unknown[] }[] } }; text?: { body: string } }[] = [];
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => { sent.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); }) as typeof fetch;

type Q = { table: string; ops: [string, ...unknown[]][] };
let state = { recent: false, onlyNotifications: false, listBefore: false, priorInbound: false, menuThread: false, orders: [] as Record<string, unknown>[] };
const has = (q: Q, op: string, arg?: unknown) => q.ops.some((o) => o[0] === op && (arg === undefined || o[1] === arg));

function fakeDb() {
  const resolve = (q: Q) => {
    if (has(q, "insert") || has(q, "upsert") || has(q, "update")) return { data: has(q, "single") || has(q, "maybeSingle") ? { id: "row1", created_at: new Date().toISOString() } : [{ id: "row1", created_at: new Date().toISOString() }], error: null };
    // "new" mode: has this number ever written before / did we ever send it a guided message?
    if (q.table === "wa_messages" && q.ops.some((o) => o[0] === "eq" && o[1] === "direction" && o[2] === "in") && has(q, "lt")) return { data: state.priorInbound ? [{ id: "i1" }] : [], error: null };
    if (q.table === "wa_messages" && has(q, "like")) return { data: state.menuThread ? [{ id: "m1" }] : [], error: null };
    if (q.table === "wa_messages" && has(q, "eq", "ai_meta->>fixedReply")) return { data: state.listBefore ? [{ id: "m1" }] : [], error: null };
    if (q.table === "wa_messages" && has(q, "lt")) return { data: state.recent ? [state.onlyNotifications ? { created_at: new Date(Date.now() - 3_600_000).toISOString(), direction: "out", source: "system", ai_meta: null } : { created_at: new Date(Date.now() - 3_600_000).toISOString(), direction: "in", source: "customer", ai_meta: null }] : [], error: null };
    if (q.table === "orders") return { data: state.orders, error: null };
    return { data: has(q, "single") || has(q, "maybeSingle") ? null : [], error: null };
  };
  const make = (table: string, ops: Q["ops"]): unknown => new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(resolve({ table, ops })).then(res, rej);
      return (...args: unknown[]) => make(table, [...ops, [String(prop), ...args]]);
    },
  });
  return { from: (t: string) => make(t, []), rpc: async () => ({ data: null, error: null }) } as never;
}

async function main() {
const { maybeStartMenu, menuInsteadOfNotice } = await import("@/lib/menuHandler");

const PHONE = "9000100023";
const go = async () => ({ status: "go" as const });
const run = (message: string, extra: Record<string, unknown> = {}) => maybeStartMenu(fakeDb(), { phone: PHONE, message, name: "Test", arrivedAt: new Date().toISOString(), hasPhoto: false, wake: false, quiet: go, ...extra });
let passed = 0;
const eq = (n: string, g: unknown, w: unknown) => { assert.deepEqual(g, w, n); passed++; };
const reset = (s: Partial<typeof state> = {}) => { sent.length = 0; state = { recent: false, onlyNotifications: false, listBefore: false, priorInbound: false, menuThread: false, orders: [], ...s }; };
const order = { id: "AJUKI710009", status: "shipped", created_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), estimated_delivery: new Date(Date.now() + 2 * 86_400_000).toISOString(), items: [{ name: "Dorian Bracelet" }], address: { phone: PHONE } };

// A vague opener after 24 hours of silence: the topic list, once.
reset();
let r = await run("Hi");
eq("vague opener: handled and sent", [r.handled, r.handled && r.outcome], [true, "sent"]);
eq("it is a list message with the nine topics", [sent[0].interactive?.type, sent[0].interactive?.action.sections?.[0].rows.length], ["list", 9]);
eq("it asks them to choose", /choose/i.test(sent[0].interactive?.body.text ?? ""), true);

reset({ listBefore: true });
eq("once per chat: not sent again", (await run("Hi")).handled, false);
eq("and nothing went out", sent.length, 0);

reset({ recent: true });
eq("mid-conversation 'hello' is not an opener", (await run("hello")).handled, false);

reset();
eq("a photo is never an opener", (await run("Hi", { hasPhoto: true })).handled, false);
eq("a wake replay is never an opener", (await run("Hi", { wake: true })).handled, false);
eq("a pending button flow owns the message", (await run("Hi", { pendingKind: "ndr_phone" })).handled, false);

// A message that names a topic starts that flow, not the list.
reset({ orders: [order] });
r = await run("where is my order?");
eq("named topic: handled", r.handled && r.outcome, "sent");
eq("it asks which order, with buttons", [sent[0].interactive?.type, sent[0].interactive?.action.buttons?.length], ["button", 2]);
eq("the order is named", /AJUKI710009/.test(sent[0].interactive?.body.text ?? ""), true);

reset({ orders: [order] });
r = await run("Where is my order AJUKI710009");
eq("a typed order id skips the question (one button: the escape)", [r.handled, sent[0].interactive?.action.buttons?.length], [true, 1]);
eq("and answers from the record", /AJUKI710009 is on its way/.test(sent[0].interactive?.body.text ?? ""), true);

reset();
r = await run("I want to exchange this bracelet");
eq("exchange: the email line, no order needed", [r.handled, /Exchanges are handled by email/.test(sent[0].interactive?.body.text ?? "")], [true, true]);

reset({ orders: [order] });
eq("an unclear message is left to the bot", (await run("Do you have the gold chain in 22 inch")).handled, false);
eq("two topics are left to the bot", (await run("cancel my order and return it")).handled, false);
eq("a long complaint is left to the bot", (await run("My order arrived broken and I am very upset " + "because I waited a long time ".repeat(6))).handled, false);
eq("nothing was sent for them", sent.length, 0);

// The switch.
process.env.SUPPORT_MENU = "off";
reset();
eq("off: nothing happens", [(await run("Hi")).handled, sent.length], [false, 0]);
process.env.SUPPORT_MENU = "allow";
process.env.SUPPORT_MENU_ALLOW = "9000100013";
eq("allow mode: other numbers are left alone", (await run("Hi")).handled, false);
process.env.SUPPORT_MENU = "on";

// A quiet period that stands down: nothing is sent.
reset();
const stood = await run("Hi", { quiet: async () => ({ status: "superseded" as const }) });
eq("superseded during the quiet period: stands down, sends nothing", [stood.handled && stood.outcome, sent.length], ["superseded", 0]);

// Out of hours the list replaces the notice, the first time.
reset();
eq("out of hours: the list goes instead of the notice", [await menuInsteadOfNotice(fakeDb(), PHONE), sent[0].interactive?.type, /11:00 AM to 7:00 PM/.test(sent[0].interactive?.body.text ?? "")], [true, "list", true]);
reset({ listBefore: true });
eq("out of hours, already had the list: the old notice is used", [await menuInsteadOfNotice(fakeDb(), PHONE), sent.length], [false, 0]);

// A refused interactive send falls back to plain text, never to silence.
reset();
globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
  const body = JSON.parse(String(init?.body)); sent.push(body);
  return body.type === "interactive" ? new Response("{\"error\":\"nope\"}", { status: 400 }) : new Response("{}", { status: 200 });
}) as typeof fetch;
r = await run("Hi");
eq("refused list falls back to numbered text", [r.handled, sent.map((s) => s.type), /1\. Late delivery/.test(sent[1]?.text?.body ?? "")], [true, ["interactive", "text"], true]);


// "new" mode: the guided flows are for customers who have never written to us before.
{
  const { menuEligible } = await import("@/lib/menuHandler");
  process.env.SUPPORT_MENU = "new";
  delete process.env.SUPPORT_MENU_ALLOW;
  reset();
  r = await run("Hi");
  eq("new mode: a first-time customer's vague opener gets the list", [r.handled, sent[0]?.interactive?.type], [true, "list"]);
  reset({ priorInbound: true });
  eq("new mode: someone who has written before is left to the bot", [(await run("Hi")).handled, sent.length], [false, 0]);
  reset();
  r = await run("where is my order?");
  eq("new mode: a first message that names a topic starts that flow", r.handled && r.outcome, "sent");
  reset();
  eq("new mode: a first message the menu does not own is left to the bot", [(await run("Do you have the gold chain in 22 inch")).handled, sent.length], [false, 0]);
  reset();
  eq("new mode: out of hours, a first-time customer gets the list instead of the notice", [await menuInsteadOfNotice(fakeDb(), PHONE), sent[0]?.interactive?.type], [true, "list"]);
  reset({ priorInbound: true });
  eq("new mode: out of hours, a returning customer still gets the notice", [await menuInsteadOfNotice(fakeDb(), PHONE), sent.length], [false, 0]);
  reset({ menuThread: true });
  eq("new mode: a tap is answered when we sent them a guided message", await menuEligible(fakeDb(), PHONE, { tap: true }), true);
  reset({ menuThread: false });
  eq("new mode: a tap on something we never sent them is not ours", await menuEligible(fakeDb(), PHONE, { tap: true }), false);
  reset({ priorInbound: true });
  process.env.SUPPORT_MENU = "new"; process.env.SUPPORT_MENU_ALLOW = "9000100013";
  eq("new mode: the allow list still works for a returning number", [await menuEligible(fakeDb(), "9000100013"), await menuEligible(fakeDb(), PHONE)], [true, false]);
  process.env.SUPPORT_MENU = "on"; delete process.env.SUPPORT_MENU_ALLOW;
}
// 14 Oct: an automatic order notification (out for delivery, confirmed, a pay link) is not a conversation, so it must not hide the menu.
{
  reset({ recent: true, onlyNotifications: true });
  r = await run("Hi");
  eq("a customer who only received an order notification still gets the list", [r.handled, sent[0]?.interactive?.type], [true, "list"]);
  reset({ recent: true, onlyNotifications: true, orders: [order] });
  r = await run("where is my order?");
  eq("and a message naming a topic starts that flow", r.handled && r.outcome, "sent");
  reset({ recent: true });
  eq("but a real recent conversation still keeps it away", (await run("Hi")).handled, false);
  // The delivery-failure buttons have their own flow: their titles are never a topic or an opener.
  for (const t of ["Update phone", "Update address", "Deliver tomorrow", "Contact support", "Try again tomorrow", "Edit Address"]) {
    reset();
    eq(`the button title "${t}" is left to its own flow`, [(await run(t)).handled, sent.length], [false, 0]);
  }
}

console.log(`menuHandler: ${passed} assertions passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
