// Granular courier tracking — one vocabulary across Delhivery, Shadowfax and DTDC.
//
// For Delhivery and Shadowfax, the courier webhooks (app/api/shipping/*) already
// collapse every scan into orders.status; this is the finer layer underneath —
// the hub name, the re-route, the failed attempt — the events that let us reach
// a customer before an RTO, and let the support bot say "last scanned 3h ago at
// the Pune hub" instead of just handing over a link.
//
// DTDC has no webhook at all, so for it this file's ParcelEvent vocabulary is
// also what dtdc-tracking-sync/route.ts uses, via dtdcOrderStatus() below, to
// drive orders.status directly — see that function's comment.
//
// Pure and dependency-free below recordScan(), so the mappers are testable
// (npx tsx lib/parcelScan.test.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderStatus } from "@engine/orders";

/**
 * The cross-courier event vocabulary. Ordered roughly by journey stage; the
 * four in the middle (`failed_attempt`, `rerouting`, `address_updated`,
 * `on_hold`) are the RTO-risk signals worth acting on.
 */
export const PARCEL_EVENTS = [
  "manifested",
  "picked_up",
  "in_transit",
  "at_facility",
  "out_for_delivery",
  "failed_attempt",
  "rerouting",
  "address_updated",
  "on_hold",
  "rto_in_transit",
  "rto_delivered",
  "delivered",
  "lost",
  "unknown",
] as const;

export type ParcelEvent = (typeof PARCEL_EVENTS)[number];

/** Events where a parcel is at risk and a customer contact can still change the
 *  outcome — the ones a proactive WhatsApp should be triggered from. */
export const AT_RISK_EVENTS: readonly ParcelEvent[] = [
  "failed_attempt", "rerouting", "address_updated", "on_hold",
];

export interface NormalizedScan {
  event: ParcelEvent;
  location: string | null;
  remark: string | null;
  scannedAt: string | null;
}

const clean = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
const orNull = (v: unknown): string | null => clean(v) || null;

// Wording that means the parcel is being sent somewhere other than first planned
// — the customer changed the address, or the courier is re-routing to a nearer
// hub. Both are the moment to confirm where it should actually go.
const REROUTE_RE = /re-?rout|nearest (hub|facility|centre|center)|address updat|consignee address (change|updat)/i;
const PIN_UPDATE_RE = /pin\s?code (of the destination )?(updated|changed)|destination pin/i;
const FAILED_RE = /(not attempt|delivery attempted|rescheduled by customer|consignee (not available|unavailable|unreachable|refus)|customer (not available|unavailable|unreachable|refus)|refused|address (incorrect|incomplete|wrong)|incomplete address|(office|business|premises) closed|cod (amount )?not ready|payment not ready|phone (not reachable|switched off)|no response)/i;
const FACILITY_RE = /received at (facility|hub)|added to bag|inscan at|reached (destination|hub)|arrived at/i;
const HOLD_RE = /on hold|held at|shipment hold/i;

/** Delhivery scan → NormalizedScan. `StatusType` (UD/RT/DL/PP) says the leg;
 *  the status string alone is ambiguous ("In Transit" is both directions). */
export function normalizeDelhiveryScan(input: {
  rawStatus: string; statusType?: string; instructions?: string;
  location?: string; scannedAt?: string | null;
}): NormalizedScan {
  const s = clean(input.rawStatus).toUpperCase();
  const t = clean(input.statusType).toUpperCase();
  const instr = clean(input.instructions);
  const text = `${s} ${instr}`;
  const base: Omit<NormalizedScan, "event"> = {
    location: orNull(input.location),
    remark: orNull(input.instructions),
    scannedAt: input.scannedAt ?? null,
  };

  let event: ParcelEvent = "unknown";

  if (s === "RTO" && t === "DL") event = "rto_delivered";
  else if (s === "RTO" || t === "RT") event = "rto_in_transit";
  else if (t === "DL" && s === "DELIVERED") event = "delivered";
  else if (/\bLOST\b/.test(text)) event = "lost";
  else if (PIN_UPDATE_RE.test(text)) event = "address_updated";
  else if (REROUTE_RE.test(text)) event = "rerouting";
  else if (HOLD_RE.test(text)) event = "on_hold";
  else if (s === "PENDING" && FAILED_RE.test(instr)) event = "failed_attempt";
  else if (s === "MANIFESTED") event = "manifested";
  else if (s === "DISPATCHED" || /out for delivery/i.test(text)) event = "out_for_delivery";
  else if (FACILITY_RE.test(text)) event = "at_facility";
  else if (s === "IN TRANSIT") event = "in_transit";
  else if (/picked/i.test(text)) event = "picked_up";

  return { event, ...base };
}

