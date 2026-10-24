// A read-only OrderSource for Shopify (Admin GraphQL API). UNTESTED AGAINST A LIVE STORE: it is built from Shopify's documentation and unit-tested
// with fixtures. Treat it as a starting point and check every assumption below against your own store before going live.
//
// What was checked in Shopify's docs (Oct 2026):
//   Order: name, createdAt, cancelledAt, displayFulfillmentStatus, displayFinancialStatus, paymentGatewayNames, shippingAddress, phone, fulfillments,
//          lineItems (connection), totalPriceSet, tags. LineItem: name, quantity, variantTitle. MailingAddress: phone, name, address1, address2, city,
//          province, zip. Fulfillment: displayStatus, estimatedDeliveryAt, deliveredAt, trackingInfo{company number url}.
//   The `orders` query has NO phone filter; `name` and `customer_id` filters exist. The `customers` query has a `phone` filter.
// Not checked: the arguments of Order.fulfillments, MoneyV2.amount (standard but not read), whether your customers' phone numbers are stored in E.164,
//   and the current stable apiVersion.
//
// Limits you should know about:
//   - byPhone finds the CUSTOMER with that phone number, then that customer's orders. A guest checkout, or a shipping phone that differs from the
//     customer's phone, will not be found. If that matters to you, add a second lookup (for example a metafield or your own phone index).
//   - Shopify has no "return to origin", "undelivered" attempt count or failure reason: statuses come from the fulfilment's displayStatus only.
//   - The bot's COD logic needs to know whether an order is cash on delivery. Set `codGatewayPattern` to match your gateway name or adapt mapPayment().

import type { OrderRow } from "@engine/orderLines";
import { normalizePhone } from "@engine/phone";
import type { OrderSource } from "@adapters/orders/types";

export interface ShopifyConfig {
  /** your-store.myshopify.com */
  shop: string;
  /** Admin API access token of a custom app with read access to orders and customers. */
  accessToken: string;
  /** A current stable Admin API version, for example "2025-10". Check shopify.dev. */
  apiVersion: string;
  /** Prefix for national numbers when searching customers. Default "+91". */
  countryCode?: string;
  /** Matches the payment gateway name that means cash on delivery. */
  codGatewayPattern?: RegExp;
  /** How a customer types an order number. Default: "#1001" (a hash and 3 to 8 digits). */
  orderIdPattern?: RegExp;
  fetchImpl?: typeof fetch;
}

const ORDER_FIELDS = `
  id name createdAt cancelledAt displayFulfillmentStatus displayFinancialStatus paymentGatewayNames phone
  shippingAddress { name phone address1 address2 city province zip }
  lineItems(first: 10) { nodes { name quantity variantTitle } }
  totalPriceSet { shopMoney { amount } }
  fulfillments { displayStatus estimatedDeliveryAt deliveredAt createdAt trackingInfo { company number url } }
`;

export type ShopifyOrderNode = {
  id: string; name: string; createdAt: string; cancelledAt: string | null;
  displayFulfillmentStatus: string; displayFinancialStatus: string | null; paymentGatewayNames: string[]; phone: string | null;
  shippingAddress: { name?: string | null; phone?: string | null; address1?: string | null; address2?: string | null; city?: string | null; province?: string | null; zip?: string | null } | null;
  lineItems: { nodes: Array<{ name: string; quantity: number; variantTitle: string | null }> };
  totalPriceSet: { shopMoney: { amount: string } };
  fulfillments: Array<{
    displayStatus: string | null; estimatedDeliveryAt: string | null; deliveredAt: string | null; createdAt: string;
    trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }>;
  }>;
};

/** Shopify's fulfilment display status mapped to the bot's status vocabulary (src/engine/orders.ts). */
export function mapStatus(o: Pick<ShopifyOrderNode, "cancelledAt" | "displayFulfillmentStatus" | "fulfillments">): string {
  if (o.cancelledAt) return "cancelled";
  const live = [...o.fulfillments].filter((f) => f.displayStatus !== "CANCELED" && f.displayStatus !== "LABEL_VOIDED")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (live) {
    switch (live.displayStatus) {
      case "DELIVERED": return "delivered";
      case "OUT_FOR_DELIVERY": return "out_for_delivery";
      case "ATTEMPTED_DELIVERY": case "NOT_DELIVERED": case "FAILURE": return "undelivered";
      case "LABEL_PRINTED": case "LABEL_PURCHASED": case "READY_FOR_PICKUP": case "SUBMITTED": return "manifested";
      default: return "shipped"; // IN_TRANSIT, CARRIER_PICKED_UP, PICKED_UP, DELAYED, CONFIRMED, FULFILLED, MARKED_AS_FULFILLED
    }
  }
  return "processing"; // UNFULFILLED, OPEN, SCHEDULED, ON_HOLD, IN_PROGRESS, PENDING_FULFILLMENT, ...
}

