// formatOrders — the per-order line the support model answers from.
//
// lib/waSupport.ts throws at import (productContext builds a Sanity client with
// no projectId), so when Batch 2 changed two branches of this function — the
// typed-id ₹total/items leak and the day-2 OVERDUE threshold — it could not add
// a test. The function now lives in the import-free lib/orderLines.ts; this is
// that missing coverage plus the surrounding branches.
//
// No database. Run with `npx tsx lib/orderLines.test.ts`.

import { formatOrders, type OrderRow, type RefundLine } from "@engine/orderLines";

let passed = 0;
let failed = 0;
const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual === expected) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
};
const has = (label: string, hay: string, needle: string) => eq(`${label} — contains ${JSON.stringify(needle)}`, hay.includes(needle), true);
const lacks = (label: string, hay: string, needle: string) => eq(`${label} — omits ${JSON.stringify(needle)}`, hay.includes(needle), false);

const DAY = 86_400_000;
const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY).toISOString();
const scanAt = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

const order = (over: Partial<OrderRow>): OrderRow => ({
  id: "AJUKI710007",
  status: "confirmed",
  total: 1299,
  created_at: iso(-10),
  items: [{ name: "Cuban Chain", size: "5 mm", color: "Silver", quantity: 2 }],
  address: { phone: "9876543210", line1: "12 MG Road", city: "Pune", state: "MH", pincode: "411001" },
  ...over,
});

// ── Batch 2 fix: typed-id leak — ₹total and the item list ride only on the
//    own-phone (withAddress=true) path. AGENTS.md: an order id is guessable and
//    has twice been typed by someone who was not that order's customer.
{
  const o = [order({})];
  const withAddr = formatOrders(o, true, false);
  const typedId = formatOrders(o, false, false);

  has("withAddress=true", withAddr, "₹1299");
  has("withAddress=true", withAddr, "Cuban Chain (5 mm, Silver) x2");
  has("withAddress=true", withAddr, "delivering to: 12 MG Road");

  lacks("withAddress=false (typed id)", typedId, "₹");
  lacks("withAddress=false (typed id)", typedId, "Cuban Chain");
  lacks("withAddress=false (typed id)", typedId, "delivering to:");
  // The parts that are NOT address-gated still show.
  has("withAddress=false (typed id)", typedId, "#AJUKI710007 · confirmed");
  has("withAddress=false (typed id)", typedId, "ordered ");
}

// ── Batch 2 fix: the OVERDUE / running-late framing starts at day 2, not day 1.
//    Founder decision — one day past the estimate is ordinary courier slippage.
{
  const late = (days: number, extra: Partial<OrderRow> = {}) =>
    formatOrders([order({ status: "shipped", estimated_delivery: iso(-days), ...extra })], true, false);

  // day 0 — not late at all
  const d0 = late(0, { courier_status: "in_transit", courier_status_at: scanAt(4), courier_status_detail: "In Transit" });
  has("lateDays 0", d0, "expected around ");
  lacks("lateDays 0", d0, "OVERDUE");
  lacks("lateDays 0", d0, "STILL MOVING"); // verdict hint suppressed while not overdue AND moving

  // day 1 — "was expected around ... running a little late" (founder, 25 Oct), NOT OVERDUE, but a concerning verdict is surfaced
  const d1moving = late(1, { courier_status: "in_transit", courier_status_at: scanAt(4), courier_status_detail: "In Transit" });
  has("lateDays 1 moving", d1moving, "was expected around ");
  has("lateDays 1: says it is running a little late", d1moving, "running a little late");
  lacks("lateDays 1 moving", d1moving, "OVERDUE");
  lacks("lateDays 1 moving", d1moving, "STILL MOVING"); // moving + not overdue → no hint

  const d1stuck = late(1, { courier_status: "in_transit", courier_status_at: scanAt(60), courier_status_detail: "In Transit" });
  has("lateDays 1 stuck", d1stuck, "was expected around ");
  lacks("lateDays 1 stuck", d1stuck, "OVERDUE");
  has("lateDays 1 stuck", d1stuck, "STUCK (no courier scan in over 48h)"); // non-moving verdict still hinted at day 1

  const d1dark = late(1);
  has("lateDays 1 dark", d1dark, "was expected around ");
  lacks("lateDays 1 dark", d1dark, "OVERDUE");
  has("lateDays 1 dark", d1dark, "NO COURIER SCANS on record");

  // day 2 — OVERDUE wording kicks in, with the verdict
  const d2 = late(2, { courier_status: "in_transit", courier_status_at: scanAt(60), courier_status_detail: "In Transit" });
  has("lateDays 2", d2, "OVERDUE by 2 days");
  lacks("lateDays 2", d2, "expected around ");
  has("lateDays 2", d2, "STUCK (no courier scan in over 48h)");

  // day 5 moving — OVERDUE, and the moving verdict is now surfaced (overdue forces it)
  const d5 = late(5, { courier_status: "in_transit", courier_status_at: scanAt(3), courier_status_detail: "In Transit" });
  has("lateDays 5 moving", d5, "OVERDUE by 5 days");
  has("lateDays 5 moving", d5, "STILL MOVING (courier scanned it recently)");

  // day 5 failed attempt → NEEDS ATTENTION
  const d5att = late(5, { status: "undelivered", courier_status: "failed_attempt", courier_status_at: scanAt(3), courier_status_detail: "Consignee not available" });
  has("lateDays 5 attention", d5att, "OVERDUE by 5 days");
  has("lateDays 5 attention", d5att, "NEEDS ATTENTION");
}

