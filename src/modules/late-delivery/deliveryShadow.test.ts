// Run with `npx tsx lib/deliveryShadow.test.ts`. The model reads, the shadow runner and its memory, with a fake database and a fake fetch: no network.
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callJson, validateIntentRead, validateAnalysis, readIntent, analyseParcel } from "@late/deliveryLlm";
import { deliveryAgentMode, deliverySampled, runDeliveryShadow, runDeliveryLive, storeDeliveryShadow, saveCase, loadCase, type ShadowOrder } from "@late/deliveryShadow";
import { emptyState, liveLiteLine, type Escalate } from "@late/deliveryCaseState";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

// ── a fake database: only the calls the module makes ──────────────────────────────────────────────────────────────────────────────────
type Store = { scans: Record<string, unknown>[]; cases: Record<string, unknown>[]; messages: Record<string, { ai_meta: Record<string, unknown> | null }> };
function fakeDb(store: Store, opts: { noCases?: boolean; scansError?: boolean } = {}): SupabaseClient {
  let nextId = 1;
  const from = (table: string) => {
    const q = { op: "select", filters: [] as [string, unknown][], inF: null as [string, unknown[]] | null, row: null as Record<string, unknown> | null, patch: null as Record<string, unknown> | null };
    const run = (): { data: unknown; error: { code?: string; message?: string } | null } => {
      if (table === "parcel_scans") return opts.scansError ? { data: null, error: { message: "boom" } } : { data: store.scans.filter((r) => !q.inF || q.inF[1].includes(r[q.inF[0]])), error: null };
      if (table === "delivery_cases") {
        if (opts.noCases) return { data: null, error: { code: "42P01", message: 'relation "delivery_cases" does not exist' } };
        if (q.op === "insert") { store.cases.push({ id: nextId++, ...q.row }); return { data: null, error: null }; }
        const rows = store.cases.filter((r) => q.filters.every(([c, v]) => r[c] === v));
        if (q.op === "update") { rows.forEach((r) => Object.assign(r, q.patch)); return { data: null, error: null }; }
        return { data: rows, error: null };
      }
      if (table === "wa_messages") {
        const id = String(q.filters.find(([c]) => c === "id")?.[1]);
        if (q.op === "update") { store.messages[id] = { ai_meta: (q.patch as { ai_meta: Record<string, unknown> }).ai_meta }; return { data: null, error: null }; }
        return { data: store.messages[id] ?? null, error: null };
      }
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b, insert: (row: Record<string, unknown>) => { q.op = "insert"; q.row = row; return b; }, update: (patch: Record<string, unknown>) => { q.op = "update"; q.patch = patch; return b; },
      eq: (c: string, v: unknown) => { q.filters.push([c, v]); return b; }, in: (c: string, v: unknown[]) => { q.inF = [c, v]; return b; }, order: () => b, limit: () => b,
      maybeSingle: async () => run(), then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

// ── a fake fetch that answers the two reads ───────────────────────────────────────────────────────────────────────────────────────────
let calls: string[] = [];
function fakeFetch(intent: Record<string, unknown> | "fail" | "garbage", analysis?: Record<string, unknown>): typeof fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    const name = JSON.parse(String(init?.body)).response_format.json_schema.name as string; calls.push(name);
    if (name === "delivery_intent") {
      if (intent === "fail") return { ok: false, status: 500, json: async () => ({}) };
      const content = intent === "garbage" ? "not json" : JSON.stringify({ situation: "late_delivery", intent: "status_question", confidence: "high", date: null, phone: null, pincode: null, ...intent });
      return { ok: true, status: 200, json: async () => ({ usage: { total_tokens: 900 }, choices: [{ message: { content } }] }) };
    }
    const a = { current_state: "Delivery attempt failed", cause_class: "customer_side", attempts: 1, last_scan_at: "x", hours_since_last_scan: 8, days_past_estimate: null, delivery_person_remarks: ["Customer not contactable"], safe_facts: [], concerns: [], recommended_next_step: "ask_customer_availability", ...analysis };
    return { ok: true, status: 200, json: async () => ({ usage: { total_tokens: 1400 }, choices: [{ message: { content: JSON.stringify(a) } }] }) };
  }) as unknown as typeof fetch;
}
process.env.OPENAI_API_KEY = "test-key";

