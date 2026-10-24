// Part 6 of the control-plane design: eligibility decisions that used to live
// as ad hoc route logic, given one home, a version, and an audit trail.
//
// Every function here wraps a rule that already existed — lib/supportActions.ts's
// cancellationAllowed, lib/returnPolicy.ts's isWithinReturnWindow. This module
// adds nothing to what is or isn't allowed; it only makes the decision durable.
//
// AI may explain a policy's output. It may never compute one itself — every
// caller here is a route handler or the WhatsApp action executor, never the
// model.

import type { SupabaseClient } from "@supabase/supabase-js";
import { cancellationAllowedInWindow, type ActionOrder, type ActionRefusal } from "@/lib/supportActions";
import { isWithinReturnWindow, daysLeftToReturn, returnWindowOverride } from "@/lib/returnPolicy";

// Bumped when a rule changes; never edited in place, so a past decision stays
// explained by the version that actually produced it.
const POLICY_VERSIONS = {
  cancellation_eligibility: 1,
  return_eligibility: 1,
} as const;
type PolicyName = keyof typeof POLICY_VERSIONS;

/** Best-effort: a policy decision must never fail the request that asked for
 *  it just because the audit write did. */
async function recordDecision(
  db: SupabaseClient,
  policy: PolicyName,
  orderId: string | null,
  input: Record<string, unknown>,
  output: string,
  reason?: string | null,
): Promise<void> {
  try {
    const { error } = await db.from("policy_decisions").insert({
      policy, policy_version: POLICY_VERSIONS[policy], order_id: orderId, input, output, reason: reason ?? null,
    });
    if (error) throw error;
  } catch (err) {
    console.error(JSON.stringify({ event: "policy_decision_write_failed", policy, order_id: orderId, error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * Cancellation eligibility — nothing booked, nothing settled, and placed within 24 hours (cancellationAllowedInWindow). The WhatsApp
 * bot already used, now also the account-page cancel route's rule instead of
 * that route's own, looser check (which never looked at awb_code at all).
 */
export async function decideCancellation(
  db: SupabaseClient,
  order: Pick<ActionOrder, "status" | "awb_code" | "created_at"> & { id: string },
): Promise<{ ok: true } | { ok: false; reason: ActionRefusal }> {
  const result = cancellationAllowedInWindow(order);
  await recordDecision(
    db, "cancellation_eligibility", order.id,
    { status: order.status, hasAwb: Boolean(order.awb_code), placedAt: order.created_at ?? null },
    result.ok ? "allow" : "refuse",
    result.ok ? null : result.reason,
  );
  return result;
}

/**
 * Return eligibility — the 7-day window from lib/returnPolicy.ts. Orders with
 * no delivered_at pass through as eligible for manual review, same as today —
 * wrongly refusing a genuine return is worse than looking at an old one.
 */
export async function decideReturnEligibility(
  db: SupabaseClient,
  order: { id: string; delivered_at?: string | null; admin_notes?: string | null },
): Promise<{ eligible: boolean; daysLeft: number | null }> {
  const granted = returnWindowOverride(order.admin_notes);
  const eligible = isWithinReturnWindow(order.delivered_at, order.admin_notes);
  const daysLeft = daysLeftToReturn(order.delivered_at);
  await recordDecision(
    db, "return_eligibility", order.id,
    // The override is recorded alongside, so the audit row says why an order
    // outside its window was allowed through rather than looking like a bug.
    { deliveredAt: order.delivered_at ?? null, daysLeft, windowOverride: granted ? new Date(granted).toISOString() : null },
    eligible ? "eligible" : "ineligible",
    eligible ? null : "window_closed",
  );
  return { eligible, daysLeft };
}
