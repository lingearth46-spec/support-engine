// Run with `npx tsx lib/bookedAddressEdit.test.ts`. The booked-parcel address edit: the proposal line, the checks, and the approve and skip taps,
// with a fake database and fake couriers (nothing is sent anywhere).
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { proposalLine, openProposal, checkBookedEdit, approveAddressEdit, skipAddressEdit, parkAddressEditPending, type BookedOrder, type ApproveDeps, type Partner } from "@/lib/bookedAddressEdit";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

// ── the proposal line ────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const line = proposalLine("Flat 4B,  Green Park\nNew Delhi 110016", "110016");
  ok("one line, whitespace collapsed", !line.includes("\n") && line.endsWith("Flat 4B, Green Park New Delhi 110016"));
  eq("an open proposal is found", openProposal(`note one\n${line}`), { pincode: "110016", text: "Flat 4B, Green Park New Delhi 110016" });
  eq("the newest of two is the open one", openProposal(`${proposalLine("old address 560001", "560001")}\n[addr-edit-skipped 2026-10-17T00:00:00Z]\n${line}`)?.pincode, "110016");
  eq("a decided proposal is not open", openProposal(`${line}\n[addr-edit-approved 2026-10-17T00:00:00Z] done`), null);
  eq("a skipped one is not open", openProposal(`${line}\n[addr-edit-skipped 2026-10-17T00:00:00Z]`), null);
  eq("no notes", openProposal(null), null);
  eq("text is capped at 240 characters", (openProposal(proposalLine("x".repeat(500) + " 560001", "560001"))?.text ?? "").length <= 240, true);
}

// ── the checks ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const booked = (status: string, extra: Partial<BookedOrder> = {}): BookedOrder => ({ id: "AJUKI1", status, awb_code: "AWB1", address: { line1: "12 Old St", city: "Pune", pincode: "411001", phone: "9000000001" }, admin_notes: "", ...extra });
{
  eq("Delhivery, same pincode, failed-delivery window: fine, no warning", checkBookedEdit(booked("undelivered"), "411001", "Delhivery"), { ok: true, warnings: [], partner: "Delhivery" });
  const shipped = checkBookedEdit(booked("shipped"), "411001", "Delhivery");
  eq("Delhivery, parcel in transit: allowed, with a warning that the courier may refuse", [shipped.ok, shipped.warnings.length, /failed-delivery window/.test(shipped.warnings[0])], [true, 1, true]);
  const pin = checkBookedEdit(booked("undelivered"), "110016", "Delhivery");
  eq("Delhivery cannot change a pincode: refused with the reason", [pin.ok, /cannot change the pincode \(411001 to 110016\)/.test(pin.reason ?? "")], [false, true]);
  const sfx = checkBookedEdit(booked("shipped"), "110016", "Shadowfax");
  eq("Shadowfax with a different pincode: allowed, warned about the same-city rule", [sfx.ok, /same city/.test(sfx.warnings[0])], [true, true]);
  eq("Shadowfax, same pincode: nothing to warn", checkBookedEdit(booked("shipped"), "411001", "Shadowfax").warnings, []);
  eq("another courier: refused", checkBookedEdit(booked("shipped"), "411001", null).ok, false);
  eq("a delivered parcel: refused", checkBookedEdit(booked("delivered"), "411001", "Delhivery").ok, false);
  eq("an unbooked order: refused (the ordinary edit applies)", checkBookedEdit(booked("processing", { awb_code: null }), "411001", "Delhivery").ok, false);
}

