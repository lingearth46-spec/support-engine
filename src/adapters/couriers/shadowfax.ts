// Shadowfax forward shipments (marketplace / seller-pickup model: their rider
// collects from our shop).
//
// Unlike Ekart and Amazon, Shadowfax pushes every status change back to us — see
// /api/shipping/shadowfax — so an order booked here never needs a spreadsheet
// upload to find out what happened to it.
//
// Docs: https://sfxunifiedapi.docs.apiary.io (the rendered page 502s; the raw
// blueprint is at https://jsapi.apiary.io/apis/sfxunifiedapi.apib)

import type { Order } from "@engine/orders";
import { codAmountFor, isCodOrder } from "@commerce/partialCod";
import { GST_RATE, SELLER, gstStateOf } from "@commerce/gstInvoice";

const BASE = "https://dale.shadowfax.in/api";

// Their rider collects from the shop, so this address is where the parcel starts
// and where an RTO comes back to. Both are the same place.
const PICKUP = {
  name: "EXAMPLE TRADERS",
  contact: "9000100011",
  address_line_1: "Example Building, Shop No 4 / Plot No 299",
  address_line_2: "Example marg, Mumbai Suburban",
  city: "Mumbai",
  state: "Maharashtra",
  pincode: 400070,
};

/** Money, to the paise. Floating point otherwise declares 82.99999999 to a courier. */
const round2 = (n: number) => Math.round(n * 100) / 100;

const HSN_CODE = "7117";              // imitation jewellery — the customs code, not marketing copy
const CATEGORY = "Fashion Jewellery";
const GSTIN = "27AAAAA0000A1Z5";

// The same parcel every courier is told about: Ekart is sent 500 g / 18×10×8 cm,
// and the Amazon sheet declares the same box. Describing it differently to
// Shadowfax is how a courier re-weighs at the hub and bills a discrepancy.
const WEIGHT_GRAMS = 500;
const DIMS_CM = { length: 18, width: 10, height: 8 };

// Shadowfax takes no dimensions — only a volumetric weight, by their own formula
// (l×b×h)/5000, in grams. Left unset it defaults to 0, which understates the box.
// Couriers bill on max(actual, volumetric); at 288 g this stays under the 500 g
// actual weight, so declaring it honestly costs nothing and pre-empts a dispute.
const VOLUMETRIC_GRAMS = Math.round((DIMS_CM.length * DIMS_CM.width * DIMS_CM.height) / 5000 * 1000);

export type ShadowfaxShipment = {
  awb: string;
  trackingUrl: string;
};

/**
 * The sentence a human can act on, out of whatever Shadowfax returned.
 *
 * Their rejections arrive as a nested object carrying a status code, an opaque
 * correlation hash and the actual reason. Stringifying the lot put forty
 * characters of hex in front of the one clause that mattered, and twenty of
 * those in a toast made a wall the reason could not be read out of at all —
 * "not enough balance" and "pincode not serviceable" are very different
 * problems and both were invisible.
 */
function readableError(data: unknown, status: number): string {
  const seen = new Set<unknown>();
  const dig = (node: unknown): string | null => {
    if (!node || typeof node === "number" || seen.has(node)) return null;
    if (typeof node === "string") {
      const s = node.trim();
      // A bare correlation id is not a reason — those are hex, slashes and
      // digits, and carry no words.
      return s && /[a-z]{3}/i.test(s) && !/^[0-9a-f/\-]+$/i.test(s) ? s : null;
    }
    if (typeof node !== "object") return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) { const found = dig(item); if (found) return found; }
      return null;
    }
    const rec = node as Record<string, unknown>;
    // errors before message, and deliberately so. On a rejected booking their
    // top-level message is the bare word "Failure" while errors carries the
    // sentence — "Invalid Delivery Pincode. Pincode 302034 is not serviceble".
    // Reading message first returned "Failure" and threw the reason away, which
    // is the whole failure this function exists to prevent.
    for (const key of ["errors", "error", "detail", "reason", "message"]) {
      const found = dig(rec[key]);
      if (found) return found;
    }
    for (const value of Object.values(rec)) { const found = dig(value); if (found) return found; }
    return null;
  };

  const message = dig(data);
  if (!message) return `HTTP ${status}`;
  // Kept whole, only tidied and capped. Trimming to the first sentence looked
  // neater and lost the answer: their wallet rejection opens with "Invalid
  // Delivery prepaid Shipment for <our account email>." and puts "You don't have
  // enough balance" in the sentence after it.
  return message.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** 10 digits, no +91, no spaces — their validator rejects anything else. */
function toContact(phone: string): string {
  return (phone ?? "").replace(/\D/g, "").slice(-10);
}

/** The express (same-day / next-day) account: a separate Shadowfax login with its own token,
 *  webhook and parcels. Its parcels are stored with this courier_name. */
export const SHADOWFAX_EXPRESS_NAME = "Shadowfax Express";
export const isShadowfaxExpress = (courierName?: string | null) => /shadowfax\s+express/i.test(courierName ?? "");

/**
 * The express account is ONE service at one rate: whether a parcel lands same-day or next-day
 * depends on when it ships (founder, 2026-10-23), so there is no SDD / NDD choice to make.
 *
 * Whether the account needs an `order_service` on the order is NOT known - Shadowfax's public docs
 * only show "regular", and a wrong value is how a serviceable pincode was rejected on the main
 * account. So it is sent only if SHADOWFAX_EXPRESS_ORDER_SERVICE is set; otherwise it is omitted,
 * exactly as the main account's booking does. Confirm with Shadowfax on the first live booking.
 */
export function expressOrderService(): string | undefined {
  return process.env.SHADOWFAX_EXPRESS_ORDER_SERVICE?.trim() || undefined;
}

