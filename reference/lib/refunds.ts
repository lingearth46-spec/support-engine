// The refund ledger's own transitions (Part 5/6 of the control-plane design).
//
// One entry point per state change, same discipline as lib/supportCases.ts —
// so "who is currently owed money" can always be answered from this table
// alone, never from orders.status or a founder's memory of what they meant to
// do.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordPromise, fulfillOpenPromises } from "@/lib/cxPromises";
import { creditWallet } from "@/lib/wallet";
import { getOrCreateCustomer } from "@/lib/customerIdentity";
import Razorpay from "razorpay";

export type RefundStatus = "REFUND_ELIGIBLE" | "REFUND_REQUESTED" | "REFUND_PROCESSING" | "REFUND_COMPLETED" | "REFUND_FAILED" | "REFUND_MANUAL_REVIEW";
export type ReasonCategory = "cancellation" | "return_approved" | "goodwill" | "price_error" | "other";

export interface Refund {
  id: string;
  original_order_id: string;
  payment_id: string | null;
  return_request_id: string | null;
  support_case_id: string | null;
  amount: number;
  currency: string;
  reason_category: ReasonCategory;
  reason_detail: string | null;
  requested_by: "ai" | "customer" | "founder";
  authorized_by: string | null;
  execution_status: RefundStatus;
  provider_status: string | null;
  provider_refund_id: string | null;
  acquirer_rrn: string | null;
  idempotency_key: string;
  created_at: string;
  processed_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  manual_settlement: boolean;
  manual_settlement_evidence: string | null;
}

/** One key per (category, order) — a retried cancellation write finds the
 *  existing row instead of minting a second one. */
export function refundIdempotencyKey(category: ReasonCategory, orderId: string): string {
  return `${category}:${orderId}`;
}

/**
 * Open the REFUND_ELIGIBLE row for this order, or return the existing one.
 *
 * Called the moment eligibility is established — a prepaid cancellation going
 * through, a return being approved — never as a side effect of a message
 * being sent. paymentId absent (COD, nothing captured online) is legitimate;
 * that refund can only ever be settled manually, and the execute endpoint
 * refuses it accordingly.
 */
export async function openOrCreateRefund(
  db: SupabaseClient,
  args: {
    orderId: string;
    paymentId: string | null;
    amount: number;
    reasonCategory: ReasonCategory;
    reasonDetail?: string | null;
    requestedBy: "ai" | "customer" | "founder";
    supportCaseId?: string | null;
  },
): Promise<{ refund: Refund; isNew: boolean }> {
  const idempotencyKey = refundIdempotencyKey(args.reasonCategory, args.orderId);

  const { data: existing } = await db.from("refunds").select("*").eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existing) return { refund: existing as Refund, isNew: false };

  const { data: created, error } = await db.from("refunds").insert({
    original_order_id: args.orderId,
    payment_id: args.paymentId,
    amount: args.amount,
    reason_category: args.reasonCategory,
    reason_detail: args.reasonDetail ?? null,
    requested_by: args.requestedBy,
    support_case_id: args.supportCaseId ?? null,
    idempotency_key: idempotencyKey,
  }).select("*").single();

  if (error) {
    // A concurrent request already created this exact refund between the
    // lookup above and this insert — re-read and return the winner rather
    // than erroring the cancellation the customer is waiting on.
    if (error.code === "23505") {
      const { data: winner } = await db.from("refunds").select("*").eq("idempotency_key", idempotencyKey).single();
      if (winner) return { refund: winner as Refund, isNew: false };
    }
    throw new Error(`refund creation failed: ${error.message}`);
  }

  // The customer has been (or is about to be) told a refund is coming. Track
  // that promise so the founder digest can flag it if it stalls. Best-effort —
  // never blocks the cancellation this refund settles.
  await recordPromise({
    db,
    kind: "refund",
    orderId: args.orderId,
    sourceCaseId: args.supportCaseId ?? null,
    detail: args.reasonDetail ?? `${args.reasonCategory} refund of ₹${args.amount}`,
    promisedBy: args.requestedBy === "founder" ? "founder" : "ai",
  });

  return { refund: created as Refund, isNew: true };
}

/**
 * Founder-triggered execution (Part 13: refund issuance stays manual even
 * after this pipeline exists). Moves REFUND_ELIGIBLE → REFUND_PROCESSING on
 * success, or → REFUND_FAILED with a reason on the Razorpay call itself
 * failing — REFUND_COMPLETED is reached only by the webhook, never here.
 */
