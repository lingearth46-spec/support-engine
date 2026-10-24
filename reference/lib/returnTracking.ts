// Where a return's collection is, and when a person needs to hear about it.
//
// WHY THIS EXISTS
//
// A reverse pickup was booked and then never looked at again. Both courier
// webhooks match on orders.awb_code — the FORWARD parcel — while a reverse
// waybill lives in return_request.pickup_shipment, so no tracking update for a
// collection has ever reached us. On 13 Sep 2026 Rohit Patil's return
// (Delhivery 60000000000005) had been picked up and was "In Transit · Vehicle
// Departed", and nothing in the system knew. For an exchange that is the whole
// problem: the replacement ships when the returned item arrives, and nobody
// would learn that it had.
//
// Everything here is pure — no database, no courier, no clock of its own — so
// the rules can be tested without either. app/api/cron/return-pickup-tracking
// does the fetching and the writing.

/** One ordered lifecycle both couriers are folded into. */
export type PickupStage =
  | "scheduled"        // booked, no one has come yet
  | "out_for_pickup"   // a rider is on the way today
  | "attempt_failed"   // came and could not collect — recoverable
  | "picked_up"        // in the courier's hands
  | "in_transit"       // moving between their facilities
  | "delivered"        // back with us
  | "cancelled"
  | "exception";       // lost, or undeliverable to us

/** Stages after which there is nothing left to watch. */
export const TERMINAL_STAGES: ReadonlySet<PickupStage> = new Set(["delivered", "cancelled"]);

/** A pickup still not collected this long after booking needs chasing. */
export const NOT_COLLECTED_HOURS = 48;
/** A collected parcel with no new scan this long is stuck. */
export const NO_MOVEMENT_HOURS = 72;

/**
 * Shadowfax reverse status → stage.
 *
 * From their reverse-pickup document (sfxreversepickup.docs.apiary.io, v4
 * tracking). "Received" is used for BOTH the hub receiving a picked item and the
 * item returning to origin, so it cannot mean "back with us" — the terminal
 * state is "Returned To Client", "Item Return To Origin Delivered".
 */
export function shadowfaxReverseStage(status: string | null | undefined): PickupStage | null {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "new" || s === "assigned") return "scheduled";
  if (s === "out for pickup") return "out_for_pickup";
  if (s === "picked") return "picked_up";
  if (s === "returned to client") return "delivered";
  if (s === "cancelled") return "cancelled";
  if (s === "lost" || s === "undelivered") return "exception";
  if (["cid", "not contactable", "not attempted", "on hold", "qc failed"].includes(s)) return "attempt_failed";
  if ([
    "received", "received at return dc", "item added to bag", "bag in transit", "bag received",
    "in transit for return", "item misrouted", "pincode updated", "reopen",
  ].includes(s)) return "in_transit";
  return null;
}

/**
 * Delhivery reverse status → stage.
 *
 * Their StatusType for a reverse leg runs PP (pickup pending) → PU (picked up,
 * then moving) → DL (delivered to origin), or CN (cancelled). The free-text
 * status separates a failed attempt and an out-for-pickup day inside PP.
 * Observed live 2026-09-13: "Scheduled · PP", then "In Transit · PU".
 */
export function delhiveryReverseStage(
  t: { status?: string | null; statusType?: string | null } | null | undefined,
): PickupStage | null {
  if (!t) return null;
  const type = (t.statusType ?? "").toUpperCase();
  const text = (t.status ?? "").toLowerCase();

  if (type === "CN" || /cancel/.test(text)) return "cancelled";
  if (/lost/.test(text)) return "exception";
  if (type === "DL") return "delivered";
  if (type === "PU") return /picked up|pickup completed/.test(text) ? "picked_up" : "in_transit";
  if (type === "PP") {
    if (/out for pickup/.test(text)) return "out_for_pickup";
    if (/not picked|attempt|unable|refus|not available|reschedul|closed/.test(text)) return "attempt_failed";
    return "scheduled";
  }
  return null;
}

/** What the order carries about the collection's progress. */
export interface PickupTracking {
  stage: PickupStage;
  /** The courier's own wording, for a person reading the panel. */
  raw: string;
  /** When we last asked. */
  checked_at: string;
  /**
   * When the courier last reported something NEW — a different stage or a
   * different status line. What "stuck" is measured from.
   *
   * Not the stage alone: a parcel in transit gets scan after scan while its
   * stage stays in_transit, and measuring from the stage change would call an
   * ordinary four-day journey stuck at 72 hours.
   */
  changed_at: string;
  picked_at?: string;
  delivered_at?: string;
  /** Alert keys already sent, so each fires once. */
  alerted: string[];
}

