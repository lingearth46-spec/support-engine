/**
 * The tax invoice for one order — the numbers only, no markup.
 *
 * Two things make this harder than "print the order":
 *
 * 1. **Every price on the site is tax-inclusive.** The product page says
 *    "Inclusive of all taxes" and the customer paid `total`. A tax invoice has to
 *    declare the taxable value and the tax separately, so both are back-computed
 *    out of the gross. The gross is the fact; the split is derived from it, never
 *    the other way round, or the invoice totals to something nobody paid.
 *
 * 2. **`subtotal − discount + shipping + cod_fee = total` does not always hold.**
 *    94 of 2,806 orders break it, in six different directions (+30 and +35 COD
 *    fees from before `cod_fee` existed, −55 prepaid discounts, +99 express, and
 *    three one-offs), and 315 more have items whose price × qty sums *above*
 *    `subtotal` because a bundle was priced at the cart. So nothing here trusts
 *    `subtotal` or `discount` as the shape of the sale. Line values are built from
 *    the items, and whatever is left over between them and `total` becomes one
 *    explicit reconciling line — a discount if the customer paid less, a charge if
 *    they paid more. The invoice therefore foots to `total` by construction, for
 *    every order in the table, without inventing a rule about where the gap came
 *    from.
 *
 * Pure — no network, no Sanity, no Supabase — so `gstInvoice.test.ts` can run it.
 */

import { normalizeState } from "@engine/states";

// ── The tax inputs ───────────────────────────────────────────────────────────
// These are the accountant's numbers, not the developer's. If the CA says the
// rate or the heading is wrong, this is the only place to change it and every
// invoice ever reprinted changes with it.

/** Imitation jewellery. Everything we sell is stainless steel or brass alloy. */
export const HSN_CODE = "7117";

/** GST on HSN 7117. Confirm against the current schedule before an audit. */
export const GST_RATE = 3;

/** The registered person issuing the invoice. Matches the GST certificate character for character. */
export const SELLER = {
  name: "EXAMPLE TRADERS",
  address: ["Example Building, Shop No 4 / Plot No 299,", "Example marg, Kurla, Mumbai - 400070,", "Maharashtra, India"],
  gstin: "27AAAAA0000A1Z5",
  /** The PAN inside the GSTIN — characters 3-12. */
  pan: "AAAAA0000A",
  stateCode: "27",
  state: "Maharashtra",
  phone: "+91 90001 00012",
  email: "ajukisupport@gmail.com",
} as const;

// ── State codes ──────────────────────────────────────────────────────────────

/**
 * GST state codes, keyed on the state name squashed to bare letters.
 *
 * Squashed because the address `state` is typed by the customer or handed over by
 * Razorpay and arrives 70 different ways across 2,806 orders — "Jammu & Kashmir",
 * "JAMMU AND KASHMIR", "Jammu Kashmir", "Andaman And Nico.In.", "MP", "Hyderabad".
 * `normalizeState` already folds the four J&K spellings and the casing; this
 * folds the punctuation and the ampersand, and the aliases below cover the rest.
 *
 * The code is printed on the invoice and decides IGST versus CGST+SGST, so a
 * wrong entry is a wrong tax. Anything not in here refuses to produce an invoice
 * rather than guessing — see `gstStateOf`.
 */
