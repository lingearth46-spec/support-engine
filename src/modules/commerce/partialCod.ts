// Partial COD: part of the order paid online, the rest collected at the door.
//
// Razorpay's native-merchant document defines this by a *combination* of
// statuses rather than a field, which is the whole reason this module exists —
// the rule is easy to get subtly wrong and expensive when it is:
//
//   order.status                  === "attempted"
//   the prepaid payment.status    === "captured"
//
// `attempted` is the trap. Everywhere else in this codebase an attempted order
// is an abandoned cart (see lib/razorpayCarts.ts), because until now it meant
// "they opened checkout and did not pay". With partial COD it can also mean
// "they paid part of it and the balance is due on delivery" — a purchase.
// Telling those two apart is what stops a customer being sent a 20%-off
// win-back four hours after they bought.
//
// The order stays in `attempted` permanently: per the document, creating the
// COD payment for the balance does not move it. So this is not a transient
// state to wait out; it is what a completed partial COD order looks like
// forever.

// The fee itself, and which regions carry it, live in lib/codFee.ts. What
// matters here is only that it sits OUTSIDE `order.amount` — Razorpay's worked
// example is an order of 950 with a fee of 20, of which 200 was prepaid,
// leaving 770 to collect rather than 750. Deriving the balance as
// `total - paid` silently drops the fee and shorts every collection, which is
// why `cod_due` is stored rather than computed downstream.
import { COD_FEE } from "@policy/codFee";

export { COD_FEE };

export type RazorpayOrderLike = {
  status?: string | null;
  amount?: number | null;       // paise
  amount_paid?: number | null;  // paise
  amount_due?: number | null;   // paise
};

export type RazorpayPaymentLike = {
  status?: string | null;
  amount?: number | null;       // paise
  method?: string | null;
};

/** Paise to rupees, rounded — every figure we store and quote is in rupees. */
const toRupees = (paise: number | null | undefined): number =>
  Math.round((Number(paise) || 0) / 100);

/**
 * Is this a partial COD order?
 *
 * Both halves are required. `attempted` alone is an abandoned cart — 31 of
 * them in one week, every one with nothing paid. A captured payment alone is an
 * ordinary prepaid order. Only together do they mean a part-paid purchase.
 *
 * The payment argument is optional because the order's own `amount_paid` is
 * sufficient evidence when we have not fetched the payment: money captured
 * against an attempted order can only have come from a partial payment.
 */
export function isPartialCod(
  order: RazorpayOrderLike | null | undefined,
  payment?: RazorpayPaymentLike | null,
): boolean {
  if (!order) return false;

  // Detected on the money, not the status.
  //
  // Razorpay's document says the order "will remain in the 'attempted' state",
  // and a live part-paid order proved otherwise: order_TLjEHSAGsZ7M5S read
  // `attempted` until a COD payment was raised against it, then flipped to
  // `placed` — while still holding ₹49 captured and ₹750 due. Gating on the
  // documented status made that order read as an ordinary one, and an ordinary
  // COD order tells the courier to collect `total`. On a ₹349 advance that is
  // ₹349 demanded a second time, from a customer who has the receipt.
  //
  // Money captured with money still owed is the definition and cannot be
  // anything else: a fully paid order has no `amount_due`, an untouched COD
  // order has no `amount_paid`. It holds whatever Razorpay calls the status.
  const paid = Number(order.amount_paid) || 0;
  const due = order.amount_due != null
    ? Number(order.amount_due) || 0
    : Math.max(0, (Number(order.amount) || 0) - paid);

  if (paid <= 0 || due <= 0) return false;

  // When the payment is to hand it must be a real capture. Anything else —
  // failed, refunded, pending — is not money we hold.
  return payment ? String(payment.status ?? "") === "captured" : true;
}

export type PartialSplit = {
  /** Captured online, in rupees. */
  paidOnline: number;
  /** What the rider collects, in rupees, including the COD fee. */
  codDue: number;
  /** The COD fee applied, in rupees. Broken out so a slip can show it. */
  codFee: number;
};

/**
 * What was paid and what is still owed.
 *
 * `amount_due + cod fee`, exactly as the document specifies. Taken from
 * Razorpay's own figures rather than recomputed from our cart: they are the
 * authority on what was actually captured, and a coupon or shipping line we
 * rounded differently would otherwise put the rider's collection out by rupees.
 */
