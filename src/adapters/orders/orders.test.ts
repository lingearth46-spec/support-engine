// Run with `npx tsx src/adapters/orders/orders.test.ts`. The order-reading seam: the generic orchestration, the reference shop's id format, and the Shopify source
// (fixtures built from Shopify's documented fields; NOT a test against a live store).

import assert from "node:assert/strict";
import { extractPhones, ordersFromMentions, type OrderSource } from "@adapters/orders/types";
import { extractOrderIds } from "@adapters/orders/supabase";
import { shopifyOrderSource, mapStatus, mapOrder, type ShopifyOrderNode } from "@adapters/orders/shopify";
import type { OrderRow } from "@engine/orderLines";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const row = (id: string) => ({ id, status: "shipped" } as unknown as OrderRow);

// ── extractPhones ──
eq("a mobile in the text", extractPhones("I ordered from 9876543210", "9000000001"), ["9876543210"]);
eq("with +91", extractPhones("number is +91 9876543210", "9000000001"), ["9876543210"]);
eq("not the sender's own", extractPhones("9000000001 and 9876543210", "9000000001"), ["9876543210"]);
eq("pincodes and totals are not phones", extractPhones("pincode 560001 total 1499", "9000000001"), []);

// ── the reference shop's id format ──
eq("an id", extractOrderIds("where is AJUKI123456"), ["AJUKI123456"]);
eq("lower case and a space", extractOrderIds("ajuki 123456 please"), ["AJUKI123456"]);
eq("at most five", extractOrderIds("AJUKI100001 AJUKI100002 AJUKI100003 AJUKI100004 AJUKI100005 AJUKI100006").length, 5);
eq("too short is not an id", extractOrderIds("AJUKI12"), []);

// ── ordersFromMentions with a fake source ──
function fake(known: Record<string, OrderRow[]>, byId: Record<string, OrderRow>) {
  const calls: string[] = [];
  const source: OrderSource = {
    byPhone: async (p) => { calls.push(`phone:${p}`); return known[p] ?? []; },
    byIds: async (ids) => { calls.push(`ids:${ids.join(",")}`); return ids.map((i) => byId[i]).filter(Boolean); },
    idsIn: extractOrderIds,
  };
  return { source, calls };
}

