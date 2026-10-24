// Delhivery — direct integration, not through Shiprocket.
//
// Required env vars:
//   DELHIVERY_API_TOKEN   — Settings > API Setup > "Request Live API Token" on
//                           one.delhivery.com. Regenerating it kills the old one
//                           instantly, so rotate during a quiet hour.
//   DELHIVERY_PICKUP_NAME — the pickup location's registered name, EXACTLY as it
//                           reads under Settings > Pickup Locations. Delhivery
//                           matches on this string and there is no API to list
//                           them, so a typo here fails every booking.
//   DELHIVERY_DEFAULT_WEIGHT_G — grams per shipment (default 500)
//   DELHIVERY_DEFAULT_LENGTH_CM / _WIDTH_CM / _HEIGHT_CM — cm (default 18/10/8)
//   DELHIVERY_SHIPPING_MODE — "Surface" (default) or "Express"
//   DELHIVERY_PICKUP_TIME   — hh:mm:ss the van should come (default 11:00:00)
//   DELHIVERY_TRANSPORT_SPEED — "D" standard TAT (default), or "F" for Next Day
//                           Delivery. The nearest thing this API has to a faster
//                           local service; there is no intracity mode.
//
// Endpoints were confirmed against the live API with our own token rather than
// taken from documentation:
//   GET  /c/api/pin-codes/json/?filter_codes=<pin>   serviceability
//   GET  /waybill/api/fetch/json/?count=<n>          allocate waybills
//   POST /api/cmu/create.json                        create shipment
//   GET  /api/v1/packages/json/?waybill=<awb>        track
//   POST /api/p/edit                                 cancel
//   POST /fm/request/new/                            raise a pickup request
//
// Payload fields follow Delhivery's own B2C order-creation spec, lifted from the
// developer portal's bundle (assets/order-creation.2522b7dd.js) because the page
// itself renders client-side and cannot be read. Two things from it worth
// keeping in mind:
//   - shipping_mode is "Surface/Express" and nothing else. There is no intracity
//     or same-day mode on this API, so a guess at one would be accepted silently
//     and shipped Surface.
//   - "The raw JSON body does not accept special characters: & # % ; \ . Use
//     URL-encoded payloads instead." This sends form-encoded, so that holds.
//
// THE TRAP: Delhivery answers 200 for failures too. A rejected booking comes
// back as HTTP 200 with {"error":true,"success":false,"rmk":"..."} — verified
// live: an empty shipment list returned 200 and "shipment list contains no
// data.". Checking res.ok alone would record a shipment that does not exist,
// which is exactly how a Shadowfax cancellation once reported success while the
// parcel stayed booked. Every call here reads the body.

import { samePhone } from "./phone";
import { codAmountFor, isCodOrder } from "./partialCod";

const BASE = "https://track.delhivery.com";

const SELLER_NAME = "AJUKI";
const SELLER_GST_TIN = "27AAAAA0000A1Z5";
// Must match the pickup location registered with Delhivery, character for
// character where it matters — this string is what prints on the label, and a
// returning parcel is routed by a human comparing the two.
//
// It used to end "Mumbai Suburban, MUMBAI" with no pincode, while the registered
// address ends "Maharashtra, India 400070". A returned parcel sat in the
// Kajupada facility for four days against the scan "Address on package is
// different from HQ address" — a return has nowhere to go if the label cannot be
// matched to a warehouse.
const RETURN_NAME = "EXAMPLE TRADERS B2C";
const RETURN_PHONE = "9000100013";
const RETURN_CITY = "Mumbai";
const RETURN_STATE = "Maharashtra";
const RETURN_PIN = "400070";
const SELLER_ADDRESS =
  "Example Building Shop No 4 / Plot No 299, Lal Bahadur Shastri Marg, Mumbai, Maharashtra, India 400070";
const HSN_CODE = "7117";

function token(): string {
  const t = process.env.DELHIVERY_API_TOKEN;
  if (!t) throw new Error("DELHIVERY_API_TOKEN is not set");
  return t;
}

function pickupName(): string {
  const n = process.env.DELHIVERY_PICKUP_NAME;
  if (!n) {
    throw new Error(
      "DELHIVERY_PICKUP_NAME is not set — it must match a name under Settings > Pickup Locations exactly",
    );
  }
  return n;
}

/** Retries network blips and 5xx only. A rejected booking is not retried: it
 *  would be rejected again, and a retry that did succeed would double-ship. */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, delays = [1000, 2000, 4000]): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const retryable =
        err instanceof TypeError ||
        (err instanceof Error && /5\d\d|network|ECONNRESET|ETIMEDOUT|timeout/i.test(err.message));
      if (!retryable || attempt === maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastError;
}

/**
 * Whatever Delhivery is complaining about, in one readable line.
 *
 * The message can arrive as `rmk`, as `error` (sometimes a string, sometimes the
 * boolean flag), or buried per-package in `packages[].remarks`. Digging for the
 * specific one first matters: the top-level text is often generic while the
 * package-level remark says the actual reason, and "an error occurred" tells
 * nobody which order to fix.
 */
function readableError(data: Record<string, unknown>, status: number): string {
  const pkgRemark = (data.packages as Array<{ remarks?: unknown; status?: string }> | undefined)
    ?.flatMap((p) => (Array.isArray(p.remarks) ? p.remarks : p.remarks ? [p.remarks] : []))
    .filter(Boolean)
    .join("; ");
  if (pkgRemark) return String(pkgRemark).slice(0, 200);

  if (typeof data.error === "string" && data.error.trim()) return data.error.slice(0, 200);
  if (typeof data.rmk === "string" && data.rmk.trim()) return data.rmk.slice(0, 200);
  if (typeof data.Error === "string" && data.Error.trim()) return data.Error.slice(0, 200);

  // Last resort: read whatever strings the body does carry, under whatever keys.
  // Delhivery does not use one error shape — a refused pickup came back as
  // {"prepaid":"Client wallet balance is 171.11 which is less than 500.0"},
  // which matched none of the names above, so the panel showed only "HTTP 400"
  // and four parcels sat booked with no van coming while the real reason was
  // sitting in the response all along.
  const loose = Object.values(data)
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join("; ");
  if (loose) return loose.slice(0, 200);

  return `Delhivery request failed (HTTP ${status})`;
}

/** ASCII-only, matching what the other couriers demand — phone keyboards
 *  substitute curly quotes and en-dashes that these APIs reject. */