// ── return_request blocks render on BOTH paths (not address-gated), one block
//    per status. The new per-block detail (reason, photo count, resolution,
//    replacement pointer) is own-phone only.
{
  for (const withAddr of [true, false]) {
    const tag = `return pending (withAddress=${withAddr})`;
    const pending = formatOrders([order({ return_request: { status: "pending", reason: "Wrong item received", submitted_at: iso(-2), photo_paths: ["AJUKI1/a.jpg", "AJUKI1/b.jpg"] } })], withAddr, false);
    has(tag, pending, "RETURN REQUEST ALREADY RAISED");
    has(tag, pending, "is with the team");
    has(tag, pending, "NEVER mention the return window");
    has(tag, pending, "Please wait until they");

    const rejected = formatOrders([order({ return_request: { status: "rejected", reason: "Item is defective", submitted_at: iso(-3), resolved_at: iso(-1), admin_note: "photo shows no damage" } })], withAddr, false);
    has(`return rejected (withAddress=${withAddr})`, rejected, "RETURN REQUEST ALREADY REJECTED");
    has(`return rejected (withAddress=${withAddr})`, rejected, "do not argue it");
    // Never send a rejected-return customer back to Request Return — the site
    // hides it once a return exists (Vishnu, AJUKI710057).
    has(`return rejected (withAddress=${withAddr})`, rejected, "NEVER tell the customer to open Request Return");
    has(`return rejected (withAddress=${withAddr})`, rejected, "Senior Support Team at");
    has(`return rejected (withAddress=${withAddr})`, rejected, "do NOT set needs_human");
    // admin_note NEVER reaches the model — Telegram only.
    lacks(`return rejected (withAddress=${withAddr})`, rejected, "photo shows no damage");
    // and the reason it was rejected is not restated to the model either.
    lacks(`return rejected (withAddress=${withAddr})`, rejected, 'reason filed: "Item is defective"');

    has(tag, pending, "do NOT");
    has(tag, pending, "dead end"); // pending also must not send them to Request Return

    const approved = formatOrders([order({ return_request: { status: "approved", reason: "Item arrived damaged", submitted_at: iso(-3), resolved_at: iso(-1), resolution: "replacement" } })], withAddr, false);
    has(`return approved (withAddress=${withAddr})`, approved, "RETURN REQUEST ALREADY APPROVED");
    has(`return approved (withAddress=${withAddr})`, approved, "track their return at www.ajuki.in/returns/start");
    has(`return approved (withAddress=${withAddr})`, approved, "resolution: replacement");
  }

  // own-phone: reason + photo COUNT (never a path); typed-id: neither.
  const rrPending = { status: "pending" as const, reason: "Wrong item received", submitted_at: iso(-2), photo_paths: ["AJUKI1/a.jpg", "AJUKI1/b.jpg"] };
  const own = formatOrders([order({ return_request: rrPending })], true, false);
  has("pending reason own-phone", own, 'reason filed: "Wrong item received"');
  has("pending photo count own-phone", own, "2 photo(s) attached");
  lacks("pending never leaks a photo path", own, "AJUKI1/a.jpg");

  const typed = formatOrders([order({ return_request: rrPending })], false, false);
  lacks("pending reason hidden on typed-id", typed, "reason filed");
  lacks("pending photo count hidden on typed-id", typed, "photo(s) attached");

  // approved + replacement + replacement_order_id → pointer, own-phone only.
  const withRepl = formatOrders([order({ return_request: { status: "approved", reason: "Item arrived damaged", submitted_at: iso(-4), resolved_at: iso(-1), resolution: "replacement", replacement_order_id: "AJUKI710092" } })], true, false);
  has("approved replacement pointer", withRepl, "replacement parcel #AJUKI710092 (see its own line)");
}

