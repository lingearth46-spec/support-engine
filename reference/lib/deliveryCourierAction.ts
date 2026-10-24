// The late-delivery agent's courier ACTIONS on a Delhivery parcel: a delivery date (DEFER_DLV), another attempt (RE-ATTEMPT) and a corrected phone or address
// (EDIT_DETAILS). A pure planner (planCourierAction) and the IO around it (performCourierAction). Delhivery first; Shadowfax edits stay with lib/ndrButtonReply.ts and
// lib/bookedAddressEdit.ts, and DTDC / Shiprocket-assigned parcels have no action API.
//
// Every limit is the NDR policy's, read from lib/ndrPolicy.ts and lib/delhivery.ts, the same constants the hourly job uses:
//   · direct Delhivery only; never a finished parcel; never blind (the live status code must be read)
//   · MAXED_OUT_CODES (ST-108): no action is accepted, a person chases the KAM
//   · three requests per parcel ever (RE-ATTEMPT and DEFER_DLV count together), one a day, deferred_retry rejections forgiven
//   · DEFER_DLV only for DEFER_ELIGIBLE_CODES, only up to estimated delivery + 5 days (the date is clamped to it, and a parcel past it is a person's)
//   · no bare RE-ATTEMPT for EOD-11 / EOD-6 / EOD-16 (NDR_POLICY 4.1: the same rider, the same door); EOD-86 "not attempted" is a plain re-attempt
//   · EDIT_DETAILS only while the parcel sits in its failed-delivery window (otherwise "Package in incorrect status"), never a pincode
//
// A 201 proves nothing on this API, so a submitted action is recorded in delhivery_ndr_requests with its request id and the hourly pass reconciles it against
// get_bulk_upl; this module never reports an action as confirmed. SUPPORT_DELIVERY_AGENT_ACTIONS = off (default) | dry | on; a shadow run is forced to dry.
// Nothing here is wired to the customer's reply yet: the wording for a submitted-but-unconfirmed action is a founder decision.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFER_ELIGIBLE_CODES, DEFER_PREFERRED_CODES, MAXED_OUT_CODES, NDR_ELIGIBLE_CODES, nextWorkingDay } from "@/lib/delhivery";
import { MAX_REQUESTS_PER_ORDER, NOTE_PREFIX, askedToday, deferHorizon, timesAsked, todayUtc } from "@/lib/ndrPolicy";

export type AgentAct = "DEFER_DLV" | "RE-ATTEMPT" | "EDIT_DETAILS";
export type ActionsMode = "off" | "dry" | "on";
export function actionsMode(env: Record<string, string | undefined> = process.env): ActionsMode {
  const v = (env.SUPPORT_DELIVERY_AGENT_ACTIONS ?? "").trim().toLowerCase();
  return v === "dry" ? "dry" : v === "on" ? "on" : "off";
}

export interface ActionOrder {
  id: string;
  awb: string | null;
  courierName: string | null;
  shiprocketOrderId: string | null;
  status: string | null;
  estimatedDelivery: string | null;
  adminNotes: string | null;
  pincode: string | null;
}
export interface ActionAsk {
  act: AgentAct;
  /** The delivery date the customer asked for (YYYY-MM-DD) for DEFER_DLV; absent = the next working day. */
  date?: string | null;
  edit?: { phone?: string | null; address?: string | null };
}
export interface ActionLive { code: string | null; status: string | null }
export interface ActionCtx { now: number; /** deferred_retry rejections for this parcel (they do not count against the cap). */ forgiven: number }

export type Planned =
  | { ok: true; act: AgentAct; deferredDate: string | null; clamped: boolean; edit: { phone?: string; address?: string } | null; countsAsAsk: boolean }
  | { ok: false; reason: string; to: "person" | "wait" | "none" };

const no = (reason: string, to: "person" | "wait" | "none"): Planned => ({ ok: false, reason, to });
const TERMINAL = new Set(["delivered", "rto", "returned", "cancelled", "wa_cancelled"]);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const tenDigits = (s: string | null | undefined): string | null => { const d = String(s ?? "").replace(/\D/g, ""); const n = d.length >= 10 ? d.slice(-10) : d; return /^[6-9]\d{9}$/.test(n) ? n : null; };