const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);

export function mapOrder(o: ShopifyOrderNode, cfg: Pick<ShopifyConfig, "codGatewayPattern"> = {}): OrderRow {
  const status = mapStatus(o);
  const live = [...o.fulfillments].filter((f) => f.displayStatus !== "CANCELED" && f.displayStatus !== "LABEL_VOIDED")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const track = live?.trackingInfo?.[0];
  const total = Number(o.totalPriceSet?.shopMoney?.amount);
  const cod = (cfg.codGatewayPattern ?? /cash on delivery|\bcod\b/i).test((o.paymentGatewayNames ?? []).join(" "));
  const sa = o.shippingAddress;
  return {
    id: o.name,
    status,
    total: Number.isFinite(total) ? total : null,
    created_at: o.createdAt,
    delivered_at: live?.deliveredAt ?? null,
    estimated_delivery: day(live?.estimatedDeliveryAt),
    awb_code: track?.number ?? null,
    courier_name: track?.company ?? null,
    tracking_url: track?.url ?? null,
    payment_id: cod ? "COD" : (o.paymentGatewayNames?.[0] ?? "prepaid"),
    amount_paid_online: cod ? 0 : (Number.isFinite(total) ? total : null),
    cod_due: cod ? (Number.isFinite(total) ? total : null) : 0,
    items: o.lineItems.nodes.map((n) => ({ name: n.name, quantity: n.quantity, ...(n.variantTitle ? { size: n.variantTitle } : {}) })),
    address: {
      phone: sa?.phone ?? o.phone ?? undefined, name: sa?.name ?? undefined, line1: sa?.address1 ?? undefined, line2: sa?.address2 ?? undefined,
      city: sa?.city ?? undefined, state: sa?.province ?? undefined, pincode: sa?.zip ?? undefined,
    },
  } as OrderRow;
}

export function shopifyOrderSource(cfg: ShopifyConfig): OrderSource {
  const f = cfg.fetchImpl ?? fetch;
  const cc = cfg.countryCode ?? "+91";
  // A '#' is required by default: bare numbers in a message are usually pincodes, phones and amounts. Pass orderIdPattern to accept "order 1001" etc.
  const idRe = cfg.orderIdPattern ?? /#\d{3,8}\b/g;

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
    try {
      const res = await f(`https://${cfg.shop}/admin/api/${cfg.apiVersion}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": cfg.accessToken },
        body: JSON.stringify({ query, variables }),
      });
      const body = (await res.json()) as { data?: T; errors?: unknown };
      if (!res.ok || body.errors) { console.warn("[shopify] request failed", res.status, JSON.stringify(body.errors ?? "").slice(0, 300)); return null; }
      return body.data ?? null;
    } catch (e) {
      console.warn("[shopify] request threw", e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  const ordersQuery = `query($q: String!) { orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`;

  return {
    async byPhone(phone) {
      const p = normalizePhone(phone);
      if (p.length !== 10) return [];
      const cust = await gql<{ customers: { nodes: Array<{ id: string }> } }>(
        `query($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`, { q: `phone:${cc}${p}` });
      const gid = cust?.customers.nodes[0]?.id;
      const numeric = gid?.split("/").pop();
      if (!numeric) return [];
      const data = await gql<{ orders: { nodes: ShopifyOrderNode[] } }>(ordersQuery, { q: `customer_id:${numeric}` });
      return (data?.orders.nodes ?? []).map((n) => mapOrder(n, cfg));
    },
    async byIds(ids) {
      const names = [...new Set(ids.map((i) => i.replace(/^#/, "")).filter((i) => /^\d+$/.test(i)))].slice(0, 5);
      if (!names.length) return [];
      const data = await gql<{ orders: { nodes: ShopifyOrderNode[] } }>(ordersQuery, { q: names.map((n) => `name:${n}`).join(" OR ") });
      return (data?.orders.nodes ?? []).map((n) => mapOrder(n, cfg));
    },
    idsIn(text) {
      const hits = text.match(new RegExp(idRe.source, idRe.flags.includes("g") ? idRe.flags : idRe.flags + "g")) ?? [];
      return [...new Set(hits.map((h) => (h.startsWith("#") ? h : `#${h}`)))].slice(0, 5);
    },
  };
}