function sanitize(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

const tenDigits = (phone: string) => phone.replace(/\D/g, "").slice(-10);

// ── Serviceability ───────────────────────────────────────────────────────────

export type Serviceability = {
  serviceable: boolean;
  cod: boolean;
  prepaid: boolean;
  district?: string;
  /** Out of delivery area — reachable, but slower and often surcharged. */
  oda?: boolean;
  /**
   * Their `repl` flag: whether a reverse / replacement pickup can be collected
   * from this pincode. NOT the same as `pickup`, which is about collecting a
   * forward consignment from a seller there.
   *
   * AND IT IS NOT RELIABLE. 451221 answers pickup=Y, repl=N — and Delhivery
   * then scheduled a reverse pickup from 451221 on 2026-09-12 (waybill
   * 60000000000005). Never gate a booking on this; ask the carrier and use this
   * only to explain a refusal that already mentions serviceability.
   */
  reversePickup?: boolean;
};

/** Whether Delhivery delivers to a pincode, and whether it will collect COD
 *  there. Cheap and read-only, so it is worth calling before booking rather
 *  than discovering the answer as a failed shipment. */
export async function checkServiceability(pincode: string): Promise<Serviceability | null> {
  const pin = pincode.replace(/\D/g, "");
  if (pin.length !== 6) return null;

  return withRetry(async () => {
    const res = await fetch(`${BASE}/c/api/pin-codes/json/?filter_codes=${pin}`, {
      headers: { Authorization: `Token ${token()}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Delhivery serviceability failed (HTTP ${res.status})`);
    const data = await res.json();
    const code = (data?.delivery_codes ?? [])[0]?.postal_code;
    if (!code) return { serviceable: false, cod: false, prepaid: false, reversePickup: false };
    return {
      serviceable: true,
      cod: code.cod === "Y",
      prepaid: code.pre_paid === "Y",
      district: code.district,
      oda: code.is_oda === "Y",
      reversePickup: code.repl === "Y",
    };
  });
}

// ── Waybills ─────────────────────────────────────────────────────────────────

/**
 * Reserve waybill numbers.
 *
 * Create can allocate one itself, but asking first means the number is known
 * before the shipment exists — so a create that times out mid-flight can be
 * chased by waybill rather than guessed at.
 */
export async function fetchWaybills(count = 1): Promise<string[]> {
  return withRetry(async () => {
    const res = await fetch(`${BASE}/waybill/api/fetch/json/?count=${count}`, {
      headers: { Authorization: `Token ${token()}`, Accept: "application/json" },
    });
    const text = (await res.text()).trim();
    if (!res.ok) throw new Error(`Delhivery waybill fetch failed (HTTP ${res.status})`);
    // Comes back as a quoted string — one waybill, or several comma-separated.
    const cleaned = text.replace(/^"|"$/g, "");
    const list = cleaned.split(",").map((w) => w.trim()).filter(Boolean);
    if (!list.length) throw new Error("Delhivery returned no waybills");
    return list;
  });
}

// ── Create ───────────────────────────────────────────────────────────────────

export type DelhiveryShipment = {
  waybill: string;
  tracking_url: string;
  /** "Express" or "Surface" — what was actually booked. */
  mode: string;
  /** Delhivery's own note on the created package, when it left one. */
  remark?: string;
};

export async function createDelhiveryShipment(
  order: {
    id: string;
    payment_id: string;
    total: number;
    /** Set on a partial-COD order — see isCodOrder/codAmountFor in partialCod.ts. */
    amount_paid_online?: number | null;
    cod_due?: number | null;
    /** "express" when the customer paid the extra fee at checkout. */
    shipping_method?: string | null;
    items: { name: string; quantity: number; color?: string; size?: string }[];
    address: {
      name: string; phone: string; altPhone?: string;
      line1: string; line2?: string; city: string; state: string; pincode: string;
    };
  },
  /** Force the service regardless of what the customer paid — the per-order
   *  Express button. Left undefined, the order decides. */
  opts: { express?: boolean } = {},
): Promise<DelhiveryShipment> {
  const addr = order.address;
  // A partial-COD order's payment_id is a real Razorpay id, not "COD" — but
  // cash is still owed at the door, so it must still be booked as COD or
  // Delhivery zeroes cod_amount regardless of what we send there.
  const isCOD = isCodOrder(order);
  const quantity = order.items.reduce((sum, i) => sum + i.quantity, 0);
  const productsDesc = sanitize(
    order.items
      .map((i) => [i.name, i.color, i.size].filter(Boolean).join(" - ") + (i.quantity > 1 ? ` x${i.quantity}` : ""))
      .join("; "),
  );

  const express = opts.express ?? order.shipping_method === "express";
  const phone = tenDigits(addr.phone);
  const alt = addr.altPhone && !samePhone(addr.altPhone, addr.phone) ? tenDigits(addr.altPhone) : "";

  const shipment: Record<string, unknown> = {
    name: sanitize(addr.name),
    add: sanitize([addr.line1, addr.line2].filter(Boolean).join(", ")),
    city: sanitize(addr.city),
    state: sanitize(addr.state),
    country: "India",
    pin: addr.pincode.replace(/\D/g, ""),
    phone,
    ...(alt ? { alt_phone: alt } : {}),

    order: order.id,
    // Their docs ask for the sample payload's optional fields too — "good to
    // have for optimal processing" — so the ones we can fill honestly are sent.
    order_date: new Date().toISOString().slice(0, 10),
    seller_inv: order.id,
    // COD collects the full order value; a prepaid parcel must collect zero, and
    // sending the total here regardless would have couriers asking paid
    // customers for money at the door.
    payment_mode: isCOD ? "COD" : "Prepaid",
    // See codAmountFor: on a partial COD order this is the balance plus the
    // COD fee, not the order total.
    cod_amount: codAmountFor(order),
    total_amount: order.total,

    products_desc: productsDesc,
    // Typed `string` in the spec, so sent as one even though a number is
    // accepted — matching the contract is cheaper than finding out where it
    // stops being accepted.
    quantity: String(quantity),
    hsn_code: HSN_CODE,
    seller_name: SELLER_NAME,
    seller_add: SELLER_ADDRESS,
    seller_gst_tin: SELLER_GST_TIN,

    // Where a refused parcel goes. Delhivery's pickup location has "return
    // address is the same as pickup" ticked, so omitting these did not misroute
    // anything — but nothing was printed on the label for a returns clerk to
    // read either, which is how one sat in a facility for four days. Stated
    // explicitly, structured, and matching the registered warehouse.
    return_name: RETURN_NAME,
    return_add: SELLER_ADDRESS,
    return_city: RETURN_CITY,
    return_state: RETURN_STATE,
    return_country: "India",
    return_pin: RETURN_PIN,
    return_phone: RETURN_PHONE,

    weight: Number(process.env.DELHIVERY_DEFAULT_WEIGHT_G ?? 500),
    shipment_length: Number(process.env.DELHIVERY_DEFAULT_LENGTH_CM ?? 18),
    shipment_width: Number(process.env.DELHIVERY_DEFAULT_WIDTH_CM ?? 10),
    shipment_height: Number(process.env.DELHIVERY_DEFAULT_HEIGHT_CM ?? 8),
    // A customer who paid ₹99 for Express gets Express carriage, without anyone
    // having to remember. Booking those on Surface is how an express order ends
    // up arriving at standard speed with the fee already collected — the exact
    // complaint that surfaced the estimated-delivery bug.
    shipping_mode: express ? "Express" : (process.env.DELHIVERY_SHIPPING_MODE ?? "Surface"),
    // "F" = Next Day Delivery, "D" = standard TAT.
    transport_speed: process.env.DELHIVERY_TRANSPORT_SPEED ?? "D",

    fragile_shipment: false,
  };

  const body = new URLSearchParams();
  body.set("format", "json");
  body.set("data", JSON.stringify({ shipments: [shipment], pickup_location: { name: pickupName() } }));

  return withRetry(async () => {
    const res = await fetch(`${BASE}/api/cmu/create.json`, {
      method: "POST",
      headers: {
        Authorization: `Token ${token()}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    const raw = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Delhivery returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
    }

    // 200 is not success here — see the note at the top of this file.
    const packages = (data.packages as Array<{ waybill?: string; status?: string; remarks?: unknown }>) ?? [];
    const pkg = packages[0];
    const ok = data.success === true && pkg?.waybill && pkg.status !== "Fail";
    if (!ok) throw new Error(readableError(data, res.status));

    const remarks = Array.isArray(pkg.remarks) ? pkg.remarks.filter(Boolean).join("; ") : String(pkg.remarks ?? "");
    return {
      waybill: pkg.waybill!,
      tracking_url: `https://www.delhivery.com/track/package/${pkg.waybill}`,
      mode: express ? "Express" : (process.env.DELHIVERY_SHIPPING_MODE ?? "Surface"),
      ...(remarks ? { remark: remarks } : {}),
    };
  });
}

// ── Track ────────────────────────────────────────────────────────────────────

/**
 * Book a reverse pickup: collect from the customer's door, return to us.
 *
 * Same endpoint and the same payload shape as a forward booking — Delhivery's
 * own words are that "the process of order creation is the same for both
 * forward flow and reverse flow". Three things change:
 *
 *   payment_mode  "Pickup" instead of COD/Prepaid. This is the whole switch.
 *   cod_amount    0. A reverse leg never collects money; anything else here has
 *                 a rider asking a customer for cash on a return.
 *   products_desc only the items coming back, not the whole order.
 *
 * The addresses do NOT swap. The consignee is still the customer — on a reverse
 * that is the door being visited — and the return_* fields, which already point
 * at our warehouse, become where the parcel is delivered to.
 *
 * WHY A SECOND COURIER EXISTS FOR THIS
 *
 * Shadowfax refused a live return on 12 Sep 2026: "Invalid Pickup Pincode.
 * Pickup pincode 451221 is not serviceable." One carrier's reverse network has
 * holes another's may not, and a customer whose pincode falls in one of them
 * otherwise has an approved return that can never be collected.
 *
 * Check serviceability first (`reversePickup` on checkServiceability) — it is a
 * cheap read, and it turns "the courier refused" into "we knew before asking".
 */
export async function createDelhiveryReversePickup(
  order: {
    id: string;
    total: number;
    items: { name: string; quantity: number; color?: string; size?: string; price?: number }[];
    return_request?: { item_indexes?: number[]; reason?: string } | null;
    address: {
      name: string; phone: string; altPhone?: string;
      line1: string; line2?: string; city: string; state: string; pincode: string;
    };
  },
): Promise<DelhiveryShipment> {
  const addr = order.address;
  const pin = addr.pincode.replace(/\D/g, "");
  const phone = tenDigits(addr.phone);

  if (!addr.name || phone.length < 10 || !addr.line1 || pin.length !== 6) {
    throw new Error("Return address is incomplete — Delhivery will reject this pickup.");
  }

  // Only what is coming back. No item_indexes means the whole order, which is
  // what every request raised before /returns/start meant.
  const idx = order.return_request?.item_indexes;
  const coming = idx?.length ? idx.map((i) => order.items?.[i]).filter(Boolean) : (order.items ?? []);
  if (!coming.length) throw new Error("No items on this return — nothing to collect.");

  const quantity = coming.reduce((sum, i) => sum + (i.quantity ?? 1), 0);
  const productsDesc = sanitize(
    coming
      .map((i) => [i.name, i.color, i.size].filter(Boolean).join(" - ") + ((i.quantity ?? 1) > 1 ? ` x${i.quantity}` : ""))
      .join("; "),
  );
  // The goods coming back, not the order total: the declared value is what gets
  // claimed if the parcel is lost on the way to us.
  const declared = Math.max(
    1,
    Math.round(coming.reduce((sum, i) => sum + (i.price ?? 0) * (i.quantity ?? 1), 0)) || Math.round(order.total),
  );

  const alt = addr.altPhone && !samePhone(addr.altPhone, addr.phone) ? tenDigits(addr.altPhone) : "";

  const shipment: Record<string, unknown> = {
    name: sanitize(addr.name),
    add: sanitize([addr.line1, addr.line2].filter(Boolean).join(", ")),
    city: sanitize(addr.city),
    state: sanitize(addr.state),
    country: "India",
    pin,
    phone,
    ...(alt ? { alt_phone: alt } : {}),

    // Suffixed so it cannot collide with the forward parcel's order id on their
    // side — the same order now has two legs.
    order: `${order.id}-R`,
    order_date: new Date().toISOString().slice(0, 10),
    seller_inv: order.id,

    // The switch that makes this a reverse.
    payment_mode: "Pickup",
    cod_amount: 0,
    total_amount: declared,

    products_desc: productsDesc,
    quantity: String(quantity),
    hsn_code: HSN_CODE,
    seller_name: SELLER_NAME,
    seller_add: SELLER_ADDRESS,
    seller_gst_tin: SELLER_GST_TIN,

    // On a reverse these are the destination — where the collected parcel is
    // delivered. Same warehouse a forward RTO comes back to.
    return_name: RETURN_NAME,
    return_add: SELLER_ADDRESS,
    return_city: RETURN_CITY,
    return_state: RETURN_STATE,
    return_country: "India",
    return_pin: RETURN_PIN,
    return_phone: RETURN_PHONE,

    weight: Number(process.env.DELHIVERY_DEFAULT_WEIGHT_G ?? 500),
    shipment_length: Number(process.env.DELHIVERY_DEFAULT_LENGTH_CM ?? 18),
    shipment_width: Number(process.env.DELHIVERY_DEFAULT_WIDTH_CM ?? 10),
    shipment_height: Number(process.env.DELHIVERY_DEFAULT_HEIGHT_CM ?? 8),
    shipping_mode: "Surface",
    fragile_shipment: false,
  };

  const body = new URLSearchParams();
  body.set("format", "json");
  body.set("data", JSON.stringify({ shipments: [shipment], pickup_location: { name: pickupName() } }));

  return withRetry(async () => {
    const res = await fetch(`${BASE}/api/cmu/create.json`, {
      method: "POST",
      headers: {
        Authorization: `Token ${token()}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    const data = await res.json().catch(() => ({}));
    // Delhivery answers HTTP 200 for failures — a rejected booking is
    // {"error":true,"success":false,"rmk":"..."} — so the body is what decides.
    const pkg = (data?.packages ?? [])[0];
    const waybill = pkg?.waybill;
    if (!res.ok || data?.error || !waybill) {
      const why = pkg?.remarks?.join?.("; ") || data?.rmk || data?.error || `HTTP ${res.status}`;
      throw new Error(`Delhivery rejected this pickup: ${String(why).slice(0, 200)}`);
    }

    return {
      waybill,
      tracking_url: `https://www.delhivery.com/track/package/${waybill}`,
      mode: "Surface",
      remark: pkg?.remarks?.join?.("; ") || undefined,
    };
  });
}

export type DelhiveryTracking = {
  status: string;
  statusType?: string;
  /** e.g. "EOD-104" — what NDR_ELIGIBLE_CODES is checked against. */
  statusCode?: string;
  location?: string;
  /** Free-text instruction on the latest scan, when present. */
  instructions?: string;
  /** When Delhivery says the latest scan happened (tz-less, IST). */
  statusDateTime?: string | null;
  /** Delhivery's own promised date, when it has one. */
  promisedDate?: string | null;
  deliveredAt?: string | null;
};

/**
 * Live status for one waybill, or null when Delhivery has nothing on it.
 *
 * An unknown waybill answers 200 with {"Success":false}, so the absence of data
 * is not an error and must not be raised as one — it is the normal answer for a
 * parcel booked minutes ago.
 */
export async function trackDelhivery(waybill: string): Promise<DelhiveryTracking | null> {
  return withRetry(async () => {
    const res = await fetch(`${BASE}/api/v1/packages/json/?waybill=${encodeURIComponent(waybill)}`, {
      headers: { Authorization: `Token ${token()}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Delhivery tracking failed (HTTP ${res.status})`);
    const data = await res.json();
    if (data?.Success === false) return null;

    const shipment = (data?.ShipmentData ?? [])[0]?.Shipment;
    if (!shipment) return null;
    const st = shipment.Status ?? {};
    return {
      status: st.Status ?? "",
      statusType: st.StatusType ?? undefined,
      statusCode: st.StatusCode ?? undefined,
      location: st.StatusLocation ?? undefined,
      instructions: st.Instructions ?? undefined,
      statusDateTime: st.StatusDateTime ?? null,
      promisedDate: shipment.PromisedDeliveryDate ?? shipment.ExpectedDeliveryDate ?? null,
      deliveredAt: shipment.DeliveryDate ?? null,
    };
  });
}

// ── Cancel ───────────────────────────────────────────────────────────────────

/**
 * Take COD off a parcel that is already on its way — the customer paid online.
 *
 * Two fields, and neither is named what you would guess.
 *
 *   pt   the payment type. NOT `payment_mode`, which is what
 *        createDelhiveryShipment sends and is the obvious first try; on this
 *        endpoint it is silently ignored.
 *   cod  the collectable amount. NOT `cod_amount`, likewise ignored here, and
 *        likewise the name used at creation.
 *
 * Both were found by probing, because none of this is in their documentation.
 * Against a cancelled waybill, where an edit could do no harm, only `pt` drew a
 * reasoned answer while `payment_mode`, `cod_amount` and a field we invented all
 * returned the same bare `{"status":false}`.
 *
 * Then verified end to end on a live manifested parcel (AJUKI710060, AWB
 * 60000000000003), reading the package record before and after rather than
 * trusting the reply:
 *
 *   before   CODAmount 499  OrderType "COD"
 *   after    CODAmount 0    OrderType "Pre-paid"
 *   restored CODAmount 499  OrderType "COD"     via { pt: "COD", cod: 499 }
 *
 * `pt` alone does zero the amount, but both are sent: the failure mode here is a
 * rider collecting cash from someone who has already paid, and that is not a
 * place to depend on the far end inferring what we meant.
 *
 * Which is also why this reads the body. Per this file's opening note, Delhivery
 * answers 200 for failures too, and a refused payment-mode change would
 * otherwise look exactly like a successful one.
 */
/**
 * Delhivery statuses where an edit is still accepted.
 *
 * An allowlist, not a blocklist, and that is the whole point. Getting this wrong
 * in one direction costs a missed conversion; getting it wrong in the other
 * takes money for a parcel the rider is still going to collect cash on, which is
 * the exact failure this file exists to prevent. So anything unrecognised is
 * refused.
 *
 * The upper bound was found the way the edit endpoint itself was — on a live
 * parcel. On 16 Aug 2026 order AJUKI710016 went "Out for delivery" at 10:30 and
 * the customer paid at 11:51, and Delhivery answered: "Shipment data cannot be
 * changed as Current status is UD Dispatched." The rider was already carrying it
 * with ₹449 to collect against ₹394 taken online. Their docs say nothing about
 * this; before that order nobody knew the window closed at dispatch.
 */
const COD_EDITABLE_STATUSES = [
  "manifested",
  "not picked",
  "pickup scheduled",
  "in transit",
  "pending",
];

/**
 * Will Delhivery still accept a COD edit on this parcel?
 *
 * Null tracking is a no. An outage is indistinguishable from a parcel already on
 * a rider, and only one of those is safe to guess at.
 */
export function delhiveryAcceptsCodEdit(t: Pick<DelhiveryTracking, "status"> | null): boolean {
  const status = (t?.status ?? "").trim().toLowerCase();
  if (!status) return false;
  return COD_EDITABLE_STATUSES.some((ok) => status === ok || status.startsWith(`${ok} `));
}

export async function clearDelhiveryCod(waybill: string): Promise<void> {
  const res = await fetch(`${BASE}/api/p/edit`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ waybill, pt: "Pre-paid", cod: 0 }),
  });

  const raw = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Delhivery returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  // `status: false` with no error is their silent no-op, and it is what an
  // unrecognised field returns — so anything that is not an outright true is a
  // failure here, not an ambiguity to be optimistic about.
  if (data.status !== true && data.success !== true) {
    throw new Error(`Delhivery refused to clear COD on ${waybill}: ${readableError(data, res.status)}`);
  }
}

/** Cancel a booked parcel. Only possible before pickup; Delhivery refuses once
 *  the parcel is in its network, and that refusal also arrives as HTTP 200. */
export async function cancelDelhiveryShipment(waybill: string): Promise<void> {
  const res = await fetch(`${BASE}/api/p/edit`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ waybill, cancellation: "true" }),
  });

  const raw = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Delhivery returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  if (data.status !== true && data.success !== true) throw new Error(readableError(data, res.status));
}

// ── NDR actions ──────────────────────────────────────────────────────────────
//
// Delhivery's documented "Asynchronous NDR Package Action API" — found via their
// public docs, not probed, because guessing at an undocumented field on a live
// customer parcel (rather than a cancelled test one) was not a risk worth
// taking. Source:
// https://delhivery-express-api-doc.readme.io/reference/asynchronous-ndr-package-action-api

/**
 * StatusCodes where Delhivery accepts a **RE-ATTEMPT** — the parcel goes back
 * out for another try with no other change.
 *
 * The list is Delhivery's, matched against the Remarks column of an HQ shipments
 * export rather than taken from prose. A waybill outside it — already RTO'd,
 * already delivered, never attempted — is refused, and that refusal is worth
 * surfacing rather than swallowing: acting on the wrong parcel is worse than
 * not acting.
 *
 * `ST-108` ("maximum attempts reached") was on this list per the docs, and was
 * removed 2026-09-03 after the live reconciliation showed every action on it
 * rejected with "Shipment has reached maximum attempt count" — 4/4 on the first
 * day. Delhivery's docs list it as eligible; the API does not honour it. A
 * maxed-out parcel is committed to RTO and only a manual KAM call can move it,
 * so the cron surfaces these (see MAXED_OUT_CODES) instead of spending a
 * guaranteed-reject request on them.
 */
export const NDR_ELIGIBLE_CODES = new Set([
  "EOD-74", "EOD-15", "EOD-104", "EOD-43", "EOD-86",
  "EOD-11", "EOD-16", "EOD-69", "EOD-6",
]);

/**
 * StatusCodes where Delhivery accepts a **DEFER_DLV** (reschedule to a dated
 * attempt). `[DOCUMENTED]` — and deliberately NOT the same list as
 * NDR_ELIGIBLE_CODES: DEFER adds EOD-3 and drops EOD-104 / EOD-43 / EOD-86 /
 * EOD-69. In particular **EOD-86 ("not attempted") is not deferrable** — the
 * rider never went, so it stays a plain RE-ATTEMPT.
 *
 * `ST-108` removed here too, same reason as above — the docs say it defers, the
 * API rejects it.
 */
export const DEFER_ELIGIBLE_CODES = new Set([
  "EOD-74", "EOD-15", "EOD-11", "EOD-3", "EOD-16", "EOD-6",
]);

/**
 * StatusCodes that mean the parcel is out of moves — Delhivery has made its
 * maximum attempts and will RTO it. No NDR action is accepted (verified live
 * 2026-09-03: "Shipment has reached maximum attempt count"). The cron collects
 * these into the sweep summary so a human can decide whether to chase the KAM,
 * rather than silently skipping them or burning a request that always fails.
 */
export const MAXED_OUT_CODES = new Set(["ST-108"]);

/**
 * Reject reasons from get_bulk_upl that are *transient* — the parcel is on a
 * delivery run right now, so Delhivery locks edits until that attempt finishes
 * ("Package is part of dispatch. Cannot update information now"). Not a refusal
 * of the instruction, just bad timing: the parcel drops back to NDR-pending
 * after the attempt fails and the same request lands then. The cron keeps these
 * retryable rather than closing them as rejected.
 *
 * "Package in incorrect status" added 2026-09-04 — seen live the first day
 * P0.1 ran (3 of that day's rejections), and it's the exact generic phrasing
 * Delhivery's own API docs use for this same "wrong moment to ask" case (their
 * get_bulk_upl example response uses this precise string). Same live day: the
 * batch that got rejected "part of dispatch" during the afternoon was
 * re-submitted at the next 00:00 UTC (pre-dispatch) run and 16 of 17 landed —
 * confirming the timing read is correct, not just a theory.
 */
export const TRANSIENT_NDR_REJECT = /part of dispatch|cannot update information now|being dispatched|in dispatch|incorrect status/i;

/**
 * Of the DEFER-eligible codes, the ones where a bare RE-ATTEMPT demonstrably
 * changes nothing — the same rider is sent back to the same door.
 *
 *   EOD-11  consignee unavailable
 *   EOD-6   refused / consignee not reachable
 *   EOD-16  consignee unavailable / shifted
 *
 * For these the cron routes to deferDelhiveryDelivery(nextWorkingDay()); every
 * other RE-ATTEMPT-eligible code keeps a plain RE-ATTEMPT. Root cause #2 of the
 * 56% RTO rate: 211 asked, 119 came back, and a bare RE-ATTEMPT on an
 * "unavailable" consignee is most of that.
 *
 * TODO(verify against KAM): whether DEFER_DLV is simply better for ALL
 * RE-ATTEMPT codes (open question #3/#7 in the research doc). If so, widen this
 * to equal DEFER_ELIGIBLE_CODES.
 */
export const DEFER_PREFERRED_CODES = new Set(["EOD-11", "EOD-6", "EOD-16"]);

/**
 * One item in a `/api/p/update` batch.
 *
 * RE-ATTEMPT carries nothing extra; DEFER_DLV and EDIT_DETAILS nest their fields
 * inside `action_data` (NOT flat on the item — a flat `deferred_date` is
 * silently ignored). `[DOCUMENTED]`
 */
export type NdrActionItem =
  | { waybill: string; act: "RE-ATTEMPT" }
  | { waybill: string; act: "DEFER_DLV"; action_data: { deferred_date: string } }
  | { waybill: string; act: "EDIT_DETAILS"; action_data: { name?: string; add?: string; phone?: string } };

/** Self-imposed cap on items per `/api/p/update` call. Delhivery publishes no
 *  ceiling; this mirrors the caution used for packing_slip (hard ceiling 9) and
 *  create.json. TODO(verify against KAM): the real limit. */
export const NDR_ACTION_BATCH_CAP = 50;

/**
 * POST a batch of NDR package actions. Returns the ONE `request_id` Delhivery
 * issues to cover the whole batch — store it against every order in the batch,
 * because Get NDR Status is keyed by it.
 *
 * Endpoint: `POST /api/p/update`, JSON `{ data: NdrActionItem[] }`,
 * `Authorization: Token <token>`. Success is **HTTP 201** with
 * `{ "message": "Request submitted successfully!", "request_id": "UPL…" }`.
 * https://delhivery-express-api-doc.readme.io/reference/asynchronous-ndr-package-action-api
 *
 * **This call succeeding proves nothing.** Per this file's opening note a 2xx is
 * not proof on this API — verified 14 Aug against a made-up act name, which was
 * also accepted — and being asynchronous, even a clean 201 only means the batch
 * was queued. The real per-(waybill, action) outcome comes from
 * getDelhiveryNdrStatus(request_id) on a later run.
 */
export async function requestDelhiveryNdrActions(
  items: NdrActionItem[],
): Promise<{ ok: true; requestId?: string }> {
  if (!items.length) throw new Error("requestDelhiveryNdrActions: no items");
  if (items.length > NDR_ACTION_BATCH_CAP) {
    throw new Error(`requestDelhiveryNdrActions: ${items.length} items exceeds the ${NDR_ACTION_BATCH_CAP} cap — chunk before calling`);
  }
  for (const it of items) {
    if (it.act === "DEFER_DLV" && !/^\d{4}-\d{2}-\d{2}$/.test(it.action_data.deferred_date)) {
      throw new Error(`DEFER_DLV deferred_date must be YYYY-MM-DD, got "${it.action_data.deferred_date}"`);
    }
  }

  const res = await fetch(`${BASE}/api/p/update`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ data: items }),
  });

  const raw = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Delhivery returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  // 201 is the documented success code; res.ok already covers it. A 401 comes
  // back as { detail: "Authentication credentials were not provided" }.
  if (!res.ok) throw new Error(readableError(data, res.status));

  const requestId =
    typeof data.request_id === "string" && data.request_id.trim() ? data.request_id.trim()
    // Older/other spellings kept only as a fallback — the documented key is request_id.
    : typeof data.upl === "string" && data.upl.trim() ? data.upl.trim()
    : typeof data.upload_id === "string" && data.upload_id.trim() ? data.upload_id.trim()
    : undefined;
  return { ok: true, requestId };
}