export async function executeRefund(db: SupabaseClient, refundId: string, authorizedBy: string): Promise<Refund> {
  const { data: refund, error: readError } = await db.from("refunds").select("*").eq("id", refundId).single();
  if (readError) throw new Error(`refund read failed: ${readError.message}`);
  const row = refund as Refund;

  if (row.execution_status !== "REFUND_ELIGIBLE" && row.execution_status !== "REFUND_MANUAL_REVIEW") {
    throw new Error(`refund is ${row.execution_status}, not eligible for execution`);
  }
  if (!row.payment_id) {
    throw new Error("no online payment on this order — settle manually and record it, not execute");
  }

  const razorpay = new Razorpay({
    key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID!,
    key_secret: process.env.RAZORPAY_KEY_SECRET!,
  });

  try {
    const result = await (razorpay.payments as any).refund(row.payment_id, {
      amount: Math.round(row.amount * 100), // paise
      speed: "normal",
      notes: { order_id: row.original_order_id, refund_id: row.id, reason: row.reason_category },
    });

    const { data: updated, error: updateError } = await db.from("refunds").update({
      execution_status: "REFUND_PROCESSING",
      provider_status: result.status ?? null,
      provider_refund_id: result.id ?? null,
      authorized_by: authorizedBy,
    }).eq("id", refundId).select("*").single();
    if (updateError) throw new Error(`refund state update failed: ${updateError.message}`);
    return updated as Refund;
  } catch (err) {
    // Lands on REFUND_MANUAL_REVIEW directly rather than the intermediate
    // REFUND_FAILED the state diagram shows — that state has exactly one
    // outbound edge (straight to MANUAL_REVIEW) and no action a founder can
    // take while in it, so storing it as a resting state would just be a
    // status nobody can act on. This is also what keeps the row inside this
    // function's own retry guard above instead of stranding it.
    const message = err instanceof Error ? err.message : String(err);
    const { data: failed, error: updateError } = await db.from("refunds").update({
      execution_status: "REFUND_MANUAL_REVIEW",
      failed_at: new Date().toISOString(),
      failure_reason: message,
      authorized_by: authorizedBy,
    }).eq("id", refundId).select("*").single();
    if (updateError) throw new Error(`refund failure write failed: ${updateError.message}`);
    return failed as Refund;
  }
}

/**
 * Money moved outside Razorpay entirely — UPI, bank transfer, cash — which is
 * the only path available for a COD order (nothing was ever captured online
 * to call refund() on) and for anything a founder chooses to settle by hand.
 * This is what turns today's "silent, settled off-system" into an actual
 * record instead of memory: evidence is required, not optional.
 */
export async function settleManually(
  db: SupabaseClient,
  refundId: string,
  evidence: string,
  authorizedBy: string,
): Promise<Refund> {
  if (!evidence.trim()) throw new Error("manual settlement requires evidence — a UPI id, a screenshot reference, a note");

  const { data: refund, error: readError } = await db.from("refunds").select("execution_status").eq("id", refundId).single();
  if (readError) throw new Error(`refund read failed: ${readError.message}`);
  if (refund.execution_status === "REFUND_COMPLETED") throw new Error("already completed");

  const { data: updated, error } = await db.from("refunds").update({
    execution_status: "REFUND_COMPLETED",
    processed_at: new Date().toISOString(),
    manual_settlement: true,
    manual_settlement_evidence: evidence.trim(),
    settled_as: "manual_transfer",
    authorized_by: authorizedBy,
  }).eq("id", refundId).select("*").single();
  if (error) throw new Error(`manual settlement failed: ${error.message}`);
  return updated as Refund;
}

/**
 * Settle a refund as AJUKI Wallet credit instead of money.
 *
 * This is the answer to the COD problem. A COD order has no payment to reverse,
 * so until now every approved COD refund ended at settleManually — the founder
 * making a UPI transfer by hand and typing the evidence in. That works, and it
 * stays available, but it costs founder time per refund and it is the slowest
 * step in every approved COD return.
 *
 * ORDER OF OPERATIONS, AND WHY
 *
 * The wallet is credited FIRST, the refund is marked completed second. If the
 * process dies between the two, the customer has their money and our bookkeeping
 * is behind — which a retry fixes, because creditWallet is idempotent on
 * refund_id (unique index) and reports an existing credit as success rather than
 * writing a second one.
 *
 * The other order would fail the other way: a refund marked COMPLETED with
 * nothing in the customer's wallet, which looks settled to everyone who reads
 * the table and is only discovered when the customer asks where their money is.
 * Given a choice of which side to be wrong on, be wrong in the customer's favour.
 */
