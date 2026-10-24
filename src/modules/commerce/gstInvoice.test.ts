// npx tsx lib/gstInvoice.test.ts
//
// The invariant worth defending here is one line: **the invoice foots to what the
// customer paid, on every order in the table.** A tax invoice that totals to
// anything else is a wrong legal document, and the orders it would happen on are
// exactly the ones nobody looks at — the 94 that break the money invariant and
// the 315 bundle orders whose items sum above their own subtotal.

import {
  buildInvoice, invoiceHtml, gstStateOf, amountInWords, InvoiceError, GST_RATE, SELLER,
  type InvoiceOrder,
} from "@commerce/gstInvoice";

let pass = 0;
const fails: string[] = [];
function eq(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else fails.push(`${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
function ok(cond: boolean, label: string) { eq(cond, true, label); }

const addr = (state: string, city = "Anantnag") => ({
  name: "Ganai Haris", line1: "Mattan ganaipora", line2: "Near jamia masjid",
  city, state, pincode: "192125", phone: "+919000100001",
});

const order = (over: Partial<InvoiceOrder> = {}): InvoiceOrder => ({
  id: "AJUKI710011",
  created_at: "2026-07-11T15:52:01.781766+00:00",
  items: [{ name: "Snake Pipe Bracelet - Silver", price: 299, quantity: 1, size: "2 mm", color: "Silver" }],
  shipping: 0, cod_fee: 0, total: 269, coupon: "AJUKI10", payment_id: "COD",
  address: addr("Jammu and Kashmir"),
  ...over,
});

// ── State codes ──────────────────────────────────────────────────────────────

eq(gstStateOf("Jammu and Kashmir")?.code, "01", "J&K, spelled out");
eq(gstStateOf("JAMMU AND KASHMIR")?.code, "01", "J&K, shouted");
eq(gstStateOf("Jammu & Kashmir")?.code, "01", "J&K, ampersand");
eq(gstStateOf("Jammu Kashmir")?.code, "01", "J&K, no conjunction");
eq(gstStateOf("Maharashtra")?.code, "27", "seller's own state");
eq(gstStateOf("MAHARASHTRA")?.code, "27", "seller's own state, shouted");
eq(gstStateOf("Chattisgarh")?.code, "22", "Chhattisgarh, one h");
eq(gstStateOf("Megalaya")?.code, "17", "Meghalaya, misspelled in real orders");
eq(gstStateOf("PONDICHERRY")?.code, "34", "Pondicherry is Puducherry");
eq(gstStateOf("Hyderabad")?.code, "36", "a city typed into the state field");
eq(gstStateOf("MP")?.code, "23", "two-letter code");
eq(gstStateOf("New Delhi")?.code, "07", "Delhi with the New");
eq(gstStateOf("Andaman And Nico.In.")?.code, "35", "courier's truncation, punctuation and all");
eq(gstStateOf("Daman And Diu")?.code, "26", "merged UT");
eq(gstStateOf(""), null, "a blank state cannot be placed");
eq(gstStateOf("Sindh"), null, "an unknown state is refused, not guessed");

// An unplaceable state must refuse rather than default to IGST — a guessed place
// of supply is a wrong tax return, and it fails silently.
let threw = false;
try { buildInvoice(order({ address: addr("") })); } catch (e) { threw = e instanceof InvoiceError; }
ok(threw, "blank delivery state throws InvoiceError");

// ── The real order this was built from ───────────────────────────────────────

const inv = buildInvoice(order());
eq(inv.number, "AJ/2026-27/710011", "invoice number carries the financial year");
eq(inv.date, "11.07.2026", "invoice date is the order date, dd.mm.yyyy");
eq(inv.interState, true, "Mumbai to Anantnag is inter-state");
eq(inv.buyerStateCode, "01", "place of supply code");
eq(inv.lines.length, 2, "one item plus the discount line");
eq(inv.lines[0].gross, 299, "item line is the gross the customer saw");
eq(inv.lines[0].taxable, 290.29, "taxable value backed out of a tax-inclusive price");
eq(inv.lines[0].tax, 8.71, "tax is the remainder, so the line foots");
eq(inv.lines[1].gross, -30, "the coupon becomes a negative line");
eq(inv.lines[1].taxable, -29.13, "discount is split too — it reduces the taxable value");
eq(inv.lines[1].tax, -0.87, "and the tax with it");
eq(inv.taxableTotal, 261.16, "taxable total");
eq(inv.igstTotal, 7.84, "IGST total");
eq(inv.cgstTotal, 0, "no CGST on an inter-state sale");
eq(inv.grandTotal, 269, "grand total is what the rider collected");
eq(inv.amountInWords, "Two Hundred Sixty-Nine Rupees Only", "amount in words");
eq(inv.payment, "Cash on Delivery (₹269 collected on delivery)", "payment line");

// ── Intra-state splits the tax in half ───────────────────────────────────────

const mh = buildInvoice(order({ address: addr("Maharashtra", "Mumbai"), total: 299, coupon: null }));
eq(mh.interState, false, "Mumbai to Mumbai is intra-state");
eq(mh.igstTotal, 0, "no IGST within the state");
eq(mh.cgstTotal, 4.36, "CGST is half the tax");
eq(mh.sgstTotal, 4.35, "SGST takes the odd paisa, so the halves still foot");
eq(mh.cgstTotal + mh.sgstTotal, mh.taxTotal, "the two halves are the whole tax");

// ── The invariant: every invoice foots to `total` ────────────────────────────

const foots = (o: InvoiceOrder, label: string) => {
  const i = buildInvoice(o);
  const gross = i.lines.reduce((s, l) => s + l.gross, 0);
  eq(Math.round(gross * 100) / 100, o.total, `${label}: lines sum to total`);
  eq(Math.round((i.taxableTotal + i.taxTotal) * 100) / 100, o.total, `${label}: taxable + tax = total`);
  eq(i.grandTotal, o.total, `${label}: grand total = total`);
};

foots(order(), "the coupon order");
foots(order({ shipping: 99, total: 368 }), "express shipping");
foots(order({ cod_fee: 30, total: 299 }), "COD fee");
foots(order({ gift_wrap: true, shipping: 49, total: 318 }), "gift wrap folded into shipping");
// An automatic offer (B1G1) is its own line, and only what is left may carry the coupon code.
const b1g1 = order({ items: [{ name: "Atlas Bracelet", price: 499, quantity: 1 }, { name: "Cuban Link", price: 699, quantity: 1 }], total: 1198 - 499 - 120, coupon: "AJUKI10", offer_discount: 499, offers: [{ label: "Buy 1 Get 1 Free" }] });
foots(b1g1, "offer and coupon together");
const b1g1Inv = buildInvoice(b1g1);
eq(b1g1Inv.lines.filter((l) => l.gross < 0).map((l) => [l.description, l.gross, l.detail]).join("|"), "Buy 1 Get 1 Free,-499,Automatic offer|Discount,-120,Coupon AJUKI10", "the offer and the coupon are separate negative lines, each named for what it is");
const offerOnly = buildInvoice(order({ items: [{ name: "A", price: 499, quantity: 1 }, { name: "B", price: 699, quantity: 1 }], total: 699, coupon: null, offer_discount: 499, offers: [{ label: "B1G1" }] }));
eq(offerOnly.lines.filter((l) => l.gross < 0).map((l) => l.description).join("|"), "B1G1", "an offer with no coupon is one line and no phantom Discount");
const unrecorded = buildInvoice(order({ items: [{ name: "A", price: 499, quantity: 1 }, { name: "B", price: 699, quantity: 1 }], total: 699, coupon: null }));
eq(unrecorded.lines.filter((l) => l.gross < 0).map((l) => l.description).join("|"), "Discount", "an order not yet backfilled still foots, with the old single Discount line");

// A bundle: two items priced 499 each at the cart, sold for 499 the pair. The
// items sum above the money the customer paid, which 315 real orders do.
foots(order({
  items: [
    { name: "Snake Pipe Bracelet", price: 499, quantity: 1 },
    { name: "Cuban Link Chain", price: 499, quantity: 1 },
  ],
  total: 499,
}), "bundle priced below the sum of its items");

// The 94 orders that break subtotal − discount + shipping + cod_fee = total, in
// both directions. Neither may throw, and neither may misfoot.
foots(order({ total: 329 }), "paid 30 more than the parts (legacy COD fee)");
foots(order({ total: 244, coupon: null }), "paid 55 less than the parts (prepaid discount)");

const over = buildInvoice(order({ total: 329 }));
eq(over.lines[1].description, "Other charges", "an unexplained excess is a charge, not an invented COD fee");
eq(over.lines[1].gross, 30, "and it is exactly the gap");

// A free replacement is a real zero-value order and must still print.
foots(order({ items: [{ name: "Snake Pipe Bracelet", price: 299, quantity: 1 }], total: 0, coupon: null }), "free replacement");
eq(buildInvoice(order({ total: 0, coupon: null })).amountInWords, "Zero Rupees Only", "zero in words");

// ── Multiple units and quantities ────────────────────────────────────────────

const two = buildInvoice(order({ items: [{ name: "Snake Pipe Bracelet", price: 299, quantity: 2 }], total: 598, coupon: null }));
eq(two.lines.length, 1, "no reconciling line when the maths already agrees");
eq(two.lines[0].qty, 2, "quantity carried");
eq(two.lines[0].unitGross, 299, "unit price is per unit, not the line");
eq(two.grandTotal, 598, "two units");

// ── Financial year boundaries ────────────────────────────────────────────────

const fy = (iso: string) => buildInvoice(order({ created_at: iso })).number.split("/")[1];
eq(fy("2026-04-01T00:00:00Z"), "2026-27", "1 April opens the new year");
eq(fy("2026-03-31T12:00:00Z"), "2025-26", "31 March is still the old one");
// 20:00 UTC on 31 March is 01:30 IST on 1 April — the invoice belongs to the new
// financial year. Reading this in UTC would file it twelve months early.
eq(fy("2026-03-31T20:00:00Z"), "2026-27", "late-evening IST order crosses the year");
eq(buildInvoice(order({ created_at: "2026-03-31T20:00:00Z" })).date, "01.04.2026", "and the date crosses with it");

// ── Words ────────────────────────────────────────────────────────────────────

eq(amountInWords(1), "One Rupee Only", "singular rupee");
eq(amountInWords(269), "Two Hundred Sixty-Nine Rupees Only", "hyphenated tens");
eq(amountInWords(1000), "One Thousand Rupees Only", "round thousand");
eq(amountInWords(2595), "Two Thousand Five Hundred Ninety-Five Rupees Only", "a real order value");
eq(amountInWords(115000), "One Lakh Fifteen Thousand Rupees Only", "lakhs, not hundred-thousands");
eq(amountInWords(10000000), "One Crore Rupees Only", "crores");
eq(amountInWords(269.5), "Two Hundred Sixty-Nine Rupees and Fifty Paise Only", "paise when there are any");

// ── The printed sheet ────────────────────────────────────────────────────────

const html = invoiceHtml(order(), { code: "370854472323", courier: "Amazon Shipping" });
ok(html.includes("</html>"), "the sheet is a complete document");
ok(!html.includes("${"), "no unsubstituted template placeholder reaches the paper");
ok(html.includes("AJ/2026-27/710011"), "invoice number printed");
ok(html.includes("Two Hundred Sixty-Nine Rupees Only"), "amount in words printed");
ok(html.includes("IGST"), "inter-state sheet shows IGST");
ok(!html.includes(">CGST"), "and not CGST");
ok(html.includes("370854472323"), "AWB printed when there is one");
ok(invoiceHtml(order({ address: addr("Maharashtra", "Mumbai") })).includes("CGST"), "intra-state sheet shows CGST");

// Two real orders store the literal string "undefined" as an address line. It is
// truthy, so every naive filter keeps it, and it would print the word into a
// customer's address on a tax document.
ok(!invoiceHtml(order({ address: { ...addr("Kerala"), line2: "undefined" } })).includes("undefined"),
  '"undefined" stored as an address line never reaches the paper');
ok(!invoiceHtml(order({ address: { ...addr("Kerala"), line2: "N/A" } })).includes("N/A"),
  "nor does N/A");
// AJUKI710042 has it glued to the end of a real line rather than standing alone.
const glued = invoiceHtml(order({ address: { ...addr("Maharashtra", "Pune"), line2: "Ganeshkhind Road Pune, undefined" } }));
ok(!glued.includes("undefined"), '"undefined" glued to the end of a real line is stripped');
ok(glued.includes("Ganeshkhind Road Pune"), "and the real part of that line survives");

// A customer's name goes into innerHTML — it must not be able to close a tag.
ok(!invoiceHtml(order({ address: { ...addr("Kerala"), name: "<script>x</script>" } })).includes("<script>"),
  "a name containing markup is escaped");

// ── The constants are the ones on the GST certificate ────────────────────────

eq(SELLER.gstin.slice(0, 2), SELLER.stateCode, "the GSTIN starts with the seller's state code");
eq(SELLER.gstin.slice(2, 12), SELLER.pan, "the PAN is the middle of the GSTIN");
eq(GST_RATE, 3, "imitation jewellery rate");

console.log(fails.length ? `✗ ${fails.length} failed, ${pass} passed\n\n${fails.join("\n\n")}` : `✓ ${pass} assertions passed`);
process.exit(fails.length ? 1 : 0);