// ── approve and skip, with a fake database and fake couriers ─────────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
function fakeDb(order: Row | null) {
  const state = { order, updates: [] as Row[], ndr: [] as Row[] };
  const db = {
    from(table: string) {
      const q: { patch: Row | null } = { patch: null };
      const b: Record<string, unknown> = {
        select: () => b, eq: () => b, update: (p: Row) => { q.patch = p; return b; },
        maybeSingle: async () => ({ data: state.order, error: null }),
        then: (res: (x: unknown) => unknown) => { if (q.patch && table === "orders") { state.updates.push(q.patch); if (state.order) Object.assign(state.order, q.patch); } return Promise.resolve({ data: null, error: null }).then(res); },
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { db, state };
}
function fakeDeps(partner: Partner, over: Partial<ApproveDeps> = {}) {
  const log = { delhivery: [] as string[], shadowfax: [] as unknown[], sent: [] as string[], recorded: [] as string[], logged: [] as (string | undefined)[] };
  const deps: ApproveDeps = {
    partnerOf: async () => partner,
    delhiveryEdit: async (awb, text) => { log.delhivery.push(`${awb}|${text}`); return { uploadId: "REQ-1" }; },
    shadowfaxEdit: async (awb, text, pincode) => { log.shadowfax.push([awb, text, pincode]); return { ok: true, note: "address updated" }; },
    logDelhivery: async (_db, _o, _awb, id) => { log.logged.push(id); },
    send: async (_p, t) => { log.sent.push(t); return true; },
    record: async (_db, r) => { log.recorded.push(r.body); },
    ...over,
  };
  return { deps, log };
}
const proposed = (pin: string, text = "Flat 4B Green Park") => proposalLine(`${text} ${pin}`, pin);

async function main() {
  { // Delhivery, same pincode: submitted, logged for the reconcile pass, our copy updated with the old one kept, the customer told
    const o: Row = { id: "AJUKI1", status: "undelivered", awb_code: "AWB1", address: { line1: "12 Old St", city: "Pune", pincode: "411001", phone: "9000000001" }, admin_notes: proposed("411001") };
    const { db, state } = fakeDb(o); const { deps, log } = fakeDeps("Delhivery");
    const r = await approveAddressEdit(db, "AJUKI1", deps);
    eq("approved", [r.ok, r.toast], [true, "Sent to the courier"]);
    eq("Delhivery was asked once, with the address text", log.delhivery, ["AWB1|Flat 4B Green Park 411001"]);
    eq("the request is logged so the hourly check can verify it", log.logged, ["REQ-1"]);
    const addr = state.updates[0].address as Row; const notes = String(state.updates[0].admin_notes);
    eq("our copy follows", [addr.line1, addr.pincode, addr.city], ["Flat 4B Green Park 411001", "411001", "Pune"]);
    ok("the old address is kept in the note", /\[addr-edit-approved [^\]]+\] Delhivery: edit submitted \(request REQ-1\)[^|]*\| was: 12 Old St, Pune, 411001/.test(notes));
    eq("the customer is told it was sent, with no promise", [log.sent.length, /sent to the courier/.test(log.sent[0]), /will confirm|within|today|soon/i.test(log.sent[0])], [1, true, false]);
    eq("and it is recorded on the thread", log.recorded.length, 1);
    eq("a second tap finds nothing open", (await approveAddressEdit(db, "AJUKI1", deps)).toast, "Already handled");
  }
  { // Delhivery, different pincode: refused, nothing sent, nothing changed
    const o: Row = { id: "AJUKI2", status: "undelivered", awb_code: "AWB2", address: { line1: "12 Old St", pincode: "411001", phone: "9000000001" }, admin_notes: proposed("110016") };
    const { db, state } = fakeDb(o); const { deps, log } = fakeDeps("Delhivery");
    const r = await approveAddressEdit(db, "AJUKI2", deps);
    eq("refused with the reason, courier never called, our copy untouched, customer not told", [r.ok, /cannot change the pincode/.test(r.edit ?? ""), log.delhivery.length, state.updates.length, log.sent.length], [false, true, 0, 0, 0]);
  }
  { // Shadowfax with a pincode change passes the pincode through; the courier's own refusal stops everything
    const o: Row = { id: "AJUKI3", status: "shipped", awb_code: "AWB3", address: { line1: "12 Old St", pincode: "411001", phone: "9000000001" }, admin_notes: proposed("411002") };
    const { db } = fakeDb(o); const { deps, log } = fakeDeps("Shadowfax");
    const r = await approveAddressEdit(db, "AJUKI3", deps);
    eq("Shadowfax gets the new pincode", [r.ok, (log.shadowfax[0] as unknown[])[2]], [true, "411002"]);
    ok("the Telegram note carries the same-city warning", /same city/.test(r.edit ?? ""));
    const o2: Row = { id: "AJUKI4", status: "shipped", awb_code: "AWB4", address: { line1: "12 Old St", pincode: "411001", phone: "9000000001" }, admin_notes: proposed("411001") };
    const f = fakeDb(o2); const d2 = fakeDeps("Shadowfax", { shadowfaxEdit: async () => ({ ok: false, note: "intercity not allowed" }) });
    const r2 = await approveAddressEdit(f.db, "AJUKI4", d2.deps);
    eq("a courier refusal: nothing changed, customer not told", [r2.ok, f.state.updates.length, d2.log.sent.length], [false, 0, 0]);
  }
  { // a courier we cannot edit, a thrown error, a missing order
    const o: Row = { id: "AJUKI5", status: "shipped", awb_code: "AWB5", address: { pincode: "411001", phone: "9000000001" }, admin_notes: proposed("411001") };
    eq("another courier: refused", (await approveAddressEdit(fakeDb(o).db, "AJUKI5", fakeDeps(null).deps)).ok, false);
    const o6: Row = { id: "AJUKI6", status: "undelivered", awb_code: "AWB6", address: { pincode: "411001", phone: "9000000001" }, admin_notes: proposed("411001") };
    const f = fakeDb(o6); const r = await approveAddressEdit(f.db, "AJUKI6", fakeDeps("Delhivery", { delhiveryEdit: async () => { throw new Error("boom"); } }).deps);
    eq("a courier error: not changed", [r.ok, /boom/.test(r.edit ?? ""), f.state.updates.length], [false, true, 0]);
    eq("no such order", (await approveAddressEdit(fakeDb(null).db, "AJUKI7", fakeDeps("Delhivery").deps)).toast, "Order not found");
    const o8: Row = { id: "AJUKI8", status: "delivered", awb_code: "AWB8", address: { pincode: "411001" }, admin_notes: proposed("411001") };
    eq("a delivered parcel: refused", (await approveAddressEdit(fakeDb(o8).db, "AJUKI8", fakeDeps("Delhivery").deps)).ok, false);
  }
  { // skip: the courier is left alone and the proposal is closed
    const o: Row = { id: "AJUKI9", status: "shipped", awb_code: "AWB9", address: { pincode: "411001" }, admin_notes: proposed("411001") };
    const { db, state } = fakeDb(o);
    const r = await skipAddressEdit(db, "AJUKI9");
    eq("skipped", [r.toast, /skipped/.test(String(state.updates[0].admin_notes)), openProposal(String(state.updates[0].admin_notes))], ["Skipped", true, null]);
  }
  { // the ask for a new address parks the same pending action the webhook already answers with the proposal flow
    const seen: Row[] = [];
    const mk = (error: { message: string } | null) => ({ from: (t: string) => ({ upsert: async (row: Row, opt: Row) => { seen.push({ t, row, opt }); return { error }; } }) }) as unknown as SupabaseClient;
    eq("parked: true", await parkAddressEditPending(mk(null), "9000000001", "AJUKI1"), true);
    const row = seen[0].row as Row; const pa = row.pending_action as Row;
    eq("on wa_conversations, keyed by phone, kind confirm_addr_edit for that order", [seen[0].t, row.phone, (seen[0].opt as Row).onConflict, pa.kind, pa.order_id, typeof pa.set_at], ["wa_conversations", "9000000001", "phone", "confirm_addr_edit", "AJUKI1", "string"]);
    eq("a failed write is reported as false", await parkAddressEditPending(mk({ message: "boom" }), "9000000001", "AJUKI1"), false);
  }
  console.log(`bookedAddressEdit: ${passed} assertions passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