/**
 * Ask Delhivery to make another delivery attempt on a parcel stuck as an NDR.
 *
 * The fix for the courier's biggest RTO cause: 10 of 12 direct-Delhivery RTOs
 * measured 10 Aug carried "No client instructions to Reattempt" — the parcel
 * failed once and nothing ever told Delhivery to try again.
 *
 * Returns `uploadId` = the batch `request_id` (single-item batch here). Re-check
 * with getDelhiveryNdrStatus rather than trust this as confirmation.
 */
export async function requestDelhiveryReattempt(waybill: string): Promise<{ ok: true; uploadId?: string }> {
  const { requestId } = await requestDelhiveryNdrActions([{ waybill, act: "RE-ATTEMPT" }]);
  return { ok: true, uploadId: requestId };
}

/**
 * Ask Delhivery to reschedule a parcel's delivery to a specific date.
 *
 * `deferredDate` is `YYYY-MM-DD` (see nextWorkingDay). Nested under `action_data`
 * per the docs. Delhivery caps the date at `first_pending_date + 6 days` (a
 * window that shrinks as the parcel sits in NDR); we cannot know that ceiling
 * without tracking history, so this just submits and lets getDelhiveryNdrStatus
 * report a `failed_wbns` entry if the date was out of range.
 *
 * Returns `uploadId` = the batch `request_id`.
 */