// ── Shopify: statuses ──
const F = (displayStatus: string, createdAt = "2026-10-20T00:00:00Z") => ({ displayStatus, estimatedDeliveryAt: null, deliveredAt: null, createdAt, trackingInfo: [] });
const base = (over: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode => ({
  id: "gid://shopify/Order/1", name: "#1001", createdAt: "2026-10-18T10:00:00Z", cancelledAt: null, displayFulfillmentStatus: "UNFULFILLED", displayFinancialStatus: "PAID",
  paymentGatewayNames: ["razorpay"], phone: "+919000100001",
  shippingAddress: { name: "Asha", phone: "+919000100001", address1: "12 Example Road", address2: null, city: "Pune", province: "Maharashtra", zip: "411001" },
  lineItems: { nodes: [{ name: "Dorian Bracelet", quantity: 1, variantTitle: "Silver / M" }] },
  totalPriceSet: { shopMoney: { amount: "499.00" } }, fulfillments: [], ...over,
});
eq("cancelled wins", mapStatus(base({ cancelledAt: "2026-10-19T00:00:00Z", fulfillments: [F("DELIVERED")] })), "cancelled");
eq("no fulfilment: processing", mapStatus(base()), "processing");
eq("in transit: shipped", mapStatus(base({ fulfillments: [F("IN_TRANSIT")] })), "shipped");
eq("out for delivery", mapStatus(base({ fulfillments: [F("OUT_FOR_DELIVERY")] })), "out_for_delivery");
eq("attempted: undelivered", mapStatus(base({ fulfillments: [F("ATTEMPTED_DELIVERY")] })), "undelivered");
eq("not delivered: undelivered", mapStatus(base({ fulfillments: [F("NOT_DELIVERED")] })), "undelivered");
eq("delivered", mapStatus(base({ fulfillments: [F("DELIVERED")] })), "delivered");
eq("label printed: manifested", mapStatus(base({ fulfillments: [F("LABEL_PRINTED")] })), "manifested");
eq("a voided label is ignored", mapStatus(base({ fulfillments: [F("LABEL_VOIDED", "2026-10-21T00:00:00Z"), F("IN_TRANSIT", "2026-10-20T00:00:00Z")] })), "shipped");
eq("the newest live fulfilment decides", mapStatus(base({ fulfillments: [F("IN_TRANSIT", "2026-10-20T00:00:00Z"), F("DELIVERED", "2026-10-22T00:00:00Z")] })), "delivered");

// ── Shopify: the row ──
{
  const o = mapOrder(base({ fulfillments: [{ displayStatus: "IN_TRANSIT", estimatedDeliveryAt: "2026-10-25T12:00:00Z", deliveredAt: null, createdAt: "2026-10-19T00:00:00Z", trackingInfo: [{ company: "Delhivery", number: "AWB123", url: "https://track.example/AWB123" }] }] }));
  eq("id is the order name", o.id, "#1001");
  eq("tracking", [o.awb_code, o.courier_name, o.tracking_url], ["AWB123", "Delhivery", "https://track.example/AWB123"]);
  eq("estimated delivery is a day", o.estimated_delivery, "2026-10-25");
  eq("prepaid", [o.payment_id, o.cod_due, o.amount_paid_online, o.total], ["razorpay", 0, 499, 499]);
  eq("items and size", o.items, [{ name: "Dorian Bracelet", quantity: 1, size: "Silver / M" }]);
  eq("address", [o.address?.phone, o.address?.city, o.address?.pincode], ["+919000100001", "Pune", "411001"]);
  const cod = mapOrder(base({ paymentGatewayNames: ["Cash on Delivery (COD)"] }));
  eq("cash on delivery", [cod.payment_id, cod.cod_due, cod.amount_paid_online], ["COD", 499, 0]);
}

(async () => {
  {
    const { source, calls } = fake({ "9876543210": [row("AJUKI2")] }, { AJUKI123456: row("AJUKI123456") });
    const out = await ordersFromMentions(source, "my order AJUKI123456, or from 9876543210", "9000000001");
    eq("both an id and another number", [out.map((o) => o.id), calls], [["AJUKI123456", "AJUKI2"], ["ids:AJUKI123456", "phone:9876543210"]]);
  }
  {
    const { source, calls } = fake({}, {});
    eq("nothing mentioned: no reads", [await ordersFromMentions(source, "where is my parcel", "9000000001"), calls], [[], []]);
  }

  // ── Shopify source with a fake fetch ──
  const sent: Array<{ url: string; q: string; headers: Record<string, string> }> = [];
  const mk = (handler: (q: string) => unknown, status = 200): typeof fetch => (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ url, q: String(body.variables.q), headers: init.headers as Record<string, string> });
    return { ok: status === 200, status, json: async () => handler(String(body.variables.q)) } as Response;
  }) as unknown as typeof fetch;
  const cfg = (fetchImpl: typeof fetch) => ({ shop: "demo.myshopify.com", accessToken: "t", apiVersion: "2025-10", fetchImpl });

  {
    sent.length = 0;
    const src = shopifyOrderSource(cfg(mk((q) => q.startsWith("phone:")
      ? { data: { customers: { nodes: [{ id: "gid://shopify/Customer/777" }] } } }
      : { data: { orders: { nodes: [base()] } } })));
    const out = await src.byPhone("9000100001");
    eq("byPhone: customer first, then that customer's orders", [out.map((o) => o.id), sent.map((s) => s.q)], [["#1001"], ["phone:+919000100001", "customer_id:777"]]);
    eq("byPhone: the store, version and token are used", [sent[0].url, sent[0].headers["X-Shopify-Access-Token"]], ["https://demo.myshopify.com/admin/api/2025-10/graphql.json", "t"]);
    eq("byPhone: a short number is not searched", [await src.byPhone("12345"), sent.length], [[], 2]);
  }
  {
    sent.length = 0;
    const src = shopifyOrderSource(cfg(mk(() => ({ data: { customers: { nodes: [] } } }))));
    eq("byPhone: no customer, no orders", [await src.byPhone("9000100001"), sent.length], [[], 1]);
  }
  {
    sent.length = 0;
    const src = shopifyOrderSource(cfg(mk(() => ({ data: { orders: { nodes: [base()] } } }))));
    const out = await src.byIds(["#1001", "#1002", "1003", "x"]);
    eq("byIds: names searched together", [out.length, sent[0].q], [1, "name:1001 OR name:1002 OR name:1003"]);
    eq("byIds: nothing valid, no request", [await src.byIds(["abc"]), sent.length], [[], 1]);
  }
  {
    const src = shopifyOrderSource(cfg(mk(() => ({ errors: [{ message: "Throttled" }] }))));
    eq("a GraphQL error gives no orders, not a throw", await src.byPhone("9000100001"), []);
    const down = shopifyOrderSource({ ...cfg(mk(() => ({}))), fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    eq("a network failure gives no orders, not a throw", await down.byIds(["#1001"]), []);
  }
  {
    const src = shopifyOrderSource(cfg(mk(() => ({}))));
    eq("idsIn: needs a hash by default", [src.idsIn("order #1001 pincode 411001 and #1002"), src.idsIn("my pincode is 411001")], [["#1001", "#1002"], []]);
    const loose = shopifyOrderSource({ ...cfg(mk(() => ({}))), orderIdPattern: /\b\d{4}\b/g });
    eq("idsIn: your own pattern", loose.idsIn("order 1001"), ["#1001"]);
  }
  console.log(`${passed} passed, 0 failed`);
})();