// ── payment fact — own-phone only, ungated by message intent.
{
  const cod = formatOrders([order({ payment_id: "COD", cod_due: 1349 })], true, false);
  has("COD payment fact", cod, "· COD, ₹1349 due on delivery");

  const codNoDue = formatOrders([order({ payment_id: "COD", cod_due: null })], true, false);
  has("COD falls back to total", codNoDue, "· COD, ₹1299 due on delivery");

  const prepaid = formatOrders([order({ payment_id: "pay_ABC123", cod_due: null })], true, false);
  has("prepaid payment fact", prepaid, "· PREPAID, ₹1299 paid online");

  const prepaidPaid = formatOrders([order({ payment_id: "pay_ABC123", amount_paid_online: 1299 })], true, false);
  has("prepaid uses amount_paid_online", prepaidPaid, "· PREPAID, ₹1299 paid online");

  const partial = formatOrders([order({ payment_id: "COD", amount_paid_online: 99, cod_due: 1250 })], true, false);
  has("partial-COD payment fact", partial, "· PARTIAL-COD, ₹99 paid online + ₹1250 due on delivery");

  // typed-id path: no payment detail at all.
  const typed = formatOrders([order({ payment_id: "COD", cod_due: 1349 })], false, false);
  lacks("payment fact hidden on typed-id", typed, "COD, ₹1349");
  lacks("payment fact hidden on typed-id", typed, "PARTIAL-COD");

  // no payment_id / no cod info → no payment fact (older rows).
  const bare = formatOrders([order({})], true, false);
  lacks("no payment fact without payment_id", bare, "PREPAID");
  lacks("no payment fact without payment_id", bare, " COD,");
}

// ── money breakdown — gated on showMoney AND own-phone.
{
  const moneyOrder = order({ subtotal: 1200, discount: 100, shipping: 199, total: 1299, coupon: "SAVE100" });
  const off = formatOrders([moneyOrder], true, false, false);
  lacks("money breakdown off by default", off, "subtotal ₹1200");

  const on = formatOrders([moneyOrder], true, false, true);
  has("money breakdown when showMoney", on, "subtotal ₹1200 - discount ₹100 + shipping ₹199 = ₹1299 (coupon SAVE100)");

  const typed = formatOrders([moneyOrder], false, false, true);
  lacks("money breakdown hidden on typed-id", typed, "subtotal ₹1200");

  const gw = formatOrders([order({ subtotal: 999, discount: 0, shipping: 0, total: 1029, gift_wrap: true })], true, false, true);
  has("gift wrap shows the flat ₹30 so the line adds up", gw, "+ gift wrap ₹30 = ₹1029");

  // An automatic offer (B1G1 and friends) is part of the breakdown: the subtotal is already net of it, and the line must say so or it does not add up.
  const offered = formatOrders([order({ subtotal: 1198, discount: 0, offer_discount: 399, shipping: 0, total: 1198 })], true, false, true);
  has("an automatic offer is named in the money line", offered, "subtotal ₹1198 (after ₹399 off from an automatic offer) - discount ₹0 + shipping ₹0 = ₹1198");

  const noMoney = formatOrders([order({ subtotal: null })], true, false, true);
  lacks("money breakdown skipped when subtotal missing", noMoney, "subtotal ₹");
}