export type PickupAlert =
  | { key: "delivered"; kind: "delivered" }
  | { key: string; kind: "attempt_failed"; raw: string }
  | { key: "cancelled" | "exception"; kind: "cancelled" | "exception"; raw: string }
  | { key: "not_collected"; kind: "not_collected"; hours: number }
  | { key: "no_movement"; kind: "no_movement"; hours: number };

const H = 3_600_000;

/** The courier's status word from a stored line — "Not Contactable · Customer
 *  not reachable · TRV" → "not contactable". The line is built status-first in
 *  the tracking cron; the rest is free text that couriers reword at will. */
export function courierStatus(raw: string | null | undefined): string {
  return String(raw ?? "").split(" · ")[0].trim().toLowerCase();
}

/**
 * Fold a fresh reading into the stored tracking and work out what to say.
 *
 * `stage` may be null when the courier answered with a status we do not
 * recognise; the stored stage is then kept, but the raw wording still updates
 * so a person can see what the courier actually said.
 */
export function advanceTracking(
  prev: PickupTracking | null | undefined,
  reading: { stage: PickupStage | null; raw: string },
  bookedAt: string,
  now: Date,
): { tracking: PickupTracking; alerts: PickupAlert[] } {
  const nowIso = now.toISOString();
  const stage = reading.stage ?? prev?.stage ?? "scheduled";
  const raw = reading.raw || prev?.raw || "";
  const changed = !prev || prev.stage !== stage || prev.raw !== raw;

  const tracking: PickupTracking = {
    stage,
    raw,
    checked_at: nowIso,
    changed_at: changed ? nowIso : prev!.changed_at,
    picked_at: prev?.picked_at,
    delivered_at: prev?.delivered_at,
    alerted: [...(prev?.alerted ?? [])],
  };

  if (!tracking.picked_at && ["picked_up", "in_transit", "delivered"].includes(stage)) tracking.picked_at = nowIso;
  if (!tracking.delivered_at && stage === "delivered") tracking.delivered_at = nowIso;

  const alerts: PickupAlert[] = [];
  const fire = (a: PickupAlert) => {
    if (tracking.alerted.includes(a.key)) return;
    tracking.alerted.push(a.key);
    alerts.push(a);
  };

  if (stage === "delivered") fire({ key: "delivered", kind: "delivered" });
  if (stage === "cancelled") fire({ key: "cancelled", kind: "cancelled", raw: tracking.raw });
  if (stage === "exception") fire({ key: "exception", kind: "exception", raw: tracking.raw });
  // News when the pickup ENTERS a failed state, or the courier's status changes
  // while in one ("Not Contactable" after "Cid"). Not when only the sentence
  // changes: on 15 Sep Shadowfax said "Customer not reachable" and an hour later
  // "Item Customer_not_contactable at TRV_Chirayinkeezhu" for the same failure,
  // and keying on the whole line alerted twice for AJUKI710080. The key carries
  // the time so a later, genuinely new failure is never mistaken for this one.
  if (
    stage === "attempt_failed" &&
    (prev?.stage !== "attempt_failed" || courierStatus(prev.raw) !== courierStatus(tracking.raw))
  ) {
    fire({ key: `attempt_failed:${courierStatus(tracking.raw)}:${nowIso}`, kind: "attempt_failed", raw: tracking.raw });
  }

  const sinceBooked = (now.getTime() - Date.parse(bookedAt)) / H;
  if (["scheduled", "out_for_pickup", "attempt_failed"].includes(stage) && sinceBooked > NOT_COLLECTED_HOURS) {
    fire({ key: "not_collected", kind: "not_collected", hours: Math.round(sinceBooked) });
  }

  const sinceChange = (now.getTime() - Date.parse(tracking.changed_at)) / H;
  if (["picked_up", "in_transit"].includes(stage) && sinceChange > NO_MOVEMENT_HOURS) {
    fire({ key: "no_movement", kind: "no_movement", hours: Math.round(sinceChange) });
  }

  return { tracking, alerts };
}
