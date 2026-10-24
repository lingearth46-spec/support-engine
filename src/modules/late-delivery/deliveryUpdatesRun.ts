// The sweep behind "I will message you here when it moves": for every open late-delivery case the agent has spoken in (mode live), read the parcel's scans, ask
// lib/deliveryMovement.ts whether it moved, and tell the customer. The rules are the pure module's; this is the reading, the claiming, the sending and the writing.
//
//   SUPPORT_DELIVERY_UPDATES = off (default) | dry | on
//     off  nothing is read or written.
//     dry  every decision is made and reported, nothing is sent or written.
//     on   live. A case is claimed (a conditional update on updated_at) BEFORE the send, so two overlapping runs cannot both tell the customer; a failed send hands the
//          claim back so the next run tries again.
// Free text inside the 23 hour window (a margin under WhatsApp's 24), the approved template after it. Any hour. Never to an opted-out phone.
// Harmless when delivery_cases does not exist: it says so and does nothing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildTimeline, type MovementMeta } from "@late/deliveryCaseState";
import { loadScans } from "@late/deliveryShadow";
import { decideMovement, type MovementDecision } from "@late/deliveryMovement";

export type UpdatesMode = "off" | "dry" | "on";
export function updatesMode(env: Record<string, string | undefined> = process.env): UpdatesMode {
  const v = (env.SUPPORT_DELIVERY_UPDATES ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true" ? "on" : v === "dry" ? "dry" : "off";
}

export const WINDOW_HOURS = 23;
export const MAX_SENDS_PER_RUN = 40;
const PACE_MS = 900;
const H = 3_600_000;

export interface UpdatesDeps {
  db: SupabaseClient;
  now(): number;
  sendText(phone: string, text: string): Promise<boolean>;
  sendTemplate(phone: string, name: string, variables: string[]): Promise<boolean>;
  record(row: { phone: string; body: string; orderId: string; aiMeta: unknown }): Promise<void>;
  sleep(ms: number): Promise<void>;
}
export interface UpdatesTally {
  mode: UpdatesMode; skippedRun?: string; considered: number; sent: number; closed: number; skipped: number; failed: number;
  reasons: Record<string, number>;
  /** What a dry run would send: the line id, the order, the route and the last four digits only. */
  wouldSend: { replyId: string; order: string; via: "text" | "template"; phone: string }[];
}
interface CaseRow { id: number; phone: string; order_id: string; last_scan_at: string | null; ledger: Record<string, unknown> | null; updated_at: string }

const last4 = (p: string) => `…${p.slice(-4)}`;
const noTable = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === "42P01" || /does not exist|schema cache|could not find the table/i.test(e.message ?? ""));
const metaOf = (ledger: Record<string, unknown> | null): MovementMeta | null => {
  const m = (ledger?.movement ?? null) as Partial<MovementMeta> | null;
  return m && typeof m === "object" ? { lastEvent: (m.lastEvent as string | null) ?? null, updatesSent: Number(m.updatesSent ?? 0), lastUpdateAt: m.lastUpdateAt == null ? null : Number(m.lastUpdateAt) } : null;
};