// Pass `codFee` explicitly. The default is the standard fee, but the fee is
// regional — most addresses carry none — so a caller that omits it will
// over-collect by ₹49 outside West Bengal, Punjab and Odisha. Both production
// callers read the real figure off `order.cod_fee`, which is what Razorpay
// actually charged.
export function partialSplit(order: RazorpayOrderLike, codFee = COD_FEE): PartialSplit {
  const paidOnline = toRupees(order.amount_paid);
  // amount_due is what Razorpay says is left. Falling back to amount - paid
  // covers a payload that omits it, but their order object always carries it.
  const due = order.amount_due != null
    ? toRupees(order.amount_due)
    : Math.max(0, toRupees(order.amount) - paidOnline);

  return { paidOnline, codDue: due + codFee, codFee };
}

/**
 * What the courier must be told to collect.
 *
 * One function for all three integrations, because each of them had its own
 * copy of `isCOD ? order.total : 0` and every one of them would have demanded
 * the full amount from a customer who had already paid part of it.
 *
 * `cod_due` is authoritative when present. It is null on every order that
 * predates partial COD, and on those the old rule is still exactly right.
 */
export function codAmountFor(order: {
  payment_id?: string | null;
  total?: number | null;
  cod_due?: number | null;
}): number {
  if (order.cod_due != null) return Math.round(Number(order.cod_due));
  return order.payment_id === "COD" ? Math.round(Number(order.total) || 0) : 0;
}

/** True when money was taken online and more is owed at the door. */
export function isPartiallyPaid(order: {
  amount_paid_online?: number | null;
  cod_due?: number | null;
}): boolean {
  return (Number(order.amount_paid_online) || 0) > 0 && (Number(order.cod_due) || 0) > 0;
}

/**
 * Whether the rest of the app treats a partial-COD order as a COD order —
 * couriers get told to collect cash, admin dashboards count it under COD,
 * cancellation refunds only return the online portion, and so on.
 *
 * One switch rather than sprinkling this decision through every call site.
 * The detection itself (`isPartiallyPaid`) is pure live data — nothing here
 * is guessed — so the only thing that should ever need reverting in a hurry
 * is the classification, not the underlying read. Flip to false to fall back
 * to the pre-partial-COD behaviour everywhere at once: e.g. if Razorpay's
 * Partial COD gets disabled account-side and stops producing new orders like
 * this, or if this rule needs to be backed out temporarily while something
 * downstream is investigated.
 */
export const TREAT_PARTIAL_COD_AS_COD = true;

/**
 * Is this a cash-collection order — legacy full COD, or (while the switch
 * above is on) a partial-COD order with a real balance still due at the door?
 *
 * Use this, not a raw `payment_id === "COD"` check, anywhere money, risk, or
 * courier instructions are decided. A partial-COD order's `payment_id` is a
 * genuine Razorpay payment id, not the literal string "COD" — so the old
 * check silently reads it as fully prepaid even though cash is still owed.
 */
export function isCodOrder(order: {
  payment_id?: string | null;
  amount_paid_online?: number | null;
  cod_due?: number | null;
}): boolean {
  if (order.payment_id === "COD") return true;
  return TREAT_PARTIAL_COD_AS_COD && isPartiallyPaid(order);
}

/**
 * How much of this order's value came in online versus is cash collected at
 * the door. All-or-nothing for an ordinary order; split for a partial-COD
 * one — the advance already in the account, and the rest still owed as cash.
 * Always sums to `order.total`. Deliberately not `cod_due` for the cash side:
 * `cod_due` includes the courier handling fee, which is money collected for
 * the courier, not revenue on the sale.
 */
export function revenueSplit(order: {
  payment_id?: string | null;
  total?: number | null;
  amount_paid_online?: number | null;
  cod_due?: number | null;
}): { online: number; cod: number } {
  const total = Number(order.total) || 0;
  if (TREAT_PARTIAL_COD_AS_COD && isPartiallyPaid(order)) {
    const online = Number(order.amount_paid_online) || 0;
    return { online, cod: Math.max(0, total - online) };
  }
  return order.payment_id === "COD" ? { online: 0, cod: total } : { online: total, cod: 0 };
}
