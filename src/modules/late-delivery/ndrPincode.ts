// Same-city pincode confirmation for Shadowfax parcels on hold.
//
// Shadowfax puts a parcel on hold as "Same City Pincode Update" when the hub does
// not recognise the pincode on it. Only the customer knows the right one, so we
// ask — once, with one reminder — using the approved template
// ndr_pincode_confirm_v1, and act on the answer:
//
//   button "Pincode is correct"   → reopen_ndr (the pincode stands)
//   a typed 6-digit pincode       → order_update (async at Shadowfax), then the
//                                   sweep reopens the parcel if it is still on hold
//
// State lives in places that already exist, so no migration is needed:
//   * orders.admin_notes markers  [sfx-pin-ask <iso>] / [sfx-pin-remind <iso>] /
//                                 [sfx-pin-cust <iso>] / [sfx-pin-reopened <iso>]
//   * wa_conversations.pending_action  { kind: "ndr_pincode", ... } for the reply
//     window (48h, not the 2h of the phone/address flow). lib/ndrButtonReply.ts
//     ignores any kind it does not know, so the two flows cannot collide.
//
// The send is OFF unless NDR_PINCODE_ASK_ENABLED=true. Replies are always handled
// (a customer answering an earlier ask must not be left hanging if it is switched off).

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@engine/phone";
import { sendTemplate, sendWhatsApp } from "@adapters/messaging/whatsapp";
import { recordInbound, recordOutbound } from "@engine/waSupport";
import { reopenShadowfaxNdr, shadowfaxOrderStatus, updateShadowfaxDeliveryDetails } from "@adapters/couriers/shadowfax";

export const PINCODE_TEMPLATE = "ndr_pincode_confirm_v1";
const BUTTON_TITLE = "pincode is correct";
const HOUR = 3600 * 1000;
const WINDOW_MS = 48 * HOUR;
const REMIND_AFTER_MS = 24 * HOUR;
/** After the customer's pincode is submitted, wait this long for Shadowfax to apply
 *  it before reopening a parcel that is still on hold. */
const REOPEN_AFTER_MS = 2 * HOUR;
const MAX_PER_RUN = 20;

const M_ASK = "[sfx-pin-ask";
const M_REMIND = "[sfx-pin-remind";
const M_CUST = "[sfx-pin-cust";
const M_CONFIRMED = "[sfx-pin-confirmed";
const M_REOPENED = "[sfx-pin-reopened";

export type PincodePending = {
  kind: "ndr_pincode";
  order_id: string;
  awb: string;
  courier: "shadowfax";
  pincode: string;
  set_at: string;
};

export const pincodeAskEnabled = () => process.env.NDR_PINCODE_ASK_ENABLED === "true";
export const isPincodeButton = (text: string) => text.trim().toLowerCase() === BUTTON_TITLE;

const markerTime = (notes: string | null | undefined, marker: string): number | null => {
  const m = (notes ?? "").match(new RegExp(`${marker.replace("[", "\\[")} ([^\\]]+)\\]`));
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
};
const stamp = (marker: string, extra = "") => `${marker} ${new Date().toISOString()}]${extra ? ` ${extra}` : ""}`;

async function appendNote(db: SupabaseClient, orderId: string, line: string): Promise<void> {
  const { data } = await db.from("orders").select("admin_notes").eq("id", orderId).maybeSingle();
  const notes = [(data as { admin_notes?: string | null } | null)?.admin_notes, line].filter(Boolean).join("\n");
  await db.from("orders").update({ admin_notes: notes }).eq("id", orderId);
}

// ── pending_action ───────────────────────────────────────────────────────────

async function readRawPending(db: SupabaseClient, phone: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.from("wa_conversations").select("pending_action").eq("phone", phone).maybeSingle();
  if (error || !data) return null;
  return ((data as { pending_action?: unknown }).pending_action as Record<string, unknown> | null) ?? null;
}

/** The parked pincode question for this phone, if still inside its 48h window. */
export async function readPincodePending(db: SupabaseClient, phone: string): Promise<PincodePending | null> {
  const p = await readRawPending(db, phone);
  if (!p || p.kind !== "ndr_pincode") return null;
  const t = Date.parse(String(p.set_at ?? ""));
  if (!Number.isFinite(t) || Date.now() - t > WINDOW_MS) return null;
  return p as unknown as PincodePending;
}

async function setPending(db: SupabaseClient, phone: string, value: PincodePending): Promise<boolean> {
  const { error } = await db
    .from("wa_conversations")
    .upsert({ phone, pending_action: value, updated_at: new Date().toISOString() }, { onConflict: "phone" });
  return !error;
}

