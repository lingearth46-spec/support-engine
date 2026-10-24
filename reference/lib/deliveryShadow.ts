// SHADOW of the late-delivery agent on live traffic. Records, never sends.
//
// For a message about a parcel that looks late or failed, this runs the whole late-delivery workflow (the supervisor's reading of the chat, the analyst's
// reading of the raw scans, the state-aware decision in lib/deliveryCaseState.ts) and writes what it WOULD have said and done onto the inbound message's
// ai_meta.deliveryAgent, beside what the live bot really did. It also keeps the agent's own memory (delivery_cases) so a thread is judged with state.
//
// Guarantees, because it runs inside the live handler (the same as lib/generalShadow.ts):
//   · DEFAULT OFF (SUPPORT_DELIVERY_AGENT). Only the value "shadow" turns it on; "on" is not built and behaves as off.
//   · Started AFTER the reply is final and not awaited: it adds no latency and cannot change the text, the action, the escalation or anything the
//     handler does. Every error is swallowed.
//   · It performs nothing: no courier action is taken, no message is sent, no case or escalation is opened. The only writes are the inbound row's
//     ai_meta and its own delivery_cases row.
//   · A code-only gate decides whether a message is worth it, so non-late traffic never costs a model call.
// Cost: two model reads per gated message (about 1 K and 1.5 K tokens). SUPPORT_DELIVERY_AGENT_RATE (0 to 1, default 1) samples by a stable phone hash.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { carrierOf } from "@/lib/ndrCapability";
import { mergeAiMeta } from "@/lib/inboundMeta";
import {
  buildTimeline, decideDelivery, deliveryGate, pickDeliveryOrder, mergeIntent, intentFromText, emptyState, emptyLedger, liveLiteLine, LATE_TALK, type LiveLiteLine,
  type CaseState, type Courier, type DeliveryScan, type DeliveryOrder, type OrderView, type DeliveryIntent, type Escalate, type Timeline,
} from "@/lib/deliveryCaseState";
import { readIntent, analyseParcel, type IntentRead, type Analysis } from "@/lib/deliveryLlm";

export const DELIVERY_SHADOW_VERSION = 1;

/** off (default) | shadow (records, sends nothing) | live (live-lite: sends the few approved lines in LIVE_LITE_IDS, no courier action). Anything else is off. */
export function deliveryAgentMode(env: Record<string, string | undefined> = process.env): "off" | "shadow" | "live" {
  const v = (env.SUPPORT_DELIVERY_AGENT ?? "").trim().toLowerCase();
  return v === "shadow" ? "shadow" : v === "live" ? "live" : "off";
}

/** A stable sample: the same customer is always in or always out, so a thread is shadowed whole. */
export function deliverySampled(phone: string, env: Record<string, string | undefined> = process.env): boolean {
  const rate = Number(env.SUPPORT_DELIVERY_AGENT_RATE ?? "1");
  if (!Number.isFinite(rate) || rate >= 1) return true;
  if (rate <= 0) return false;
  return parseInt(createHash("sha1").update(phone).digest("hex").slice(0, 8), 16) / 0xffffffff < rate;
}

export interface ShadowOrder {
  id: string; status?: string | null; estimated_delivery?: string | null; courier_name?: unknown; shiprocket_order_id?: unknown;
  address?: { pincode?: unknown; pin?: unknown } | null; created_at?: string | null;
}
export interface ShadowInput {
  db: SupabaseClient; phone: string; message: string; history: { direction: "in" | "out"; body: string }[]; orders: ShadowOrder[]; inboundId: string | undefined;
  live: { text: string | null; action: string; kind: string };
  now?: number; fetchImpl?: typeof fetch;
}

export interface DeliveryShadowRecord {
  v: number; at: string; skipped: string | null;
  order: { id: string; courier: Courier } | null;
  timeline: Pick<Timeline, "attempts" | "phase" | "cause" | "lastEvent" | "movedSinceFailure" | "prePickup"> & { hoursSinceMovement: number | null } | null;
  intent: { model: { situation: string; intent: string; confidence: string } | null; modelError: string | null; pattern: DeliveryIntent; merged: DeliveryIntent } | null;
  analyst: { cause: string; attempts: number; hours: number; next: string; agreesAttempts: boolean; agreesHours: boolean; remarks: string[] } | null;
  analystError: string | null;
  decision: { replyId: string; text: string; escalate: Escalate; action: { name: string; allowed: boolean } | null; moved: boolean; awaiting: string | null; chases: number } | null;
  live: { kind: string; action: string; escalated: boolean; sameText: boolean };
  state: { stored: boolean; note: string | null };
  tokens: number; calls: number; ms: number;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9₹@. ]/g, "").trim();
const IST = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");

