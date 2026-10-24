// The guard that stands between a context-fed model and a customer.
//
// Run with `npx tsx lib/replyContext.test.ts`.
//
// The interesting cases are not "does it catch a made-up AWB" — it does. They
// are the false positives: a reply that copies a real number in a different
// shape and gets blocked reads, to the person pressing the button, as the
// feature being broken. Those are the tests that decide whether this is used.

import {
  extractFacts, normalizeDate, checkFacts, unbackedPromises, contradictions,
  orderLine, buildContextBlock, day, money, TRACK_URL,
  type ContextOrder,
} from "@engine/replyContext";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : (failed++, console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`));
};

// ── Formatting ──────────────────────────────────────────────────────────────

eq("day renders the one spelling the guard expects", day("2026-09-26T04:00:00Z"), "26 Sep 2026");
eq("day survives a null", day(null), null);
eq("day survives nonsense", day("not a date"), null);
eq("money drops the paise", money(699.4), "₹699");
eq("money keeps a zero out of the block", money(0), "₹0");
eq("money survives a null", money(null), null);

const ORDER: ContextOrder = {
  id: "AJUKI710055",
  status: "rto",
  items: [{ name: "Atlas Bracelet", color: "Silver", quantity: 1 }],
  total: 679,
  cod_due: 0,
  amount_paid_online: 679,
  courier_name: "Delhivery",
  awb_code: "60000000000008",
  tracking_url: "https://www.delhivery.com/track/package/60000000000008",
  estimated_delivery: "2026-09-26T00:00:00Z",
  created_at: "2026-09-14T00:00:00Z",
  attempt_count: 3,
  ndr_reason: "Customer not available",
  rto_reason: "3 failed attempts",
};

const line = orderLine(ORDER);
eq("the order line leads with the id", line.startsWith("Order AJUKI710055 · status: rto"), true);
eq("the order line carries the AWB", line.includes("AWB 60000000000008"), true);
eq("the order line says why it came back", line.includes("returned to us because: 3 failed attempts"), true);
eq("a zero COD is not mentioned", line.includes("COD due"), false);

// The courier's own page is branded as someone else, says "not found" for the
// first day after booking, and shows raw scan text that reads as alarming. Ours
// is the only tracking link a customer is given — and because the courier's is
// never put in front of the model, a courier link in a reply matches nothing
// and is refused by the guard rather than by a rule it has to remember.
eq("tracking points at our own page", line.includes(`track at ${TRACK_URL}`), true);
eq("and the courier's link is never shown to the model", line.includes("delhivery.com"), false);
eq(
  "so a courier tracking link in a reply is caught as invented",
  checkFacts("Track it at https://www.delhivery.com/track/package/60000000000008", [line]).invented.length,
  1,
);
eq(
  "while ours passes",
  checkFacts(`Track it at ${TRACK_URL}`, [line]).ok,
  true,
);
eq(
  "an order with no AWB offers no tracking link at all",
  orderLine({ id: "AJUKI710009", status: "confirmed" }).includes("track at"),
  false,
);

eq(
  "no orders says so rather than leaving a gap",
  buildContextBlock({ customerLabel: "a@b.com", orders: [], cases: [], knowledge: [] })
    .includes("No orders found for this address. Do not guess at one."),
  true,
);
eq(
  "an open case tells the model not to treat it as new",
  buildContextBlock({
    customerLabel: "a@b.com", orders: [], knowledge: [],
    cases: [{ tag: "return", created_at: "2026-09-20T00:00:00Z", escalate_reason: "wants a refund" }],
  }).includes("Do not treat it as new."),
  true,
);

// ── Dates ───────────────────────────────────────────────────────────────────

eq("26 Sep", normalizeDate("26 Sep"), "09-26");
eq("26 September, spelled out", normalizeDate("26 September"), "09-26");
eq("Sep 26, the other way round", normalizeDate("Sep 26"), "09-26");
eq("26/09/2026, day first as India writes it", normalizeDate("26/09/2026"), "09-26");
eq("26-09", normalizeDate("26-09"), "09-26");
eq("a single-digit day still pads", normalizeDate("6 Sep"), "09-06");

// ── Extraction ──────────────────────────────────────────────────────────────

eq("an order id is found", extractFacts("about #AJUKI710055 thanks").orderIds, ["AJUKI710055"]);
eq("a spaced order id normalises", extractFacts("order AJUKI 710055").orderIds, ["AJUKI710055"]);
eq("lowercase still counts", extractFacts("ajuki710055").orderIds, ["AJUKI710055"]);

eq("an AWB is found", extractFacts("AWB 60000000000008").awbs, ["60000000000008"]);
eq("a spaced AWB normalises", extractFacts("AWB 6000 0000 000008").awbs, ["60000000000008"]);
eq("a dashed AWB normalises", extractFacts("AWB 60000000-000008").awbs, ["60000000000008"]);

eq("rupees are found", extractFacts("we sent ₹699").amounts, ["699"]);
eq("Rs. is the same amount", extractFacts("we sent Rs. 699").amounts, ["699"]);
eq("paise are dropped", extractFacts("₹699.00").amounts, ["699"]);
eq("a comma is dropped", extractFacts("₹1,299").amounts, ["1299"]);
eq("a bare number is not money", extractFacts("699 bracelets").amounts, []);

eq(
  "a link is found and lowercased",
  extractFacts("track at https://Delhivery.com/track/123456789012").urls,
  ["https://delhivery.com/track/123456789012"],
);
eq(
  "trailing punctuation is not part of the link",
  extractFacts("see https://ajuki.in/orders.").urls,
  ["https://ajuki.in/orders"],
);

eq("a mobile is found", extractFacts("call 9876543210").phones, ["9876543210"]);
eq("+91 is stripped", extractFacts("call +91 9876543210").phones, ["9876543210"]);

// ── The guard, on the cases that matter ─────────────────────────────────────

const CONTEXT = [orderLine(ORDER)];

eq(
  "a reply that copies the real AWB passes",
  checkFacts("Your parcel is with Delhivery under AWB 60000000000008.", CONTEXT).ok,
  true,
);
eq(
  "the same AWB written with spaces still passes",
  checkFacts("Your AWB is 6000 0000 000008.", CONTEXT).ok,
  true,
);
eq(
  "one digit wrong is caught",
  checkFacts("Your AWB is 60000000000009.", CONTEXT).invented,
  [{ kind: "awb", value: "60000000000009" }],
);
eq(
  "an order id nobody mentioned is caught",
  checkFacts("About order AJUKI710092.", CONTEXT).invented,
  [{ kind: "order", value: "AJUKI710092" }],
);
eq(
  "a made-up amount is caught",
  checkFacts("We will send ₹1500 back.", CONTEXT).invented,
  [{ kind: "amount", value: "1500" }],
);
eq(
  "the real total passes however it is written",
  checkFacts("Your order came to Rs 679.", CONTEXT).ok,
  true,
);
eq(
  "a tracking link that was never given is caught",
  checkFacts("Track at https://fake-courier.com/x", CONTEXT).invented,
  [{ kind: "link", value: "https://fake-courier.com/x" }],
);

// The agent's own draft counts as a source. If the founder typed the number,
// the founder owns it — the guard is there to catch the model, not the human.
eq(
  "a number the agent typed is allowed through",
  checkFacts("Your refund of ₹1500 is on the way.", [...CONTEXT, "we are sending 1500 back, refund approved"]).ok,
  true,
);

// Dates warn rather than block: "by the 26th" and "26 Sep" and "tomorrow" are
// the same promise and no normaliser catches all three.
const dated = checkFacts("It should reach you by 30 Sep.", CONTEXT);
eq("an unbacked date does not block", dated.ok, true);
eq("but it is surfaced", dated.unverifiedDates, ["09-30"]);
eq(
  "the real expected date raises nothing",
  checkFacts("It should reach you by 26 Sep.", CONTEXT).unverifiedDates,
  [],
);

// ── Promises ────────────────────────────────────────────────────────────────

eq(
  "an unbacked refund is caught",
  unbackedPromises("We will refund you shortly.", CONTEXT),
  ["refund"],
);
eq(
  "so is a replacement",
  unbackedPromises("We will send a replacement.", CONTEXT),
  ["replacement"],
);
eq(
  "a refund already on the record is reporting, not deciding",
  unbackedPromises("Your refund was processed.", [...CONTEXT, "refund issued 20 Sep, ₹679 to original method"]),
  [],
);
eq(
  "an ordinary reply promises nothing",
  unbackedPromises("Your parcel is on its way and should reach you soon.", CONTEXT),
  [],
);
eq(
  "waiving the pickup fee is a money decision too",
  unbackedPromises("We will waive the ₹99 pickup charge.", CONTEXT),
  ["waive"],
);

// ── Contradictions ──────────────────────────────────────────────────────────
//
// Handed "ur parcel is out for delivery and will reach u tomorrow morning for
// sure" against a finished order, the model returned it polished and raised no
// concern — fluent, confident and wrong. So this is worked out in code.

const DONE: ContextOrder = { id: "AJUKI710072", status: "delivered", delivered_at: "2026-09-18T00:00:00Z" };
const MOVING: ContextOrder = { id: "AJUKI710055", status: "in_transit" };

eq(
  "promising a delivery on a finished order is flagged",
  contradictions("Your parcel is out for delivery and will reach you tomorrow.", [DONE]).length,
  1,
);
eq(
  "and the flag names the order and what it actually is",
  contradictions("It will reach you tomorrow.", [DONE])[0],
  'This says a delivery is still coming, but AJUKI710072 is marked "delivered" (18 Sep 2026). Check before sending.',
);
eq(
  "an RTO is just as finished",
  contradictions("It is on its way to you.", [{ id: "AJUKI1", status: "rto" }]).length,
  1,
);
eq(
  "the same sentence on a moving order is fine",
  contradictions("Your parcel is out for delivery and will reach you tomorrow.", [MOVING]),
  [],
);
// One-sided on purpose: a customer with one delivered order and one in transit
// must never trip it, or the warning becomes noise and stops being read.
eq(
  "one order still moving is enough to say nothing",
  contradictions("It will reach you tomorrow.", [DONE, MOVING]),
  [],
);
eq(
  "a reply that promises no delivery says nothing",
  contradictions("Your return has been received and checked.", [DONE]),
  [],
);
eq("no orders, nothing to contradict", contradictions("It will reach you tomorrow.", []), []);

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