// ── delivery-failure detail — own-phone only, additive to the RTO block.
{
  const undel = formatOrders([order({ status: "undelivered", attempt_count: 2, ndr_reason: "Consignee not available" })], true, false);
  has("undelivered attempt line", undel, "delivery attempt 2, courier note: Consignee not available");

  const rto = formatOrders([order({ status: "rto", attempt_count: 3, ndr_reason: "Customer refused", rto_reason: "3 failed attempts" })], true, false);
  has("rto attempt line", rto, "delivery attempt 3, courier note: Customer refused");
  has("rto reason", rto, "RTO reason: 3 failed attempts");
  has("rto block still present", rto, "ON ITS WAY BACK TO US");

  const oneAttempt = formatOrders([order({ status: "shipped", attempt_count: 1 })], true, false);
  has("attempt_count>0 on a shipped order", oneAttempt, "delivery attempt 1");

  // An unknown attempt count is not "attempt 0": the count is left out and only the courier's own note is stated (9 Oct).
  const unknownCount = formatOrders([order({ status: "undelivered", attempt_count: null, ndr_reason: "Customer not contactable" })], true, false);
  has("courier note kept when the count is unknown", unknownCount, "courier note: Customer not contactable");
  lacks("no 'delivery attempt 0' when the count is unknown", unknownCount, "delivery attempt");
  const zeroCount = formatOrders([order({ status: "undelivered", attempt_count: 0, ndr_reason: "Consignee Unavailable" })], true, false);
  lacks("no 'delivery attempt 0' when the count is 0", zeroCount, "delivery attempt");
  const noNoteNoCount = formatOrders([order({ status: "undelivered", attempt_count: null })], true, false);
  lacks("nothing printed when there is neither a count nor a note", noNoteNoCount, "courier note");

  const typed = formatOrders([order({ status: "undelivered", attempt_count: 2, ndr_reason: "Consignee not available" })], false, false);
  lacks("delivery-failure hidden on typed-id", typed, "courier note");

  const clean = formatOrders([order({ status: "shipped", estimated_delivery: iso(3) })], true, false);
  lacks("no delivery-failure line on a healthy parcel", clean, "delivery attempt");
}

// ── refund line — own-phone only, present only when the refunds map is passed.
{
  const RID = "AJUKI710007";
  const mk = (status: RefundLine["status"], extra: Partial<RefundLine> = {}): Map<string, RefundLine> =>
    new Map([[RID, { status, amount: 1299, since: iso(-2), processedAt: null, ...extra }]]);

  const inProgress = formatOrders([order({})], true, false, false, mk("REFUND_PROCESSING"));
  has("refund in progress", inProgress, "refund: ₹1299 in progress since ");
  // Where the money goes depends on how it was paid, and the old single line
  // ("to the original method") sent COD customers to check a bank account that
  // nothing would ever arrive in. A COD order has no payment to reverse, so its
  // refund settles as AJUKI Wallet credit. Both paths pinned explicitly.
  const prepaid = formatOrders([order({ payment_id: "pay_ABC123" } as Partial<OrderRow>)], true, false, false, mk("REFUND_PROCESSING"));
  has("prepaid refund goes to the original method", prepaid, "3-5 business working days to the original method");

  const cod = formatOrders([order({ payment_id: "COD" } as Partial<OrderRow>)], true, false, false, mk("REFUND_PROCESSING"));
  has("COD refund settles as wallet credit", cod, "AJUKI Wallet credit");
  lacks("COD refund never promises a bank transfer", cod, "to the original method");

  // No payment id at all means nothing was captured online: treated as COD.
  has("no payment id is treated as COD", inProgress, "AJUKI Wallet credit");

  const eligible = formatOrders([order({})], true, false, false, mk("REFUND_ELIGIBLE"));
  has("refund eligible reads as in progress", eligible, "refund: ₹1299 in progress since ");

  const done = formatOrders([order({})], true, false, false, mk("REFUND_COMPLETED", { processedAt: iso(-1) }));
  has("refund completed", done, "refund: ₹1299 completed ");

  const manual = formatOrders([order({})], true, false, false, mk("REFUND_MANUAL_REVIEW"));
  has("refund manual review", manual, "refund: ₹1299 needs the team — escalate");

  const failed = formatOrders([order({})], true, false, false, mk("REFUND_FAILED"));
  has("refund failed", failed, "refund: ₹1299 needs the team — escalate");

  const noRow = formatOrders([order({ id: "AJUKI710018" })], true, false, false, mk("REFUND_PROCESSING"));
  has("no refund row but map passed", noRow, "no refund on record");

  const noMap = formatOrders([order({})], true, false, false);
  lacks("no refund line without the map", noMap, "refund:");
  lacks("no 'no refund on record' without the map", noMap, "no refund on record");

  const typed = formatOrders([order({})], false, false, false, mk("REFUND_PROCESSING"));
  lacks("refund line hidden on typed-id", typed, "refund:");
}

