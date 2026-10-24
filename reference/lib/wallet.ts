// AJUKI Wallet — store credit, and the rules for spending it.
//
// One entry point per movement, the same discipline lib/supportCases.ts and
// lib/refunds.ts already follow: every rupee in or out is a row saying why, and
// the balance is derived from those rows rather than stored anywhere that could
// drift from them.
//
// WHERE CREDIT IS SPENT, AND WHY IT IS THE CART AND NOT CHECKOUT
//
// Magic Checkout cannot do this. Its promotions endpoints are the only hook
// into that modal, and neither one can be personalised:
//
//   * /api/razorpay/promotions/list is called by Razorpay with no customer
//     identity at all, so anything it returns is shown to every shopper. A
//     balance listed there would be one customer's money offered to all of them.
//   * /api/razorpay/promotions/apply receives a code and an order id, and again
//     no contact — so it cannot tell whether the person applying a credit owns
//     it.
//
// So credit is applied at the CART, where the customer is signed in and we know
// exactly who they are, and Magic Checkout is simply handed the reduced amount.
// That is the same shape gift wrap and Express already use: the cart decides the
// number, the modal charges it.
//
// THE TRUST BOUNDARY
//
// The browser says "use my credit". It does NOT say how much. Every amount in
// this file is recomputed server-side from the ledger at the moment the order is
// created, because a discount the client can name is a discount the client can
// invent.

import type { SupabaseClient } from "@supabase/supabase-js";

export type WalletKind = "refund_credit" | "goodwill" | "redemption" | "adjustment" | "expiry";

export interface WalletEntry {
  id: string;
  customer_id: string;
  amount: number;
  kind: WalletKind;
  order_id: string | null;
  refund_id: string | null;
  note: string | null;
  created_at: string;
  expires_at: string | null;
}

/**
 * What this customer can spend right now.
 *
 * Summed in code rather than in a database view because the expiry filter has
 * to agree exactly with what the cart displays, and two implementations of
 * "non-expired" is one more than this should ever have.
 *
 * Returns 0, never negative. A negative sum would mean more was spent than was
 * ever credited — impossible through this module, but if a hand-written row ever
 * produces one, offering the customer a negative discount would turn a bookkeeping
 * error into an overcharge.
 */
export async function walletBalance(db: SupabaseClient, customerId: string): Promise<number> {
  const { data, error } = await db
    .from("wallet_entries")
    .select("amount, expires_at")
    .eq("customer_id", customerId);
  if (error) throw new Error(`wallet balance read failed: ${error.message}`);

  const now = Date.now();
  const sum = (data ?? []).reduce((total, row) => {
    const expired = row.expires_at != null && Date.parse(row.expires_at) <= now;
    return expired ? total : total + Number(row.amount);
  }, 0);

  return Math.max(0, Math.round(sum * 100) / 100);
}

/**
 * How much credit may be put against a cart of this value.
 *
 * Credit pays for goods, not for delivery or COD handling: those are costs we
 * actually incur per parcel, and letting credit cover them turns a refund into
 * a second, smaller loss on every redemption.
 *
 * Also never the entire amount on a prepaid order — a ₹0 Razorpay order is not
 * a payment, it is a broken checkout, and Magic Checkout has nothing to charge.
 * A customer with more credit than cart keeps the remainder for next time, which
 * is the normal behaviour of a wallet anyway.
 */
export const MIN_PAYABLE_AFTER_CREDIT = 1;

export function creditApplicable(balance: number, goodsTotal: number): number {
  const spendable = Math.min(Math.max(0, balance), Math.max(0, goodsTotal) - MIN_PAYABLE_AFTER_CREDIT);
  return spendable > 0 ? Math.floor(spendable) : 0;
}

/**
 * Put credit into a wallet.
 *
 * `refundId` is what makes this safe to call from a retried webhook or a
 * double-clicked approve button: the unique index on (refund_id) where
 * kind = 'refund_credit' rejects the second write, and that rejection is
 * reported as success — the credit exists, which is what the caller wanted.
 */
export async function creditWallet(
  db: SupabaseClient,
  args: {
    customerId: string;
    amount: number;
    kind: Extract<WalletKind, "refund_credit" | "goodwill" | "adjustment">;
    refundId?: string | null;
    orderId?: string | null;
    note?: string | null;
    expiresAt?: string | null;
  },
): Promise<{ credited: boolean; alreadyExisted: boolean }> {
  const amount = Math.round(Number(args.amount) * 100) / 100;
  if (!(amount > 0)) throw new Error(`refusing to credit a non-positive amount: ${args.amount}`);

  const { error } = await db.from("wallet_entries").insert({
    customer_id: args.customerId,
    amount,
    kind: args.kind,
    refund_id: args.refundId ?? null,
    order_id: args.orderId ?? null,
    note: args.note ?? null,
    expires_at: args.expiresAt ?? null,
  });

  if (error) {
    // 23505 = the credit for this refund is already on the ledger. That is the
    // desired end state, so it is not an error to the caller.
    if (error.code === "23505") return { credited: false, alreadyExisted: true };
    throw new Error(`wallet credit failed: ${error.message}`);
  }
  return { credited: true, alreadyExisted: false };
}

