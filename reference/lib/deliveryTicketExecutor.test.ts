// Run with `npx tsx lib/deliveryTicketExecutor.test.ts`. The executor with a fake database and fake couriers: nothing is sent anywhere.
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requestTicket, ticketsMode, triggerFor, type ExecDeps, type ExecInput } from "@/lib/deliveryTicketExecutor";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

type Row = Record<string, any>;
const NOW = Date.parse("2026-10-18T09:00:00Z");
const ACTIVE = ["queued", "raising", "raised", "deflected", "unknown"];

function world(over: { orders?: Row[]; tickets?: Row[]; requests?: Row[]; cases?: Row[]; track?: Row | null; sfxStatus?: string | null; raiseFails?: boolean; insertError?: { code?: string; message: string } } = {}) {
  const t: Record<string, Row[]> = {
    orders: (over.orders ?? [{ id: "AJUKI1", awb_code: "60000000000007", courier_name: "Delhivery", shiprocket_order_id: null, status: "undelivered", admin_notes: "", pending_courier_edit: null }]).map((o) => ({ ...o })),
    courier_tickets: over.tickets ?? [], courier_requests: over.requests ?? [], delivery_cases: over.cases ?? [],
  };
  let nextId = 1;
  const from = (table: string) => {
    const q = { op: "select" as "select" | "insert" | "update", f: [] as Array<[string, unknown]>, row: null as Row | null, patch: null as Row | null, wantRow: false };
    const run = (): { data: any; error: any } => {
      const rows = t[table] ?? [];
      const match = rows.filter((r) => q.f.every(([c, v]) => r[c] === v));
      if (q.op === "insert") {
        if (over.insertError) return { data: null, error: over.insertError };
        if (table === "courier_requests" && ACTIVE.includes(q.row!.status) && rows.some((r) => r.awb === q.row!.awb && ACTIVE.includes(r.status))) return { data: null, error: { code: "23505", message: "duplicate key" } };
        const row = { id: `req${nextId++}`, created_at: new Date(NOW).toISOString(), ...q.row };
        rows.push(row);
        return { data: q.wantRow ? { id: row.id } : null, error: null };
      }
      if (q.op === "update") { match.forEach((r) => Object.assign(r, q.patch)); return { data: null, error: null }; }
      return { data: q.wantRow ? (match[0] ?? null) : match, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => { if (q.op === "insert") q.wantRow = true; return b; },
      insert: (row: Row) => { q.op = "insert"; q.row = row; return b; },
      update: (p: Row) => { q.op = "update"; q.patch = p; return b; },
      eq: (c: string, v: unknown) => { q.f.push([c, v]); return b; },
      limit: () => b,
      maybeSingle: async () => { q.wantRow = true; return run(); },
      single: async () => { q.wantRow = true; return run(); },
      then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  const calls = { track: 0, sfxStatus: 0, raise: [] as Array<[string, string]>, notes: [] as string[] };
  const deps: ExecDeps = {
    db: { from } as unknown as SupabaseClient, now: () => NOW,
    trackDelhivery: async () => { calls.track++; return (over.track === undefined ? { status: "Pending", statusType: "UD", statusCode: "DTUP-203", statusDateTime: "2026-10-15T22:34:10.438", promisedDate: "2026-10-15T23:59:59" } : over.track) as never; },
    shadowfaxStatus: async () => { calls.sfxStatus++; return over.sfxStatus === undefined ? "in_transit" : over.sfxStatus; },
    raiseShadowfax: async (awb, cat) => { calls.raise.push([awb, cat]); if (over.raiseFails) throw new Error("Shadowfax refused the escalation"); },
    escalatedNote: () => "[sfx-escalated 2026-10-18]",
    notify: async (text) => { calls.notes.push(text); },
    ndrCodes: new Set(["EOD-11"]), maxedCodes: new Set<string>(),
  };
  return { deps, t, calls };
}
const input = (over: Partial<ExecInput> = {}): ExecInput => ({ phone: "9000000001", orderId: "AJUKI1", escalate: "stall_48h", mode: "on", ...over });
const SFX_ORDER = { id: "AJUKI2", awb_code: "SF00000000013", courier_name: "Shadowfax", shiprocket_order_id: null, status: "undelivered", admin_notes: "earlier note", pending_courier_edit: null };

async function main() {
  // ── the switch and the triggers ──
  eq("off by default; dry; on; anything else is off", [ticketsMode({}), ticketsMode({ SUPPORT_DELIVERY_AGENT_TICKETS: "dry" }), ticketsMode({ SUPPORT_DELIVERY_AGENT_TICKETS: " ON " }), ticketsMode({ SUPPORT_DELIVERY_AGENT_TICKETS: "yes" })], ["off", "dry", "on", "off"]);
  eq("which escalations ask for a ticket", [triggerFor("stall_48h"), triggerFor("repeat_chase"), triggerFor("dispute_manual"), triggerFor("two_failed"), triggerFor("no_lever"), triggerFor("needs_human"), triggerFor("not_received"), triggerFor("none")], ["stalled", "delay", "disputed_attempt", null, null, null, null, null]);

  { // off: nothing is looked up, written or sent
    const w = world();
    eq("off: nothing", [(await requestTicket(w.deps, input({ mode: "off" }))).outcome, w.calls.track, w.t.courier_requests.length], ["off", 0, 0]);
    eq("an escalation that is not a ticket trigger", [(await requestTicket(w.deps, input({ escalate: "needs_human" }))).outcome, w.calls.track, w.t.courier_requests.length], ["not_a_trigger", 0, 0]);
  }
  { // dry: a row with an inactive status, no courier call, no notification
    const w = world({ cases: [{ id: 5, phone: "9000000001", order_id: "AJUKI1", status: "open" }] });
    const r = await requestTicket(w.deps, input({ mode: "dry" }));
    eq("dry: outcome", [r.outcome, r.courier, r.kind], ["dry_run", "delhivery", "stalled"]);
    const row = w.t.courier_requests[0];
    eq("the row: dry_run, the agent's source, priority 1, the case id, the delay pair and text", [row.status, row.source, row.priority, row.case_id, row.ticket.category, /DTUP-203 on 15 Oct/.test(row.ticket.description)], ["dry_run", "delivery_agent", 1, "5", "Reattempt or Delay in delivery / consignee pickup / return", true]);
    eq("no courier was asked to raise anything and nobody was notified", [w.calls.raise, w.calls.notes], [[], []]);
    const again = await requestTicket(w.deps, input({ mode: "dry" }));
    eq("a second dry run within a day is held by the first", [again.outcome, again.to], ["refused", "wait"]);
  }
  { // a shadow run is never more than dry
    const w = world({ orders: [SFX_ORDER] });
    const r = await requestTicket(w.deps, input({ orderId: "AJUKI2", mode: "on", forceDry: true }));
    eq("forced dry: a row, no Shadowfax call, the marker untouched", [r.outcome, w.t.courier_requests[0]?.status, w.calls.raise, w.t.orders[0].admin_notes], ["dry_run", "dry_run", [], "earlier note"]);
    eq("forceDry cannot turn a switch that is off on", (await requestTicket(w.deps, input({ mode: "off", forceDry: true }))).outcome, "off");
  }
  { // on, Delhivery: queued for the night run; nothing is raised now
    const w = world();
    const r = await requestTicket(w.deps, input());
    eq("on, Delhivery: queued", [r.outcome, w.t.courier_requests[0].status, w.calls.raise, w.calls.notes.length], ["queued", "queued", [], 1]);
    ok("the notification says it waits for tonight's run", /tonight's run/.test(w.calls.notes[0]));
    const second = await requestTicket(w.deps, input());
    eq("a second request for the parcel is refused: one active request per AWB", [second.outcome, second.to], ["refused", "wait"]);
  }
  { // the index is the last guard: if the read missed an active row the insert is refused and reported as a duplicate
    const w = world({ insertError: { code: "23505", message: "duplicate key" } });
    eq("a unique violation is a duplicate, not a failure", (await requestTicket(w.deps, input())).outcome, "duplicate");
  }
  { // on, Shadowfax: the API call happens now, once; the row and the marker follow
    const w = world({ orders: [SFX_ORDER] });
    const r = await requestTicket(w.deps, input({ orderId: "AJUKI2" }));
    eq("on, Shadowfax: raised, one API call with the right category", [r.outcome, w.calls.raise], ["raised", [["SF00000000013", "delayed_delivery"]]]);
    eq("the row is raised and the one-ticket marker is written beside the old note", [w.t.courier_requests[0].status, w.t.orders[0].admin_notes], ["raised", "earlier note\n[sfx-escalated 2026-10-18] delayed_delivery (late-delivery agent)"]);
    ok("the notification names the Shadowfax label", /My shipment is delayed/.test(w.calls.notes[0]));
    const again = await requestTicket(w.deps, input({ orderId: "AJUKI2" }));
    eq("a second request while one is active: refused, no second API call", [again.outcome, again.to, w.calls.raise.length], ["refused", "wait", 1]);
    const marked = world({ orders: [{ ...SFX_ORDER, admin_notes: "x\n[sfx-escalated 2026-10-10] delayed delivery" }] });
    const m = await requestTicket(marked.deps, input({ orderId: "AJUKI2" }));
    eq("a parcel already escalated once (the marker, no request of ours): a person, nothing raised", [m.outcome, m.to, marked.calls.raise.length], ["refused", "person", 0]);
  }
  { // a disputed attempt at Shadowfax is filed as status_mismatch
    const w = world({ orders: [SFX_ORDER], sfxStatus: "ofd" });
    const r = await requestTicket(w.deps, input({ orderId: "AJUKI2", escalate: "dispute_manual", claim: "no_call" }));
    eq("dispute: status_mismatch, priority 0", [r.outcome, w.calls.raise[0]?.[1], w.t.courier_requests[0].priority, w.t.courier_requests[0].evidence.claim], ["raised", "status_mismatch", 0, "no_call"]);
    ok("the notification says Fake status", /Fake status/.test(w.calls.notes[0]));
  }
  { // Shadowfax refuses: the row says so, no marker, the team is told
    const w = world({ orders: [SFX_ORDER], raiseFails: true });
    const r = await requestTicket(w.deps, input({ orderId: "AJUKI2" }));
    eq("refused by Shadowfax: failed, row refused, marker NOT written", [r.outcome, w.t.courier_requests[0].status, /Shadowfax refused/.test(w.t.courier_requests[0].reason), w.t.orders[0].admin_notes], ["failed", "refused", true, "earlier note"]);
    ok("the team is told", /did not accept/.test(w.calls.notes[0]));
  }
  { // guards that come from the builder reach the caller as a refusal with the reason and who takes it
    eq("tracking unreadable: wait", (await requestTicket(world({ track: null }).deps, input())).to, "wait");
    eq("promised date not passed: wait", (await requestTicket(world({ track: { status: "Pending", statusType: "UD", statusCode: "DTUP-203", statusDateTime: "2026-10-17T22:00:00", promisedDate: "2026-10-18T23:59:59" } }).deps, input())).to, "wait");
    eq("an open ticket already exists: wait", (await requestTicket(world({ tickets: [{ awb: "60000000000007", ticket_state: "open" }] }).deps, input())).to, "wait");
    eq("a closed ticket does not block", (await requestTicket(world({ tickets: [{ awb: "60000000000007", ticket_state: "closed" }] }).deps, input())).outcome, "queued");
    eq("the same kind asked inside fourteen days: wait", (await requestTicket(world({ requests: [{ awb: "60000000000007", kind: "stalled", status: "expired", created_at: new Date(NOW - 5 * 86_400_000).toISOString() }] }).deps, input())).to, "wait");
    eq("the same kind asked fifteen days ago does not block", (await requestTicket(world({ requests: [{ awb: "60000000000007", kind: "stalled", status: "expired", created_at: new Date(NOW - 15 * 86_400_000).toISOString() }] }).deps, input())).outcome, "queued");
    const sr = world({ orders: [{ ...SFX_ORDER, courier_name: "Delhivery", shiprocket_order_id: "9", awb_code: "60000000000007" }] });
    const srr = await requestTicket(sr.deps, input({ orderId: "AJUKI2" }));
    eq("a Shiprocket-assigned parcel: a person, and tracking is not even asked", [srr.to, sr.calls.track], ["person", 0]);
    eq("order not found", (await requestTicket(world({ orders: [] }).deps, input())).reason, "order not found");
  }
  { // never throws
    const w = world();
    w.deps.db = { from: () => { throw new Error("db down"); } } as unknown as SupabaseClient;
    const r = await requestTicket(w.deps, input());
    eq("a database failure is an outcome, not an exception", [r.outcome, /db down/.test(r.reason ?? "")], ["failed", true]);
  }
  console.log(`deliveryTicketExecutor: ${passed} assertions passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