// ── replacement prefix — replacementOf maps child id → parent id.
{
  const child = order({ id: "AJUKI710092", status: "shipped", estimated_delivery: iso(2) });
  const out = formatOrders([child], true, false, false, undefined, new Map([["AJUKI710092", "AJUKI710007"]]));
  has("replacement prefix", out, "REPLACEMENT for #AJUKI710007 · #AJUKI710092 · shipped");

  const plain = formatOrders([child], true, false, false, undefined, new Map());
  lacks("no prefix when not a replacement", plain, "REPLACEMENT for");
}

// ── showReturnWindow gates whether the model sees the window fact. The window
//    is only computed for a delivered order.
{
  const delivered = order({ status: "delivered", delivered_at: iso(-3) });
  const off = formatOrders([delivered], true, false);
  const on = formatOrders([delivered], true, true);

  lacks("showReturnWindow=false", off, "return window");
  has("showReturnWindow=false still shows delivery date", off, "delivered ");

  has("showReturnWindow=true, in window", on, "return window for defective/damaged items: OPEN, 4 days left");

  // The Buy 1 Get 1 return rule is NOT put on the order line: business truths tell the bot to point to www.ajuki.in/returns for any question about return
  // policy or charges, and handing it the rule here would invite it to explain instead.
  lacks("a Buy 1 Get 1 order does not hand the bot the return rule to explain", formatOrders([order({ status: "delivered", delivered_at: iso(-3), created_at: "2026-10-12T10:00:00+05:30", offer_discount: 499 })], true, true), "BUY-1-GET-1");

  const oldDelivery = formatOrders([order({ status: "delivered", delivered_at: iso(-30) })], true, true);
  has("showReturnWindow=true, past window", oldDelivery, "return window (7 days from delivery): CLOSED");

  const notDelivered = formatOrders([order({ status: "shipped", estimated_delivery: iso(2) })], true, true);
  lacks("showReturnWindow=true but not delivered", notDelivered, "return window");
}

// ── RTO / returned → "ON ITS WAY BACK TO US", and the track link is withheld
//    even though withAddress=true and a tracking_url is present.
{
  for (const status of ["rto", "returned"] as const) {
    const s = formatOrders([order({ status, tracking_url: "https://track/x", courier_name: "Delhivery", awb_code: "600028111" })], true, false);
    has(`${status}`, s, "ON ITS WAY BACK TO US");
    lacks(`${status}`, s, "track: https://track/x");
    lacks(`${status}`, s, "OVERDUE");
  }
}

// ── address and track link only on the own-phone path.
{
  const o = order({ status: "shipped", tracking_url: "https://track/y", courier_name: "Shadowfax", estimated_delivery: iso(3) });
  const withAddr = formatOrders([o], true, false);
  const typedId = formatOrders([o], false, false);

  has("track link, withAddress=true: always ours, courier kept as a fact", withAddr, "track: www.ajuki.in/track (Shadowfax)"); eq("the courier page is not in the record", withAddr.includes("https://track/y"), false);
  has("address, withAddress=true", withAddr, "delivering to: 12 MG Road, Pune, MH, 411001");

  lacks("track link, withAddress=false", typedId, "track:");
  lacks("address, withAddress=false", typedId, "delivering to:");
}

// ── express and self-cancel facts (unchanged branches, kept honest).
{
  const express = formatOrders([order({ shipping_method: "express" })], true, false);
  has("express", express, "EXPRESS delivery (they paid extra for it)");

  const cancellable = formatOrders([order({ status: "confirmed", awb_code: undefined, created_at: scanAt(5) })], false, false);
  has("pre-manifest, inside 24h", cancellable, "can be cancelled by you directly");

  // Past the 24 hours we promise, an unbooked order is no longer the bot's to cancel.
  const tooOld = formatOrders([order({ status: "confirmed", awb_code: undefined, created_at: scanAt(30) })], false, false);
  has("pre-manifest, past 24h", tooOld, "CANNOT be self-cancelled (placed more than 24 hours ago");
  lacks("pre-manifest, past 24h", tooOld, "can be cancelled by you directly");

  const booked = formatOrders([order({ status: "packed", awb_code: "AWB1" })], false, false);
  has("booked", booked, "CANNOT be self-cancelled (already handed to the courier)");

  const settled = formatOrders([order({ status: "delivered", delivered_at: iso(-1) })], false, false);
  has("settled", settled, "CANNOT be self-cancelled (already closed)");
}

