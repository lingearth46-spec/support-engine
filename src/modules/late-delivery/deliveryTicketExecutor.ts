// The late-delivery agent's ticket requests: from an escalation decision to a courier_requests row (and, for Shadowfax, the real-time API call).
// Contract: workflows/late-delivery-ticket-contract.md sections 3 and 4. The decisions are lib/deliveryTicketRequest.ts's; this module is the IO around them.
//
//   SUPPORT_DELIVERY_AGENT_TICKETS = off (default) | dry | on
//     off  nothing is looked up, written or sent.
//     dry  the request is built and written with status `dry_run` (an inactive status: it holds no slot, the Courier Desk never sends it). No courier is called.
//     on   Delhivery: the row is written `queued` and the Courier Desk's nightly run raises it (its own category and text, ahead of the night job's own rows by priority).
//          Shadowfax: the Escalation API is called now, once, behind the one-active-request-per-AWB index and the [sfx-escalated] marker.
//   A shadow run never raises anything: it is forced to `dry`, whatever the switch says.
//
// Never throws: any failure is an outcome, so a ticket problem cannot reach the customer's reply.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Escalate } from "@late/deliveryCaseState";
import { buildTicketRequest, REQUEST_WINDOW_DAYS, type Built, type Claim, type TicketLive, type TicketOrder, type TicketTrigger } from "@late/deliveryTicketRequest";
import type { TrackFacts } from "@late/courierDesk/candidates";

export type TicketsMode = "off" | "dry" | "on";
export function ticketsMode(env: Record<string, string | undefined> = process.env): TicketsMode {
  const v = (env.SUPPORT_DELIVERY_AGENT_TICKETS ?? "").trim().toLowerCase();
  return v === "dry" ? "dry" : v === "on" ? "on" : "off";
}

/** Which escalations ask for a ticket. A failed attempt is the NDR flow's, "no lever" and "needs a person" have no ticket route, so they are not here. */
export function triggerFor(e: Escalate): TicketTrigger | null {
  return e === "stall_48h" ? "stalled" : e === "repeat_chase" ? "delay" : e === "dispute_manual" ? "disputed_attempt" : null;
}

const ACTIVE = ["queued", "raising", "raised", "deflected", "unknown"];
const DAY = 86_400_000;

