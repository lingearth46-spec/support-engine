// Run with `npx tsx lib/deliveryCourierAction.test.ts`. The agent's Delhivery actions: the planner (every NDR-policy limit) and the executor with a fake database and fake couriers.
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { actionsMode, planCourierAction, performCourierAction, submittedLine, type ActDeps, type ActInput, type ActionOrder } from "@late/deliveryCourierAction";
import { NOTE_PREFIX, MAX_REQUESTS_PER_ORDER, DEFER_HORIZON_DAYS, deferHorizon, timesAsked, askedToday, actionForCode } from "@late/ndrPolicy";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

const NOW = Date.parse("2026-10-18T09:00:00Z"); // a Sunday in India
const order = (over: Partial<ActionOrder> = {}): ActionOrder => ({ id: "AJUKI1", awb: "60000000000007", courierName: "Delhivery", shiprocketOrderId: null, status: "undelivered", estimatedDelivery: "2026-10-16", adminNotes: "", pincode: "411001", ...over });
const live = (code: string | null, status = "Consignee Unavailable") => ({ code, status });
const ctx = (forgiven = 0) => ({ now: NOW, forgiven });
const refused = (p: ReturnType<typeof planCourierAction>) => (p.ok ? null : { to: p.to, reason: p.reason });
const crumb = (date: string) => `${NOTE_PREFIX} ${date} — live status was "Consignee Unavailable" (EOD-11).`;

// ── the shared policy ──
eq("the policy constants the hourly job uses", [NOTE_PREFIX, MAX_REQUESTS_PER_ORDER, DEFER_HORIZON_DAYS], ["NDR reattempt requested", 3, 5]);
eq("the defer horizon is estimated delivery + 5 days", [deferHorizon({ estimated_delivery: "2026-10-16" }), deferHorizon({ estimated_delivery: null }), deferHorizon({ estimated_delivery: "soon" })], ["2026-10-21", null, null]);
eq("breadcrumbs are counted, and 'today' is found", [timesAsked(`a\n${crumb("2026-10-10")}\n${crumb("2026-10-18")}`), askedToday(`${crumb("2026-10-18")}`, NOW), askedToday(`${crumb("2026-10-17")}`, NOW)], [2, true, false]);
eq("the code decides the act: the unavailable family is a defer, the rest a re-attempt", [actionForCode("EOD-11"), actionForCode("EOD-6"), actionForCode("EOD-16"), actionForCode("EOD-86"), actionForCode("EOD-74")], ["DEFER_DLV", "DEFER_DLV", "DEFER_DLV", "RE-ATTEMPT", "RE-ATTEMPT"]);
eq("off by default; dry; on", [actionsMode({}), actionsMode({ SUPPORT_DELIVERY_AGENT_ACTIONS: "dry" }), actionsMode({ SUPPORT_DELIVERY_AGENT_ACTIONS: "ON" }), actionsMode({ SUPPORT_DELIVERY_AGENT_ACTIONS: "yes" })], ["off", "dry", "on", "off"]);

