// What we told a customer we would do — see supabase-migration-cx-promises.sql.
//
// Every function here degrades if the cx_promises table does not exist yet
// (migrations are by hand, code ships first): a write is a no-op, a read is an
// empty list. A promise insert must never break the return approval or the
// cancellation it hangs off — the same best-effort discipline openOrReuseCase
// and the refund-ledger writes already use.

import type { SupabaseClient } from "@supabase/supabase-js";

export type PromiseKind = "refund" | "replacement" | "pickup" | "callback" | "reship" | "other";

// Calendar days from promised_at until it counts as overdue. Approximate on
// purpose — this drives "should the founder have heard about this by now", not
// an SLA anyone quotes to a customer.
const DUE_DAYS: Record<PromiseKind, number> = {
  refund: 5,
  replacement: 5,
  reship: 5,
  pickup: 3,
  callback: 1,
  other: 3,
};

/** Postgres "relation does not exist" — the table has not been migrated yet. */
export function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  return err?.code === "42P01" || Boolean(err?.message && /relation .*cx_promises.* does not exist/i.test(err.message));
}

/** When a promise of this kind, made now, counts as overdue. */
export function promiseDueAt(kind: PromiseKind, from: Date = new Date()): Date {
  return new Date(from.getTime() + DUE_DAYS[kind] * 86_400_000);
}

interface RecordArgs {
  db: SupabaseClient;
  kind: PromiseKind;
  orderId?: string | null;
  customerId?: string | null;
  sourceCaseId?: string | null;
  channel?: "whatsapp" | "email" | "manual" | null;
  detail?: string | null;
  promisedBy?: "ai" | "founder" | "system";
  /** Override the computed due date (business-hours math lives elsewhere). */
  dueAt?: Date;
}

/**
 * Record a promise made to a customer. Best-effort: logs and returns on any
 * failure, including the table not existing yet.
 *
 * Deduped on (order_id, kind) while still open — telling a customer twice that
 * their refund is coming is one promise, not two.
 */
export async function recordPromise(args: RecordArgs): Promise<void> {
  const { db, kind } = args;
  try {
    if (args.orderId) {
      const { data: open, error: dupErr } = await db
        .from("cx_promises")
        .select("id")
        .eq("order_id", args.orderId)
        .eq("kind", kind)
        .is("fulfilled_at", null)
        .limit(1);
      if (dupErr) {
        if (isMissingTable(dupErr)) return;
        throw new Error(dupErr.message);
      }
      if (open && open.length) return;
    }

    const dueAt = args.dueAt ?? promiseDueAt(kind);
    const { error } = await db.from("cx_promises").insert({
      order_id: args.orderId ?? null,
      customer_id: args.customerId ?? null,
      source_case_id: args.sourceCaseId ?? null,
      channel: args.channel ?? null,
      kind,
      detail: args.detail ?? null,
      promised_by: args.promisedBy ?? "ai",
      due_at: dueAt.toISOString(),
    });
    if (error && !isMissingTable(error)) throw new Error(error.message);
  } catch (err) {
    console.error(JSON.stringify({
      event: "cx_promise_write_failed",
      kind, order_id: args.orderId ?? null,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * Close any open promise of this kind on this order.
 *
 * Called from the events that actually deliver: the Razorpay refund.processed
 * webhook, the manifest step for a replacement parcel. Best-effort.
 */
export async function fulfillOpenPromises(
  db: SupabaseClient,
  orderId: string,
  kind: PromiseKind,
  fulfilledBy: string,
  evidence?: string | null,
): Promise<void> {
  try {
    const { error } = await db
      .from("cx_promises")
      .update({
        fulfilled_at: new Date().toISOString(),
        fulfilled_by: fulfilledBy,
        evidence: evidence ?? null,
      })
      .eq("order_id", orderId)
      .eq("kind", kind)
      .is("fulfilled_at", null);
    if (error && !isMissingTable(error)) throw new Error(error.message);
  } catch (err) {
    console.error(JSON.stringify({
      event: "cx_promise_fulfil_failed",
      kind, order_id: orderId,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

export interface OpenPromise {
  id: string;
  order_id: string | null;
  kind: PromiseKind;
  detail: string | null;
  promised_at: string;
  due_at: string;
}

/**
 * Unfulfilled promises past their due date — the founder digest and morning nag
 * read exactly this. Empty list (not an error) when the table is absent, so the
 * briefing falls back to deriving the same thing from order/refund state.
 */
export async function openOverduePromises(db: SupabaseClient, now: Date = new Date()): Promise<OpenPromise[]> {
  const { data, error } = await db
    .from("cx_promises")
    .select("id, order_id, kind, detail, promised_at, due_at")
    .is("fulfilled_at", null)
    .lt("due_at", now.toISOString())
    .order("due_at", { ascending: true });
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`open-promise scan failed: ${error.message}`);
  }
  return (data ?? []) as OpenPromise[];
}