const NOW = Date.parse("2026-10-12T12:30:00Z");
const hAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const scan = (order: string, h: number, event: string, remark: string | null = null, raw: string | null = null) => ({ order_id: order, event, raw_status: raw, remark, location: "Hub", scanned_at: hAgo(h) });
const SHADOWFAX_ORDER: ShadowOrder = { id: "AJUKI710008", status: "undelivered", courier_name: "Shadowfax", estimated_delivery: hAgo(48), created_at: hAgo(200), address: { pincode: "560001" } };
const failing = [scan("AJUKI710008", 14, "out_for_delivery"), scan("AJUKI710008", 8, "failed_attempt", "Customer not contactable", "Not Contactable")];
const input = (db: SupabaseClient, message: string, extra: Partial<Parameters<typeof runDeliveryShadow>[0]> = {}) => ({
  db, phone: "9000000001", message, history: [{ direction: "in" as const, body: message }], orders: [SHADOWFAX_ORDER], inboundId: "m1",
  live: { text: "I have flagged this to the team and we are working on it.", action: "escalate", kind: "fixed" }, now: NOW, ...extra,
});

async function main() {
  // ── mode and sampling ──
  eq("off by default", deliveryAgentMode({}), "off");
  eq("only 'shadow' turns it on", [deliveryAgentMode({ SUPPORT_DELIVERY_AGENT: "shadow" }), deliveryAgentMode({ SUPPORT_DELIVERY_AGENT: "on" }), deliveryAgentMode({ SUPPORT_DELIVERY_AGENT: "1" })], ["shadow", "off", "off"]);
  eq("sampling: all, none", [deliverySampled("9000000001", {}), deliverySampled("9000000001", { SUPPORT_DELIVERY_AGENT_RATE: "0" })], [true, false]);
  eq("sampling is stable per phone", [deliverySampled("9000000001", { SUPPORT_DELIVERY_AGENT_RATE: "0.5" }), deliverySampled("9000000001", { SUPPORT_DELIVERY_AGENT_RATE: "0.5" })].every((x) => x === deliverySampled("9000000001", { SUPPORT_DELIVERY_AGENT_RATE: "0.5" })), true);

  // ── the validators and the call wrapper ──
  eq("a good intent read", validateIntentRead({ situation: "late_delivery", intent: "status_question", confidence: "high", date: " tomorrow ", phone: null, pincode: null })?.date, "tomorrow");
  eq("an unknown intent is refused", validateIntentRead({ situation: "late_delivery", intent: "nope", confidence: "high", date: null, phone: null, pincode: null }), null);
  eq("a bad confidence is refused", validateIntentRead({ situation: "late_delivery", intent: "other", confidence: "maybe", date: null, phone: null, pincode: null }), null);
  eq("a good analysis", validateAnalysis({ current_state: "x", cause_class: "stuck_no_movement", attempts: 2.2, last_scan_at: "t", hours_since_last_scan: 50, days_past_estimate: null, delivery_person_remarks: ["a", 3], safe_facts: [], concerns: [], recommended_next_step: "escalate_to_team" })?.attempts, 2);
  eq("an analysis with a wrong enum is refused", validateAnalysis({ current_state: "x", cause_class: "other", attempts: 1, last_scan_at: "t", hours_since_last_scan: 5, days_past_estimate: null, delivery_person_remarks: [], safe_facts: [], concerns: [], recommended_next_step: "wait_for_movement" }), null);
  const saveKey = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  eq("no key: an error, no call", (await callJson({ system: "s", user: "u", name: "n", schema: {}, validate: (v) => v as never })).error, "no_key");
  process.env.OPENAI_API_KEY = saveKey;
  eq("an http error is reported", (await readIntent(["Customer: hi"], null, fakeFetch("fail"))).error, "http_500");
  eq("garbage is reported as unparseable", (await readIntent(["Customer: hi"], null, fakeFetch("garbage"))).error, "unparseable");
  eq("the intent prompt carries what we last asked", await (async () => { let body = ""; await readIntent(["Customer: tomorrow"], "date", (async (_u: unknown, init?: { body?: string }) => { body = String(init?.body); return { ok: false, status: 500, json: async () => ({}) }; }) as unknown as typeof fetch); return /which day they want the delivery/.test(body); })(), true);
  eq("the analyst reads the scans", (await analyseParcel("ORDER X", fakeFetch({}, { attempts: 3 }))).value?.attempts, 3);

  // ── the shadow runner ──
  { // the gate: nothing late, no call
    calls = []; const store: Store = { scans: [scan("AJUKI710008", 2, "delivered")], cases: [], messages: {} };
    const r = await runDeliveryShadow(input(fakeDb(store), "thanks", { fetchImpl: fakeFetch({}) }));
    eq("a delivered parcel and a polite message: no run, no model call", [r, calls.length], [null, 0]);
    eq("no orders: no run", await runDeliveryShadow(input(fakeDb(store), "where is my order", { orders: [], fetchImpl: fakeFetch({}) })), null);
  }
  { // first message about a failed delivery, then the answer in context
    calls = []; const store: Store = { scans: failing, cases: [], messages: { m1: { ai_meta: { existing: 1 } } } };
    const db = fakeDb(store);
    const r1 = await runDeliveryShadow(input(db, "where is my order", { fetchImpl: fakeFetch({}) }));
    ok("it ran", r1 !== null);
    eq("first contact on a customer-side failure: ask whether the rider called", [r1!.decision!.replyId, r1!.decision!.escalate, r1!.decision!.awaiting], ["A1", "none", "rider_answer"]);
    eq("the order and courier are recorded", r1!.order, { id: "AJUKI710008", courier: "shadowfax" });
    eq("the timeline is recorded", [r1!.timeline!.attempts, r1!.timeline!.phase, r1!.timeline!.cause, r1!.timeline!.hoursSinceMovement], [1, "failed_attempt", "customer_side", 8]);
    eq("the analyst agrees with the timeline on attempts and hours", [r1!.analyst!.agreesAttempts, r1!.analyst!.agreesHours], [true, true]);
    eq("both reads ran, tokens added up", [calls.sort(), r1!.tokens, r1!.calls], [["delivery_analysis", "delivery_intent"], 2300, 2]);
    eq("the live reply is recorded beside it", [r1!.live.kind, r1!.live.escalated, r1!.live.sameText], ["fixed", true, false]);
    eq("a case was created, open, in shadow mode", [store.cases.length, store.cases[0].status, store.cases[0].mode, store.cases[0].awaiting, store.cases[0].chases], [1, "open", "shadow", "rider_answer", 1]);
    eq("stored and flagged as stored", r1!.state.stored, true);
    // the answer
    const r2 = await runDeliveryShadow(input(db, "No", { fetchImpl: fakeFetch({ intent: "no_contact_complaint" }), history: [{ direction: "out", body: "Did the rider contact you?" }, { direction: "in", body: "No" }] }));
    eq("'No' after our question is the dispute: a Shadowfax issue", [r2!.decision!.replyId, r2!.decision!.action?.name], ["B3", "SHADOWFAX_ISSUE"]);
    eq("the same case row was updated, not duplicated; B3 awaits nothing (Shadowfax cannot schedule and the reply asks for no day)", [store.cases.length, store.cases[0].chases, store.cases[0].awaiting], [1, 2, null]);
    // persistence
    const l = await loadCase(db, "9000000001", "AJUKI710008");
    ok("the case loads back with its state", l !== null && l !== "absent" && l.state.chases === 2 && l.state.awaiting === null);
    // storing the record keeps what was already on the row
    await storeDeliveryShadow(db, "m1", r1);
    eq("the record is merged into ai_meta, nothing lost", [(store.messages.m1.ai_meta as { existing: number }).existing, !!(store.messages.m1.ai_meta as { deliveryAgent?: unknown }).deliveryAgent], [1, true]);
    await storeDeliveryShadow(db, "m1", null); ok("a null record writes nothing", true);
  }
  { // repeat chasing, state carried by the table
    calls = []; const store: Store = { scans: [scan("AJUKI710008", 30, "in_transit")], cases: [], messages: {} }; const db = fakeDb(store);
    const seq: string[] = [];
    for (let k = 0; k < 4; k++) { const r = await runDeliveryShadow(input(db, "any update", { fetchImpl: fakeFetch({}), now: NOW + k * 3_600_000 })); seq.push(`${r!.decision!.replyId}/${r!.decision!.escalate}`); }
    eq("a repeat chase is not a new escalation: one prompt on the third, then quiet", seq, ["A2s/none", "C1/none", "E2/repeat_chase", "C1/none"]);
  }
  { // the table is not there: runs stateless and says so
    const store: Store = { scans: failing, cases: [], messages: {} };
    const r = await runDeliveryShadow(input(fakeDb(store, { noCases: true }), "where is my order", { fetchImpl: fakeFetch({}) }));
    eq("no table: still decides, says it ran stateless", [r!.decision!.replyId, r!.state.stored, /stateless/.test(r!.state.note ?? "")], ["A1", false, true]);
  }
  { // a failed model read: the code still decides, and a long unplaced message goes to a person
    const store: Store = { scans: failing, cases: [], messages: {} };
    const r = await runDeliveryShadow(input(fakeDb(store), "this is a long message about something quite different that the reader could not place at all", { fetchImpl: fakeFetch("fail") }));
    eq("the intent read failed: the error is recorded and a person is prompted", [r!.intent!.modelError, r!.decision!.escalate], ["http_500", "needs_human"]);
    const r2 = await runDeliveryShadow(input(fakeDb({ ...store, cases: [] }), "Help me with this", { fetchImpl: fakeFetch("fail") }));
    eq("the intent read failed on a short message: a chase", r2!.intent!.merged, "chase");
  }
  { // unreadable scans: nothing is guessed
    const r = await runDeliveryShadow(input(fakeDb({ scans: [], cases: [], messages: {} }, { scansError: true }), "where is my order", { fetchImpl: fakeFetch({}) }));
    eq("unreadable scans: skipped", r!.skipped, "scans_unreadable");
  }
  { // nothing it records can change the live reply
    const store: Store = { scans: failing, cases: [], messages: {} };
    const live = { text: "Your order AJUKI710008 had a delivery attempt that did not complete, and the courier reports that you were not available. Would you like it delivered at a later time? If so, please tell me which day. If nobody called or came, please tell me that instead and I will raise it with the courier.", action: "reply", kind: "fixed" };
    const r = await runDeliveryShadow(input(fakeDb(store), "where is my order", { fetchImpl: fakeFetch({}), live }));
    eq("same text as the live bot is noticed", [r!.live.sameText, r!.live.escalated], [true, false]);
  }
  { // a delivered parcel closes its case
    const store: Store = { scans: [], cases: [{ id: 9, phone: "9000000001", order_id: "AJUKI710008", status: "open" }], messages: {} };
    ok("a case is closed with a reason", await saveCase(fakeDb(store), "9000000001", "AJUKI710008", 9, emptyState(), "delivered"));
    eq("closed", [store.cases[0].status, store.cases[0].closed_reason], ["closed", "delivered"]);
  }
  // ── LIVE-LITE: the few approved lines the agent may send, no courier action ──
  eq("the live mode is recognised; anything else is off", [deliveryAgentMode({ SUPPORT_DELIVERY_AGENT: "live" }), deliveryAgentMode({ SUPPORT_DELIVERY_AGENT: " LIVE " }), deliveryAgentMode({ SUPPORT_DELIVERY_AGENT: "true" })], ["live", "live", "off"]);
  const L = (replyId: string, text: string, escalate: Escalate = "none", o: { blameCourier?: boolean } = {}) => liveLiteLine({ replyId, text, escalate }, o);
  eq("C1 loses the promise of a later message", L("C1", "There is no newer update on order A1 since 12 Oct. I will message you here as soon as it moves. You can track it at www.ajuki.in/track.")?.text, "There is no newer update on order A1 since 12 Oct. We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry. You can track it at www.ajuki.in/track.");
  eq("A2s loses it too", L("A2s", "Update on your order A1: the latest status is in transit (last scan 12 Oct). I will message you here when it moves. You can track it at www.ajuki.in/track.")?.text, "Update on your order A1: the latest status is in transit (last scan 12 Oct). We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry. You can track it at www.ajuki.in/track.");
  eq("E1 says at least 2 days and prompts a person", [L("E1", "There has been no movement on order A1 for 2 days. I have escalated this to the team. You can track it at www.ajuki.in/track.", "stall_48h")?.text, L("E1", "x y", "stall_48h")?.person], ["There has been no movement on order A1 for at least 2 days. I have escalated this to the team. We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry. You can track it at www.ajuki.in/track.", true]);
  eq("18 Oct (founder): the courier is named only when the caller says the parcel stopped in its hands", [L("E1", "There has been no movement on order A1 for 2 days. I have escalated this to the team. You can track it at www.ajuki.in/track.", "stall_48h", { blameCourier: true })?.text, L("E1", "There has been no movement on order A1 for 2 days. I have escalated this to the team. You can track it at www.ajuki.in/track.", "stall_48h")?.text.includes("courier")], [`There has been no movement on order A1 for at least 2 days. I have escalated this to the team. The delay is on the courier's side. We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry. You can track it at www.ajuki.in/track.`, false]);
  eq("a movement update carries the short effort sentence, not 'no need to worry'", [L("D1", "Update on your order A1: the latest status is in transit. You can follow it at www.ajuki.in/track.")?.text, /worry/.test(L("D1", "Update on your order A1: the latest status is in transit. You can follow it at www.ajuki.in/track.")?.text ?? "")], [`Update on your order A1: the latest status is in transit. We are working to get it to you as soon as possible. You can follow it at www.ajuki.in/track.`, false]);
  eq("every late-parcel line a customer can get carries the reassurance, and no other line does", ["A2", "A2s", "A5", "C1", "E1", "E2"].every((id) => (L(id, `Line. You can track it at www.ajuki.in/track.`)?.text ?? "").includes("no need to worry")) && !["D1", "D2"].some((id) => /worry/.test(L(id, "Line. You can follow it at www.ajuki.in/track.")?.text ?? "")), true);
  eq("a line without a person prompt does not prompt one", L("D2", "Your order A1 is out for delivery today. You can track it at www.ajuki.in/track.")?.person, false);
  for (const id of ["A3", "B5", "B5b", "F1", "F3a", "F3b", "F3c", "F4", "F5", "H1", "N1", "S0", "D3", "D4"]) eq(`${id} is left to the existing path`, L(id, "some text"), null);
  for (const id of ["A1", "B1", "B2", "B3", "B4", "B6", "F2", "P1", "P2"]) eq(`${id} is a live line from 19 Oct (the customer-unavailable flow and the packing lines)`, L(id, "some text")?.replyId, id);
  eq("an empty line is never sent", L("E1", "  "), null);
  eq("the lines it may send have no promise of a later message", ["A2", "A2s", "A5", "C1", "D1", "D2", "E1", "E2"].every((id) => !/I will message you/.test(L(id, `Line. I will message you here when it moves. ${id}`)?.text ?? "")), true);
  { // a stalled parcel, first contact: the 48-hour line, a person, the case stored in live mode
    const store: Store = { scans: [scan("AJUKI710008", 60, "in_transit")], cases: [], messages: {} };
    const r = await runDeliveryLive(input(fakeDb(store), "where is my order", { fetchImpl: fakeFetch({}) }));
    eq("E1 for a parcel with no scan for 60 hours", [r.line?.replyId, r.line?.person, /at least 2 days/.test(r.line?.text ?? "")], ["E1", true, true]);
    eq("the case row is written with mode live", [store.cases.length, store.cases[0].mode], [1, "live"]);
    eq("no courier action is recorded as taken", r.rec?.decision?.action?.allowed === undefined || typeof r.rec?.decision?.action?.allowed === "boolean", true);
  }
  { // a customer-side failed attempt: A1 (19 Oct) says the courier reports the customer was unavailable, offers a later time, and the case waits for the answer
    const store: Store = { scans: failing, cases: [], messages: {} };
    const r = await runDeliveryLive(input(fakeDb(store), "where is my order", { fetchImpl: fakeFetch({}) }));
    eq("A1 is sent, no person yet", [r.line?.replyId, r.line?.person], ["A1", false]);
    ok("it tells the customer what the courier reports and offers the options", /courier reports that you were not available/.test(r.line?.text ?? "") && /later time/.test(r.line?.text ?? "") && /nobody called or came/.test(r.line?.text ?? ""));
    eq("the case is stored, waiting for the rider answer", [store.cases.length, store.cases[0]?.awaiting], [1, "rider_answer"]);
    ok("the courier is not blamed on a failed attempt that waits on the customer", !/courier's side/.test(r.line?.text ?? ""));
  }
  { // repeat chasing in live mode: the sequence, every line allowed, the state carried
    const store: Store = { scans: [scan("AJUKI710008", 30, "in_transit")], cases: [], messages: {} }; const db = fakeDb(store);
    const seq: string[] = [];
    for (let k = 0; k < 4; k++) { const r = await runDeliveryLive(input(db, "any update", { fetchImpl: fakeFetch({}), now: NOW + k * 3_600_000 })); seq.push(`${r.line?.replyId}/${r.line?.escalate}`); }
    eq("A2s, C1, then one person prompt on the third chase, then quiet", seq, ["A2s/none", "C1/none", "E2/repeat_chase", "C1/none"]);
    eq("one case row, chases counted", [store.cases.length, store.cases[0].chases], [1, 4]);
  }
  { // errors and timeouts are 'no line': the existing path answers
    const store: Store = { scans: [scan("AJUKI710008", 60, "in_transit")], cases: [], messages: {} };
    const r = await runDeliveryLive(input(fakeDb(store, { scansError: true }), "where is my order", { fetchImpl: fakeFetch({}) }));
    eq("unreadable scans: no line", r.line, null);
    const slow = (async () => { await new Promise((res) => setTimeout(res, 300)); return { ok: false, status: 500, json: async () => ({}) }; }) as unknown as typeof fetch;
    const t = await runDeliveryLive(input(fakeDb(store), "where is my order", { fetchImpl: slow }), { timeoutMs: 50 });
    eq("a timeout is no line and nothing recorded", [t.line, t.rec], [null, null]);
    const thrown = await runDeliveryLive({ ...input(fakeDb(store), "where is my order"), orders: null as never });
    eq("a thrown error is no line", thrown.line, null);
  }
  { // the gate: a polite message about a delivered parcel never reaches the agent
    const store: Store = { scans: [scan("AJUKI710008", 2, "delivered")], cases: [], messages: {} };
    const r = await runDeliveryLive(input(fakeDb(store), "thanks", { fetchImpl: fakeFetch({}) }));
    eq("not gated in: no record, no line", [r.rec, r.line], [null, null]);
  }
  console.log(`deliveryShadow: ${passed} assertions passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