export async function deferDelhiveryDelivery(
  waybill: string,
  deferredDate: string,
): Promise<{ ok: true; uploadId?: string }> {
  const { requestId } = await requestDelhiveryNdrActions([
    { waybill, act: "DEFER_DLV", action_data: { deferred_date: deferredDate } },
  ]);
  return { ok: true, uploadId: requestId };
}

/**
 * Edit the consignee name / address / phone on a pending NDR parcel.
 *
 * `address` is a single free-text string (Delhivery's `add` field) — this act
 * cannot change pincode or city; that needs `/api/p/edit` (the endpoint
 * clearDelhiveryCod already uses). Send only the fields that change.
 *
 * Here for P1 (address-correction on NDR parcels); the cron does not call it
 * yet. Same async caveat — confirm via getDelhiveryNdrStatus.
 */
export async function editDelhiveryNdrDetails(
  waybill: string,
  details: { name?: string; address?: string; phone?: string },
): Promise<{ ok: true; uploadId?: string }> {
  const action_data: { name?: string; add?: string; phone?: string } = {};
  if (details.name != null) action_data.name = sanitize(details.name);
  if (details.address != null) action_data.add = sanitize(details.address);
  if (details.phone != null) action_data.phone = tenDigits(details.phone);
  if (!Object.keys(action_data).length) throw new Error("editDelhiveryNdrDetails: nothing to change");

  const { requestId } = await requestDelhiveryNdrActions([{ waybill, act: "EDIT_DETAILS", action_data }]);
  return { ok: true, uploadId: requestId };
}