async function clearPending(db: SupabaseClient, phone: string): Promise<void> {
  await db.from("wa_conversations").update({ pending_action: null, updated_at: new Date().toISOString() }).eq("phone", phone);
}

async function say(db: SupabaseClient, phone: string, body: string): Promise<void> {
  await sendWhatsApp(phone, body);
  await recordOutbound(db, { phone, body, source: "system", tag: "late_delivery" });
}

// ── Replies ──────────────────────────────────────────────────────────────────

async function confirmPincode(db: SupabaseClient, phone: string, p: PincodePending): Promise<void> {
  const r = await reopenShadowfaxNdr(p.awb);
  await appendNote(db, p.order_id, stamp(M_CONFIRMED, `pincode ${p.pincode} confirmed by customer; reopen ${r.ok ? "ok" : "not confirmed"} — ${r.note}`));
  await clearPending(db, phone);
  await say(db, phone, "Thanks for confirming. We've asked the courier to deliver your order again — please keep your phone reachable.");
}

/** The "Pincode is correct" button. Returns false when there is nothing to attach it to. */
export async function handlePincodeTap(db: SupabaseClient, args: { phone: string; text: string; waMessageId?: string | null }): Promise<boolean> {
  const pending = await readPincodePending(db, args.phone);
  if (!pending) return false;
  await recordInbound(db, { phone: args.phone, body: args.text, waMessageId: args.waMessageId ?? null, orderId: pending.order_id });
  await confirmPincode(db, args.phone, pending);
  return true;
}

/** A typed reply to the pincode question. Returns false when it is not an answer
 *  (a question, a complaint) so the support bot takes it, leaving the window open. */
export async function handlePincodeReply(
  db: SupabaseClient,
  args: { phone: string; text: string; pending: PincodePending; waMessageId?: string | null },
): Promise<boolean> {
  const { phone, text, pending } = args;
  const typed = text.match(/\b[1-9]\d{5}\b/)?.[0] ?? null;
  const yes = /^\s*(yes|yep|yeah|ya|y|correct|right|ok|okay|sahi|haan|ha)\b/i.test(text);
  if (!typed && !yes) return false;

  await recordInbound(db, { phone, body: text, waMessageId: args.waMessageId ?? null, orderId: pending.order_id });

  if (yes || typed === pending.pincode) {
    await confirmPincode(db, phone, pending);
    return true;
  }

  const upd = await updateShadowfaxDeliveryDetails(pending.awb, { pincode: typed! });
  await appendNote(db, pending.order_id, stamp(M_CUST, `customer gave pincode ${typed} (was ${pending.pincode}); ${upd.ok ? "submitted" : "refused"} — ${upd.note}`));
  await clearPending(db, phone);
  if (upd.ok) {
    await say(db, phone, `Thanks — we've sent the new pincode ${typed} to the courier and they'll try delivery again. Please keep your phone reachable.`);
  } else {
    // The courier refused it (e.g. a different city). A person takes it from here.
    await say(db, phone, "Thanks — we couldn't apply that pincode automatically, so our team will check it and get back to you.");
  }
  return true;
}

// ── The cron body ────────────────────────────────────────────────────────────

type Row = {
  id: string;
  awb_code: string | null;
  admin_notes: string | null;
  address: { name?: string; phone?: string; line1?: string; line2?: string; city?: string; pincode?: string } | null;
};

const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();

async function sendAsk(db: SupabaseClient, o: Row, marker: string, silent: Set<string>): Promise<"sent" | "skipped" | "failed"> {
  const phone = normalizePhone(o.address?.phone);
  if (phone.length !== 10 || silent.has(phone) || !o.awb_code) return "skipped";
  const pincode = String(o.address?.pincode ?? "").replace(/\D/g, "");
  if (pincode.length !== 6) return "skipped";

  // Don't talk over a phone/address question that is still open.
  const raw = await readRawPending(db, phone);
  if (raw && raw.kind !== "ndr_pincode") {
    const t = Date.parse(String(raw.set_at ?? ""));
    if (Number.isFinite(t) && Date.now() - t < 2 * HOUR) return "skipped";
  }

  // Claim before the send — the only failure worth guarding is sending twice.
  const before = o.admin_notes ?? "";
  const next = [before, stamp(marker)].filter(Boolean).join("\n");
  let q = db.from("orders").update({ admin_notes: next }).eq("id", o.id);
  q = o.admin_notes == null ? q.is("admin_notes", null) : q.eq("admin_notes", before);
  const { data: claimed } = await q.select("id");
  if (!claimed?.length) return "skipped";

  const name = oneLine(String(o.address?.name ?? "")).split(" ")[0] || "there";
  const address = oneLine([o.address?.line1, o.address?.line2, o.address?.city].filter(Boolean).join(", ")).slice(0, 120) || "your address";
  const ok = await sendTemplate(phone, PINCODE_TEMPLATE, [name, o.id, address, pincode]).catch(() => false);
  if (!ok) {
    await db.from("orders").update({ admin_notes: before || null }).eq("id", o.id);
    return "failed";
  }
  const parked = await setPending(db, phone, { kind: "ndr_pincode", order_id: o.id, awb: o.awb_code, courier: "shadowfax", pincode, set_at: new Date().toISOString() });
  if (!parked) console.warn("[ndr-pincode] pending_action not stored for", o.id);
  return "sent";
}