// ── DEFER_DLV ──
{
  const p = planCourierAction(order(), { act: "DEFER_DLV" }, live("EOD-11"), ctx());
  ok("a defer with no date: the next working day (Monday, the day after a Sunday)", p.ok && p.act === "DEFER_DLV" && p.deferredDate === "2026-10-19" && !p.clamped && p.countsAsAsk);
  eq("the customer's date is used", planCourierAction(order(), { act: "DEFER_DLV", date: "2026-10-20" }, live("EOD-11"), ctx()).ok && (planCourierAction(order(), { act: "DEFER_DLV", date: "2026-10-20" }, live("EOD-11"), ctx()) as { deferredDate: string }).deferredDate, "2026-10-20");
  const far = planCourierAction(order(), { act: "DEFER_DLV", date: "2026-10-30" }, live("EOD-11"), ctx());
  ok("beyond estimated delivery + 5 (21 Oct) the date is clamped to it", far.ok && far.deferredDate === "2026-10-21" && far.clamped);
  const sun = planCourierAction(order({ estimatedDelivery: "2026-10-18" }), { act: "DEFER_DLV", date: "2026-10-25" }, live("EOD-11"), ctx());
  ok("a date that falls on a Sunday moves to Monday, or to Saturday if Monday is past the limit", sun.ok && sun.deferredDate === "2026-10-22" || (sun.ok && new Date(`${sun.deferredDate}T00:00:00Z`).getUTCDay() !== 0));
  const sat = planCourierAction(order({ estimatedDelivery: "2026-10-20" }), { act: "DEFER_DLV", date: "2026-10-25" }, live("EOD-11"), ctx());
  eq("horizon 25 Oct is a Sunday and Monday is past it: Saturday", sat.ok && sat.deferredDate, "2026-10-24");
  eq("a past or same-day date is replaced by the next working day", (planCourierAction(order(), { act: "DEFER_DLV", date: "2026-10-17" }, live("EOD-11"), ctx()) as { deferredDate: string }).deferredDate, "2026-10-19");
  eq("past the last accepted date: a person", refused(planCourierAction(order({ estimatedDelivery: "2026-10-01" }), { act: "DEFER_DLV" }, live("EOD-11"), ctx()))?.to, "person");
  eq("a status that takes no date (EOD-86 not attempted): a person", refused(planCourierAction(order(), { act: "DEFER_DLV" }, live("EOD-86"), ctx()))?.to, "person");
  eq("a status that is not an NDR at all: a person", refused(planCourierAction(order(), { act: "DEFER_DLV" }, live("DTUP-203"), ctx()))?.to, "person");
}

// ── RE-ATTEMPT ──
eq("a re-attempt where it is allowed (EOD-86 not attempted, EOD-74)", [planCourierAction(order(), { act: "RE-ATTEMPT" }, live("EOD-86"), ctx()).ok, planCourierAction(order(), { act: "RE-ATTEMPT" }, live("EOD-74"), ctx()).ok], [true, true]);
for (const c of ["EOD-11", "EOD-6", "EOD-16"]) eq(`no bare re-attempt at ${c} (same rider, same door): a person`, refused(planCourierAction(order(), { act: "RE-ATTEMPT" }, live(c), ctx()))?.to, "person");
eq("a re-attempt at a status Delhivery does not accept: a person", refused(planCourierAction(order(), { act: "RE-ATTEMPT" }, live("EOD-3"), ctx()))?.to, "person");

// ── EDIT_DETAILS ──
{
  const p = planCourierAction(order(), { act: "EDIT_DETAILS", edit: { phone: "+91 98765 43210", address: "Flat 4B, Green Park, Pune 411001" } }, live("EOD-11"), ctx());
  ok("a phone and an address in the failed-delivery window", p.ok && p.edit?.phone === "9876543210" && /Flat 4B/.test(p.edit?.address ?? "") && !p.countsAsAsk);
  eq("a different pincode is refused (Delhivery cannot change it)", refused(planCourierAction(order(), { act: "EDIT_DETAILS", edit: { address: "Flat 4B, Green Park, New Delhi 110016" } }, live("EOD-11"), ctx()))?.to, "person");
  eq("outside the failed-delivery window it would be 'Package in incorrect status': a person", refused(planCourierAction(order(), { act: "EDIT_DETAILS", edit: { phone: "9876543210" } }, live("DTUP-203"), ctx()))?.to, "person");
  eq("a bad phone is refused", refused(planCourierAction(order(), { act: "EDIT_DETAILS", edit: { phone: "12345" } }, live("EOD-11"), ctx()))?.to, "person");
  eq("a one-word address is refused", refused(planCourierAction(order(), { act: "EDIT_DETAILS", edit: { address: "Pune" } }, live("EOD-11"), ctx()))?.to, "person");
  eq("nothing to change", refused(planCourierAction(order(), { act: "EDIT_DETAILS", edit: {} }, live("EOD-11"), ctx()))?.to, "none");
  ok("an edit is allowed even when the parcel is at its request cap (it is not an ask)", planCourierAction(order({ adminNotes: [crumb("2026-10-01"), crumb("2026-10-02"), crumb("2026-10-03")].join("\n") }), { act: "EDIT_DETAILS", edit: { phone: "9876543210" } }, live("EOD-11"), ctx()).ok);
}