export async function createShadowfaxShipment(
  order: Order,
  opts: { token?: string; orderService?: string } = {},
): Promise<ShadowfaxShipment> {
  const token = opts.token ?? process.env.SHADOWFAX_TOKEN;
  if (!token) throw new Error(opts.token === undefined ? "SHADOWFAX_TOKEN is not set." : "The Shadowfax token for this account is not set.");

  const addr = order.address;
  // A partial-COD order's payment_id is a real Razorpay id, not "COD" — but
  // cash is still owed at the door, so payment_mode must still say COD or the
  // rider is told to collect nothing regardless of what codAmount says below.
  const isCOD = isCodOrder(order);

  // The single most important field on the whole request. A prepaid order sent
  // with a cod_amount would have the rider collect money we have already taken.
  //
  // codAmountFor also covers partial COD: when part of the order was paid
  // online, `cod_due` holds the balance plus the COD fee and the rider must be
  // told that, not the total. Sending `order.total` here would demand the whole
  // amount from a customer who has already paid some of it.
  const codAmount = codAmountFor(order);

  const customer = {
    name: addr?.name ?? "",
    contact: toContact(addr?.phone ?? ""),
    address_line_1: addr?.line1 ?? "",
    address_line_2: addr?.line2 ?? "",
    city: addr?.city ?? "",
    state: addr?.state ?? "",
    pincode: Number(addr?.pincode),
  };

  if (!customer.name || customer.contact.length < 10 || !customer.address_line_1 || !customer.pincode) {
    throw new Error("Order is missing a name, phone, address or pincode — Shadowfax will reject it.");
  }

  const body = {
    order_type: "marketplace",
    order_details: {
      client_order_id: order.id,
      actual_weight: WEIGHT_GRAMS,
      volumetric_weight: VOLUMETRIC_GRAMS,
      product_value: Math.round(order.subtotal ?? order.total),
      payment_mode: isCOD ? "COD" : "Prepaid",
      cod_amount: codAmount,
      total_amount: Math.round(order.total),
      gstin_number: GSTIN,
      // Only the express account may name a service (see expressOrderService).
      ...(opts.orderService ? { order_service: opts.orderService } : {}),
      // order_service is deliberately NOT sent on the main account. It is optional, and the docs only
      // ever show "regular" — but a marketplace lane offers "Marketplace" /
      // "Surface_Mkt", never "Regular". Asking for "regular" made Shadowfax reject
      // a genuinely serviceable pincode as "not serviceble" (401105, which their
      // own serviceability API lists for every relevant service). Omitting it lets
      // them choose the service that lane actually runs.
    },
    customer_details: customer,
    pickup_details: PICKUP,
    // Where the parcel goes if it is never delivered. Same shop it came from.
    rts_details: { ...PICKUP },
    product_details: (order.items ?? []).map((item) => ({
      sku_id: item.sku || item.id,
      sku_name: item.name,
      hsn_code: HSN_CODE,
      category: CATEGORY,
      price: Math.round(item.price),
      additional_details: { quantity: item.quantity },
    })),
  };

  const res = await fetch(`${BASE}/v3/clients/orders/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  // Shadowfax reports a rejected order as HTTP *200* with {"message":"Failure"} —
  // checking res.ok alone let a real failure through and reported it to the admin
  // as "accepted but returned no AWB", burying the actual reason. Trust the body.
  const failed = !res.ok || data?.message === "Failure" || (data?.errors && !data?.data);
  if (failed) {
    throw new Error(`Shadowfax rejected this order: ${readableError(data, res.status)}`);
  }

  const awb = data?.data?.awb_number;
  if (!awb) throw new Error(`Shadowfax accepted the order but returned no AWB: ${JSON.stringify(data).slice(0, 200)}`);

  return {
    awb,
    trackingUrl: `https://tracker.shadowfax.in/#/track/${awb}`,
  };
}

// ── Reverse pickups ───────────────────────────────────────────────────────────
//
// A different API from everything above, and not a variant of it. Reverse lives
// in its own product with its own document
// (https://sfxreversepickup.docs.apiary.io, raw blueprint at
// https://jsapi.apiary.io/apis/sfxreversepickup.apib) — the forward blueprint
// this file is otherwise written against says so in its own title: "Unified API
// for FORWARD Integrations".
//
// Nothing carries over. Different path (/v3/clients/requests, not
// /v3/clients/orders/), different cancel (/v2/clients/requests/mark_cancel),
// different identifier (client_request_id, not awb_number), different field
// names top to bottom — `address_attributes` not `customer_details`,
// `skus_attributes` not `product_details`, weights in a nested object. An
// earlier draft of this function guessed `order_type: "reverse"` on the forward
// endpoint; every field of that guess was wrong.
//
// There are two reverse documents. This is the "return to your warehouse" one,
// which is us — the seller-delivery variant sends the item to a third-party
// seller instead.

/** Returned instead of a booking when the integration is switched off. */
export class ShadowfaxReverseNotConfigured extends Error {
  constructor() {
    super("Shadowfax reverse pickup is not switched on — book this collection by hand.");
    this.name = "ShadowfaxReverseNotConfigured";
  }
}

export type ShadowfaxReversePickup = {
  /** Their id for the collection. A reverse request has no AWB at creation. */
  requestId: string;
  /** "New" on a fresh request. */
  status: string | null;
};

// Their serviceability API lists this account's reverse lane as
// ["Regular", "Slotted", "Surface"] on our pincodes, which maps onto the
// pickup_type values "regular", "slot" and "surface". Regular is the standard
// door pickup; slot would commit us to a time window we cannot promise.
const PICKUP_TYPE = "regular";