/**
 * Ask Delhivery what became of the NDR actions queued under one `request_id`.
 *
 * The submit call is fire-and-forget — it returns a `request_id` and nothing
 * else. This is the other half: `GET /api/cmu/get_bulk_upl/<request_id>?verbose=true`,
 * which reports each (waybill, action) pair as either honoured or refused. It
 * closes the blind spot that let 119 of 211 asked parcels RTO before anyone saw
 * the requests were not landing.
 *
 * The documented response shape:
 *   {
 *     status: "Partial" | "Success" | "Failed",
 *     success_wbns: [ { waybill, message: "", action } ],   // honoured
 *     failed_wbns:  [ { waybill, message: "<why>", action } ] // refused
 *   }
 * Outcome is **per (waybill, action) pair** — the same waybill can be in both
 * arrays for different acts. Do not branch on the top-level `status`; branch on
 * which array a pair sits in. Use ndrOutcomeForWaybill(raw, waybill, act) for
 * that; the `state` here is a batch-level summary only.
 *
 *   404 `{}` / both arrays empty  → the batch is still being processed → `pending`
 *   any failed pair, no success   → `rejected`
 *   any success pair, no failed   → `accepted`
 *   both                          → `rejected` (so a partial batch draws a look)
 *   non-JSON / malformed          → `unknown` (the lookup itself is broken — a
 *                                   different alarm from `pending`)
 *
 * Host confirmed 2026-09-03: GET track.delhivery.com/api/cmu/get_bulk_upl/<id>
 * with our token returns 404 {} for an unknown id (not DNS/HTML) — right host,
 * auth accepted. Still open: whether a still-processing request_id returns 404
 * or 200-with-empty-arrays (both handled as `pending`).
 */