export interface ExecDeps {
  db: SupabaseClient;
  now(): number;
  trackDelhivery(awb: string): Promise<(TrackFacts & { statusCode?: string }) | null>;
  shadowfaxStatus(awb: string): Promise<string | null>;
  raiseShadowfax(awb: string, category: "delayed_delivery" | "status_mismatch" | "delivery_dispute"): Promise<void>;
  escalatedNote(): string;
  notify(text: string): Promise<void>;
  ndrCodes: ReadonlySet<string>;
  maxedCodes: ReadonlySet<string>;
}
export interface ExecInput { phone: string; orderId: string; escalate: Escalate; claim?: Claim; mode: TicketsMode; /** A shadow run: never anything but dry. */ forceDry?: boolean }
export type ExecOutcome = "off" | "not_a_trigger" | "refused" | "dry_run" | "queued" | "raised" | "duplicate" | "failed";
export interface ExecResult { outcome: ExecOutcome; reason?: string; to?: "person" | "wait" | "none"; courier?: string; kind?: string; requestId?: string | null }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function requestTicket(d: ExecDeps, i: ExecInput): Promise<ExecResult> {
  try {
    const mode: TicketsMode = i.mode === "off" ? "off" : i.forceDry ? "dry" : i.mode;
    if (mode === "off") return { outcome: "off" };
    const trigger = triggerFor(i.escalate);
    if (!trigger) return { outcome: "not_a_trigger" };

    const { data: o } = await d.db.from("orders").select("id, awb_code, courier_name, shiprocket_order_id, status, admin_notes, pending_courier_edit").eq("id", i.orderId).maybeSingle();
    if (!o) return { outcome: "refused", reason: "order not found", to: "none" };
    const order: TicketOrder = { id: String(o.id), awb: (o.awb_code as string | null) ?? null, courierName: (o.courier_name as string | null) ?? null, shiprocketOrderId: (o.shiprocket_order_id as string | null) ?? null, status: (o.status as string | null) ?? null, adminNotes: (o.admin_notes as string | null) ?? null, pendingCourierEdit: (o.pending_courier_edit as boolean | null) ?? null };
    const awb = order.awb ?? "";
    const now = d.now();

    // What already exists for this parcel: open tickets, active requests, and what was asked in the last fourteen days (a dry-run row counts for one day only).
    const [{ data: tk }, { data: rq }] = await Promise.all([
      d.db.from("courier_tickets").select("awb, ticket_state").eq("awb", awb),
      d.db.from("courier_requests").select("kind, status, created_at").eq("awb", awb),
    ]);
    const openTicketAwbs = new Set(((tk ?? []) as Array<{ awb: string; ticket_state: string }>).filter((t) => t.ticket_state === "open" || t.ticket_state === "replied").map((t) => t.awb));
    const reqs = (rq ?? []) as Array<{ kind: string; status: string; created_at: string }>;
    const activeRequestAwbs = new Set(reqs.some((r) => ACTIVE.includes(r.status)) ? [awb] : []);
    const recentRequests = new Set(reqs
      .filter((r) => now - Date.parse(r.created_at) < (r.status === "dry_run" ? DAY : REQUEST_WINDOW_DAYS * DAY))
      .map((r) => `${awb}|${r.kind}`));

    const courier = (order.courierName ?? "").trim().toLowerCase();
    const live: TicketLive = { delhivery: null, shadowfaxStatus: null };
    if (awb && !order.shiprocketOrderId) {
      if (courier === "delhivery") live.delhivery = await d.trackDelhivery(awb).catch(() => null);
      else if (courier === "shadowfax") live.shadowfaxStatus = await d.shadowfaxStatus(awb).catch(() => null);
    }

    const built: Built = buildTicketRequest(order, { trigger, claim: i.claim ?? null }, live, { now, openTicketAwbs, activeRequestAwbs, recentRequests, ndrCodes: d.ndrCodes, maxedCodes: d.maxedCodes });
    if (!built.ok) return { outcome: "refused", reason: built.reason, to: built.to };
    const r = built.request;

    const { data: kase } = await d.db.from("delivery_cases").select("id").eq("phone", i.phone).eq("order_id", i.orderId).eq("status", "open").limit(1);
    const caseId = ((kase as Array<{ id: number }> | null)?.[0]?.id ?? null);
    const row = { courier: r.courier, kind: r.kind, source: r.source, order_id: r.orderId, awb: r.awb, priority: r.priority, case_id: caseId === null ? r.caseId : String(caseId), ticket: r.ticket, evidence: r.evidence };

    if (mode === "dry") {
      const ins = await d.db.from("courier_requests").insert({ ...row, status: "dry_run", reason: "dry run: nothing was sent" }).select("id").single();
      if (ins.error) return { outcome: "failed", reason: errText(ins.error.message), courier: r.courier, kind: r.kind };
      return { outcome: "dry_run", courier: r.courier, kind: r.kind, requestId: ins.data?.id ?? null };
    }

    if (r.courier === "delhivery") {
      const ins = await d.db.from("courier_requests").insert({ ...row, status: "queued" }).select("id").single();
      if (ins.error) return ins.error.code === "23505" ? { outcome: "duplicate", reason: "a request for this parcel is already active", courier: r.courier, kind: r.kind } : { outcome: "failed", reason: errText(ins.error.message), courier: r.courier, kind: r.kind };
      await d.notify(`📮 <b>Late-delivery agent</b>: Delhivery ${r.kind.replace("_", " ")} ticket queued for tonight's run: <b>${r.orderId}</b> (${r.awb}).`).catch(() => {});
      return { outcome: "queued", courier: r.courier, kind: r.kind, requestId: ins.data?.id ?? null };
    }

    // Shadowfax: the slot is taken first (the one-active-request index), then the one API call.
    const cat = r.ticket.shadowfaxCategory!;
    const ins = await d.db.from("courier_requests").insert({ ...row, status: "raising" }).select("id").single();
    if (ins.error) return ins.error.code === "23505" ? { outcome: "duplicate", reason: "a request for this parcel is already active", courier: r.courier, kind: r.kind } : { outcome: "failed", reason: errText(ins.error.message), courier: r.courier, kind: r.kind };
    const id = ins.data?.id as string;
    try {
      await d.raiseShadowfax(r.awb, cat);
    } catch (e) {
      await d.db.from("courier_requests").update({ status: "refused", reason: `Shadowfax refused: ${errText(e)}`, attempts: 1, updated_at: new Date(now).toISOString() }).eq("id", id);
      await d.notify(`⚠️ <b>Late-delivery agent</b>: Shadowfax did not accept the ${cat} issue for <b>${r.orderId}</b> (${r.awb}): ${errText(e)}`).catch(() => {});
      return { outcome: "failed", reason: errText(e), courier: r.courier, kind: r.kind, requestId: id };
    }
    await d.db.from("courier_requests").update({ status: "raised", attempts: 1, reason: null, updated_at: new Date(now).toISOString() }).eq("id", id);
    await d.db.from("orders").update({ admin_notes: [order.adminNotes, `${d.escalatedNote()} ${cat} (late-delivery agent)`].filter(Boolean).join("\n") }).eq("id", order.id);
    await d.notify(`📮 <b>Late-delivery agent</b>: Shadowfax ${cat === "status_mismatch" ? "'Fake status'" : "'My shipment is delayed'"} issue raised for <b>${r.orderId}</b> (${r.awb}).`).catch(() => {});
    return { outcome: "raised", courier: r.courier, kind: r.kind, requestId: id };
  } catch (e) {
    return { outcome: "failed", reason: errText(e) };
  }
}