// The reverse spec asks for the 8-digit tariff line where the invoice carries
// the 4-digit heading 7117 a small taxpayer is required to show. Same code at a
// different depth: 71171990 is "imitation jewellery, other".
const HSN_CODE_8 = "71171990";

// Doorstep QC is a check the rider performs at the customer's door, and their
// API defaults it to TRUE. Left on, a rider can fail the check and refuse the
// parcel — on a return the customer has already paid ₹99 to have collected, and
// whose evidence we have already reviewed from the photos the form required.
// The item gets inspected here, on arrival, where a decision can be revisited.
const QC_AT_DOOR = "false";

/**
 * Book the collection: their rider picks up from the customer's door.
 *
 * VERIFIED LIVE against this account on 2026-09-12: order AJUKI710091 booked as
 * R24344094622, status New, then cancelled. So the field names, the GST block
 * and the serviceability of the lane are all confirmed, not assumed.
 *
 * Still gated on SHADOWFAX_REVERSE_ENABLED, which is a business switch now
 * rather than a technical one: with it off every approved pickup is recorded as
 * "book this by hand" and ops is alerted, which is the behaviour to keep until
 * someone decides returns should book themselves without a person looking.
 */
export async function createShadowfaxReversePickup(order: Order): Promise<ShadowfaxReversePickup> {
  const token = process.env.SHADOWFAX_TOKEN;
  if (!token) throw new Error("SHADOWFAX_TOKEN is not set.");

  const addr = order.address;
  const phone = toContact(addr?.phone ?? "");

  if (!addr?.name || phone.length < 10 || !addr?.line1 || !addr?.pincode) {
    throw new Error("Return address is incomplete — Shadowfax will reject this pickup.");
  }

  // Which state the parcel starts in decides IGST against CGST + SGST, exactly
  // as it does on the invoice. Read through gstInvoice so the tax declared to
  // the courier and the tax on our own paperwork cannot disagree.
  const state = gstStateOf(addr.state);
  if (!state) throw new Error(`Cannot place "${addr.state ?? ""}" for GST — fix the state on the order first.`);
  const interState = state.code !== SELLER.stateCode;

  // Only what is coming back. No item_indexes means the whole order, which is
  // what every request raised before /returns/start meant.
  const coming = (order.return_request?.item_indexes?.length
    ? order.return_request.item_indexes.map((i) => order.items?.[i]).filter(Boolean)
    : order.items ?? []) as Order["items"];
  if (!coming.length) throw new Error("No items on this return — nothing to collect.");

  if (process.env.SHADOWFAX_REVERSE_ENABLED !== "true") throw new ShadowfaxReverseNotConfigured();

  /** Our prices are tax-inclusive; their API wants the split. */
  const taxesOn = (gross: number) => {
    const taxable = round2(gross / (1 + GST_RATE / 100));
    const tax = round2(gross - taxable);
    const half = round2(tax / 2);
    return {
      cgst_amount: interState ? 0 : half,
      sgst_amount: interState ? 0 : round2(tax - half),
      igst_amount: interState ? tax : 0,
      total_tax_amount: tax,
      taxable,
    };
  };

  const seller = {
    regd_name: SELLER.name,
    regd_address: SELLER.address.join(" "),
    state: SELLER.state,
    gstin: SELLER.gstin,
  };

  // The taxable value of each line is needed for the order total but is not a
  // field on the SKU itself, so it is carried alongside rather than inside.
  const taxables: number[] = [];

  const skus = coming.map((item) => {
    const gross = item.price * (item.quantity ?? 1);
    const { taxable, ...taxes } = taxesOn(gross);
    taxables.push(taxable);
    return {
      name: [item.name, [item.color, item.size].filter(Boolean).join(", ")].filter(Boolean).join(" — "),
      client_sku_id: item.sku || item.id,
      price: round2(gross),
      brand: "AJUKI",
      category: CATEGORY,
      // Shown to the rider at the door, so it says what is being collected and
      // why rather than reading as an internal code.
      return_reason: (order.return_request?.reason ?? "Return").slice(0, 200),
      qc_required: QC_AT_DOOR,
      seller_details: seller,
      taxes,
      hsn_code: HSN_CODE_8,
      // We raise no separate invoice number per item; the order id is the
      // document everything else here is filed under.
      invoice_id: order.id,
      additional_details: {
        ...(item.color ? { color: item.color } : {}),
        ...(item.size ? { size: String(item.size) } : {}),
        quantity_value: item.quantity ?? 1,
        quantity_unit: "EA",
      },
    };
  });

  const grossTotal = round2(skus.reduce((s, k) => s + k.price, 0));
  const taxableTotal = round2(taxables.reduce((s, t) => s + t, 0));

  const body = {
    // Suffixed so it cannot collide with the forward parcel on their side — the
    // same order now has two legs, and their cancel endpoint accepts this id.
    client_order_number: `${order.id}-R`,
    warehouse_name: PICKUP.name,
    warehouse_address: [PICKUP.address_line_1, PICKUP.address_line_2, PICKUP.city, PICKUP.state, PICKUP.pincode].join(", "),
    destination_pincode: PICKUP.pincode,
    pickup_type: PICKUP_TYPE,
    // price excludes GST, total_amount includes it. The wrong way round declares
    // a value we would be paid out at if the parcel is lost on the way back.
    price: taxableTotal,
    total_amount: grossTotal,
    // eway_bill is deliberately absent: mandatory only above ₹50,000, and an
    // order that size does not exist here.
    address_attributes: {
      name: addr.name,
      phone_number: phone,
      address_line: [addr.line1, addr.line2].filter(Boolean).join(", "),
      city: addr.city ?? "",
      country: "India",
      pincode: Number(addr.pincode),
    },
    // In grams, the same parcel every other courier is told about.
    weight_details: { actual_weight: WEIGHT_GRAMS, volumetric_weight: VOLUMETRIC_GRAMS },
    skus_attributes: skus,
  };

  const res = await fetch(`${BASE}/v3/clients/requests`, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  // Same discipline as the forward booking: a rejection can arrive as a 200 with
  // "Failure" in the body. Read the body, not the status.
  if (!res.ok || data?.message === "Failure" || data?.responseMsg === "Failure") {
    throw new Error(`Shadowfax rejected this pickup: ${readableError(data, res.status)}`);
  }

  const requestId = data?.client_request_id;
  if (!requestId) {
    throw new Error(`Shadowfax accepted the pickup but returned no request id: ${JSON.stringify(data).slice(0, 200)}`);
  }

  return { requestId, status: data?.status ?? null };
}

/**
 * Where a reverse pickup is, from Shadowfax's own reverse tracking.
 *
 * The forward trackShadowfax() cannot see these: it looks up an AWB, and a
 * reverse request is identified by client_request_id on a different endpoint
 * (/v4/clients/requests/{id}). Returns null when there is nothing to report —
 * a request booked moments ago, or the API being unavailable — which the caller
 * treats as "try again next run", never as a state.
 */
export async function trackShadowfaxReversePickup(requestId: string): Promise<{
  status: string;
  comment: string | null;
  location: string | null;
  at: string | null;
} | null> {
  const token = process.env.SHADOWFAX_TOKEN;
  if (!token || !requestId) return null;

  let res: Response;
  try {
    res = await fetch(`${BASE}/v4/clients/requests/${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Token ${token}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const body = await res.json().catch(() => null);
  const d = body?.data ?? body;
  if (!d?.status) return null;

  // The newest history row carries the facility and the human sentence; the
  // top-level status alone repeats itself across several hops.
  const history = Array.isArray(d.pickup_request_state_histories) ? d.pickup_request_state_histories : [];
  const latest = [...history].sort((a, b) => String(b?.created_at).localeCompare(String(a?.created_at)))[0];

  return {
    status: String(d.status),
    comment: latest?.comment ? String(latest.comment) : null,
    location: latest?.current_location ? String(latest.current_location) : null,
    at: d.status_last_updated_at ? String(d.status_last_updated_at) : null,
  };
}

/**
 * Call off a booked collection.
 *
 * Only while it is still queued: once the status is Out for Pickup, Picked or
 * already Cancelled their API answers 400 "Pickup request cannot be cancelled
 * now", and a rider turns up regardless.
 *
 * THERE IS ALSO A WINDOW WHERE IT IS TOO EARLY. Found live on 2026-09-12: a
 * cancel fired seconds after booking is refused with "Order is being processed.
 * Please try cancelling after sometime" — which reads like the permanent
 * refusal above but is not. It cleared on a retry twenty seconds later. Anything
 * cancelling a fresh request must retry rather than report failure, or a pickup
 * nobody wants stays booked.
 *
 * `remarks` is not free text — their API takes one of three fixed strings.
 */
export async function cancelShadowfaxReversePickup(
  requestId: string,
  remarks: "Cancelled By Customer" | "Incorrect/ Incomplete contact info" | "Payment Issue" = "Cancelled By Customer",
): Promise<void> {
  const token = process.env.SHADOWFAX_TOKEN;
  if (!token) throw new Error("SHADOWFAX_TOKEN is not set.");

  const res = await fetch(`${BASE}/v2/clients/requests/mark_cancel`, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId, cancel_remarks: remarks }),
  });

  const data = await res.json().catch(() => ({}));
  // Their cancel reports failure as a 200 carrying responseCode 400.
  if (!res.ok || (data?.responseCode && data.responseCode !== 200)) {
    throw new Error(`Shadowfax would not cancel ${requestId}: ${readableError(data, res.status)}`);
  }
}

/**
 * Take COD off a parcel that is already on its way — the customer paid online.
 *
 * Shadowfax's own words: "This API can be used to update the payment mode of the
 * order to prepaid if the cod_amount is passed as 0, but the updation can only be
 * done after the pickup phase i.e post the item is picked." Before pickup the
 * lever is cancelDelhiveryShipment's opposite number below, cancel and rebook.
 *
 * Their published spec is wrong in three places, each found against the live API:
 *
 *   1. The key is `awb_number`, singular. The attribute table says `awb_numbers`,
 *      and that spelling is silently ignored — it returns "Please provide AWB
 *      number", which reads exactly like the endpoint being unavailable rather
 *      than like a wrong key name. Only the example body has it right.
 *   2. Untouched sections must be OMITTED, not passed as null. The spec says the
 *      opposite; sending `delivery_details: null` is rejected outright with
 *      "This field may not be null." So the body here is the minimum.
 *   3. "Only after the pickup phase" is not enforced. This applied cleanly to a
 *      parcel still in `new` status, before any rider had collected it.
 *
 * And the response cannot be trusted at all, which is why this reads the parcel
 * back. "Request accepted." is returned for changes that never happen: the
 * reverse direction, prepaid back to COD, answers 200 with that exact body and
 * silently does nothing, confirmed over a minute of polling. Since the whole
 * point of this call is that a rider must stop asking for cash, "they said OK"
 * is not good enough — the only acceptable evidence is the parcel itself saying
 * cod_amount is 0.
 */
export async function clearShadowfaxCod(awb: string): Promise<void> {
  const token = process.env.SHADOWFAX_TOKEN;
  if (!token) throw new Error("SHADOWFAX_TOKEN is not set.");

  const res = await fetch(`${BASE}/v3/clients/order_update/`, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ awb_number: awb, order_details: { cod_amount: 0 } }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Shadowfax refused to clear COD on ${awb}: ${readableError(data, res.status)}`);
  }

  // Read it back. The update is asynchronous at their end, so a short wait comes
  // first — it landed within four seconds in testing, and this budget is spent
  // on a path that has already taken a customer's money.
  await new Promise((r) => setTimeout(r, 4000));
  const cod = await shadowfaxCodAmount(awb);
  if (cod !== 0) {
    throw new Error(
      `Shadowfax accepted the change on ${awb} but the parcel still collects ` +
      `${cod === null ? "an unknown amount" : `₹${cod}`}`,
    );
  }
}

/** What the parcel is currently set to collect, or null if we cannot tell.
 *  Null is deliberately not 0 — "we could not read it" must never pass for
 *  "there is nothing to collect". */
export async function shadowfaxCodAmount(awb: string): Promise<number | null> {
  const token = process.env.SHADOWFAX_TOKEN;
  if (!token) return null;
  const res = await fetch(`${BASE}/v4/clients/orders/${encodeURIComponent(awb)}/track/`, {
    headers: { Authorization: `Token ${token}` },
  });
  if (!res.ok) return null;
  const amount = (await res.json().catch(() => ({})))?.order_details?.cod_amount;
  return typeof amount === "number" ? amount : null;
}

export type ShadowfaxScan = {
  /** Shadowfax's `status_id` — the machine event, e.g. "recd_at_fwd_hub". */
  event: string;
  /** Human-readable status name. */
  status?: string;
  /** Hub / facility name on this scan. */
  location?: string;
  remark?: string;
  scannedAt: string | null;
};

export type ShadowfaxTracking = {
  /** Current machine status (`order_details.status`), e.g. "bag_in_transit". */
  status: string;
  /** Current human status (`status_display`), e.g. "Bag In Transit". */
  statusDisplay?: string;
  /** Hub on the latest scan. */
  location?: string;
  remark?: string;
  /** ISO instant of the latest scan. */
  scannedAt: string | null;
  promisedDate: string | null;
  /** Full scan trail, oldest first. */
  scans: ShadowfaxScan[];
};

function sfxIso(value: unknown): string | null {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Read a Shadowfax parcel's status and full scan trail.
 *
 * Same `v4/clients/orders/{awb}/track/` endpoint `shadowfaxCodAmount` already
 * uses, whose response carries a `tracking_details` array — `{created,
 * location, status_id, status, remarks}` per scan — alongside `order_details`.
 * Built because Shadowfax's push webhook, assumed reliable when the scan
 * pipeline shipped, turned out to cover only ~half of in-flight parcels; this
 * is the read the /api/cron/parcel-scan-sync comment said to build once gaps
 * showed. Returns null on any failure — the caller treats that as "no data",
 * same as `trackDelhivery`.
 */
export async function trackShadowfax(awb: string, token: string | undefined = process.env.SHADOWFAX_TOKEN): Promise<ShadowfaxTracking | null> {
  if (!token) return null;

  let res: Response;
  try {
    res = await fetch(`${BASE}/v4/clients/orders/${encodeURIComponent(awb)}/track/`, {
      headers: { Authorization: `Token ${token}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    // An AWB booked on the other Shadowfax account answers the main token with HTTP 400
    // {"message":"Invalid AWB Number"} (observed 2026-10-23; a nonsense AWB answers the same).
    // So an express parcel is found by asking once more with the express token. The retry only
    // happens from the main token, so it cannot loop.
    const express = process.env.SHADOWFAX_EXPRESS_TOKEN;
    if (res.status === 400 && express && token !== express) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (/invalid awb/i.test(String(body?.message ?? ""))) return trackShadowfax(awb, express);
    }
    return null;
  }

  const data = (await res.json().catch(() => null)) as
    | { order_details?: Record<string, unknown>; tracking_details?: unknown[] }
    | null;
  const od = data?.order_details ?? {};
  const rows = Array.isArray(data?.tracking_details) ? data!.tracking_details! : [];

  const scans: ShadowfaxScan[] = (rows as Array<Record<string, unknown>>)
    .map((d) => ({
      event: String(d?.status_id ?? "").trim(),
      status: String(d?.status ?? "").trim() || undefined,
      location: String(d?.location ?? "").trim() || undefined,
      remark: String(d?.remarks ?? "").trim() || undefined,
      scannedAt: sfxIso(d?.created),
    }))
    .filter((s) => s.event || s.status)
    .sort((a, b) => String(a.scannedAt ?? "").localeCompare(String(b.scannedAt ?? "")));

  const latest = scans[scans.length - 1];
  const status = String(od.status ?? latest?.event ?? "").trim();
  if (!status && !scans.length) return null;

  return {
    status,
    statusDisplay: String(od.status_display ?? "").trim() || undefined,
    location: latest?.location,
    remark: latest?.remark,
    scannedAt: latest?.scannedAt ?? null,
    promisedDate: (od.promised_delivery_date as string | null) ?? null,
    scans,
  };
}

export async function cancelShadowfaxShipment(awb: string, reason: string, token: string | undefined = process.env.SHADOWFAX_TOKEN): Promise<void> {
  if (!token) throw new Error("The Shadowfax token for this account is not set.");

  const res = await fetch(`${BASE}/v3/clients/orders/cancel/`, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: awb, cancel_remarks: reason }),
  });

  // Shadowfax answers this endpoint with HTTP 200 whatever happens and puts the
  // real outcome in the body — the same trap already documented above for order
  // creation, and unfixed here. Trusting res.ok meant a refused cancellation
  // ("Order cannot be cancelled. Invalid state.", body code 400) was reported to
  // the admin as done, leaving a live parcel someone believed was stopped.
  //
  // Of their documented replies only body code 400 is a failure. 200 covers both
  // "marked as cancelled" and "already in its cancellation phase", and 304 means
  // the parcel is mid-flight and will be cancelled at the next facility — queued,
  // not refused.
  const data = await res.json().catch(() => ({}));
  const code = Number(data?.responseCode ?? (res.ok ? 200 : res.status));
  if (code >= 400 || (!res.ok && res.status !== 304)) {
    throw new Error(
      data?.responseMsg ?? data?.message ?? `Shadowfax could not cancel this shipment (HTTP ${res.status}).`
    );
  }
}

/**
 * Files a ticket in Shadowfax's own support queue — visible on shadowfax360.in
 * under Help & Support, not just in our admin. Separate from `ticket_status` on
 * the order, which only ever tracked *our* follow-up queue; this is the first
 * thing here that puts a record in front of Shadowfax itself rather than us.
 *
 * Five categories, each valid only in a specific window — see the docs link at
 * the top of this file, `#group Escalation API`. `delayed_delivery` is the one
 * that fits both an NDR and a silent no-scan parcel: their own example ticket
 * pairs "Customer Not Contactable" (an NDR order status) with this same
 * category, so it is not reserved for the no-scan case alone. `status_mismatch`
 * and `delivery_dispute` are narrower and unverified — try `delayed_delivery`
 * first for anything picked and past its estimated delivery date.
 */
const ISSUE_CATEGORY_CODES = {
  delayed_delivery: 1,          // picked, not delivered past estimated delivery date (Forward)
  expedite_pickup_customer: 2,  // reverse pickup not yet collected from the customer
  expedite_pickup_seller: 3,    // forward pickup not yet collected from us
  status_mismatch: 4,           // expected vs. actual order status disagree
  delivery_dispute: 5,          // only once the order is marked Delivered
} as const;

export type ShadowfaxIssueCategory = keyof typeof ISSUE_CATEGORY_CODES;

// Breadcrumb dropped into orders.admin_notes once a portal escalation has been
// filed for a parcel, so the "Raise ticket" button (and the backfill script)
// don't file a second one on a re-click. Match on the marker, write the dated
// form.
export const SFX_ESCALATED_MARKER = "[sfx-escalated";
export const shadowfaxEscalatedNote = (now = new Date()) =>
  `${SFX_ESCALATED_MARKER} ${now.toISOString().slice(0, 10)}]`;

/** A direct Shadowfax booking whose AWB their escalation API will accept — the
 *  bare "Shadowfax" courier name and no Shiprocket order id (a Shiprocket-
 *  assigned Shadowfax parcel is escalated through Shiprocket, not here). */
export function isDirectShadowfax(o: {
  courier_name?: string | null;
  awb_code?: string | null;
  shiprocket_order_id?: string | null;
}): boolean {
  return (
    (o.courier_name ?? "").trim().toLowerCase() === "shadowfax" &&
    !o.shiprocket_order_id &&
    Boolean(o.awb_code)
  );
}

export async function raiseShadowfaxIssue(awb: string, category: ShadowfaxIssueCategory): Promise<void> {
  const token = process.env.SHADOWFAX_TOKEN;
  if (!token) throw new Error("SHADOWFAX_TOKEN is not set.");

  const res = await fetch(`${BASE}/v1/clients/support/issue/`, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ awb_number: awb, issue_category: ISSUE_CATEGORY_CODES[category] }),
  });

  // Undocumented whether this endpoint shares the "200 for a failure" trap the
  // rest of Shadowfax's API has, so it is treated the same way on principle:
  // read the body rather than trust the status code alone.
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.status !== "SUCCESS") {
    throw new Error(`Shadowfax refused the escalation on ${awb}: ${readableError(data, res.status)}`);
  }
}

// ── NDR actions — the delivery_attempt_failed_v2 buttons (P1) ────────────────
//
// The four quick-reply buttons on delivery_attempt_failed_v2 (Deliver tomorrow /
// Update phone / Update address / Contact support) are wired to real courier
// actions in lib/ndrButtonReply.ts. For Delhivery those map cleanly onto
// DEFER_DLV / EDIT_DETAILS (lib/delhivery.ts). Shadowfax is weaker, and these
// three helpers are what the handler leans on — every one written to the house
// rule that a 200 from Shadowfax proves nothing, so each re-reads the parcel.
//
// What a read-only probe of our 12 live "undelivered" Shadowfax parcels found
// (2026-09-03), and which the design here follows:
//
//   - Shadowfax AUTO-RETRIES NDR parcels itself: they cycle
//     nc → assigned_for_delivery → ofd → nc … with no input from us. None of the
//     12 was ever in `on_hold`.
//   - CONFIRMED 2026-09-03 (live probe): `status_update.status = "reopen_ndr"`
//     is a SILENT NO-OP from `nc` — the POST returns HTTP 200 "Request
//     accepted." but the parcel stays `nc`, with no `reopen_ndr` scan, verified
//     over 3+ minutes. It is only effective from `on_hold` /
//     `cancelled_by_customer`, which our NDR parcels are never in.
//     `reopenShadowfaxNdr` is therefore best-effort: the caller fires it (it is
//     cheap, harmless, and does work on the rare `on_hold` parcel) and MUST NOT
//     treat `!ok` as a failure — no fallback case, no alert on `!ok` alone.
//   - The track endpoint returns `delivery_details.contact` BLANK (privacy-
//     masked) on every parcel — so a phone change CANNOT be verified by reading
//     the value back. `updateShadowfaxDeliveryDetails` treats a clean 2xx as
//     "submitted, unconfirmed" and only a 400 as a hard reject.
//     TODO(verify): confirm Shadowfax emits a scan when contact/address is
//     updated (pincode already emits `pincode_updated`).
//   - `attempt_number` is enabled on our account (2026-10-15) and the webhook
//     writes it to orders.attempt_count. Absent on older callbacks — treat null as unknown.

const SFX_READBACK_WAIT_MS = 6000;

/**
 * Shadowfax's "you can't edit this parcel right now" reject.
 *
 * CONFIRMED 2026-09-03 by the Shadowfax team: `order_update` is refused for the
 * whole time a parcel is assigned to a rider ("shipment is in active runsheet"),
 * not just while it is physically OFD — a "not contactable" parcel stays on the
 * runsheet for days. The edit window only opens once the parcel is out of the
 * delivery boy's hands, i.e. back at a hub / `on_hold`. So this is NOT a hard
 * failure: the caller should queue the value and retry when the parcel is
 * editable (see orders.pending_courier_edit and the ndr-reattempt cron's drain
 * pass), not open a support case.
 */
export const SHADOWFAX_EDIT_LOCKED = /active runsheet|in runsheet|assigned to (a )?(rider|delivery)|out for delivery.*cannot|with the delivery (boy|partner|executive)/i;

/** Live machine status of a Shadowfax parcel (`order_details.status`, e.g. `nc`,
 *  `na`, `on_hold`, `ofd`, `assigned_for_delivery`, `reopen_ndr`), lower-cased.
 *  Null when the parcel cannot be read — never guessed. */
export async function shadowfaxOrderStatus(awb: string): Promise<string | null> {
  const token = process.env.SHADOWFAX_TOKEN;
  if (!token || !awb) return null;
  let res: Response;
  try {
    res = await fetch(`${BASE}/v4/clients/orders/${encodeURIComponent(awb)}/track/`, {
      headers: { Authorization: `Token ${token}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { order_details?: Record<string, unknown> } | null;
  const status = String(data?.order_details?.status ?? "").trim().toLowerCase();
  return status || null;
}

/** The parcel's current delivery pincode + full address text, from the track
 *  endpoint. `contact` is deliberately not returned — it comes back masked. */
async function shadowfaxDeliverySnapshot(
  awb: string,
): Promise<{ pincode: string; address: string; scanEvents: string[] } | null> {
  const token = process.env.SHADOWFAX_TOKEN;
  if (!token || !awb) return null;
  let res: Response;
  try {
    res = await fetch(`${BASE}/v4/clients/orders/${encodeURIComponent(awb)}/track/`, {
      headers: { Authorization: `Token ${token}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as
    | { order_details?: { delivery_details?: Record<string, unknown> }; tracking_details?: unknown[] }
    | null;
  const dd = (data?.order_details?.delivery_details ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(data?.tracking_details) ? (data!.tracking_details as Array<Record<string, unknown>>) : [];
  return {
    pincode: String(dd.pincode ?? "").replace(/\D/g, ""),
    address: [dd.address_line_1, dd.address_line_2, dd.city, dd.state]
      .map((s) => String(s ?? "").trim())
      .filter(Boolean)
      .join(", ")
      .toLowerCase(),
    scanEvents: rows.map((r) => `${String(r.status_id ?? "")} ${String(r.status ?? "")}`.trim().toLowerCase()),
  };
}

/** Shadowfax statuses that mean "a re-attempt is genuinely in motion". */
const SFX_REATTEMPTING = new Set(["reopen_ndr", "assigned_for_delivery", "ofd", "out_for_delivery"]);

/**
 * Ask Shadowfax to re-open an NDR parcel for another attempt.
 *
 * Best-effort by design (see the block comment above). `reopen_ndr` is a silent
 * no-op from `nc` (confirmed live) and only works from `on_hold`, so this will
 * usually return `ok: false` "status unchanged" — that is EXPECTED, not an
 * error. The caller fires it anyway (harmless, works on the rare `on_hold`
 * parcel) and never opens a case or alerts on `!ok` alone. A business rejection
 * (HTTP 400) is likewise returned as `{ ok: false, note }`, never thrown.
 */
export async function reopenShadowfaxNdr(
  awb: string,
): Promise<{ ok: boolean; status: string | null; note: string }> {
  const token = process.env.SHADOWFAX_TOKEN;
  if (!token) return { ok: false, status: null, note: "SHADOWFAX_TOKEN is not set" };

  let res: Response;
  try {
    res = await fetch(`${BASE}/v3/clients/order_update/`, {
      method: "POST",
      headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
      // awb_number, singular — the attribute table's `awb_numbers` is silently
      // ignored (see clearShadowfaxCod). status_update is the only section sent.
      body: JSON.stringify({ awb_number: awb, status_update: { status: "reopen_ndr" } }),
    });
  } catch (err) {
    return { ok: false, status: null, note: `network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    // A 400 here is the documented "Status transition from <x> to ndr is not
    // allowed" — the parcel is in nc/na/cid, not on_hold. Not a fault.
    return { ok: false, status: null, note: readableError(data, res.status) };
  }

  // "Request accepted." means nothing on its own. Wait, then read the parcel.
  await new Promise((r) => setTimeout(r, SFX_READBACK_WAIT_MS));
  const status = await shadowfaxOrderStatus(awb);
  const ok = status != null && SFX_REATTEMPTING.has(status);
  return {
    ok,
    status,
    note: ok
      ? `parcel is "${status}" — reattempt in motion`
      : `Shadowfax accepted the call but the parcel is "${status ?? "unreadable"}" (reopen_ndr needs on_hold)`,
  };
}

/**
 * Update the delivery contact / address / pincode on a Shadowfax NDR parcel.
 *
 * This is the real lever for a Shadowfax NDR — a wrong or unanswered number is
 * why the auto-retry loop never converges. `order_update` only changes the
 * details; it does NOT itself trigger a re-attempt, and Shadowfax re-attempts on
 * its own anyway.
 *
 * Only the `delivery_details` section is sent, and only the fields that changed —
 * an untouched section passed as `null` is rejected outright ("This field may
 * not be null.").
 *
 * `ok` means "accepted for processing" (a clean 2xx, or the documented
 * pincode-2nd-update 400 whose body says "request is stored, will be
 * validated"). Only a real 400 is `ok: false`. `applied` lists the fields a
 * follow-up read of the parcel could positively confirm — usually empty for a
 * contact change, because the track endpoint masks `contact`. `pincode` is
 * async everywhere and never counts as immediately applied.
 *
 * A pincode change that is not intra-city is rejected up front (Shadowfax:
 * "Intercity pincode updates are not allowed", max 2/order) by comparing the
 * first three digits — the sorting district — against the parcel's current
 * pincode, rather than eating the 400.
 */
export async function updateShadowfaxDeliveryDetails(
  awb: string,
  details: { contact?: string; address?: string; pincode?: string | number },
): Promise<{ ok: boolean; locked?: boolean; applied: string[]; note: string }> {
  const token = process.env.SHADOWFAX_TOKEN;
  if (!token) return { ok: false, applied: [], note: "SHADOWFAX_TOKEN is not set" };

  const contact = details.contact != null ? toContact(details.contact) : undefined;
  const address = details.address != null ? String(details.address).trim() : undefined;
  const pincode = details.pincode != null ? String(details.pincode).replace(/\D/g, "") : undefined;

  if (contact !== undefined && contact.length !== 10) {
    return { ok: false, applied: [], note: "contact must be a 10-digit number" };
  }
  if (pincode !== undefined && pincode.length !== 6) {
    return { ok: false, applied: [], note: "pincode must be 6 digits" };
  }

  const before = pincode ? await shadowfaxDeliverySnapshot(awb) : null;
  if (pincode && before?.pincode && before.pincode.slice(0, 3) !== pincode.slice(0, 3)) {
    return {
      ok: false,
      applied: [],
      note: `pincode ${pincode} is not intra-city with the parcel's current ${before.pincode} — Shadowfax rejects intercity pincode edits`,
    };
  }

  const delivery_details: Record<string, unknown> = {};
  if (contact) delivery_details.contact = contact;
  if (address) delivery_details.customer_address = address;
  if (pincode) delivery_details.pincode = Number(pincode);
  if (!Object.keys(delivery_details).length) {
    return { ok: false, applied: [], note: "nothing to change" };
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/v3/clients/order_update/`, {
      method: "POST",
      headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ awb_number: awb, delivery_details }),
    });
  } catch (err) {
    return { ok: false, applied: [], note: `network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  const bodyText = JSON.stringify(data);
  // 21 Oct: the parcel already held the pincode ("Current Delivery Pincode and requested pincode … are same") and Shadowfax rejected the WHOLE update, so the address in it was never
  // saved. A pincode it already has is not a reason to drop the rest: send the other fields on their own.
  if (!res.ok && pincode && (address || contact) && /pincode/i.test(bodyText) && /\bsame\b/i.test(bodyText)) {
    const rest = await updateShadowfaxDeliveryDetails(awb, { ...(contact ? { contact } : {}), ...(address ? { address } : {}) });
    return rest.ok ? { ...rest, applied: [...rest.applied, "pincode"], note: `${rest.note}; the pincode was already ${pincode}` } : rest;
  }
  // The 2nd pincode update comes back as a 400 body whose message is really
  // "accepted, pending validation" — treat it as submitted, not rejected.
  const pincodeStored = /request is stored|will be validated/i.test(bodyText);
  if (!res.ok && !pincodeStored) {
    // "Active runsheet" is not a refusal — the parcel is just out with a rider.
    // Flag it so the caller queues the value and retries later instead of
    // escalating to a human.
    if (SHADOWFAX_EDIT_LOCKED.test(bodyText)) {
      return { ok: false, locked: true, applied: [], note: readableError(data, res.status) };
    }
    return { ok: false, applied: [], note: readableError(data, res.status) };
  }

  // Read it back. `contact` is masked so it can never confirm a phone change;
  // the best available signal is a fresh scan mentioning an update. pincode
  // lands async and emits `pincode_updated` minutes-to-hours later.
  await new Promise((r) => setTimeout(r, SFX_READBACK_WAIT_MS));
  const after = await shadowfaxDeliverySnapshot(awb);
  const applied: string[] = [];
  const scanText = (after?.scanEvents ?? []).join(" | ");

  if (address && after?.address) {
    const tokens = address.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    if (tokens.length && tokens.some((t) => after.address.includes(t))) applied.push("address");
  }
  if (pincode && after?.pincode === pincode) applied.push("pincode");
  // TODO(verify): the exact scan id/name Shadowfax emits for a contact/address
  // edit is unconfirmed — this matches a few plausible spellings. `pincode` does
  // emit a documented `pincode_updated` scan.
  if (/pincode_updated|details?.?updat|customer.?details|contact.?updat/i.test(scanText)) {
    if (contact && !applied.includes("phone")) applied.push("phone");
    if (address && !applied.includes("address")) applied.push("address");
  }

  const submitted = [contact && "phone", address && "address", pincode && "pincode"].filter(Boolean) as string[];
  const note = applied.length
    ? `submitted; confirmed on read-back: ${applied.join(", ")}`
    : `submitted (${submitted.join(", ")}) — Shadowfax accepted it but the track endpoint cannot confirm the change yet`;
  return { ok: true, applied, note };
}