export async function runDeliveryUpdates(d: UpdatesDeps, o: { mode: UpdatesMode; maxSends?: number }): Promise<UpdatesTally> {
  const t: UpdatesTally = { mode: o.mode, considered: 0, sent: 0, closed: 0, skipped: 0, failed: 0, reasons: {}, wouldSend: [] };
  const bump = (r: string) => { t.reasons[r] = (t.reasons[r] ?? 0) + 1; };
  if (o.mode === "off") { t.skippedRun = "SUPPORT_DELIVERY_UPDATES is off"; return t; }
  const live = o.mode === "on";
  const now = d.now();
  const nowIso = new Date(now).toISOString();
  const maxSends = o.maxSends ?? MAX_SENDS_PER_RUN;

  const { data: cases, error } = await d.db.from("delivery_cases").select("id, phone, order_id, last_scan_at, ledger, updated_at").eq("status", "open").eq("mode", "live").order("updated_at", { ascending: true }).limit(200);
  if (error) { t.skippedRun = noTable(error) ? "delivery_cases not available: the migration is not applied" : `delivery_cases unreadable: ${error.message}`; return t; }
  const rows = (cases ?? []) as CaseRow[];
  if (!rows.length) return t;
  const { scans, ok } = await loadScans(d.db, [...new Set(rows.map((r) => r.order_id))]);
  if (!ok) { t.skippedRun = "parcel_scans unreadable"; return t; }

  for (const c of rows) {
    t.considered++;
    try {
      const [{ data: ord }, { data: opt }, { data: conv }] = await Promise.all([
        d.db.from("orders").select("id, status").eq("id", c.order_id).maybeSingle(),
        d.db.from("wa_optouts").select("phone").eq("phone", c.phone).maybeSingle(),
        d.db.from("wa_conversations").select("last_in_at").eq("phone", c.phone).maybeSingle(),
      ]);
      const timeline = buildTimeline(scans.get(c.order_id) ?? [], now, (ord as { status?: string | null } | null)?.status ?? null);
      const lastIn = (conv as { last_in_at?: string | null } | null)?.last_in_at ? Date.parse(String((conv as { last_in_at: string }).last_in_at)) : null;
      const windowOpen = lastIn !== null && Number.isFinite(lastIn) && now - lastIn < WINDOW_HOURS * H;
      const meta = metaOf(c.ledger);
      const dec: MovementDecision = decideMovement({ c: { lastScanAt: c.last_scan_at ? Date.parse(c.last_scan_at) : null, meta }, timeline, orderId: c.order_id, now, windowOpen, optedOut: Boolean(opt) });

      if (dec.kind === "close") {
        bump(`close:${dec.reason}`); t.closed++;
        if (live) await d.db.from("delivery_cases").update({ status: "closed", closed_reason: dec.reason, updated_at: nowIso }).eq("id", c.id);
        continue;
      }
      if (dec.kind === "skip") {
        bump(`skip:${dec.reason}`); t.skipped++;
        if (live && dec.baseline) await d.db.from("delivery_cases").update({ last_scan_at: new Date(dec.baseline.lastScanAt).toISOString(), updated_at: nowIso }).eq("id", c.id);
        continue;
      }

      const via: "text" | "template" = dec.viaTemplate ? "template" : "text";
      if (!live) { bump(`would_send:${via}`); t.wouldSend.push({ replyId: dec.replyId, order: c.order_id, via, phone: last4(c.phone) }); continue; }
      if (t.sent >= maxSends) { bump("skip:run_cap"); t.skipped++; continue; }
      // Claim first: the update only matches while nobody has touched the case since we read it.
      const nextLedger = { ...(c.ledger ?? {}), movement: { lastEvent: dec.patch.lastEvent, updatesSent: dec.patch.updatesSent, lastUpdateAt: dec.patch.lastUpdateAt } };
      const claim = await d.db.from("delivery_cases").update({ last_scan_at: new Date(dec.patch.lastScanAt).toISOString(), ledger: nextLedger, updated_at: nowIso }).eq("id", c.id).eq("updated_at", c.updated_at).select("id");
      if (claim.error || !claim.data || !claim.data.length) { bump("skip:claimed_elsewhere"); t.skipped++; continue; }
      const sent = dec.viaTemplate ? await d.sendTemplate(c.phone, dec.template.name, dec.template.variables).catch(() => false) : await d.sendText(c.phone, dec.text).catch(() => false);
      if (!sent) {
        // Hand the claim back so the next run tries again.
        await d.db.from("delivery_cases").update({ last_scan_at: c.last_scan_at, ledger: c.ledger, updated_at: c.updated_at }).eq("id", c.id);
        bump("failed:send"); t.failed++;
        continue;
      }
      await d.record({ phone: c.phone, body: dec.text, orderId: c.order_id, aiMeta: { deliveryUpdate: { replyId: dec.replyId, via, template: dec.viaTemplate ? dec.template.name : null, case: c.id } } }).catch(() => {});
      bump(`sent:${via}`); t.sent++;
      await d.sleep(PACE_MS);
    } catch (err) {
      t.failed++; bump("failed:error");
      console.error(JSON.stringify({ event: "delivery_update_failed", case: c.id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  return t;
}

/** The real dependencies. Lazy imports keep the module testable without the WhatsApp client. */
export async function realUpdatesDeps(db: SupabaseClient): Promise<UpdatesDeps> {
  const [{ sendWhatsApp, sendTemplate }, { recordOutbound }] = await Promise.all([import("@adapters/messaging/whatsapp"), import("@engine/waSupport")]);
  return {
    db, now: () => Date.now(),
    sendText: (phone, text) => sendWhatsApp(phone, text),
    sendTemplate: (phone, name, vars) => sendTemplate(phone, name, vars),
    // notAReply: a proactive update is not an answer, so the conversation's reply clock stays where it was.
    record: (r) => recordOutbound(db, { phone: r.phone, body: r.body, source: "system", tag: "late_delivery", orderId: r.orderId, aiMeta: r.aiMeta, notAReply: true }),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  };
}
