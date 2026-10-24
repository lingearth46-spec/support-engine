// The refund a return is worth.
//
// Worth testing rather than eyeballing because every error here is money in one
// direction or the other, and the previous answer — `order.total` — was wrong in
// three ways at once: it refunded shipping and fees, ignored which items came
// back, and ignored the discount.

import { returnedGoodsAmount, refundDestination } from "@commerce/returnSettlement";

let passed = 0;
let failed = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) passed++;
  else { failed++; console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// Three items, ₹1,500 of goods, ₹80 shipping, ₹49 COD fee.
const threeItems = {
  items: [{ price: 499, quantity: 1 }, { price: 599, quantity: 1 }, { price: 402, quantity: 1 }],
  subtotal: 1500, discount: 0, total: 1629,
};

// ── Only the goods ────────────────────────────────────────────────────────────
eq("whole order refunds goods, not shipping or fees", returnedGoodsAmount(threeItems), 1500);
eq("no indexes means the whole order", returnedGoodsAmount(threeItems, []), 1500);

// ── Only what came back ───────────────────────────────────────────────────────
eq("one of three refunds that one", returnedGoodsAmount(threeItems, [1]), 599);
eq("two of three", returnedGoodsAmount(threeItems, [0, 2]), 901);

// ── The discount comes back out ───────────────────────────────────────────────
//
// ₹300 off a ₹1,000 basket: the customer paid ₹700 for goods. Returning half
// the basket by value returns half of what they paid, not half of list price.
const discounted = {
  items: [{ price: 600, quantity: 1 }, { price: 400, quantity: 1 }],
  subtotal: 1000, discount: 300, total: 700,
};
eq("discount prorated by value", returnedGoodsAmount(discounted, [0]), 420);
eq("the whole discounted order refunds what was paid", returnedGoodsAmount(discounted), 700);

// BOGO: two of an item at ₹799, one free, recorded as a ₹799 discount.
const bogo = { items: [{ price: 799, quantity: 2 }], subtotal: 1598, discount: 799, total: 799 };
eq("a BOGO return refunds what was paid, not two list prices", returnedGoodsAmount(bogo), 799);

// ── It must never pay out more than was taken ─────────────────────────────────
eq("capped at the order total", returnedGoodsAmount({ items: [{ price: 999, quantity: 1 }], discount: 0, total: 500 }), 500);
eq("a discount larger than the basket refunds nothing", returnedGoodsAmount({ items: [{ price: 500, quantity: 1 }], discount: 900, total: 0 }), 0);

// ── The trust boundary ────────────────────────────────────────────────────────
//
// Indexes come from the browser. Out-of-range, negative, duplicated or
// fractional ones must not refund goods that were never bought, or the same
// item twice.
eq("an index past the end refunds nothing", returnedGoodsAmount(threeItems, [7]), 0);
eq("a negative index refunds nothing", returnedGoodsAmount(threeItems, [-1]), 0);
eq("a duplicated index is counted once", returnedGoodsAmount(threeItems, [1, 1, 1]), 599);
eq("a fractional index is ignored", returnedGoodsAmount(threeItems, [1.5]), 0);

// ── Degenerate orders ─────────────────────────────────────────────────────────
eq("no items, no refund", returnedGoodsAmount({ items: [] }), 0);
eq("null items, no refund", returnedGoodsAmount({ items: null }), 0);
eq("whole rupees, rounded down", returnedGoodsAmount({ items: [{ price: 333, quantity: 1 }, { price: 334, quantity: 1 }], discount: 100, total: 567 }, [0]), 283);

// ── Where the money goes ──────────────────────────────────────────────────────
eq("a Razorpay payment goes back to the card", refundDestination({ items: [], payment_id: "pay_ABC123" }), "original_method");
eq("COD becomes wallet credit", refundDestination({ items: [], payment_id: "COD" }), "wallet_credit");
eq("no payment id is treated as COD", refundDestination({ items: [], payment_id: null }), "wallet_credit");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