// ── guards common to every act ──
eq("no AWB / finished / not a direct Delhivery parcel", [
  refused(planCourierAction(order({ awb: null }), { act: "DEFER_DLV" }, live("EOD-11"), ctx()))?.to,
  refused(planCourierAction(order({ status: "delivered" }), { act: "DEFER_DLV" }, live("EOD-11"), ctx()))?.to,
  refused(planCourierAction(order({ shiprocketOrderId: "9" }), { act: "DEFER_DLV" }, live("EOD-11"), ctx()))?.to,
  refused(planCourierAction(order({ courierName: "Shadowfax", awb: "SF1" }), { act: "DEFER_DLV" }, live("EOD-11"), ctx()))?.to,
], ["none", "none", "person", "person"]);
eq("no live status code: wait, never blind", refused(planCourierAction(order(), { act: "DEFER_DLV" }, live(null), ctx()))?.to, "wait");
eq("attempts exhausted (ST-108): a person chases the account manager", refused(planCourierAction(order(), { act: "DEFER_DLV" }, live("ST-108"), ctx()))?.to, "person");
eq("ST-108 stops an edit too", refused(planCourierAction(order(), { act: "EDIT_DETAILS", edit: { phone: "9876543210" } }, live("ST-108"), ctx()))?.to, "person");
eq("asked three times already: a person", refused(planCourierAction(order({ adminNotes: [crumb("2026-10-01"), crumb("2026-10-02"), crumb("2026-10-03")].join("\n") }), { act: "DEFER_DLV" }, live("EOD-11"), ctx()))?.to, "person");
ok("…but deferred_retry rejections do not count toward it", planCourierAction(order({ adminNotes: [crumb("2026-10-01"), crumb("2026-10-02"), crumb("2026-10-03")].join("\n") }), { act: "DEFER_DLV" }, live("EOD-11"), ctx(2)).ok);
eq("asked today: wait", refused(planCourierAction(order({ adminNotes: crumb("2026-10-18") }), { act: "RE-ATTEMPT" }, live("EOD-74"), ctx()))?.to, "wait");