export type NdrPairOutcome = "accepted" | "rejected" | "pending" | "unknown";

export type DelhiveryNdrStatus = {
  state: NdrPairOutcome;
  raw: unknown;
};

type NdrStatusRow = { waybill?: unknown; message?: unknown; action?: unknown };

export async function getDelhiveryNdrStatus(uplId: string): Promise<DelhiveryNdrStatus> {
  return withRetry(async () => {
    const res = await fetch(
      `${BASE}/api/cmu/get_bulk_upl/${encodeURIComponent(uplId)}?verbose=true`,
      { headers: { Authorization: `Token ${token()}`, Accept: "application/json" } },
    );
    // 5xx is retried by withRetry. A 404 is documented as "{}" and is most
    // likely "not processed yet" rather than a hard error, so it is read as
    // pending below rather than raised.
    if (res.status >= 500) throw new Error(`Delhivery get_bulk_upl ${res.status}`);

    const rawText = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(rawText);
    } catch {
      return { state: "unknown" as const, raw: rawText };
    }
    if (res.status === 404) return { state: "pending" as const, raw: data };
    if (!res.ok) return { state: "unknown" as const, raw: data };

    const body = (data ?? {}) as { success_wbns?: unknown; failed_wbns?: unknown };
    const success = Array.isArray(body.success_wbns) ? (body.success_wbns as NdrStatusRow[]) : [];
    const failed = Array.isArray(body.failed_wbns) ? (body.failed_wbns as NdrStatusRow[]) : [];

    let state: NdrPairOutcome;
    if (!success.length && !failed.length) state = "pending";
    else if (failed.length) state = "rejected";
    else state = "accepted";

    return { state, raw: data };
  });
}

