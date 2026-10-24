// Proactive movement updates for the late-delivery agent: the message that keeps the promise "I will message you here when it moves" (founder, 18 Oct 2026). PURE.
//
// What it covers, and what it deliberately does not:
//   · It tells the customer when a parcel they chased MOVES again in the transit stages (picked up, in transit, at a facility, manifested). That is the gap.
//   · It does NOT repeat what the order lifecycle already sends with its own approved templates: out for delivery (order_out_for_delivery), delivered (order_delivered_v2),
//     a failed attempt (delivery_attempt_failed_v2 and the RTO journey's reminder) and a return to origin. Those stages only advance the baseline, never send.
//
// Rules (founder 16 Oct, cap from the plan): a message only for a NEW scan at a NEW stage (a re-poll that shows the same scan is not movement; the same stage again only after
// 12 hours); at most 3 updates per case; at least 6 hours between two; any hour of the day (no support-hours window); free text inside the 24 hour window, the approved
// template after it; never to a customer who opted out. The decision is a value: the caller does the sending and the writing.

import { STATUS_WORDS, type Timeline, type MovementMeta } from "@late/deliveryCaseState";
import { LATE_EFFORT } from "@engine/lateReassurance";

export const MOVEMENT_MAX_UPDATES = 3;
export const MOVEMENT_MIN_GAP_HOURS = 6;
export const MOVEMENT_SAME_STAGE_HOURS = 12;
/** The approved-template name (scripts/create-delivery-update-templates.mts): {{1}} order id, {{2}} the status in words. Utility, English only, neither variable first nor last. */
export const UPDATE_TEMPLATE = "order_delivery_update_v1";
/** The body submitted to Meta for it (scripts/create-delivery-update-templates.mts). Rendered with its two variables it is exactly updateText(), so the template and the free text say the same words. */
export const UPDATE_TEMPLATE_BODY = `Update on your order {{1}}: the latest status is {{2}}. ${LATE_EFFORT} You can follow it at www.ajuki.in/track.`;
export const UPDATE_TEMPLATE_EXAMPLE: [string, string] = ["AJUKI710037", "in transit"];
/** Stages another approved message already covers. Their movement moves the baseline and tells the customer nothing here. */
export const COVERED_BY_LIFECYCLE: ReadonlySet<string> = new Set(["out_for_delivery", "failed_attempt", "on_hold"]);
const H = 3_600_000;

export interface MovementCase { lastScanAt: number | null; meta: MovementMeta | null }
export interface MovementInput { c: MovementCase; timeline: Timeline; orderId: string; now: number; windowOpen: boolean; optedOut: boolean }
export interface MovementBaseline { lastScanAt: number; lastEvent: string | null }

export type MovementDecision =
  | { kind: "send"; replyId: "D1"; text: string; template: { name: string; variables: [string, string] }; viaTemplate: boolean; patch: MovementMeta & { lastScanAt: number } }
  | { kind: "skip"; reason: string; baseline?: MovementBaseline }
  | { kind: "close"; reason: "delivered" | "returning_to_us" };

export const updateText = (orderId: string, status: string): string => `Update on your order ${orderId}: the latest status is ${status}. ${LATE_EFFORT} You can follow it at www.ajuki.in/track.`;

export function decideMovement(i: MovementInput): MovementDecision {
  const { c, timeline: t, now } = i;
  if (t.phase === "delivered") return { kind: "close", reason: "delivered" };
  if (t.phase === "rto") return { kind: "close", reason: "returning_to_us" };
  if (t.lastAt === null) return { kind: "skip", reason: "no_scans" };
  const event = t.lastEvent;
  // Before the courier has the parcel, nothing is "in transit": no update (the customer is told it is being packed when they ask).
  if (t.prePickup) return { kind: "skip", reason: "pre_pickup", baseline: { lastScanAt: t.lastAt, lastEvent: event } };
  const baseline: MovementBaseline = { lastScanAt: t.lastAt, lastEvent: event };
  // First sight of the parcel: remember where it is, say nothing.
  if (c.lastScanAt === null) return { kind: "skip", reason: "baseline", baseline };
  // Same scan as before: a re-poll, not movement.
  if (t.lastAt <= c.lastScanAt) return { kind: "skip", reason: "no_movement" };
  // A stage another approved message covers: the baseline moves, nothing is sent.
  if (event && COVERED_BY_LIFECYCLE.has(event)) return { kind: "skip", reason: "covered_by_lifecycle", baseline };
  if (i.optedOut) return { kind: "skip", reason: "opted_out", baseline };
  const meta: MovementMeta = c.meta ?? { lastEvent: null, updatesSent: 0, lastUpdateAt: null };
  if (meta.updatesSent >= MOVEMENT_MAX_UPDATES) return { kind: "skip", reason: "cap", baseline };
  const sinceUpdateH = meta.lastUpdateAt === null ? Infinity : (now - meta.lastUpdateAt) / H;
  if (sinceUpdateH < MOVEMENT_MIN_GAP_HOURS) return { kind: "skip", reason: "too_soon" }; // not advanced: it is reconsidered once the gap has passed
  if (event === meta.lastEvent && sinceUpdateH < MOVEMENT_SAME_STAGE_HOURS) return { kind: "skip", reason: "same_stage", baseline };
  const status = STATUS_WORDS[event ?? "unknown"] ?? "in transit";
  // The same words as the last update ("in transit" after "in transit") tell the customer nothing new: not before a day has passed (20 Oct: the same text went twice, six hours apart).
  // Not advanced, so the scan is reconsidered each hour and goes once the day is up.
  if (meta.lastEvent !== null && (STATUS_WORDS[meta.lastEvent] ?? "in transit") === status && sinceUpdateH < 24) return { kind: "skip", reason: "same_words" };
  return {
    kind: "send", replyId: "D1", text: updateText(i.orderId, status),
    template: { name: UPDATE_TEMPLATE, variables: [i.orderId, status] }, viaTemplate: !i.windowOpen,
    patch: { lastScanAt: t.lastAt, lastEvent: event, updatesSent: meta.updatesSent + 1, lastUpdateAt: now },
  };
}