// ── the executor ──
type Row = Record<string, any>;
function world(over: { orders?: Row[]; ndr?: Row[]; track?: { statusCode?: string; status?: string } | null; fail?: boolean; insertError?: { code?: string; message: string } } = {}) {
  const t: Record<string, Row[]> = { orders: (over.orders ?? [{ id: "AJUKI1", awb_code: "60000000000007", courier_name: "Delhivery", shiprocket_order_id: null, status: "undelivered", estimated_delivery: "2026-10-16", admin_notes: "", address: { pincode: "411001" } }]).map((o) => ({ ...o })), delhivery_ndr_requests: over.ndr ?? [] };
  const from = (table: string) => {
    const q = { op: "select" as "select" | "insert" | "update", f: [] as Array<[string, unknown]>, row: null as Row | null, patch: null as Row | null };
    const run = () => {
      const rows = t[table] ?? []; const match = rows.filter((r) => q.f.every(([c, v]) => r[c] === v));
      if (q.op === "insert") { if (over.insertError) return { data: null, error: over.insertError }; rows.push({ ...q.row }); return { data: null, error: null }; }
      if (q.op === "update") { match.forEach((r) => Object.assign(r, q.patch)); return { data: null, error: null }; }
      return { data: match, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b, insert: (r: Row) => { q.op = "insert"; q.row = r; return b; }, update: (p: Row) => { q.op = "update"; q.patch = p; return b; }, eq: (c: string, v: unknown) => { q.f.push([c, v]); return b; },
      maybeSingle: async () => { const r = run(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }; },
      then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  const calls = { defer: [] as Array<[string, string]>, reattempt: [] as string[], edit: [] as Array<[string, unknown]>, notes: [] as string[], track: 0 };
  const deps: ActDeps = {
    db: { from } as unknown as SupabaseClient, now: () => NOW,
    trackDelhivery: async () => { calls.track++; return over.track === undefined ? { statusCode: "EOD-11", status: "Consignee Unavailable" } : over.track; },
    defer: async (awb, date) => { calls.defer.push([awb, date]); if (over.fail) throw new Error("Delhivery 500"); return { uploadId: "UPL-1" }; },
    reattempt: async (awb) => { calls.reattempt.push(awb); if (over.fail) throw new Error("Delhivery 500"); return { uploadId: "UPL-2" }; },
    edit: async (awb, d) => { calls.edit.push([awb, d]); if (over.fail) throw new Error("Delhivery 500"); return { uploadId: "UPL-3" }; },
    notify: async (text) => { calls.notes.push(text); },
  };
  return { deps, t, calls };
}
const input = (over: Partial<ActInput> = {}): ActInput => ({ orderId: "AJUKI1", ask: { act: "DEFER_DLV", date: "2026-10-20" }, mode: "on", ...over });

async function main() {
  { const w = world();
    eq("off: nothing", [(await performCourierAction(w.deps, input({ mode: "off" }))).outcome, w.calls.track], ["off", 0]); }
  { const w = world();
    const r = await performCourierAction(w.deps, input({ mode: "dry" }));
    eq("dry: the plan, no courier call, nothing written", [r.outcome, r.act, r.deferredDate, w.calls.defer, w.t.delhivery_ndr_requests.length, w.t.orders[0].admin_notes], ["dry_run", "DEFER_DLV", "2026-10-20", [], 0, ""]); }
  { const w = world();
    const r = await performCourierAction(w.deps, input({ mode: "on", forceDry: true }));
    eq("a shadow run is forced to dry", [r.outcome, w.calls.defer], ["dry_run", []]);
    eq("forceDry cannot turn an off switch on", (await performCourierAction(w.deps, input({ mode: "off", forceDry: true }))).outcome, "off"); }
  { const w = world();
    const r = await performCourierAction(w.deps, input());
    eq("on: one defer call with the AWB and the date", [r.outcome, w.calls.defer, r.uploadId], ["submitted", [["60000000000007", "2026-10-20"]], "UPL-1"]);
    eq("it is NEVER reported as confirmed", r.confirmed, false);
    const row = w.t.delhivery_ndr_requests[0];
    eq("the ledger row the hourly pass reconciles: act, request id, the live code, the source", [row.act, row.upl_id, row.live_status_code, row.raw.source, row.raw.deferred_date], ["DEFER_DLV", "UPL-1", "EOD-11", "delivery_agent", "2026-10-20"]);
    eq("the breadcrumb the cap counts, in the exact historical shape", w.t.orders[0].admin_notes, `${NOTE_PREFIX} 2026-10-18 — live status was "Consignee Unavailable" (EOD-11).`);
    ok("the team is told it is submitted and not confirmed", /submitted/.test(w.calls.notes[0]) && /not yet confirmed/.test(w.calls.notes[0]));
    const again = await performCourierAction(w.deps, input());
    eq("a second ask the same day is refused: no second call", [again.outcome, again.to, w.calls.defer.length], ["refused", "wait", 1]); }
  { const w = world({ track: { statusCode: "EOD-74", status: "Customer unavailable" } });
    const r = await performCourierAction(w.deps, input({ ask: { act: "RE-ATTEMPT" } }));
    eq("a re-attempt is one call and counts as an ask", [r.outcome, w.calls.reattempt, /^NDR reattempt requested/.test(w.t.orders[0].admin_notes)], ["submitted", ["60000000000007"], true]); }
  { const w = world();
    const r = await performCourierAction(w.deps, input({ ask: { act: "EDIT_DETAILS", edit: { phone: "98765 43210" } } }));
    eq("an edit passes only the validated fields and adds no breadcrumb (it is not an ask)", [r.outcome, w.calls.edit, w.t.orders[0].admin_notes], ["submitted", [["60000000000007", { phone: "9876543210" }]], ""]);
    eq("…and is recorded for reconciliation", [w.t.delhivery_ndr_requests[0].act, w.t.delhivery_ndr_requests[0].upl_id], ["EDIT_DETAILS", "UPL-3"]); }
  { const w = world({ fail: true });
    const r = await performCourierAction(w.deps, input());
    eq("Delhivery fails: a failure, nothing recorded as asked, the team told", [r.outcome, w.t.delhivery_ndr_requests.length, w.t.orders[0].admin_notes, /failed/.test(w.calls.notes[0])], ["failed", 0, "", true]); }
  { const w = world({ ndr: [{ order_id: "AJUKI1", outcome: "deferred_retry" }, { order_id: "AJUKI1", outcome: "deferred_retry" }, { order_id: "AJUKI1", outcome: "accepted" }] });
    w.t.orders[0].admin_notes = [crumb("2026-10-01"), crumb("2026-10-02"), crumb("2026-10-03")].join("\n");
    eq("two of three asks were deferred_retry: the cap does not bite", (await performCourierAction(w.deps, input())).outcome, "submitted"); }
  { const w = world({ track: null });
    eq("tracking unreadable: wait, no call", [(await performCourierAction(w.deps, input())).to, w.calls.defer.length], ["wait", 0]);
    eq("order not found", (await performCourierAction(world({ orders: [] }).deps, input())).reason, "order not found"); }
  { const w = world({ insertError: { code: "23514", message: "check violation" } });
    const r = await performCourierAction(w.deps, input());
    eq("the request went out even if its ledger row did not save: still submitted, the breadcrumb still written (the next run must not ask again)", [r.outcome, /^NDR reattempt requested/.test(w.t.orders[0].admin_notes)], ["submitted", true]); }
  { const w = world();
    w.deps.db = { from: () => { throw new Error("db down"); } } as unknown as SupabaseClient;
    const r = await performCourierAction(w.deps, input());
    eq("a database failure is an outcome, not an exception", [r.outcome, /db down/.test(r.reason ?? "")], ["failed", true]); }
  // ── the customer's line for a submitted, unconfirmed action (founder, 18 Oct) ──
  eq("a date: the founder's wording, with the date the courier was actually sent", submittedLine({ orderId: "AJUKI1", act: "DEFER_DLV", deferredDate: "2026-10-20" }), "I have passed your request for 20 Oct to the courier. I will message you here when it moves. You can track it at www.ajuki.in/track.");
  eq("a clamped date says it is the latest the courier accepts", submittedLine({ orderId: "AJUKI1", act: "DEFER_DLV", deferredDate: "2026-10-21", clamped: true }), "I have passed a request for 21 Oct to the courier, the latest date they accept for this parcel. I will message you here when it moves. You can track it at www.ajuki.in/track.");
  eq("a re-attempt", submittedLine({ orderId: "AJUKI1", act: "RE-ATTEMPT" }), "I have passed a request for another delivery attempt on order AJUKI1 to the courier. I will message you here when it moves. You can track it at www.ajuki.in/track.");
  eq("a phone, an address, both", [submittedLine({ orderId: "A1", act: "EDIT_DETAILS", edit: { phone: "9876543210" } }), submittedLine({ orderId: "A1", act: "EDIT_DETAILS", edit: { address: "x" } }), submittedLine({ orderId: "A1", act: "EDIT_DETAILS", edit: { phone: "9876543210", address: "x" } })].map((t) => /new (number|address|number and address) for order A1/.exec(t)?.[1]), ["number", "address", "number and address"]);
  const lines = [submittedLine({ orderId: "AJUKI1", act: "DEFER_DLV", deferredDate: "2026-10-20" }), submittedLine({ orderId: "AJUKI1", act: "RE-ATTEMPT" }), submittedLine({ orderId: "AJUKI1", act: "EDIT_DETAILS", edit: { phone: "9876543210" } })];
  ok("it never says the courier did, will do, or confirmed anything", lines.every((t) => /^I have passed /.test(t) && !/\b(asked the courier|has agreed|confirmed|will deliver|will attempt|guarantee)\b/i.test(t)));
  ok("it promises a later message, which is why it waits for the movement updates", lines.every((t) => /I will message you here when it moves\./.test(t)));
  ok("it names no phone number and no address", lines.every((t) => !/\d{10}/.test(t)));
  eq("a defer with no usable date falls back to the plain re-attempt wording rather than inventing a date", /another delivery attempt/.test(submittedLine({ orderId: "A1", act: "DEFER_DLV", deferredDate: null })), true);
  console.log(`deliveryCourierAction: ${passed} assertions passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