/**
 * Resolve one (waybill, action) pair against a get_bulk_upl body.
 *
 * `success_wbns` → accepted, `failed_wbns` → rejected, neither → pending (still
 * draining). Matches BOTH waybill and action, because one waybill can carry two
 * acts with different outcomes. `act` is matched loosely (case / dash / space)
 * since our stored value and Delhivery's echo have differed on "RE-ATTEMPT".
 */
export function ndrOutcomeForWaybill(
  raw: unknown,
  waybill: string,
  act: string,
): { state: NdrPairOutcome; message?: string } {
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const wantWb = norm(waybill);
  const wantAct = norm(act);
  const body = (raw ?? {}) as { success_wbns?: unknown; failed_wbns?: unknown };
  const rows = (v: unknown): NdrStatusRow[] => (Array.isArray(v) ? (v as NdrStatusRow[]) : []);
  const hit = (list: NdrStatusRow[]) =>
    list.find((r) => norm(r.waybill) === wantWb && (!wantAct || norm(r.action) === wantAct));

  const bad = hit(rows(body.failed_wbns));
  if (bad) return { state: "rejected", message: String(bad.message ?? "").trim() || "rejected by Delhivery" };
  const good = hit(rows(body.success_wbns));
  if (good) return { state: "accepted" };
  return { state: "pending" };
}

/**
 * The next date Delhivery could plausibly attempt a deferred parcel, `YYYY-MM-DD`.
 *
 * Tomorrow, unless tomorrow is a Sunday — Delhivery runs deliveries on
 * Saturdays but not Sundays, so a defer to a Sunday just wastes the attempt.
 * Computed on the IST calendar because that is the calendar Delhivery schedules
 * against, while this code runs on a UTC clock: a 23:00 IST cron run is already
 * "tomorrow" in UTC, and deferring to the wrong day is the whole failure mode.
 */
export function nextWorkingDay(from: Date = new Date()): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(from.getTime() + IST_OFFSET_MS);
  ist.setUTCDate(ist.getUTCDate() + 1);
  if (ist.getUTCDay() === 0) ist.setUTCDate(ist.getUTCDate() + 1); // Sunday → Monday
  return ist.toISOString().slice(0, 10);
}

// ── Pickup requests ──────────────────────────────────────────────────────────

/**
 * Ask Delhivery to come and collect.
 *
 * Booking a shipment does not summon a van. Per their docs the request is raised
 * "against the warehouse location, not the waybill number", so one request
 * covers every parcel leaving that address that day — the nightly booking run
 * needs exactly one of these, not one per order.
 *
 * Two constraints worth knowing, both from the same page:
 *   - "a second pickup request can be raised for any warehouse only when the
 *     existing pickup request is closed", so a repeat run on the same day is
 *     expected to be refused rather than to quietly book a second van.
 *   - It is optional: pickups can be raised from the One Panel instead, and the
 *     account POC can enable auto-pickup, which removes the need entirely.
 *
 * Note this endpoint takes JSON, unlike create.json which takes form-encoded.
 */