export function planCourierAction(order: ActionOrder, ask: ActionAsk, live: ActionLive, ctx: ActionCtx): Planned {
  const awb = String(order.awb ?? "").trim();
  if (!awb) return no("the parcel is not booked: there is no AWB to act on", "none");
  const status = String(order.status ?? "").toLowerCase();
  if (TERMINAL.has(status)) return no(`the order is ${status}`, "none");
  if ((order.courierName ?? "").trim().toLowerCase() !== "delhivery" || order.shiprocketOrderId || !/^\d{10,15}$/.test(awb)) return no("only a direct Delhivery booking can be acted on from here: a person handles this courier", "person");
  const code = (live.code ?? "").trim();
  if (!code) return no("Delhivery's live status code could not be read: no action is taken blind", "wait");
  if (MAXED_OUT_CODES.has(code)) return no(`Delhivery has made its maximum attempts (${code}) and accepts no action: a person chases the account manager`, "person");

  const countsAsAsk = ask.act !== "EDIT_DETAILS";
  if (countsAsAsk) {
    if (timesAsked(order.adminNotes) - ctx.forgiven >= MAX_REQUESTS_PER_ORDER) return no(`this parcel has already been asked for ${MAX_REQUESTS_PER_ORDER} times, Delhivery's own ceiling: a person decides`, "person");
    if (askedToday(order.adminNotes, ctx.now)) return no("this parcel was already asked for today", "wait");
  }

  if (ask.act === "DEFER_DLV") {
    if (!DEFER_ELIGIBLE_CODES.has(code)) return no(`Delhivery does not accept a delivery date at ${code}${code === "EOD-86" ? " (not attempted is a plain re-attempt)" : ""}: a person decides`, "person");
    const today = todayUtc(ctx.now);
    const horizon = deferHorizon({ estimated_delivery: order.estimatedDelivery });
    if (horizon && horizon < today) return no(`the last date Delhivery accepts for this parcel (${horizon}) has passed, and there is no bare re-attempt for ${code}: a person chases the account manager`, "person");
    let wanted = ask.date && YMD.test(ask.date) && ask.date > today ? ask.date : nextWorkingDay(new Date(ctx.now));
    let clamped = false;
    if (horizon && wanted > horizon) { wanted = horizon; clamped = true; }
    // Delhivery does not deliver on Sundays: a date that falls on one moves to Monday, or to Saturday when Monday is past the last accepted date.
    if (new Date(`${wanted}T00:00:00Z`).getUTCDay() === 0) {
      const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
      const monday = addDays(wanted, 1);
      wanted = horizon && monday > horizon ? addDays(wanted, -1) : monday;
    }
    if (wanted <= today) return no("no date is left between today and the last date Delhivery accepts: a person decides", "person");
    return { ok: true, act: "DEFER_DLV", deferredDate: wanted, clamped, edit: null, countsAsAsk };
  }

  if (ask.act === "RE-ATTEMPT") {
    if (!NDR_ELIGIBLE_CODES.has(code)) return no(`Delhivery does not accept a re-attempt at ${code}: a person decides`, "person");
    if (DEFER_PREFERRED_CODES.has(code)) return no(`a bare re-attempt at ${code} sends the same rider to the same door (NDR policy 4.1): a delivery date is the action, or a person`, "person");
    return { ok: true, act: "RE-ATTEMPT", deferredDate: null, clamped: false, edit: null, countsAsAsk };
  }

  // EDIT_DETAILS
  if (!NDR_ELIGIBLE_CODES.has(code)) return no(`Delhivery takes an edit only while the parcel is in its failed-delivery window; at ${code} it would answer "Package in incorrect status": a person decides`, "person");
  const phone = ask.edit?.phone ? tenDigits(ask.edit.phone) : null;
  if (ask.edit?.phone && !phone) return no("that is not a valid 10-digit mobile number", "person");
  const address = ask.edit?.address ? String(ask.edit.address).replace(/\s+/g, " ").trim() : null;
  if (ask.edit?.address) {
    if (!address || address.length < 15 || address.length > 240) return no("the address is too short or too long to send to the courier", "person");
    const pin = /\b(\d{6})\b/.exec(address)?.[1];
    if (pin && order.pincode && pin !== order.pincode) return no(`Delhivery cannot change the pincode (${order.pincode} to ${pin}): a person decides`, "person");
  }
  if (!phone && !address) return no("nothing to change", "none");
  return { ok: true, act: "EDIT_DETAILS", deferredDate: null, clamped: false, edit: { ...(phone ? { phone } : {}), ...(address ? { address } : {}) }, countsAsAsk };
}