function courierOf(o: ShadowOrder): Courier {
  const c = carrierOf({ courier_name: o.courier_name, shiprocket_order_id: o.shiprocket_order_id });
  return c === "delhivery" || c === "shadowfax" || c === "dtdc" ? c : "other";
}

const noTable = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === "42P01" || /does not exist|schema cache|could not find the table/i.test(e.message ?? ""));

export async function loadScans(db: SupabaseClient, ids: string[]): Promise<{ scans: Map<string, DeliveryScan[]>; ok: boolean }> {
  const scans = new Map<string, DeliveryScan[]>();
  if (!ids.length) return { scans, ok: true };
  const { data, error } = await db.from("parcel_scans").select("order_id,event,raw_status,remark,location,scanned_at").in("order_id", ids).order("scanned_at", { ascending: true }).limit(3000);
  if (error || !data) return { scans, ok: false };
  for (const r of data as { order_id: string; event: string; raw_status: string | null; remark: string | null; location: string | null; scanned_at: string | null }[]) {
    if (!r.scanned_at) continue;
    (scans.get(r.order_id) ?? scans.set(r.order_id, []).get(r.order_id)!).push({ event: r.event, raw_status: r.raw_status, remark: r.remark, location: r.location, scanned_at: r.scanned_at });
  }
  return { scans, ok: true };
}

interface CaseRow { id: number; awaiting: string | null; chases: number; failed_attempts: number; last_scan_at: string | null; last_reply_at: string | null; ledger: Record<string, unknown> | null }
const toState = (r: CaseRow): CaseState => ({
  awaiting: r.awaiting === "rider_answer" || r.awaiting === "date" || r.awaiting === "address" ? r.awaiting : null, chases: r.chases ?? 0, failedAttempts: r.failed_attempts ?? 0,
  lastScanAt: r.last_scan_at ? Date.parse(r.last_scan_at) : null, lastReplyAt: r.last_reply_at ? Date.parse(r.last_reply_at) : null,
  ledger: { ...emptyLedger(), ...(r.ledger as Partial<ReturnType<typeof emptyLedger>> | null ?? {}) },
});

/**
 * The whole chat is read (founder 19 Oct): how many separate times this customer already asked about their delivery before this message. Their inbound messages of the last
 * ten days that talk about a delivery, grouped into bursts (a gap of 20 minutes or more starts a new one). The message being answered is not counted. Used only when the agent has
 * no case yet, so a customer who chased for three days is not treated as a first-time asker. Capped at 6; any error is 0.
 */
const NOT_A_CHASE = /^\s*(?:late delivery|yes|no|need other help|ok(?:ay)?|thanks?(?: you)?|hi|hello|hey|AJUKI\d+)\s*[.!]?\s*$/i;
export async function countPriorChases(db: SupabaseClient, phone: string, message: string, now: number): Promise<number> {
  try {
    const since = new Date(now - 10 * 86_400_000).toISOString();
    const { data, error } = await db.from("wa_messages").select("body, created_at").eq("phone", phone).eq("direction", "in").gte("created_at", since).order("created_at", { ascending: true }).limit(300);
    if (error || !data) return 0;
    // A menu tap ("Late delivery", "Yes"), an order id on its own, a thank-you: the start of a conversation or a courtesy, not a chase.
    const rows = (data as { body: string | null; created_at: string }[]).filter((r) => r.body && LATE_TALK.test(r.body) && !NOT_A_CHASE.test(r.body));
    if (rows.length && norm(rows[rows.length - 1].body ?? "") === norm(message)) rows.pop();
    let bursts = 0; let last = -Infinity;
    for (const r of rows) { const t = Date.parse(r.created_at); if (t - last >= 20 * 60_000) bursts++; last = t; }
    return Math.min(6, bursts);
  } catch { return 0; }
}

/** Is a question of ours still waiting for the customer's answer (the rider question, a delivery day, an address)? Then their next message belongs to the agent even if it does not look like a delivery message ("tomorrow", "no one called"). */
export async function hasAwaitingCase(db: SupabaseClient, phone: string, now = Date.now()): Promise<boolean> {
  try {
    const { data, error } = await db.from("delivery_cases").select("awaiting, last_reply_at").eq("phone", phone).eq("status", "open").not("awaiting", "is", null).limit(5);
    if (error || !data) return false;
    return (data as { awaiting: string | null; last_reply_at: string | null }[]).some((r) => r.last_reply_at && now - Date.parse(r.last_reply_at) < 3 * 86_400_000);
  } catch { return false; }
}

/** Load the open case, if any. `absent` means the table is not there (migration not applied): the agent then runs stateless. */
export async function loadCase(db: SupabaseClient, phone: string, orderId: string): Promise<{ id: number; state: CaseState } | null | "absent"> {
  const { data, error } = await db.from("delivery_cases").select("*").eq("phone", phone).eq("order_id", orderId).eq("status", "open").limit(1);
  if (error) return noTable(error) ? "absent" : null;
  const row = (data as CaseRow[] | null)?.[0];
  return row ? { id: row.id, state: toState(row) } : null;
}