export type PickupRequest = {
  /** YYYY-MM-DD. Defaults to today. */
  date?: string;
  /** hh:mm:ss. Defaults to DELHIVERY_PICKUP_TIME or 11:00:00. */
  time?: string;
  /** How many parcels are waiting. */
  count: number;
};

export async function createPickupRequest(req: PickupRequest): Promise<Record<string, unknown>> {
  const body = {
    pickup_time: req.time ?? process.env.DELHIVERY_PICKUP_TIME ?? "11:00:00",
    pickup_date: req.date ?? new Date().toISOString().slice(0, 10),
    pickup_location: pickupName(),
    expected_package_count: req.count,
  };

  const res = await fetch(`${BASE}/fm/request/new/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Delhivery returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }

  // Unlike create.json this one does use status codes, but the body still
  // carries the reason — and "one is already open" arrives here, which is a
  // normal outcome for a second run rather than a fault.
  if (!res.ok) throw new Error(readableError(data, res.status));
  return data;
}

/** One label, fetched. `pdf` is null when Delhivery had nothing for that waybill. */
export type DelhiveryLabel = { waybill: string; pdf: Uint8Array | null; error?: string };

/**
 * Packing slips for a set of waybills.
 *
 * `packing_slip` answers with JSON, not a PDF: `?pdf=true` makes each package
 * carry a **signed S3 link** to its own slip, which then has to be fetched
 * separately. So one call describes the batch and one download per waybill
 * follows — there is no endpoint that returns several labels in one file, and
 * no size parameter anywhere (see lib/delhiveryLabel.ts for why that matters).
 *
 * **The endpoint has an undocumented per-call ceiling (9 waybills when first
 * measured) when `pdf=true`.** Past it, it answers HTTP 200 with `{"packages":null,
 * "packages_found":<the real count>}` — it counted them correctly and then
 * simply declined to serialise the array, almost certainly because embedding
 * ten-plus full PDFs as base64 in one JSON response is too much for whatever
 * generates it. Measured directly: n=9 returns real packages every time, n=10
 * returns null every time, on the same waybills in the same order. This is
 * what "every label download failing at once, always with the same error"
 * looks like from the caller's side — every waybill in an 87-order batch
 * failed identically because they were one oversized request, not 87 broken
 * ones.
 *
 * Chunked rather than requested in one go for exactly this reason.
 * Failures are still reported per waybill: one label Delhivery cannot produce
 * must not cost you the rest of the batch, and a whole chunk's request
 * failing outright must not cost the other chunks either.
 *
 * **The ceiling moves.** Re-measured 2026-09-15 on the same kind of waybills:
 * n=7 fine (683KB of JSON), n=8 stalls ~23s and comes back null. It looks like
 * a response-size cap, not a count, so a slip with more items lowers it. With
 * chunks of 9 every call was failing, and at ~23s a call an 87-order batch ran
 * past the route's maxDuration before it got anywhere. So the chunk is kept
 * well under the last measurement, and a chunk that still comes back with
 * `packages: null` is split in half and asked again rather than written off.
 */
const PACKING_SLIP_CHUNK_SIZE = 5;

export async function fetchDelhiveryLabels(waybills: string[]): Promise<DelhiveryLabel[]> {
  const wanted = [...new Set(waybills.map((w) => w.trim()).filter(Boolean))];
  if (!wanted.length) return [];

  // The link's key has moved between Delhivery's own docs and what the API
  // actually returns, so take whichever of the known spellings is present
  // rather than trusting one.
  const linkOf = (p: Record<string, unknown>) =>
    String(p.pdf_download_link ?? p.pdf_link ?? p.pdf ?? "").trim();

  const byWaybill = new Map<string, string>();
  const chunkErrors: { waybills: string[]; error: string }[] = [];

  async function slips(chunk: string[]): Promise<void> {
    try {
      const res = await withRetry(async () => {
        const r = await fetch(
          `${BASE}/api/p/packing_slip?wbns=${encodeURIComponent(chunk.join(","))}&pdf=true`,
          { headers: { Authorization: `Token ${token()}`, Accept: "application/json" } },
        );
        if (r.status >= 500) throw new Error(`Delhivery packing_slip ${r.status}`);
        return r;
      });

      const data = (await res.json().catch(() => ({}))) as {
        packages?: Array<Record<string, unknown>> | null;
        packages_found?: number;
      };
      if (!res.ok) throw new Error(readableError(data as Record<string, unknown>, res.status));

      // Found but not serialised: the size ceiling above. Halve until it fits;
      // a single waybill that still comes back null is a real failure.
      if (data.packages == null && Number(data.packages_found) > 0) {
        if (chunk.length > 1) {
          const mid = Math.ceil(chunk.length / 2);
          await slips(chunk.slice(0, mid));
          await slips(chunk.slice(mid));
          return;
        }
        throw new Error("Delhivery found the slip but returned no content");
      }

      for (const p of data.packages ?? []) {
        const wbn = String(p.wbn ?? p.waybill ?? "").trim();
        if (wbn) byWaybill.set(wbn, linkOf(p));
      }
    } catch (err) {
      // A whole chunk failing (network, 5xx) must not silently drop those
      // waybills — the per-waybill loop below only knows "no slip", this is
      // the one place that still knows why.
      chunkErrors.push({ waybills: chunk, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (let i = 0; i < wanted.length; i += PACKING_SLIP_CHUNK_SIZE) {
    await slips(wanted.slice(i, i + PACKING_SLIP_CHUNK_SIZE));
  }

  const out: DelhiveryLabel[] = [];
  for (const waybill of wanted) {
    const link = byWaybill.get(waybill);
    if (!link) {
      const chunkError = chunkErrors.find((c) => c.waybills.includes(waybill))?.error;
      out.push({
        waybill, pdf: null,
        error: chunkError ?? "Delhivery returned no slip for this waybill",
      });
      continue;
    }
    try {
      const pdfRes = await fetch(link);
      if (!pdfRes.ok) throw new Error(`download failed (${pdfRes.status})`);
      const bytes = new Uint8Array(await pdfRes.arrayBuffer());
      // A signed link that has expired answers 200 with an XML error body.
      if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
        throw new Error("link did not return a PDF");
      }
      out.push({ waybill, pdf: bytes });
    } catch (err) {
      out.push({ waybill, pdf: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