export async function runPincodeCron(db: SupabaseClient): Promise<Record<string, unknown>> {
  const select = "id, awb_code, admin_notes, address";
  const base = () =>
    db.from("orders").select(select)
      .ilike("courier_name", "%shadowfax%")
      .eq("courier_status", "on_hold")
      .ilike("courier_status_detail", "%same city pincode%")
      .not("status", "in", "(delivered,rto,cancelled,wa_cancelled)");

  const out: Record<string, unknown> = { enabled: pincodeAskEnabled() };

  // 1. First ask, then the single reminder — only while the switch is on.
  if (pincodeAskEnabled()) {
    const { data: held } = await base().limit(200);
    const rows = (held ?? []) as unknown as Row[];
    const phones = [...new Set(rows.map((o) => normalizePhone(o.address?.phone)).filter((p) => p.length === 10))];
    const { data: opt } = phones.length ? await db.from("wa_optouts").select("phone").in("phone", phones) : { data: [] };
    const silent = new Set(((opt ?? []) as { phone: string }[]).map((r) => r.phone));

    let asked = 0, reminded = 0, skipped = 0, failed = 0;
    for (const o of rows) {
      if (asked + reminded >= MAX_PER_RUN) break;
      const notes = o.admin_notes ?? "";
      if (notes.includes(M_CUST) || notes.includes(M_CONFIRMED)) continue;
      const askedAt = markerTime(notes, M_ASK);
      let kind: "ask" | "remind" | null = null;
      if (askedAt == null) kind = "ask";
      else if (!notes.includes(M_REMIND) && Date.now() - askedAt >= REMIND_AFTER_MS && Date.now() - askedAt < WINDOW_MS) kind = "remind";
      if (!kind) continue;
      const r = await sendAsk(db, o, kind === "ask" ? M_ASK : M_REMIND, silent);
      if (r === "sent") { if (kind === "ask") asked++; else reminded++; }
      else if (r === "failed") failed++;
      else skipped++;
    }
    Object.assign(out, { asked, reminded, skipped, failed });
  }

  // 2. Reopen parcels whose customer-given pincode was submitted and which are
  //    still on hold. Always on — it only follows up an answer already given.
  const { data: given } = await base().ilike("admin_notes", `%${M_CUST}%`).limit(100);
  let reopened = 0;
  for (const o of (given ?? []) as unknown as Row[]) {
    const notes = o.admin_notes ?? "";
    const at = markerTime(notes, M_CUST);
    if (notes.includes(M_REOPENED) || at == null || Date.now() - at < REOPEN_AFTER_MS || !o.awb_code) continue;
    if ((await shadowfaxOrderStatus(o.awb_code)) !== "on_hold") continue;
    const r = await reopenShadowfaxNdr(o.awb_code);
    await appendNote(db, o.id, stamp(M_REOPENED, `${r.ok ? "ok" : "not confirmed"} — ${r.note}`));
    if (r.ok) reopened++;
  }
  out.reopened = reopened;
  return out;
}

/** Plain-English state of the pincode question for the NDR queue, or null. */
export function pincodeStateLabel(notes: string | null | undefined): string | null {
  const n = notes ?? "";
  if (n.includes(M_REOPENED)) return "Customer's pincode applied — reopen sent";
  if (n.includes(M_CUST)) return "Customer sent a pincode — submitted, reopen pending";
  if (n.includes(M_CONFIRMED)) return "Customer confirmed the pincode — reopen sent";
  const at = markerTime(n, M_ASK);
  if (at != null) {
    const h = Math.max(0, Math.round((Date.now() - at) / HOUR));
    return n.includes(M_REMIND) ? `Asked ${h}h ago, reminded — awaiting reply` : `Asked ${h}h ago — awaiting reply`;
  }
  return null;
}