/** Shadowfax scan → NormalizedScan. Their push is `event` (an id) + `comments`
 *  (free-text remark) + `status` (the event's readable name). Location is not in
 *  the default payload — read a few likely keys defensively so it starts working
 *  if Shadowfax enable it, same as estimatedDeliveryDate. */
export function normalizeShadowfaxScan(input: {
  event: string; comments?: string; status?: string;
  location?: string; scannedAt?: string | null;
}): NormalizedScan {
  const e = clean(input.event).toLowerCase();
  const remark = clean(input.comments) || clean(input.status);
  const text = `${e} ${remark}`;
  const base: Omit<NormalizedScan, "event"> = {
    location: orNull(input.location),
    remark: orNull(remark),
    scannedAt: input.scannedAt ?? null,
  };

  let event: ParcelEvent = "unknown";

  if (e === "delivered") event = "delivered";
  else if (e.startsWith("rts") || e.startsWith("rto")) event = /deliver|handed/i.test(remark) ? "rto_delivered" : "rto_in_transit";
  else if (e === "lost") event = "lost";
  else if (PIN_UPDATE_RE.test(text)) event = "address_updated";
  else if (REROUTE_RE.test(text)) event = "rerouting";
  else if (e === "on_hold" || HOLD_RE.test(text)) event = "on_hold";
  else if (["nc", "na", "cid", "reopen_ndr"].includes(e) || FAILED_RE.test(remark)) event = "failed_attempt";
  else if (["ofd", "assigned_for_delivery"].includes(e)) event = "out_for_delivery";
  else if (["recd_at_rev_hub", "recd_at_fwd_hub", "recd_at_fwd_dc"].includes(e) || FACILITY_RE.test(text)) event = "at_facility";
  else if (e === "picked") event = "picked_up";
  else if (["assigned_for_pickup", "assigned_for_seller_pickup", "ofp"].includes(e)) event = "manifested";
  else if (e) event = "in_transit";

  return { event, ...base };
}

/**
 * DTDC scan → NormalizedScan.
 *
 * Unlike Delhivery and Shadowfax, DTDC's live status vocabulary is not
 * verified against real data: no DTDC parcel has tracked yet (the account's
 * wallet was still ₹0 as of 2026-09-27, so createDtdcShipment has never
 * completed against a real order). The only confirmed real values are the
 * three named in lib/dtdc.ts's own comment on `DtdcTracking.status`, taken
 * from a live probe before that: "pickup_awaited", "pickup_scheduled",
 * "reachedathub" — lowercase, inconsistently separated (sometimes `_`,
 * sometimes nothing). So this matches on loose, separator-agnostic text
 * rather than an exhaustive enum, the same defensive shape as the other two
 * — and it should be re-checked the first time `dtdc.livetest.ts`'s track
 * step (or a real order) returns live data.
 */
