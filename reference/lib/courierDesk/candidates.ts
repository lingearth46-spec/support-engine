// Which Delhivery parcels deserve a "delayed" ticket tonight. Pure: facts in, a verdict and a reason out.
//
// A parcel is LATE only by Delhivery's OWN promised date (never our estimated_delivery, which is
// unreliable): Delhivery refuses an earlier ticket anyway ("Promised delivery date has not breached").
// Before that, guards drop everything that is not a courier delay: customer-side stops, parcels the
// NDR system owns, finished parcels, and anything that already has a ticket or a request.

import { parcelStateFromDelhivery, type DelhiveryTrackIn, type ParcelState } from "./ticketMap";

export interface OrderFacts {
  id: string;
  awb: string;
  status: string | null;
  ndrReason: string | null;
  pendingCourierEdit: boolean | null;
}
export interface TrackFacts extends DelhiveryTrackIn {
  promisedDate?: string | null;
  statusDateTime?: string | null;
}
export interface GuardContext {
  /** AWBs that already have an open Delhivery ticket (our table or the portal list). */
  openTicketAwbs: ReadonlySet<string>;
  /** AWBs with a queued / raising / raised / deflected / unknown request. */
  activeRequestAwbs: ReadonlySet<string>;
  /** Orders with a recent NDR request the NDR loop has not yet verified. */
  unverifiedNdrOrderIds: ReadonlySet<string>;
  /** delhivery.ts NDR_ELIGIBLE_CODES and MAXED_OUT_CODES: the NDR system owns these. */
  ndrCodes: ReadonlySet<string>;
  maxedCodes: ReadonlySet<string>;
}

export type Verdict =
  | { ok: true; promisedDate: string; daysLate: number; parcel: ParcelState; lastScanAt: string | null }
  | { ok: false; why: string };

const TERMINAL_ORDER = new Set(["delivered", "rto", "returned", "cancelled", "wa_cancelled", "undelivered"]);

export const istDate = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
const dayNumber = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);

/** The date part of Delhivery's promised date, or null when it is missing / not a date. */
export function promisedDay(v: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? "").trim());
  return m ? m[1] : null;
}

export function evaluateDelhiveryCandidate(order: OrderFacts, track: TrackFacts | null, ctx: GuardContext, nowMs: number): Verdict {
  const no = (why: string): Verdict => ({ ok: false, why });
  if (order.status && TERMINAL_ORDER.has(order.status.toLowerCase())) return no(`order is ${order.status}`);
  if (order.ndrReason) return no("a failed delivery is open: the NDR system owns it");
  if (order.pendingCourierEdit) return no("a delivery-detail edit is pending");
  if (ctx.unverifiedNdrOrderIds.has(order.id)) return no("an NDR request is awaiting verification");
  if (ctx.openTicketAwbs.has(order.awb)) return no("an open ticket already exists");
  if (ctx.activeRequestAwbs.has(order.awb)) return no("a request for this parcel is already active");
  if (!track) return no("no live tracking answer");

  const parcel = parcelStateFromDelhivery(track, ctx.ndrCodes);
  if (parcel === "delivered" || parcel === "rto" || parcel === "cancelled") return no(`parcel is ${parcel}`);
  if (parcel === "customer_side") return no("waiting on the customer, not a courier delay");
  if (parcel === "on_hold") return no("parcel is on hold");
  if (parcel === "out_for_delivery") return no("out for delivery today");
  if (track.statusCode && ctx.maxedCodes.has(track.statusCode)) return no("delivery attempts exhausted: chase the KAM, not a delay ticket");

  const promised = promisedDay(track.promisedDate);
  if (!promised) return no("Delhivery gave no promised date");
  const today = istDate(nowMs);
  const daysLate = dayNumber(today) - dayNumber(promised);
  if (daysLate < 1) return no(`promised date ${promised} has not passed`);

  const scan = track.statusDateTime ? new Date(`${track.statusDateTime.replace(" ", "T").slice(0, 19)}+05:30`).toISOString() : null;
  return { ok: true, promisedDate: promised, daysLate, parcel, lastScanAt: scan };
}

/**
 * The send order when the nightly cap is shared with the late-delivery agent's requests: priority first (0 a disputed attempt, 1 a stalled parcel, 2 a plain delay and
 * the night job's own rows, which have no priority), then stalest first inside each, so a cap never postpones the worst. A missing or unknown priority counts as 2.
 */
export function byPriorityThenStalest<T extends { priority?: number | null; lastScanAt: string | null; daysLate: number }>(items: T[]): T[] {
  const p = (x: T) => (x.priority === 0 || x.priority === 1 ? x.priority : 2);
  return [0, 1, 2].flatMap((n) => byStalest(items.filter((x) => p(x) === n)));
}

/** Stalest first: the longest since the last scan, then the most days late, so a cap never postpones the worst. */
export function byStalest<T extends { lastScanAt: string | null; daysLate: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.lastScanAt ?? "").localeCompare(b.lastScanAt ?? "") || b.daysLate - a.daysLate);
}