// ── what the customer is told ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The customer's line for an action that was SUBMITTED to the courier and not yet confirmed (founder, 18 Oct: "I have passed your request for {date} to the courier. I will
 * message you here when it moves."). It says the request was PASSED, never that the courier did or will do it, and it names the date the courier was actually sent, which is
 * the clamped one when the date was cut back to the last the courier accepts. Built from the plan, so the words can never claim more than was done.
 *
 * It promises a later message, so it must not be sent until the proactive movement update (the D lines) exists to keep that promise.
 */
const SUBMITTED_TRACK = "You can track it at www.ajuki.in/track.";
const LATER = "I will message you here when it moves.";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayName = (ymd: string): string => `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}`;
export function submittedLine(a: { orderId: string; act: AgentAct; deferredDate?: string | null; clamped?: boolean; edit?: { phone?: string; address?: string } | null }): string {
  if (a.act === "DEFER_DLV" && a.deferredDate && YMD.test(a.deferredDate)) {
    const d = dayName(a.deferredDate);
    return a.clamped
      ? `I have passed a request for ${d} to the courier, the latest date they accept for this parcel. ${LATER} ${SUBMITTED_TRACK}`
      : `I have passed your request for ${d} to the courier. ${LATER} ${SUBMITTED_TRACK}`;
  }
  if (a.act === "EDIT_DETAILS") {
    const what = a.edit?.phone && a.edit?.address ? "number and address" : a.edit?.phone ? "number" : "address";
    return `I have passed your new ${what} for order ${a.orderId} to the courier. ${LATER} ${SUBMITTED_TRACK}`;
  }
  return `I have passed a request for another delivery attempt on order ${a.orderId} to the courier. ${LATER} ${SUBMITTED_TRACK}`;
}

