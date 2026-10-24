// Partial COD arithmetic and detection.
//
// Two failures are worth guarding above all others, and both cost money in the
// real world rather than merely looking wrong:
//
//   1. Reading a part-paid purchase as an abandoned cart, which sends a
//      20%-off win-back to someone who has just bought.
//   2. Telling the courier to collect the full total from a customer who has
//      already paid part of it.
//
// Razorpay's own worked example is used as the reference case: order 950,
// COD fee 20, 200 prepaid, 770 to collect.
//
// Run with `npm run test:partialcod`.

import {
  isPartialCod, partialSplit, codAmountFor, isPartiallyPaid, COD_FEE,
} from "@commerce/partialCod";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  good ? pass++ : fail++;
  if (!good) console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};
const ok = (name: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  if (!cond) console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── detection ──
{
  // The reference case: money captured, money still owed. `amount` is included
  // because every real order has one — without it there is no balance to speak
  // of, and "partly paid" is meaningless.
  ok("attempted with money paid is partial",
    isPartialCod({ status: "attempted", amount: 39900, amount_paid: 9900, amount_due: 30000 }));
  ok("attempted + captured payment is partial",
    isPartialCod({ status: "attempted", amount: 39900, amount_paid: 9900, amount_due: 30000 }, { status: "captured" }));

  // Taken from order_TLjEHSAGsZ7M5S, a real part-paid order: ₹49 captured, ₹750
  // owed — and status `placed`, not the `attempted` Razorpay's document promises
  // it would "remain" in. Gating on the documented status read this as ordinary
  // COD and would have had the courier collect the full ₹799 from someone who
  // had already paid ₹49 of it.
  ok("placed with money paid is still partial",
    isPartialCod({ status: "placed", amount: 79900, amount_paid: 4900, amount_due: 75000 }));
  ok("paid-in-full is not partial, whatever the status",
    !isPartialCod({ status: "placed", amount: 79900, amount_paid: 79900, amount_due: 0 }));
  ok("due derived from amount when amount_due is absent",
    isPartialCod({ status: "placed", amount: 79900, amount_paid: 4900 }));

  // The expensive false positive: a genuinely abandoned cart.
  ok("attempted with nothing paid is NOT partial",
    !isPartialCod({ status: "attempted", amount_paid: 0 }),
    "this is an abandoned cart, and calling it a purchase silences the win-back");
  ok("attempted with a failed payment is NOT partial",
    !isPartialCod({ status: "attempted", amount_paid: 0 }, { status: "failed" }));

  // Ordinary orders must never be read as partial.
  ok("paid is not partial", !isPartialCod({ status: "paid", amount_paid: 39900 }));
  ok("placed (ordinary COD) is not partial", !isPartialCod({ status: "placed", amount_paid: 0 }));
  ok("created is not partial", !isPartialCod({ status: "created", amount_paid: 0 }));
  ok("null order is not partial", !isPartialCod(null));
  ok("missing status is not partial", !isPartialCod({ amount_paid: 9900 }));
}

// ── the arithmetic, against Razorpay's own example ──
{
  // order 950, paid 200, due 750, fee 20 -> collect 770
  const s = partialSplit({ status: "attempted", amount: 95000, amount_paid: 20000, amount_due: 75000 }, 20);
  eq("paid online", s.paidOnline, 200);
  eq("collect at the door", s.codDue, 770);
  eq("fee broken out", s.codFee, 20);
  ok("the fee is NOT dropped", s.codDue !== 750,
    "total - paid = 750 silently loses the fee and shorts every collection");
}

// ── our own numbers, at the real fee ──
{
  eq("our COD fee", COD_FEE, 49);
  // A 399 order with 99 taken online: 300 left + 49 fee = 349.
  const s = partialSplit({ status: "attempted", amount: 39900, amount_paid: 9900, amount_due: 30000 });
  eq("399 order, 99 prepaid", [s.paidOnline, s.codDue], [99, 349]);
}
{
  // amount_due absent: fall back to amount - paid, still adding the fee.
  const s = partialSplit({ status: "attempted", amount: 39900, amount_paid: 9900 });
  eq("derives due when absent", s.codDue, 349);
}
{
  // Paid in full but still 'attempted' — nothing left but the fee should not
  // be invented on a zero balance.
  const s = partialSplit({ status: "attempted", amount: 39900, amount_paid: 39900, amount_due: 0 });
  eq("nothing left to collect but the fee", s.codDue, 49);
}

// ── what the courier is told ──
{
  // The bug this replaces: every courier sent `total` on any COD order.
  eq("partial order: collect the balance, not the total",
    codAmountFor({ payment_id: "COD", total: 399, cod_due: 349 }), 349);
  eq("ordinary COD: collect the total",
    codAmountFor({ payment_id: "COD", total: 399, cod_due: null }), 399);
  eq("prepaid: collect nothing",
    codAmountFor({ payment_id: "pay_abc", total: 399, cod_due: null }), 0);
  // A prepaid order that somehow carries cod_due must still honour it: the
  // column is the authority, and this is the shape a partial order has.
  eq("cod_due wins over payment_id",
    codAmountFor({ payment_id: "pay_abc", total: 399, cod_due: 349 }), 349);
  eq("legacy order with no columns", codAmountFor({ payment_id: "COD", total: 299 }), 299);
  eq("zero cod_due collects nothing", codAmountFor({ payment_id: "COD", total: 399, cod_due: 0 }), 0);
}

// ── the flag the panel and packing slip read ──
{
  ok("part-paid", isPartiallyPaid({ amount_paid_online: 99, cod_due: 349 }));
  ok("ordinary COD is not part-paid", !isPartiallyPaid({ amount_paid_online: null, cod_due: null }));
  ok("fully prepaid is not part-paid", !isPartiallyPaid({ amount_paid_online: 399, cod_due: 0 }));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
