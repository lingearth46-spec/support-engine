// How much a return is actually worth, and where the money goes.
//
// Before this existed, every return quoted `order.total` — the approval
// WhatsApp, the admin copy and every return email alike. That figure is wrong
// in three separate ways at once:
//
//   * it includes shipping, the COD handling fee and gift wrapping, which are
//     services already delivered, not goods coming back;
//   * it ignores which items are being returned, so someone sending back one
//     bracelet from a three-item order was promised the whole order;
//   * it ignores the discount, so a customer who paid ₹499 for a ₹799 piece
//     under a coupon would be refunded ₹799.
//
// This file is the one place that answers "how much", so every message and the
// refund row itself agree. It is deliberately pure — no database, no model —
// because a number that decides money should be testable without either.

import { deriveOfferDiscount } from "@/lib/orderOffers";

export interface SettlementItem {
  price: number;
  quantity: number;
}

export interface SettlementOrder {
  items: SettlementItem[] | null | undefined;
  subtotal?: number | null;
  /** Codes and credits taken off AFTER the automatic offers (convention: lib/orderOffers.ts). */
  discount?: number | null;
  /** What the automatic offers (B1G1 and friends) took off. Absent or 0 on an order not yet backfilled; see offersOn() below. */
  offer_discount?: number | null;
  shipping?: number | null;
  cod_fee?: number | null;
  gift_wrap?: boolean | null;
  total?: number | null;
  payment_id?: string | null;
}

/**
 * What the automatic offers took off this order.
 *
 * The recorded `offer_discount` when there is one. For an order that predates the column, the offer is what the money shows: list value
 * plus shipping and fees, less the recorded discount, less what was charged.
 *
 * Deliberately NOT read off the gap between list value and `subtotal`. The webhook used to subtract the express fee from the subtotal, so
 * on those orders the gap is the fee, not an offer, and treating it as one would refund the customer 35 too little (order AJUKI710055).
 * Fees that are not on the object count as zero, which can only make the derived offer SMALLER, never larger: an order whose fee fields
 * are missing therefore errs towards refunding a little more, not less.
 */
export function offersOn(order: SettlementOrder, basket: number): number {
  const recorded = Math.max(0, Number(order.offer_discount) || 0);
  if (recorded > 0) return Math.min(recorded, basket);
  const total = Number(order.total) || 0;
  if (total <= 0) return 0;
  return Math.min(basket, deriveOfferDiscount({
    items: order.items, discount: order.discount, shipping: order.shipping, cod_fee: order.cod_fee, gift_wrap: order.gift_wrap, total,
  }));
}

/**
 * The refund for the returned items, in whole rupees.
 *
 * Prorates the order's discount across the goods by value: a coupon took money
 * off the whole basket, so each item carries its share of it back out. The
 * alternative — refunding list price — pays out more than was ever taken.
 *
 * `itemIndexes` absent or empty means the whole order came back, which is what
 * the older signed-in form sent and what a return raised before item selection
 * existed means.
 *
 * Never more than the order total. A rounding quirk or a discount recorded
 * against the wrong field must not be able to refund more than was paid.
 */
export function returnedGoodsAmount(order: SettlementOrder, itemIndexes?: number[] | null): number {
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) return 0;

  const lineValue = (i: SettlementItem) => Math.max(0, Number(i.price) || 0) * Math.max(0, Math.floor(Number(i.quantity) || 0));
  const basket = items.reduce((sum, i) => sum + lineValue(i), 0);
  if (basket <= 0) return 0;

  const chosen = itemIndexes?.length
    ? [...new Set(itemIndexes)].filter((n) => Number.isInteger(n) && n >= 0 && n < items.length)
    : items.map((_, n) => n);
  const returned = chosen.reduce((sum, n) => sum + lineValue(items[n]), 0);
  if (returned <= 0) return 0;

  // What was actually paid for goods: the basket less whatever discount applied
  // to it. Clamped, because a discount larger than the basket would otherwise
  // produce a negative refund.
  const offers = offersOn(order, basket);
  const discount = Math.min(Math.max(0, Number(order.discount) || 0), basket - offers);
  const paidForGoods = basket - offers - discount;

  const refund = Math.floor(paidForGoods * (returned / basket));
  const ceiling = Math.max(0, Number(order.total) || 0);
  return Math.max(0, ceiling > 0 ? Math.min(refund, ceiling) : refund);
}

/**
 * Where a return's money goes back to.
 *
 * A Razorpay payment id means there is a card or UPI transaction to reverse. A
 * COD order carries the literal "COD" (see app/api/orders/save — keying on it
 * would fold the whole COD book into one order), so there is nothing to reverse
 * and the refund becomes AJUKI Wallet credit instead.
 */
export function refundDestination(order: SettlementOrder): "original_method" | "wallet_credit" {
  return typeof order.payment_id === "string" && order.payment_id.startsWith("pay_")
    ? "original_method"
    : "wallet_credit";
}