// ── the IO ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ActDeps {
  db: SupabaseClient;
  now(): number;
  trackDelhivery(awb: string): Promise<{ statusCode?: string; status?: string } | null>;
  defer(awb: string, date: string): Promise<{ uploadId?: string }>;
  reattempt(awb: string): Promise<{ uploadId?: string }>;
  edit(awb: string, d: { phone?: string; address?: string }): Promise<{ uploadId?: string }>;
  notify(text: string): Promise<void>;
}
export interface ActInput { orderId: string; ask: ActionAsk; mode: ActionsMode; /** A shadow run: never anything but dry. */ forceDry?: boolean; why?: string }
export type ActOutcome = "off" | "refused" | "dry_run" | "submitted" | "failed";
export interface ActResult {
  outcome: ActOutcome; reason?: string; to?: "person" | "wait" | "none";
  act?: AgentAct; deferredDate?: string | null; clamped?: boolean; uploadId?: string | null;
  /** Always false: a 201 proves nothing on this API. The hourly pass reconciles the request id against get_bulk_upl. */
  confirmed: false;
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function performCourierAction(d: ActDeps, i: ActInput): Promise<ActResult> {
  try {
    const mode: ActionsMode = i.mode === "off" ? "off" : i.forceDry ? "dry" : i.mode;
    if (mode === "off") return { outcome: "off", confirmed: false };
    const { data: o } = await d.db.from("orders").select("id, awb_code, courier_name, shiprocket_order_id, status, estimated_delivery, admin_notes, address").eq("id", i.orderId).maybeSingle();
    if (!o) return { outcome: "refused", reason: "order not found", to: "none", confirmed: false };
    const order: ActionOrder = {
      id: String(o.id), awb: (o.awb_code as string | null) ?? null, courierName: (o.courier_name as string | null) ?? null, shiprocketOrderId: (o.shiprocket_order_id as string | null) ?? null,
      status: (o.status as string | null) ?? null, estimatedDelivery: (o.estimated_delivery as string | null) ?? null, adminNotes: (o.admin_notes as string | null) ?? null,
      pincode: String(((o.address ?? {}) as { pincode?: unknown }).pincode ?? "").replace(/\D/g, "").slice(0, 6) || null,
    };
    const awb = order.awb ?? "";
    const now = d.now();
    // deferred_retry rejections (the parcel was mid-dispatch) are forgiven, exactly as the hourly job does.
    const { data: fr } = await d.db.from("delhivery_ndr_requests").select("outcome").eq("order_id", order.id);
    const forgiven = ((fr ?? []) as Array<{ outcome: string | null }>).filter((r) => r.outcome === "deferred_retry").length;
    const track = awb ? await d.trackDelhivery(awb).catch(() => null) : null;
    const live: ActionLive = { code: track?.statusCode ?? null, status: track?.status ?? null };
    const plan = planCourierAction(order, i.ask, live, { now, forgiven });
    if (!plan.ok) return { outcome: "refused", reason: plan.reason, to: plan.to, confirmed: false };
    const common = { act: plan.act, deferredDate: plan.deferredDate, clamped: plan.clamped };
    if (mode === "dry") return { outcome: "dry_run", ...common, confirmed: false };

    let uploadId: string | undefined;
    try {
      const r = plan.act === "DEFER_DLV" ? await d.defer(awb, plan.deferredDate!) : plan.act === "RE-ATTEMPT" ? await d.reattempt(awb) : await d.edit(awb, plan.edit!);
      uploadId = r.uploadId;
    } catch (e) {
      await d.notify(`⚠️ <b>Late-delivery agent</b>: Delhivery ${plan.act} on <b>${order.id}</b> (${awb}) failed: ${errText(e)}`).catch(() => {});
      return { outcome: "failed", reason: errText(e), ...common, confirmed: false };
    }
    // The durable record the hourly pass reconciles against (keyed on upl_id), and, for a defer or a re-attempt, the breadcrumb that the cap and the scoreboard count.
    const why = i.why ?? "late-delivery agent";
    const { error: insErr } = await d.db.from("delhivery_ndr_requests").insert({
      order_id: order.id, waybill: awb, act: plan.act, upl_id: uploadId ?? null, live_status: live.status ?? why, live_status_code: live.code,
      raw: { source: "delivery_agent", note: why, request_id: uploadId ?? null, deferred_date: plan.deferredDate, clamped: plan.clamped },
    });
    if (insErr && insErr.code !== "42P01") console.error("[delivery-action] delhivery_ndr_requests insert failed:", insErr.message);
    if (plan.countsAsAsk) {
      const line = `${NOTE_PREFIX} ${todayUtc(now)} — live status was "${(live.status ?? "").replace(/"/g, "'")}" (${live.code}).`;
      const { error: noteErr } = await d.db.from("orders").update({ admin_notes: [order.adminNotes, line].filter(Boolean).join("\n") }).eq("id", order.id);
      if (noteErr) console.error("[delivery-action] breadcrumb failed:", noteErr.message);
    }
    await d.notify(`🚚 <b>Late-delivery agent</b>: Delhivery ${plan.act}${plan.deferredDate ? ` for ${plan.deferredDate}${plan.clamped ? " (clamped to the last accepted date)" : ""}` : ""} submitted on <b>${order.id}</b> (${awb}), request ${uploadId ?? "—"}; not yet confirmed.`).catch(() => {});
    return { outcome: "submitted", ...common, uploadId: uploadId ?? null, confirmed: false };
  } catch (e) {
    return { outcome: "failed", reason: errText(e), confirmed: false };
  }
}

/** For the handler: fire and forget. Never throws. */
export async function runCourierAction(db: SupabaseClient, i: Omit<ActInput, "mode"> & { mode?: ActionsMode }): Promise<ActResult> {
  const mode = i.mode ?? actionsMode();
  if (mode === "off") return { outcome: "off", confirmed: false };
  try {
    const [dl, { notify }] = await Promise.all([import("@/lib/delhivery"), import("@/lib/telegram")]);
    const r = await performCourierAction({
      db, now: () => Date.now(),
      trackDelhivery: async (awb) => (await dl.trackDelhivery(awb)) as never,
      defer: (awb, date) => dl.deferDelhiveryDelivery(awb, date), reattempt: (awb) => dl.requestDelhiveryReattempt(awb), edit: (awb, e) => dl.editDelhiveryNdrDetails(awb, { phone: e.phone, address: e.address }),
      notify: async (t) => { await notify("OPS", t); },
    }, { ...i, mode });
    console.log(JSON.stringify({ event: "delivery_courier_action", orderId: i.orderId, act: i.ask.act, mode, forceDry: !!i.forceDry, outcome: r.outcome, reason: r.reason ?? null, to: r.to ?? null }));
    return r;
  } catch (e) {
    return { outcome: "failed", reason: errText(e), confirmed: false };
  }
}