export async function saveCase(db: SupabaseClient, phone: string, orderId: string, existingId: number | null, state: CaseState, close: string | null, mode: "shadow" | "live" = "shadow"): Promise<boolean> {
  const patch = {
    awaiting: state.awaiting, chases: state.chases, failed_attempts: state.failedAttempts, last_scan_at: state.lastScanAt === null ? null : new Date(state.lastScanAt).toISOString(),
    last_reply_at: state.lastReplyAt === null ? null : new Date(state.lastReplyAt).toISOString(), ledger: state.ledger, status: close ? "closed" : "open", closed_reason: close, updated_at: new Date().toISOString(),
  };
  const { error } = existingId ? await db.from("delivery_cases").update(patch).eq("id", existingId) : await db.from("delivery_cases").insert({ phone, order_id: orderId, mode, ...patch });
  return !error;
}

/**
 * The whole decision for one message: the gate, the two reads, the state machine. `live` says whether the caller may SEND the agent's line (live-lite): then the
 * case memory is written only when the line is actually used, so a thread the existing path answered is not recorded as if the agent had spoken. In shadow the
 * memory is always written (the agent is simulating the whole thread). Returns null when it did not run at all (the gate, or nothing to look at).
 */
async function evaluate(i: ShadowInput, live: boolean): Promise<{ rec: DeliveryShadowRecord; line: LiveLiteLine | null } | null> {
  const now = i.now ?? Date.now();
  const t0 = Date.now();
  const liveInfo = { kind: i.live.kind, action: i.live.action, escalated: i.live.action === "escalate", sameText: false };
  const base = (skipped: string | null): DeliveryShadowRecord => ({ v: DELIVERY_SHADOW_VERSION, at: new Date(now).toISOString(), skipped, order: null, timeline: null, intent: null, analyst: null, analystError: null, decision: null, live: liveInfo, state: { stored: false, note: null }, tokens: 0, calls: 0, ms: Date.now() - t0 });

  const orders = i.orders.slice(0, 8);
  const { scans, ok } = await loadScans(i.db, orders.map((o) => o.id));
  if (!ok) return { rec: base("scans_unreadable"), line: null };
  const views: OrderView[] = orders.map((o) => ({
    order: { id: o.id, courier: courierOf(o), status: o.status ?? null, estimated_delivery: o.estimated_delivery ?? null, pincode: String(o.address?.pincode ?? o.address?.pin ?? "") || null } as DeliveryOrder,
    scans: scans.get(o.id) ?? [], createdAt: o.created_at ? Date.parse(o.created_at) : 0,
  }));
  if (!deliveryGate(views, i.message, now)) return null;
  const pick = pickDeliveryOrder(views, i.message, now);
  if (!pick) return null;

  const timeline = buildTimeline(pick.scans, now, pick.order.status);
  const loaded = await loadCase(i.db, i.phone, pick.order.id);
  const absent = loaded === "absent";
  const caseId = loaded && loaded !== "absent" ? loaded.id : null;
  const state0: CaseState | null = loaded && loaded !== "absent" ? loaded.state : null;

  // the two model reads, in parallel: the supervisor's (the chat) and the analyst's (the raw scans)
  const chat = i.history.slice(-10).map((t) => `${t.direction === "in" ? "Customer" : "AJUKI"}: ${String(t.body ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
  if (!i.history.length || norm(i.history[i.history.length - 1].body ?? "") !== norm(i.message)) chat.push(`Customer: ${i.message.slice(0, 300)}`);
  const parcel = `ORDER ${pick.order.id} (${pick.order.courier})\nPlaced: ${pick.createdAt ? IST(pick.createdAt) : "unknown"} IST | Estimated delivery: ${pick.order.estimated_delivery ?? "not set"} | Order status: ${pick.order.status ?? "unknown"} | Current time: ${IST(now)} IST\nSCANS (oldest to latest)\n${pick.scans.slice(-40).map((s) => `${IST(Date.parse(s.scanned_at))} IST | ${s.event} | ${s.raw_status ?? ""} | ${s.remark ?? ""} | ${s.location ?? ""}`).join("\n") || "(no scans)"}`;
  const [ir, an] = await Promise.all([readIntent(chat, state0?.awaiting ?? null, i.fetchImpl), analyseParcel(parcel, i.fetchImpl)]);

  const model = ir.value ? { intent: ir.value.intent, confidence: ir.value.confidence } : null;
  const pattern = intentFromText(i.message, state0?.awaiting ?? null);
  const merged = mergeIntent(i.message, state0?.awaiting ?? null, model);
  const priorChases = state0 ? 0 : await countPriorChases(i.db, i.phone, i.message, now);
  const d = decideDelivery({ order: pick.order, timeline, message: i.message, intent: merged, state: state0, now, priorChases });

  const rec = base(null);
  rec.order = { id: pick.order.id, courier: pick.order.courier };
  rec.timeline = { attempts: timeline.attempts, phase: timeline.phase, cause: timeline.cause, lastEvent: timeline.lastEvent, movedSinceFailure: timeline.movedSinceFailure, prePickup: timeline.prePickup, hoursSinceMovement: timeline.hoursSinceMovement === null ? null : Math.round(timeline.hoursSinceMovement) };
  rec.intent = { model: ir.value ? { situation: ir.value.situation, intent: ir.value.intent, confidence: ir.value.confidence } : null, modelError: ir.error, pattern, merged };
  const a: Analysis | null = an.value;
  rec.analyst = a ? { cause: a.cause_class, attempts: a.attempts, hours: Math.round(a.hours_since_last_scan), next: a.recommended_next_step, agreesAttempts: a.attempts === timeline.attempts, agreesHours: timeline.hoursSinceMovement !== null && Math.abs(a.hours_since_last_scan - timeline.hoursSinceMovement) <= 2, remarks: a.delivery_person_remarks.slice(0, 4) } : null;
  rec.analystError = an.error;
  rec.decision = { replyId: d.replyId, text: d.text, escalate: d.escalate, action: d.action ? { name: d.action.name, allowed: d.action.allowed } : null, moved: d.moved, awaiting: d.state.awaiting, chases: d.state.chases };
  rec.live.sameText = !!d.text && !!i.live.text && norm(d.text) === norm(i.live.text);
  rec.tokens = (ir.tokens ?? 0) + (an.tokens ?? 0);
  rec.calls = 2;

  // The line the agent may send now (live-lite only); in shadow it is only recorded.
  // The courier is named as the source of a delay only where the parcel is in the courier's hands and has stopped moving (a courier-side cause, or in transit for a day or more), never for a failed attempt that waits on the customer.
  // 19 Oct: never when the courier's record says the customer was unavailable, the attempts ran out, or the parcel has not been collected yet.
  const blameCourier = !timeline.prePickup && timeline.cause !== "customer_side" && timeline.cause !== "max_attempts" && timeline.cause !== "ndr_pending"
    && (timeline.cause === "courier_side" || (timeline.phase === "in_transit" && (timeline.hoursSinceMovement ?? 0) >= 24));
  const line = live ? liveLiteLine(d, { blameCourier }) : null;
  // the agent's own memory; closed once the parcel is delivered or on its way back
  if (absent) rec.state = { stored: false, note: "delivery_cases table not applied: ran stateless" };
  else if (live && !line) rec.state = { stored: false, note: "the existing path answered: the agent's state was not advanced" };
  else {
    const close = timeline.phase === "delivered" ? "delivered" : timeline.phase === "rto" ? "returning_to_us" : null;
    const stored = await saveCase(i.db, i.phone, pick.order.id, caseId, d.state, close, live ? "live" : "shadow");
    rec.state = { stored, note: stored ? null : "could not write the case" };
  }
  rec.ms = Date.now() - t0;
  return { rec, line };
}

/** Run the agent as a shadow. Returns null when it did not run at all (the gate, or nothing to look at). */
export async function runDeliveryShadow(i: ShadowInput): Promise<DeliveryShadowRecord | null> {
  return (await evaluate(i, false))?.rec ?? null;
}

export interface LiveOutcome { rec: DeliveryShadowRecord | null; line: LiveLiteLine | null }

/**
 * LIVE-LITE: the agent's decision for this message, with the approved line it may send (lib/deliveryCaseState.ts liveLiteLine) or null. The caller replaces
 * its reply only when `line` is set; any error or timeout is "no line" so the existing path answers unchanged. No courier action and no ticket is requested.
 */
export async function runDeliveryLive(i: ShadowInput, o: { timeoutMs?: number } = {}): Promise<LiveOutcome> {
  const limit = o.timeoutMs ?? 20_000;
  try {
    const r = await Promise.race([evaluate(i, true), new Promise<"timeout">((res) => setTimeout(() => res("timeout"), limit))]);
    if (r === "timeout") return { rec: null, line: null };
    return r ? { rec: r.rec, line: r.line } : { rec: null, line: null };
  } catch {
    return { rec: null, line: null };
  }
}

/** Write the record onto the inbound row. Best-effort; never throws. */
export async function storeDeliveryShadow(db: SupabaseClient, inboundId: string | undefined, rec: DeliveryShadowRecord | null): Promise<void> {
  if (!rec) return;
  await mergeAiMeta(db, inboundId, { deliveryAgent: rec });
}