export function normalizeDtdcScan(input: {
  status: string; eventType?: string; update?: string; failureReason?: string | null;
  location?: string; scannedAt?: string | null;
}): NormalizedScan {
  const failure = clean(input.failureReason);
  const raw = `${clean(input.status)} ${clean(input.eventType)} ${clean(input.update)} ${failure}`;
  // Squash underscores/hyphens to spaces so "pickup_awaited" and a
  // hypothetical "pickup-awaited" match the same pattern as "pickup awaited",
  // and so "reachedathub" still hits a "reached at hub"-shaped pattern below.
  const text = raw.toLowerCase().replace(/[_-]/g, " ");
  const base: Omit<NormalizedScan, "event"> = {
    location: orNull(input.location),
    remark: orNull(failure || input.update),
    scannedAt: input.scannedAt ?? null,
  };

  let event: ParcelEvent = "unknown";

  if (/\brto\b/.test(text) && /deliver/.test(text)) event = "rto_delivered";
  else if (/\brto\b/.test(text)) event = "rto_in_transit";
  // A failure_reason on the event is DTDC's own explicit "why this failed" —
  // the strongest signal available, so it outranks a status string it might
  // still nominally call "pending" or "in transit".
  else if (failure) event = "failed_attempt";
  else if (/\blost\b/.test(text)) event = "lost";
  else if (PIN_UPDATE_RE.test(text)) event = "address_updated";
  else if (REROUTE_RE.test(text)) event = "rerouting";
  else if (HOLD_RE.test(text)) event = "on_hold";
  else if (/not\s*deliver|un\s*deliver|non\s*deliver|no\s*attempt|attempt(ed)?\b/.test(text)) event = "failed_attempt";
  else if (/out for deliver/.test(text)) event = "out_for_delivery";
  else if (/deliver/.test(text)) event = "delivered";
  else if (FACILITY_RE.test(text) || /reached\s*at\s*(hub|facility|destination)|in\s*scan/.test(text)) event = "at_facility";
  // "Not Picked Up" / "Not Picked" — DTDC's real wording, confirmed live
  // 2026-09-29 (58% of a 48-parcel batch read this way) — otherwise falls
  // through to the /pick(ed)?\s*up/ match below and gets read as the
  // opposite of what happened: a parcel still awaiting pickup reported as
  // already collected. Checked before the bare match for exactly that reason.
  else if (/not\s*picked|pickup\s*await|pickup\s*sched|pickup\s*pending/.test(text)) event = "manifested";
  else if (/pick(ed)?\s*up/.test(text)) event = "picked_up";
  else if (/transit/.test(text)) event = "in_transit";

  return { event, ...base };
}

/**
 * The orders.status promotion a DTDC ParcelEvent implies, or null when it
 * should not move the order at all.
 *
 * Delhivery and Shadowfax get this from their own webhook (readScan() in
 * app/api/shipping/delhivery/route.ts, mapEvent() in the Shadowfax one) the
 * moment a scan arrives. DTDC has no webhook, so dtdc-tracking-sync/route.ts —
 * its only tracking source — uses this instead, on the ParcelEvent already
 * computed by normalizeDtdcScan.
 *
 * Deliberately narrow, matching Delhivery's own precedent: only a clearly
 * failed attempt moves the order into `undelivered`. `on_hold`, `rerouting`
 * and `address_updated` are recorded in courier_status (still visible via
 * scanContextLine / lateParcelVerdict) without touching orders.status,
 * because — same reasoning as Delhivery's NDR_INSTRUCTION allowlist — "on
 * hold" is as often a routine customs/hub pause as an actual problem, and
 * inventing an NDR is worse than missing one.
 *
 * RTO reports as `"rto"` even once DTDC calls it delivered back to us:
 * `"returned"` means confirmed back in AJUKI's own inventory, a separate,
 * deliberate step elsewhere — not something a courier's tracking API decides
 * — which is exactly how Delhivery's own RTO scans are handled too.
 */
export function dtdcOrderStatus(event: ParcelEvent): OrderStatus | null {
  switch (event) {
    case "picked_up":
    case "in_transit":
    case "at_facility":
    case "out_for_delivery":
      return "shipped";
    case "failed_attempt":
      return "undelivered";
    case "rto_in_transit":
    case "rto_delivered":
      return "rto";
    case "delivered":
      return "delivered";
    default:
      return null;
  }
}

/**
 * A courier scan instant ("2026-09-01T09:38:00", sometimes space-separated,
 * often no timezone) as an ISO string, or null. A bare timestamp is IST —
 * that is what both Delhivery's `StatusDateTime` and Shadowfax's tz-less
 * timestamps are. This is a precise instant, never quoted to a customer, so
 * no sanity bound applies. Shared by the shipping webhooks, the reconcile
 * cron, and the live lookup, which had three copies of it.
 */