/**
 * Manually remove credit — correcting an over-issued goodwill credit, or
 * reversing one given by mistake. `kind` is always "adjustment": a debit
 * tied to an actual order spend goes through redeemCredit instead, and a
 * refund reversal is its own concern this function does not touch.
 *
 * Re-reads the balance and clamps to it, the same way redeemCredit does —
 * walletBalance already floors the number it shows at zero, but that clamp
 * happens at read time; without clamping here too, the raw ledger sum
 * itself could go negative, which is not a state anyone reading the ledger
 * directly should have to explain.
 *
 * Returns what was ACTUALLY debited, which the caller must report back —
 * it may be less than requested, including zero.
 */
export async function debitWallet(
  db: SupabaseClient,
  args: { customerId: string; amount: number; note: string; orderId?: string | null },
): Promise<number> {
  const balance = await walletBalance(db, args.customerId);
  const debit = Math.min(Math.floor(Math.max(0, args.amount)), Math.floor(balance));
  if (debit <= 0) return 0;

  const { error } = await db.from("wallet_entries").insert({
    customer_id: args.customerId,
    amount: -debit,
    kind: "adjustment",
    order_id: args.orderId ?? null,
    note: args.note,
  });
  if (error) throw new Error(`wallet debit failed: ${error.message}`);
  return debit;
}

/**
 * Spend credit on an order.
 *
 * Re-reads the balance inside this call and clamps to it. The caller has
 * usually just computed an amount from a cart a moment earlier, and between
 * those two moments the same customer may have spent the credit in another tab
 * — so the number the caller passes is a request, not an instruction.
 *
 * Returns what was ACTUALLY debited, which the caller must use when building
 * the payable amount. Trusting the requested figure instead is how an order gets
 * created for less money than the wallet could cover.
 */
export async function redeemCredit(
  db: SupabaseClient,
  args: { customerId: string; orderId: string; requested: number; note?: string | null },
): Promise<number> {
  const balance = await walletBalance(db, args.customerId);
  const debit = Math.min(Math.floor(Math.max(0, args.requested)), Math.floor(balance));
  if (debit <= 0) return 0;

  const { error } = await db.from("wallet_entries").insert({
    customer_id: args.customerId,
    amount: -debit,
    kind: "redemption",
    order_id: args.orderId,
    note: args.note ?? null,
  });

  if (error) {
    // 23505 = this order already has a redemption. A retried checkout or a
    // replayed webhook must not charge the wallet twice, so report what the
    // existing row actually took rather than debiting again.
    if (error.code === "23505") return await redemptionForOrder(db, args.orderId);
    throw new Error(`wallet redemption failed: ${error.message}`);
  }
  return debit;
}

/** What this order has already taken from the wallet, as a positive number. */
export async function redemptionForOrder(db: SupabaseClient, orderId: string): Promise<number> {
  const { data, error } = await db
    .from("wallet_entries")
    .select("amount")
    .eq("order_id", orderId)
    .eq("kind", "redemption")
    .maybeSingle();
  if (error) throw new Error(`wallet redemption read failed: ${error.message}`);
  return data ? Math.abs(Number(data.amount)) : 0;
}

/**
 * Give the credit back when an order that spent it is cancelled or returned.
 *
 * DELIBERATELY NOT CALLED by anything (founder's decision, 18 Oct 2026): credit spent on an
 * order that is then cancelled, or comes back undelivered, is NOT returned, and COD stays
 * available when credit is used. Written and tested earlier, before that was decided; it is
 * left here so that reversing the decision is a matter of calling it, not rebuilding it. Until
 * then, nothing should promise a customer their credit back (support included).
 *
 * A positive 'adjustment' rather than deleting the redemption: the customer did
 * spend it, and then the spend was undone. Both facts belong on the ledger, and
 * a statement that silently loses a row is a statement nobody can audit.
 */
export async function refundRedemption(
  db: SupabaseClient,
  args: { customerId: string; orderId: string; note?: string | null },
): Promise<number> {
  const spent = await redemptionForOrder(db, args.orderId);
  if (spent <= 0) return 0;

  const { error } = await db.from("wallet_entries").insert({
    customer_id: args.customerId,
    amount: spent,
    kind: "adjustment",
    order_id: args.orderId,
    note: args.note ?? `credit returned — order ${args.orderId} did not complete`,
  });
  if (error) throw new Error(`wallet restore failed: ${error.message}`);
  return spent;
}

/** The statement a customer or a founder reads. Newest first. */
export async function walletHistory(db: SupabaseClient, customerId: string, limit = 50): Promise<WalletEntry[]> {
  const { data, error } = await db
    .from("wallet_entries")
    .select("*")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`wallet history read failed: ${error.message}`);
  return (data ?? []) as WalletEntry[];
}
