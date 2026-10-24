// How much credit may come off a cart.
//
// Worth testing rather than eyeballing because every failure here is money.
// Too much and the order is created for less than it should be, with a Razorpay
// amount that no longer matches the goods; too little and a customer is quietly
// denied credit they are owed and will, reasonably, come and ask about it.
//
// The browser is the caller. It says "use my credit" and nothing more — the
// figure is always recomputed here, so this function is a trust boundary and not
// a display helper.

import { creditApplicable, MIN_PAYABLE_AFTER_CREDIT } from "./wallet";

let passed = 0;
let failed = 0;

function eq(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── The ordinary case ─────────────────────────────────────────────────────────
eq("credit smaller than the cart is spent in full", creditApplicable(300, 1000), 300);

// ── Never the whole amount ────────────────────────────────────────────────────
//
// A ₹0 Razorpay order is not a payment, it is a broken checkout — there is
// nothing for Magic Checkout to charge. The customer keeps the remainder, which
// is how a wallet is supposed to behave anyway.
eq("credit equal to the cart leaves something payable", creditApplicable(1000, 1000), 1000 - MIN_PAYABLE_AFTER_CREDIT);
eq("credit larger than the cart is capped", creditApplicable(5000, 799), 799 - MIN_PAYABLE_AFTER_CREDIT);

// ── Degenerate inputs must never produce a discount ───────────────────────────
//
// Each of these is a real shape: an empty cart mid-render, a customer with no
// wallet, and a negative balance that could only come from a hand-written row.
// None of them may return something a caller would subtract from a total.
eq("no balance, no credit", creditApplicable(0, 1000), 0);
eq("empty cart, no credit", creditApplicable(500, 0), 0);
eq("negative balance never becomes a discount", creditApplicable(-500, 1000), 0);
eq("negative cart never becomes a discount", creditApplicable(500, -1000), 0);

// A cart worth exactly the floor has nothing to give away: taking any credit at
// all would push the payable amount to zero.
eq("a cart at the floor yields nothing", creditApplicable(500, MIN_PAYABLE_AFTER_CREDIT), 0);

// ── Whole rupees only ─────────────────────────────────────────────────────────
//
// Razorpay works in paise and the cart displays rupees. Rounding a discount UP
// to the nearest rupee would spend credit the customer does not have, so the
// floor is deliberate and the customer keeps the fraction.
eq("a fractional balance rounds down", creditApplicable(300.99, 1000), 300);
eq("a fractional cart rounds down", creditApplicable(1000, 499.5), Math.floor(499.5 - MIN_PAYABLE_AFTER_CREDIT));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