/**
 * For the handler: ask for the ticket this escalation calls for, with the real couriers. Fire and forget (`void runTicketRequest(...)`): it never throws and the reply
 * does not wait for it. The switch is read here so a handler that does not set it costs nothing.
 */
export async function runTicketRequest(db: SupabaseClient, i: Omit<ExecInput, "mode"> & { mode?: TicketsMode }): Promise<ExecResult> {
  const mode = i.mode ?? ticketsMode();
  if (mode === "off" || !triggerFor(i.escalate)) return { outcome: mode === "off" ? "off" : "not_a_trigger" };
  try {
    const r = await requestTicket(await realExecDeps(db), { ...i, mode });
    console.log(JSON.stringify({ event: "delivery_ticket_request", orderId: i.orderId, mode, forceDry: !!i.forceDry, outcome: r.outcome, reason: r.reason ?? null, to: r.to ?? null, kind: r.kind ?? null }));
    return r;
  } catch (e) {
    return { outcome: "failed", reason: errText(e) };
  }
}

/** The real dependencies. Lazy imports keep this module testable without the courier clients. */
export async function realExecDeps(db: SupabaseClient): Promise<ExecDeps> {
  const [{ trackDelhivery, NDR_ELIGIBLE_CODES, MAXED_OUT_CODES }, sfx, { notify }] = await Promise.all([import("@adapters/couriers/delhivery"), import("@adapters/couriers/shadowfax"), import("@adapters/notifier/telegram")]);
  return {
    db, now: () => Date.now(), ndrCodes: NDR_ELIGIBLE_CODES, maxedCodes: MAXED_OUT_CODES,
    trackDelhivery: async (awb) => (await trackDelhivery(awb)) as never,
    shadowfaxStatus: async (awb) => (await sfx.trackShadowfax(awb))?.status ?? null,
    raiseShadowfax: (awb, cat) => sfx.raiseShadowfaxIssue(awb, cat),
    escalatedNote: () => sfx.shadowfaxEscalatedNote(),
    notify: async (text) => { await notify("OPS", text); },
  };
}