export function parseScanInstant(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}+05:30`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * How long a parcel can go without a courier scan before "it's just slow"
 * becomes "it's stuck and needs a person". 48h covers a normal weekend gap
 * plus a hub-to-hub leg; past that, a late parcel with no movement is the
 * shape of the ones that quietly RTO.
 */
export const SCAN_STALE_HOURS = 48;

/** Hours since the parcel's last courier scan, or null when there is none. */
export function scanAgeHours(
  o: { courier_status?: string | null; courier_status_at?: string | null },
  now: Date = new Date(),
): number | null {
  if (!o.courier_status || !o.courier_status_at) return null;
  return Math.max(0, (now.getTime() - Date.parse(o.courier_status_at)) / 3_600_000);
}

/**
 * For a LATE, still-in-flight parcel: is the courier trail fresh enough that
 * the bot can answer "where is it" from the last scan and leave it, or does a
 * person need to act?
 *
 * "moving"    — a scan within SCAN_STALE_HOURS, ordinary transit: just slow.
 * "attention" — a fresh scan, but it is a failed attempt / hold / reroute /
 *               address change: the customer needs to hear the reason and a
 *               person should follow up, however recent it is.
 * "stuck"     — a scan, but older than SCAN_STALE_HOURS: no movement, escalate.
 * "dark"      — no scans on record at all: escalate.
 *
 * Computed here rather than left to the model for the same reason the OVERDUE
 * line is: "is 40 hours recent?" is exactly the arithmetic a small model gets
 * confidently wrong, and getting it wrong here means either escalating every
 * late parcel (the status quo this replaces) or reassuring someone whose
 * parcel has genuinely stopped — or one that just failed a delivery attempt.
 */
export function lateParcelVerdict(
  o: { courier_status?: string | null; courier_status_at?: string | null },
  now: Date = new Date(),
): "moving" | "attention" | "stuck" | "dark" {
  const age = scanAgeHours(o, now);
  if (age === null) return "dark";
  if (age > SCAN_STALE_HOURS) return "stuck";
  return (AT_RISK_EVENTS as readonly string[]).includes(o.courier_status ?? "") ? "attention" : "moving";
}

/** A one-line summary for the support bot's order context, or null when there is
 *  nothing useful to say (no scan, or the order is already delivered/returned so
 *  the trail is moot). `now` is injectable for tests. */
export function scanContextLine(
  o: { status?: string | null; courier_status?: string | null; courier_status_detail?: string | null;
       courier_status_location?: string | null; courier_status_at?: string | null },
  now: Date = new Date(),
): string | null {
  if (!o.courier_status || !o.courier_status_at) return null;
  if (o.status === "delivered" || o.status === "returned" || o.status === "rto") return null;

  const ageH = Math.max(0, Math.round((now.getTime() - Date.parse(o.courier_status_at)) / 3_600_000));
  const when = ageH < 1 ? "just now" : ageH < 48 ? `${ageH}h ago` : `${Math.round(ageH / 24)}d ago`;
  const what = o.courier_status_detail || (o.courier_status as string).replace(/_/g, " ");
  const where = o.courier_status_location ? ` at ${o.courier_status_location}` : "";
  return `last courier scan ${when}${where}: "${what}"`;
}

/**
 * Persist a scan: append to parcel_scans, and move the order's snapshot forward
 * if this scan is newer than what is there.
 *
 * Best-effort by design. It runs inside the webhook's after() hook, and the
 * migration is applied by hand — a missing table (42P01) or column (42703) must
 * degrade to a no-op, never a thrown error that a courier reads as a failed
 * push. Same discipline as insertMessage in lib/waSupport.ts.
 */
export async function recordScan(
  db: SupabaseClient,
  args: {
    orderId: string | null;
    awb: string | null;
    courier: "delhivery" | "shadowfax" | "dtdc";
    scan: NormalizedScan;
    rawStatus: string;
  },
): Promise<void> {
  const stamp = args.scan.scannedAt ?? new Date().toISOString();
  try {
    // onConflict → the dedupe index; ignoreDuplicates so a replayed push is a
    // no-op rather than an error.
    await db.from("parcel_scans").upsert(
      {
        order_id: args.orderId,
        awb: args.awb ?? "",
        courier: args.courier,
        raw_status: args.rawStatus.slice(0, 300),
        event: args.scan.event,
        location: args.scan.location,
        remark: args.scan.remark?.slice(0, 500) ?? null,
        scanned_at: args.scan.scannedAt,
      },
      { onConflict: "awb,courier,raw_status,scanned_at", ignoreDuplicates: true },
    );
  } catch (e) {
    if (!isMissingSchema(e)) console.error("[parcelScan] insert failed:", (e as Error)?.message);
    return;
  }

  if (!args.orderId) return;
  try {
    // Only overwrite the snapshot when this scan is at least as recent as the
    // one already there — pushes arrive out of order.
    //
    // One conditional write, not a read followed by a write: the read was a
    // request of its own for every scan, ~4,000 a day, each a billed log line
    // (measured 7 Oct 2026). A stale scan now matches no row and changes nothing,
    // exactly as the early return did. A missing snapshot (null) still updates.
    await db.from("orders").update({
      courier_status: args.scan.event,
      courier_status_detail: args.scan.remark ?? args.rawStatus.slice(0, 300),
      courier_status_location: args.scan.location,
      courier_status_at: stamp,
    }).eq("id", args.orderId).or(`courier_status_at.is.null,courier_status_at.lte.${stamp}`);
  } catch (e) {
    if (!isMissingSchema(e)) console.error("[parcelScan] snapshot failed:", (e as Error)?.message);
  }
}

/** In-flight statuses a courier can still update — shared by every poll cron
 *  so "what counts as still moving" cannot drift between them. */
export const IN_FLIGHT_STATUSES = ["shipped", "manifested", "undelivered"] as const;

export type ScanSyncTally = { queued: number; checked: number; scanned: number; noData: number; failed: number };

/**
 * Poll one courier for every in-flight parcel whose snapshot has gone stale,
 * and write any scan found. Shared by parcel-scan-sync (the once-daily
 * backstop for Delhivery/Shadowfax, whose real source is the push webhook)
 * and dtdc-tracking-sync (DTDC's ONLY source — it has no webhook at all, so
 * this is not a backstop for that courier, just called more often and with a
 * shorter staleness window).
 *
 * `staleBefore`: an ISO instant. A parcel whose `courier_status_at` is null or
 * older than this is polled; pass "now" (or later) to poll every in-flight
 * parcel unconditionally, which is the right call for a courier with no push
 * source to fall back on.
 */
export async function reconcileCourierScans(
  db: SupabaseClient,
  courier: "delhivery" | "shadowfax" | "dtdc",
  courierNameMatch: string,
  staleBefore: string,
  fetchScan: (awb: string) => Promise<{ rawStatus: string; scan: NormalizedScan } | null>,
  opts: { maxParcels?: number; concurrency?: number } = {},
): Promise<ScanSyncTally> {
  const { maxParcels = 120, concurrency = 5 } = opts;

  const { data: rows, error } = await db
    .from("orders")
    .select("id, awb_code, courier_status_at")
    .in("status", IN_FLIGHT_STATUSES)
    .ilike("courier_name", courierNameMatch)
    .not("awb_code", "is", null)
    .or(`courier_status_at.is.null,courier_status_at.lt.${staleBefore}`)
    .order("courier_status_at", { ascending: true, nullsFirst: true })
    .limit(maxParcels);

  if (error) {
    if (/column .* does not exist|could not find/i.test(error.message)) {
      return { queued: 0, checked: 0, scanned: 0, noData: 0, failed: 0 };
    }
    throw new Error(`${courier}: ${error.message}`);
  }

  const queue = rows ?? [];
  const t: ScanSyncTally = { queued: queue.length, checked: 0, scanned: 0, noData: 0, failed: 0 };

  for (let i = 0; i < queue.length; i += concurrency) {
    await Promise.all(queue.slice(i, i + concurrency).map(async (o) => {
      t.checked++;
      let hit;
      try {
        hit = await fetchScan(o.awb_code as string);
      } catch (e) {
        t.failed++;
        console.warn(`[parcelScan] ${courier} ${o.id}: ${(e as Error).message}`);
        return;
      }
      if (!hit) { t.noData++; return; }
      await recordScan(db, {
        orderId: o.id,
        awb: o.awb_code as string,
        courier,
        rawStatus: hit.rawStatus,
        scan: hit.scan,
      });
      t.scanned++;
    }));
  }
  return t;
}

function isMissingSchema(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  const msg = (e as Error)?.message ?? "";
  return code === "42P01" || code === "42703" || code === "PGRST204" ||
    /does not exist|could not find the .* column/i.test(msg);
}