export async function settleAsWalletCredit(
  db: SupabaseClient,
  refundId: string,
  authorizedBy: string,
): Promise<{ refund: Refund; amount: number; alreadyCredited: boolean; customerId: string }> {
  const { data: refund, error: readError } = await db
    .from("refunds")
    .select("id, original_order_id, amount, execution_status")
    .eq("id", refundId)
    .single();
  if (readError) throw new Error(`refund read failed: ${readError.message}`);
  if (refund.execution_status === "REFUND_COMPLETED") throw new Error("already completed");

  const amount = Number(refund.amount);
  if (!(amount > 0)) throw new Error(`refusing to credit a non-positive refund: ${refund.amount}`);

  // Whose wallet. Taken from the order rather than from the caller — the admin
  // screen names a refund, never a customer, so there is no way for a mistyped
  // request to credit someone else's balance.
  const { data: order, error: orderError } = await db
    .from("orders")
    .select("id, address")
    .eq("id", refund.original_order_id)
    .single();
  if (orderError) throw new Error(`order read failed: ${orderError.message}`);

  const address = (order.address ?? {}) as { phone?: string; altPhone?: string; email?: string };
  const identity = await getOrCreateCustomer(db, [
    { kind: "phone", value: address.phone },
    { kind: "phone", value: address.altPhone },
    { kind: "email", value: address.email },
  ]);
  if (!identity) throw new Error("order has no phone or email — cannot credit a wallet");

  const { alreadyExisted } = await creditWallet(db, {
    customerId: identity.customerId,
    amount,
    kind: "refund_credit",
    refundId,
    orderId: order.id,
    note: `refund for order ${order.id}`,
  });

  const { data: updated, error } = await db.from("refunds").update({
    execution_status: "REFUND_COMPLETED",
    processed_at: new Date().toISOString(),
    // Still "manual" in the sense that Razorpay did not move the money, which is
    // what that flag has always meant here.
    manual_settlement: true,
    manual_settlement_evidence: `AJUKI Wallet credit of ₹${amount} issued to customer ${identity.customerId}`,
    settled_as: "wallet_credit",
    authorized_by: authorizedBy,
  }).eq("id", refundId).select("*").single();
  if (error) throw new Error(`wallet settlement failed: ${error.message}`);

  // The money has actually moved here too — same close as the Razorpay path
  // above. Missing until 22 Sep 2026: every COD refund (the majority — a COD
  // order has no payment to reverse, so it always settles this way) left its
  // "a refund is coming" promise open forever, flagging AJUKI710091 and
  // AJUKI710019 as broken promises days after their wallet credit landed.
  await fulfillOpenPromises(db, refund.original_order_id, "refund", "wallet_credit", refundId);

  return { refund: updated as Refund, amount, alreadyCredited: alreadyExisted, customerId: identity.customerId };
}

/**
 * The webhook's own transition — the authoritative one (Invariant 1). Looked
 * up by provider_refund_id, which only exists once executeRefund has run, so
 * an event for a refund this system didn't initiate is logged and ignored
 * rather than guessed at.
 */
export async function confirmRefund(
  db: SupabaseClient,
  providerRefundId: string,
  outcome: "completed" | "failed",
  providerStatus?: string,
  acquirerRrn?: string | null,
): Promise<Refund | null> {
  const { data: refund, error: readError } = await db.from("refunds").select("*").eq("provider_refund_id", providerRefundId).maybeSingle();
  if (readError) throw new Error(`refund read failed: ${readError.message}`);
  if (!refund) return null;
  const row = refund as Refund;

  // Idempotent: a webhook delivered twice for the same event must not
  // double-stamp processed_at or move a completed refund back out of it.
  // REFUND_MANUAL_REVIEW is not terminal — a second failure delivery just
  // rewrites the same outcome, which is harmless.
  if (row.execution_status === "REFUND_COMPLETED") return row;

  const patch = outcome === "completed"
    ? { execution_status: "REFUND_COMPLETED" as const, processed_at: new Date().toISOString(), provider_status: providerStatus ?? "processed" }
    : { execution_status: "REFUND_MANUAL_REVIEW" as const, failed_at: new Date().toISOString(), failure_reason: "Razorpay refund.failed webhook", provider_status: providerStatus ?? "failed" };

  const { data: updated, error } = await db.from("refunds").update(patch).eq("id", row.id).select("*").single();
  if (error) throw new Error(`refund confirmation failed: ${error.message}`);

  // The bank reference (RRN/ARN) — what a customer's bank needs to trace a
  // refund. Best-effort and separate from the status write above: the column
  // ships after this code, Razorpay can take hours to attach it, and it must
  // never hold up marking the refund complete. Only fills a blank.
  if (outcome === "completed" && acquirerRrn) {
    const { error: rrnErr } = await db.from("refunds")
      .update({ acquirer_rrn: acquirerRrn }).eq("id", row.id).is("acquirer_rrn", null);
    if (rrnErr) console.warn(`[refunds] acquirer_rrn write skipped: ${rrnErr.message}`);
  }

  // The money has actually moved — close the "a refund is coming" promise.
  if (outcome === "completed") {
    await fulfillOpenPromises(db, row.original_order_id, "refund", "webhook:refund.processed", providerRefundId);
  }

  return updated as Refund;
}
