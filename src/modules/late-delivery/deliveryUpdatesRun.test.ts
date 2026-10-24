// Run with `npx tsx lib/deliveryUpdatesRun.test.ts`. The movement sweep with a fake database and fake WhatsApp: nothing is sent anywhere.
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runDeliveryUpdates, updatesMode, WINDOW_HOURS, type UpdatesDeps } from "@late/deliveryUpdatesRun";
import { UPDATE_TEMPLATE } from "@late/deliveryMovement";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

type Row = Record<string, any>;
const NOW = Date.parse("2026-10-18T09:00:00Z");
const H = 3_600_000;
const ago = (h: number) => new Date(NOW - h * H).toISOString();
const scan = (order: string, h: number, event: string) => ({ order_id: order, event, raw_status: event, remark: null, location: "Hub", scanned_at: ago(h) });

function world(over: { cases?: Row[]; scans?: Row[]; orders?: Row[]; optouts?: Row[]; convs?: Row[]; noTable?: boolean; sendOk?: boolean; stealClaim?: boolean } = {}) {
  const t: Record<string, Row[]> = {
    delivery_cases: over.cases ?? [{ id: 1, phone: "9000000001", order_id: "AJUKI1", status: "open", mode: "live", last_scan_at: ago(30), ledger: { stall: false, movement: { lastEvent: "in_transit", updatesSent: 0, lastUpdateAt: null } }, updated_at: ago(30) }],
    parcel_scans: over.scans ?? [scan("AJUKI1", 30, "in_transit"), scan("AJUKI1", 2, "at_facility")],
    orders: over.orders ?? [{ id: "AJUKI1", status: "shipped" }], wa_optouts: over.optouts ?? [], wa_conversations: over.convs ?? [{ phone: "9000000001", last_in_at: ago(5) }],
  };
  const from = (table: string) => {
    const q = { op: "select" as "select" | "update", f: [] as Array<[string, unknown]>, inF: null as [string, unknown[]] | null, patch: null as Row | null, wantRows: false };
    const run = (): { data: any; error: any } => {
      if (over.noTable && table === "delivery_cases") return { data: null, error: { code: "42P01", message: "relation does not exist" } };
      const rows = t[table] ?? [];
      const match = rows.filter((r) => q.f.every(([c, v]) => r[c] === v) && (!q.inF || q.inF[1].includes(r[q.inF[0]])));
      if (q.op === "update") {
        if (over.stealClaim && table === "delivery_cases" && q.f.some(([c]) => c === "updated_at")) return { data: [], error: null };
        match.forEach((r) => Object.assign(r, q.patch)); return { data: q.wantRows ? match.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: match.map((r) => ({ ...r })), error: null }; // a read returns copies, as the database does
    };
    const b: Record<string, unknown> = {
      select: () => { if (q.op === "update") q.wantRows = true; return b; }, update: (p: Row) => { q.op = "update"; q.patch = p; return b; },
      eq: (c: string, v: unknown) => { q.f.push([c, v]); return b; }, in: (c: string, v: unknown[]) => { q.inF = [c, v]; return b; }, order: () => b, limit: () => b,
      maybeSingle: async () => { const r = run(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }; },
      then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  const sent = { text: [] as Array<[string, string]>, tpl: [] as Array<[string, string, string[]]>, rec: [] as Row[] };
  const deps: UpdatesDeps = {
    db: { from } as unknown as SupabaseClient, now: () => NOW,
    sendText: async (p, x) => { if (over.sendOk === false) return false; sent.text.push([p, x]); return true; },
    sendTemplate: async (p, n, v) => { if (over.sendOk === false) return false; sent.tpl.push([p, n, v]); return true; },
    record: async (r) => { sent.rec.push(r); }, sleep: async () => {},
  };
  return { deps, t, sent };
}

async function main() {
  eq("off by default; dry; on", [updatesMode({}), updatesMode({ SUPPORT_DELIVERY_UPDATES: "dry" }), updatesMode({ SUPPORT_DELIVERY_UPDATES: "ON" }), updatesMode({ SUPPORT_DELIVERY_UPDATES: "yes" })], ["off", "dry", "on", "off"]);
  eq("the window margin is under 24 hours", WINDOW_HOURS < 24, true);

  { const w = world();
    const r = await runDeliveryUpdates(w.deps, { mode: "off" });
    eq("off: nothing read, nothing sent", [r.skippedRun, r.considered, w.sent.text.length], ["SUPPORT_DELIVERY_UPDATES is off", 0, 0]); }
  { const w = world();
    const r = await runDeliveryUpdates(w.deps, { mode: "dry" });
    eq("dry: the decision is reported with the last four digits only, nothing sent or written", [r.wouldSend, w.sent.text.length, w.t.delivery_cases[0].last_scan_at], [[{ replyId: "D1", order: "AJUKI1", via: "text", phone: "…0001" }], 0, ago(30)]); }
  { const w = world();
    const r = await runDeliveryUpdates(w.deps, { mode: "on" });
    eq("on, inside the window: free text, once", [r.sent, w.sent.text, w.sent.tpl.length], [1, [["9000000001", "Update on your order AJUKI1: the latest status is in transit. We are working to get it to you as soon as possible. You can follow it at www.ajuki.in/track."]], 0]);
    const row = w.t.delivery_cases[0];
    eq("the case remembers the scan told, the stage, and one update", [row.last_scan_at, row.ledger.movement.lastEvent, row.ledger.movement.updatesSent, row.ledger.stall], [ago(2), "at_facility", 1, false]);
    eq("the message is recorded as the agent's, and is not a reply", [w.sent.rec[0].orderId, w.sent.rec[0].aiMeta.deliveryUpdate.via, w.sent.rec[0].aiMeta.deliveryUpdate.replyId], ["AJUKI1", "text", "D1"]);
    const again = await runDeliveryUpdates(w.deps, { mode: "on" });
    eq("a second sweep with no new scan sends nothing", [again.sent, again.reasons["skip:no_movement"]], [0, 1]); }
  { const w = world({ convs: [{ phone: "9000000001", last_in_at: ago(30) }] });
    const r = await runDeliveryUpdates(w.deps, { mode: "on" });
    eq("outside the 24 hour window: the approved template, with the order id and the status", [r.sent, w.sent.tpl, w.sent.text.length], [1, [["9000000001", UPDATE_TEMPLATE, ["AJUKI1", "in transit"]]], 0]); }
  { const w = world({ convs: [] });
    const r = await runDeliveryUpdates(w.deps, { mode: "on" });
    eq("no conversation row at all: template (the window is not open)", [r.sent, w.sent.tpl.length], [1, 1]); }
  { const w = world({ optouts: [{ phone: "9000000001" }] });
    const r = await runDeliveryUpdates(w.deps, { mode: "on" });
    eq("an opted-out customer is never messaged, and the case moves on", [r.sent, r.reasons["skip:opted_out"], w.t.delivery_cases[0].last_scan_at], [0, 1, ago(2)]); }
  { const w = world({ sendOk: false });
    const r = await runDeliveryUpdates(w.deps, { mode: "on" });
    eq("a failed send hands the claim back: the case is exactly as it was, and it is counted", [r.failed, r.sent, w.t.delivery_cases[0].last_scan_at, w.t.delivery_cases[0].ledger.movement.updatesSent, w.sent.rec.length], [1, 0, ago(30), 0, 0]); }
  { const w = world({ stealClaim: true });
    const r = await runDeliveryUpdates(w.deps, { mode: "on" });
    eq("a claim lost to another run: nothing sent", [r.sent, r.reasons["skip:claimed_elsewhere"], w.sent.text.length], [0, 1, 0]); }
  { // stages the lifecycle covers, delivered, returning
    const w = world({ scans: [scan("AJUKI1", 30, "in_transit"), scan("AJUKI1", 1, "out_for_delivery")] });
    const r = await runDeliveryUpdates(w.deps, { mode: "on" });
    eq("out for delivery: not repeated here, the baseline moves", [r.sent, r.reasons["skip:covered_by_lifecycle"], w.t.delivery_cases[0].last_scan_at], [0, 1, ago(1)]);
    const w2 = world({ scans: [scan("AJUKI1", 30, "in_transit"), scan("AJUKI1", 1, "delivered")] });
    const r2 = await runDeliveryUpdates(w2.deps, { mode: "on" });
    eq("delivered: the case is closed, nothing sent", [r2.closed, r2.sent, w2.t.delivery_cases[0].status, w2.t.delivery_cases[0].closed_reason], [1, 0, "closed", "delivered"]);
    const w3 = world({ scans: [scan("AJUKI1", 30, "in_transit"), scan("AJUKI1", 1, "rto_initiated")] });
    await runDeliveryUpdates(w3.deps, { mode: "on" });
    eq("returning to us: closed", w3.t.delivery_cases[0].closed_reason, "returning_to_us"); }
  { // shadow cases are not this sweep's
    const w = world({ cases: [{ id: 2, phone: "9000000002", order_id: "AJUKI1", status: "open", mode: "shadow", last_scan_at: ago(30), ledger: {}, updated_at: ago(30) }] });
    const r = await runDeliveryUpdates(w.deps, { mode: "on" });
    eq("a shadow case is never messaged", [r.considered, r.sent], [0, 0]); }
  { // the cap per run
    const cases = [1, 2, 3].map((i) => ({ id: i, phone: `900000000${i}`, order_id: `AJUKI${i}`, status: "open", mode: "live", last_scan_at: ago(30), ledger: {}, updated_at: ago(30) }));
    const scans = [1, 2, 3].flatMap((i) => [scan(`AJUKI${i}`, 30, "in_transit"), scan(`AJUKI${i}`, 2, "at_facility")]);
    const w = world({ cases, scans, orders: [1, 2, 3].map((i) => ({ id: `AJUKI${i}`, status: "shipped" })), convs: [1, 2, 3].map((i) => ({ phone: `900000000${i}`, last_in_at: ago(5) })) });
    const r = await runDeliveryUpdates(w.deps, { mode: "on", maxSends: 2 });
    eq("a run sends at most its cap; the rest wait for the next", [r.sent, r.reasons["skip:run_cap"]], [2, 1]); }
  { const w = world({ noTable: true });
    const r = await runDeliveryUpdates(w.deps, { mode: "on" });
    ok("the table is not there: it says so and does nothing", /migration is not applied/.test(r.skippedRun ?? "") && w.sent.text.length === 0); }
  { const w = world({ cases: [] });
    eq("no open cases: nothing", (await runDeliveryUpdates(w.deps, { mode: "on" })).considered, 0); }
  console.log(`deliveryUpdatesRun: ${passed} assertions passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