// ── de-dupe and the 6-order cap.
{
  const dupes = formatOrders([order({ id: "AJUKI1" }), order({ id: "AJUKI1" }), order({ id: "AJUKI2" })], false, false);
  eq("de-dupes by id", dupes.split("\n").length, 2);

  const many = formatOrders(Array.from({ length: 9 }, (_, i) => order({ id: `AJUKI${i}` })), false, false);
  eq("caps at 6 lines", many.split("\n").length, 6);
}

// ── The collection on an approved return ─────────────────────────────────────
//
// "When is someone coming?" is the commonest follow-up to an approved return.
// The order knew the courier and the reference; the bot could only say "pickup
// has been arranged", so the question escalated.
{
  const approved = (rr: Record<string, unknown>) =>
    formatOrders([order({ return_request: { status: "approved", reason: "Item arrived damaged", resolution: "pickup", submitted_at: iso(-3), resolved_at: iso(-1), ...rr } })], true, false);

  const booked = approved({ pickup_shipment: { status: "confirmed", courier: "Delhivery", request_id: "60000000000005", booked_at: iso(-1) } });
  has("booked pickup names the courier", booked, "pickup BOOKED with Delhivery");
  has("booked pickup gives the reference", booked, "60000000000005");
  // The collection's own link, not the delivered parcel's.
  has("booked Delhivery pickup links the collection", booked, "delhivery.com/track/package/60000000000005");
  has("and warns off the delivery link", booked, "never give that one");

  // Shadowfax reverse has no AWB at creation — no link beats a fabricated one.
  const sfx = approved({ pickup_shipment: { status: "confirmed", courier: "Shadowfax", request_id: "R24344094622" } });
  has("a Shadowfax pickup still gives the reference", sfx, "R24344094622");
  lacks("but invents no tracking link", sfx, "track/package");

  // A free pickup has to say so, or "do I have to pay?" escalates on an order
  // whose answer is plainly no.
  const free = approved({ pickup_fee: 0 });
  has("a free pickup says it is free", free, "FREE");

  // A charge that is still owed is the one thing on this line the customer can
  // act on, so it says where to pay it rather than only that it is unpaid.
  const unpaid = approved({ pickup_fee: 99, resolution: "pickup" });
  has("unpaid fee is stated", unpaid, "NOT yet paid");
  has("unpaid fee says where to pay", unpaid, "www.ajuki.in/returns/start");

  const paid = approved({ pickup_fee: 99, pickup_payment: { status: "paid" } });
  has("a paid fee says so", paid, "is PAID");
  lacks("a paid fee does not still ask for money", paid, "NOT yet paid");

  // THE ONE THAT MATTERS. A carrier refusing is our problem, not the
  // customer's: told "Shadowfax rejected this pickup" they would reasonably ask
  // us to fix something they cannot act on. It reads as not booked yet, which
  // is true, and the panel alerts a person separately.
  const failed = approved({ pickup_shipment: { status: "failed", error: "Shadowfax rejected this pickup: Invalid Pickup Pincode", attempted_at: iso(-1) } });
  lacks("a failed booking never names the courier's refusal", failed, "Shadowfax");
  lacks("nor the word rejected", failed, "rejected this pickup");
  has("a failed booking reads as not booked yet", failed, "not booked yet");

  // Nothing is collected on these, so a pickup line would be a lie.
  const keep = formatOrders([order({ return_request: { status: "approved", reason: "Item is defective", resolution: "keep_item", submitted_at: iso(-3), resolved_at: iso(-1), pickup_fee: 99 } })], true, false);
  lacks("keep_item has no pickup charge line", keep, "pickup charge");
  lacks("keep_item is not booked or unbooked", keep, "not booked yet");

  // Own-phone only: someone else's order must not leak a tracking reference.
  const other = formatOrders([order({ return_request: { status: "approved", resolution: "pickup", reason: "Item arrived damaged", submitted_at: iso(-3), resolved_at: iso(-1), pickup_shipment: { status: "confirmed", courier: "Delhivery", request_id: "60000000000005" } } })], false, false);
  lacks("another phone's order leaks no reference", other, "60000000000005");
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