const STATE_CODES: Record<string, string> = {
  jammukashmir: "01", himachalpradesh: "02", punjab: "03", chandigarh: "04",
  uttarakhand: "05", haryana: "06", delhi: "07", rajasthan: "08",
  uttarpradesh: "09", bihar: "10", sikkim: "11", arunachalpradesh: "12",
  nagaland: "13", manipur: "14", mizoram: "15", tripura: "16",
  meghalaya: "17", assam: "18", westbengal: "19", jharkhand: "20",
  odisha: "21", chhattisgarh: "22", madhyapradesh: "23", gujarat: "24",
  dadraandnagarhaveliandamananddiu: "26", maharashtra: "27", karnataka: "29",
  goa: "30", lakshadweep: "31", kerala: "32", tamilnadu: "33",
  puducherry: "34", andamanandnicobarislands: "35", telangana: "36",
  andhrapradesh: "37", ladakh: "38",

  // Spellings and stand-ins that appear in real orders. Each one was read off
  // the orders table, not imagined: dropping them would refuse an invoice on a
  // parcel that shipped and was paid for.
  newdelhi: "07",
  hyderabad: "36",
  megalaya: "17",
  andamanandnicoin: "35",
  andamannicobarislands: "35",
  dadranagarhaveli: "26", dadraandnagarhaveli: "26", damananddiu: "26",
  // Two-letter codes some customers type instead of the name. The same set
  // lib/states.ts already resolves for the zone map.
  dl: "07", hr: "06", pb: "03", up: "09", rj: "08", uk: "05", hp: "02", jk: "01",
  mh: "27", gj: "24", ga: "30", mp: "23", cg: "22",
  ka: "29", kl: "32", tn: "33", ap: "37", ts: "36", tg: "36",
  wb: "19", br: "10", jh: "20", or: "21", od: "21", as: "18", tr: "16",
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/**
 * The GST state code for a delivery address, or null if the state cannot be
 * placed. Null is the honest answer for "MP" typo'd as something else — an
 * invoice with the wrong place of supply is worse than no invoice, and the
 * caller shows the operator which order and which string to fix.
 */
export function gstStateOf(rawState: string | null | undefined): { code: string; name: string } | null {
  const name = normalizeState(rawState);
  const code = STATE_CODES[squash(name)];
  return code ? { code, name } : null;
}

// ── Money ────────────────────────────────────────────────────────────────────

/** Round to paise. Math.round carries negatives correctly: -29.1262 → -29.13. */
const r2 = (n: number) => Math.round(n * 100) / 100;

export type InvoiceLine = {
  description: string;
  /** Variant, coupon code, or whatever names the line without repeating it. */
  detail?: string;
  hsn: string | null;
  qty: number;
  /** Tax-inclusive rupees, exactly as the customer sees it. */
  gross: number;
  /** Tax-inclusive price of one unit. */
  unitGross: number;
  taxable: number;
  tax: number;
  cgst: number;
  sgst: number;
  igst: number;
};

/** Everything the invoice needs from an order. Structural, so `Order` satisfies it. */
export type InvoiceOrder = {
  id: string;
  created_at?: string;
  items: { name: string; price: number; quantity?: number; size?: string; color?: string }[];
  shipping?: number;
  cod_fee?: number | null;
  total: number;
  coupon?: string | null;
  /** What the automatic offers (B1G1 and friends) took off. Shown as its own line so it is not mistaken for a coupon (lib/orderOffers.ts). */
  offer_discount?: number | null;
  offers?: { label?: string }[] | null;
  payment_id?: string;
  amount_paid_online?: number | null;
  cod_due?: number | null;
  gift_wrap?: boolean;
  address: { name: string; line1?: string; line2?: string; city?: string; state?: string; pincode?: string; phone?: string };
};

export type Invoice = {
  number: string;
  /** dd.mm.yyyy — fixed format, never toLocaleString: Node and the browser ship different ICU data. */
  date: string;
  orderId: string;
  orderDate: string;
  lines: InvoiceLine[];
  taxableTotal: number;
  taxTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  grandTotal: number;
  /** True when the parcel leaves Maharashtra — IGST rather than CGST + SGST. */
  interState: boolean;
  buyerStateCode: string;
  buyerState: string;
  placeOfSupply: string;
  placeOfDelivery: string;
  amountInWords: string;
  payment: string;
};

/** Raised when an order cannot be invoiced. The message is shown to the operator verbatim. */
export class InvoiceError extends Error {}

const IST_OFFSET_MIN = 5 * 60 + 30;

/** The IST calendar date of an instant. Orders are placed in India; UTC would move a late-evening order to the next day. */
function istParts(iso: string | undefined): { d: number; m: number; y: number } {
  const t = iso ? new Date(iso) : new Date();
  const ist = new Date(t.getTime() + IST_OFFSET_MIN * 60_000);
  return { d: ist.getUTCDate(), m: ist.getUTCMonth() + 1, y: ist.getUTCFullYear() };
}

const dmy = ({ d, m, y }: { d: number; m: number; y: number }) =>
  `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;

/** The Indian financial year an IST date falls in — 1 April to 31 March. */
function financialYear({ m, y }: { m: number; y: number }): string {
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? `${t}-${ONES[n % 10]}` : t;
}

/** 1,23,456 in words, on the Indian lakh/crore scale rather than the western one. */
function words(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const push = (v: number, unit: string) => { if (v) parts.push(`${words(v)} ${unit}`); };
  push(Math.floor(n / 10000000), "Crore"); n %= 10000000;
  push(Math.floor(n / 100000), "Lakh"); n %= 100000;
  push(Math.floor(n / 1000), "Thousand"); n %= 1000;
  push(Math.floor(n / 100), "Hundred"); n %= 100;
  if (n) parts.push(twoDigits(n));
  return parts.join(" ");
}

/** "Two Hundred Sixty-Nine Rupees Only", with paise only when there are any. */
export function amountInWords(amount: number): string {
  const rupees = Math.floor(r2(amount));
  const paise = Math.round(r2(amount) * 100) % 100;
  const head = `${words(rupees)} Rupee${rupees === 1 ? "" : "s"}`;
  return paise ? `${head} and ${words(paise)} Paise Only` : `${head} Only`;
}

/** Split one tax-inclusive amount into taxable value and tax at GST_RATE. */
function split(gross: number, interState: boolean): Pick<InvoiceLine, "taxable" | "tax" | "cgst" | "sgst" | "igst"> {
  const taxable = r2(gross / (1 + GST_RATE / 100));
  // Tax is the remainder rather than a second rounding of its own, so
  // taxable + tax === gross to the paisa on every line and therefore in total.
  const tax = r2(gross - taxable);
  if (interState) return { taxable, tax, cgst: 0, sgst: 0, igst: tax };
  const cgst = r2(tax / 2);
  return { taxable, tax, cgst, sgst: r2(tax - cgst), igst: 0 };
}

function line(description: string, gross: number, qty: number, opts: { detail?: string; hsn?: string | null }, interState: boolean): InvoiceLine {
  return {
    description,
    detail: opts.detail,
    hsn: opts.hsn === undefined ? HSN_CODE : opts.hsn,
    qty,
    gross: r2(gross),
    unitGross: r2(gross / (qty || 1)),
    ...split(r2(gross), interState),
  };
}

/**
 * Build the invoice for an order.
 *
 * Throws `InvoiceError` when the delivery state cannot be placed — the one input
 * that cannot be defaulted, because it decides both the printed place of supply
 * and whether the tax is IGST or CGST + SGST.
 */
export function buildInvoice(order: InvoiceOrder): Invoice {
  const state = gstStateOf(order.address?.state);
  if (!state) {
    throw new InvoiceError(
      `Order ${order.id} has a delivery state we cannot place for GST: "${order.address?.state ?? ""}". ` +
      `Fix the state on the order, then print the invoice.`
    );
  }

  const interState = state.code !== SELLER.stateCode;
  const placed = istParts(order.created_at);

  const lines: InvoiceLine[] = order.items.map((i) => {
    const qty = i.quantity ?? 1;
    const variant = [i.color, i.size].filter(Boolean).join(", ");
    return line(i.name, i.price * qty, qty, { detail: variant || undefined }, interState);
  });

  const itemsGross = lines.reduce((s, l) => s + l.gross, 0);
  const shipping = order.shipping ?? 0;
  const codFee = order.cod_fee ?? 0;
  if (shipping) lines.push(line(order.gift_wrap ? "Shipping & gift wrap" : "Shipping charges", shipping, 1, { hsn: null }, interState));
  if (codFee) lines.push(line("COD handling fee", codFee, 1, { hsn: null }, interState));

  // The reconciling line. Positive allowance means the customer paid less than
  // the parts add up to (a coupon, a bundle price, a prepaid discount); negative
  // means more (a COD fee from before the column existed, an express charge that
  // never reached `shipping`). Named for its direction only — the orders table
  // does not record which of those it was, and guessing would put a wrong reason
  // on a tax document.
  const allowance = r2(itemsGross + shipping + codFee - order.total);
  if (allowance > 0) {
    // Where the order says an automatic offer made part of it, that part is its own line. The rest stays "Discount", and only that rest
    // may carry the coupon code: naming a coupon for money an offer took off would put a wrong reason on a tax document.
    const offerPart = Math.min(allowance, Math.max(0, r2(Number(order.offer_discount) || 0)));
    const rest = r2(allowance - offerPart);
    if (offerPart > 0) {
      const offerLines = Array.isArray(order.offers) ? order.offers.filter((o) => o?.label) : [];
      lines.push(line(offerLines.length === 1 ? String(offerLines[0].label) : "Offer", -offerPart, 1, { detail: "Automatic offer" }, interState));
    }
    if (rest > 0) lines.push(line("Discount", -rest, 1, { detail: order.coupon ? `Coupon ${order.coupon}` : undefined }, interState));
  } else if (allowance < 0) {
    lines.push(line("Other charges", -allowance, 1, { hsn: null }, interState));
  }

  const sum = (f: (l: InvoiceLine) => number) => r2(lines.reduce((s, l) => s + f(l), 0));
  const grandTotal = sum((l) => l.gross);

  const codAmount = order.cod_due ?? order.total;
  const payment =
    order.payment_id === "COD" ? `Cash on Delivery (₹${codAmount.toLocaleString("en-IN")} collected on delivery)`
    : order.cod_due ? `Part prepaid ₹${(order.amount_paid_online ?? 0).toLocaleString("en-IN")}, ₹${codAmount.toLocaleString("en-IN")} collected on delivery`
    : `Prepaid${order.payment_id ? ` (Razorpay ${order.payment_id})` : ""}`;

  return {
    // Derived from the order id, so a reprint is always the same number and no
    // two orders can collide. It is NOT a consecutive series: order ids skip, and
    // a strictly sequential register needs a counter in the database.
    number: `AJ/${financialYear(placed)}/${order.id.replace(/\D/g, "")}`,
    date: dmy(placed),
    orderId: order.id,
    orderDate: dmy(placed),
    lines,
    taxableTotal: sum((l) => l.taxable),
    taxTotal: sum((l) => l.tax),
    cgstTotal: sum((l) => l.cgst),
    sgstTotal: sum((l) => l.sgst),
    igstTotal: sum((l) => l.igst),
    grandTotal,
    interState,
    buyerStateCode: state.code,
    buyerState: state.name,
    placeOfSupply: state.name.toUpperCase(),
    placeOfDelivery: order.address?.city ?? "",
    amountInWords: amountInWords(grandTotal),
    payment,
  };
}

// ── The printed sheet ────────────────────────────────────────────────────────

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Rupees with two decimals and the sign outside the symbol: -₹30.00, not ₹-30.00. */
const rs = (n: number) =>
  `${n < 0 ? "-" : ""}₹${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * An address line worth printing.
 *
 * Two orders carry the literal string "undefined" as `line2` — a template that
 * interpolated a missing field somewhere upstream, saved into the row. It passes
 * every truthiness check there is, and it would print the word "undefined" into a
 * customer's address on a tax invoice. Dropped here rather than repaired at the
 * source, because the source is 2,800 rows old and the invoice must be right now.
 */
const addressLine = (v: string | undefined) => {
  // On one order it is the whole field; on another it is glued to the end of a
  // real line ("…Aundh Pune, undefined"), so both shapes have to go.
  const s = (v ?? "").replace(/[\s,]*\b(undefined|null)\b[\s,]*$/i, "").trim();
  return s && !/^(na|n\/a|-)$/i.test(s) ? s : "";
};

/**
 * The whole invoice as one printable A4 document.
 *
 * Lives here rather than in the admin page so it can be rendered without a
 * browser — which is the only way the layout gets checked before a customer sees
 * it — and so an email attachment or an API route can reuse it later without the
 * markup being copied.
 *
 * `printInvoice` is what the admin page calls; this returns the string.
 */
export function invoiceHtml(order: InvoiceOrder, awb?: { code?: string | null; courier?: string | null }): string {
  const inv = buildInvoice(order);
  const addr = order.address;
  const addrHtml = [
    esc(addr?.name),
    [addr?.line1, addr?.line2].map(addressLine).filter(Boolean).map(esc).join(",<br/>"),
    `${esc(addr?.city)} - ${esc(addr?.pincode)},`,
    `${esc(inv.buyerState)}, India`,
  ].filter(Boolean).join("<br/>");

  // Inter-state parcels carry one IGST column; within Maharashtra the same tax is
  // shown as CGST and SGST, which is one more column and a different total row.
  // Everything else about the sheet is identical.
  const taxHead = inv.interState
    ? `<th class="n" style="width:62px">IGST<br/>${GST_RATE}%</th>`
    : `<th class="n" style="width:56px">CGST<br/>${GST_RATE / 2}%</th><th class="n" style="width:56px">SGST<br/>${GST_RATE / 2}%</th>`;
  const taxCells = (l: InvoiceLine) => inv.interState
    ? `<td class="n">${rs(l.igst)}</td>`
    : `<td class="n">${rs(l.cgst)}</td><td class="n">${rs(l.sgst)}</td>`;

  const rows = inv.lines.map((l, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td>${esc(l.description)}${l.detail ? `<small>${esc(l.detail)}</small>` : ""}</td>
        <td class="c">${l.hsn ?? "&nbsp;"}</td>
        <td class="n">${rs(l.unitGross)}</td>
        <td class="c">${l.qty}</td>
        <td class="n">${rs(l.taxable)}</td>
        ${taxCells(l)}
        <td class="n">${rs(l.gross)}</td>
      </tr>`).join("");

  const shipped = awb?.code
    ? ` &nbsp;|&nbsp; Shipped via ${esc(awb.courier ?? "courier")}, AWB ${esc(awb.code)}`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"/><title>Tax Invoice ${esc(inv.number)}</title><style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #000; margin: 0; padding: 14mm; }
    @media print { body { padding: 0; } }
    .head { display: flex; justify-content: space-between; align-items: flex-start; }
    .brand { font-size: 28px; font-weight: 700; letter-spacing: .18em; color: #0f1f3d; }
    .brand small { display: block; font-size: 9px; font-weight: 400; letter-spacing: .22em; color: #6b7585; margin-top: 4px; }
    .doc { text-align: right; }
    .doc b { font-size: 14px; }
    .parties { display: flex; justify-content: space-between; gap: 30px; margin-top: 30px; }
    .parties > div { width: 49%; }
    .r { text-align: right; }
    h3 { font-size: 12px; margin: 0 0 6px; }
    p { margin: 0; line-height: 1.55; }
    .kv { margin-top: 12px; }
    .meta { display: flex; justify-content: space-between; margin-top: 20px; line-height: 1.7; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { border: 1px solid #000; padding: 5px 6px; vertical-align: top; }
    th { font-size: 10px; text-align: left; }
    .n { text-align: right; } .c { text-align: center; }
    td small { display: block; color: #333; font-size: 10px; margin-top: 2px; }
    tr.tot td { font-weight: 700; }
    .words { border: 1px solid #000; border-top: 0; padding: 5px 6px; font-weight: 700; }
    .sign { border: 1px solid #000; border-top: 0; padding: 10px 6px 6px; height: 84px; position: relative; }
    .sign span { font-weight: 700; }
    .sign b { position: absolute; right: 6px; bottom: 6px; }
    .rc { margin-top: 8px; }
    .foot { margin-top: 22px; font-size: 10px; color: #444; line-height: 1.7; border-top: 1px solid #ddd; padding-top: 9px; }
  </style></head><body>
    <div class="head">
      <div class="brand">AJUKI<small>${esc(SELLER.name)}</small></div>
      <div class="doc"><b>Tax Invoice/Bill of Supply/Cash Memo</b><div>(Original for Recipient)</div></div>
    </div>
    <div class="parties">
      <div>
        <h3>Sold By :</h3>
        <p>${esc(SELLER.name)}<br/>${SELLER.address.map(esc).join("<br/>")}</p>
        <div class="kv">
          <p><b>PAN No:</b> ${esc(SELLER.pan)}</p>
          <p><b>GST Registration No:</b> ${esc(SELLER.gstin)}</p>
          <p><b>State/UT Code:</b> ${esc(SELLER.stateCode)}</p>
        </div>
      </div>
      <div class="r">
        <h3>Billing Address :</h3>
        <p>${addrHtml}${addr?.phone ? `<br/>${esc(addr.phone)}` : ""}</p>
        <p style="margin-top:6px"><b>State/UT Code:</b> ${esc(inv.buyerStateCode)}</p>
        <h3 style="margin-top:14px">Shipping Address :</h3>
        <p>${addrHtml}</p>
        <p style="margin-top:6px"><b>State/UT Code:</b> ${esc(inv.buyerStateCode)}<br/>
          <b>Place of supply:</b> ${esc(inv.placeOfSupply)}<br/>
          <b>Place of delivery:</b> ${esc(inv.placeOfDelivery)}</p>
      </div>
    </div>
    <div class="meta">
      <div><b>Order Number:</b> ${esc(inv.orderId)}<br/><b>Order Date:</b> ${esc(inv.orderDate)}</div>
      <div class="r"><b>Invoice Number :</b> ${esc(inv.number)}<br/><b>Invoice Date :</b> ${esc(inv.date)}</div>
    </div>
    <table>
      <thead><tr>
        <th class="c" style="width:24px">Sl.<br/>No</th>
        <th>Description</th>
        <th class="c" style="width:42px">HSN</th>
        <th class="n" style="width:62px">Unit<br/>Price</th>
        <th class="c" style="width:26px">Qty</th>
        <th class="n" style="width:66px">Taxable<br/>Value</th>
        ${taxHead}
        <th class="n" style="width:68px">Total<br/>Amount</th>
      </tr></thead>
      <tbody>${rows}
        <tr class="tot">
          <td colspan="5">TOTAL:</td>
          <td class="n">${rs(inv.taxableTotal)}</td>
          ${inv.interState ? `<td class="n">${rs(inv.igstTotal)}</td>` : `<td class="n">${rs(inv.cgstTotal)}</td><td class="n">${rs(inv.sgstTotal)}</td>`}
          <td class="n">${rs(inv.grandTotal)}</td>
        </tr>
      </tbody>
    </table>
    <div class="words">Amount in Words:<br/>${esc(inv.amountInWords)}</div>
    <div class="sign"><span>For ${esc(SELLER.name)}:</span><b>Authorized Signatory</b></div>
    <div class="rc">Whether tax is payable under reverse charge - No</div>
    <div class="foot">
      Payment: ${esc(inv.payment)}${shipped}<br/>
      All prices on www.ajuki.in are inclusive of GST; the taxable value declared above is the price net of tax.<br/>
      Returns policy: www.ajuki.in/returns &nbsp;|&nbsp; ${esc(SELLER.email)} &nbsp;|&nbsp; ${esc(SELLER.phone)}
    </div>
  </body></html>`;
}
