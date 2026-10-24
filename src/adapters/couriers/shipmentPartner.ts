// Which of our four partners actually carried an order, and what "shipped" means.
//
// Extracted so the courier breakdown and the courier×region RTO matrix collapse
// carriers to partners identically — the mapping matters (it is what makes the
// numbers agree with the couriers' own reports), so it must not be duplicated and
// allowed to drift.

// `import type` rather than inline `type` specifiers: the whole statement is
// then erased at compile time, which is what lets this module be loaded
// directly by the test runner without the "@/" alias needing to resolve.
import type { Order, OrderStatus } from "@engine/orders";

// Everything that physically left us. Manifested is excluded: it has an AWB but
// the parcel is still awaiting pickup, so counting it would flatter every rate.
export const SHIPPED_LIFECYCLE: OrderStatus[] = ["shipped", "undelivered", "delivered", "rto", "returned"];

// On its way back, or back with us — the two RTO outcomes.
export const CAME_BACK: OrderStatus[] = ["rto", "returned"];

// The partners we actually book with. Order is display order.
export const PARTNERS = ["Shiprocket", "Amazon Shipping", "Ekart", "Shadowfax", "Delhivery", "DTDC"] as const;

/**
 * Collapse an order to its shipping partner.
 *
 * Couriers and their reports write sub-services into courier_name — "Xpressbees
 * Surface", "Delhivery Air", "Ekart Logistics Surface", "Amazon COD Surface
 * 500gm" — but each is a service of one of these partners. A shiprocket_order_id
 * is the only sure sign a shipment is Shiprocket's; the name is a fallback, and
 * anything not recognised as Amazon / Shadowfax / Ekart / DTDC reached us
 * through Shiprocket (Delhivery, Xpressbees, Blue Dart are carriers it assigns
 * — Delhivery is handled separately below because we also book it direct).
 *
 * Ekart is retired from new bookings (see lib/courierPreference) but stays
 * here: every historical Ekart shipment still needs to collapse correctly.
 */
export function shipmentPartner(o: Order): string {
  if (o.shiprocket_order_id) return "Shiprocket";
  const c = (o.courier_name ?? "").toLowerCase();
  if (c.includes("amazon")) return "Amazon Shipping";
  if (c.includes("shadowfax")) return "Shadowfax";
  if (c.includes("ekart")) return "Ekart";
  // DTDC direct is only ever booked by us — see push-dtdc — and always
  // recorded as bare "DTDC", so `includes` is safe (unlike Delhivery, DTDC is
  // never a carrier Shiprocket assigns for us today).
  if (c.includes("dtdc")) return "DTDC";
  // Delhivery is the one carrier we reach both ways, so the name has to be read
  // exactly. Shiprocket always names the service it assigned — "Delhivery
  // Surface", "Delhivery Air" — while a direct booking is recorded as the bare
  // "Delhivery" and nothing else. Matching on `includes` instead would have
  // claimed a Shiprocket "Delhivery Air" parcel that predates this integration
  // and happens to carry no shiprocket_order_id.
  if (c.trim() === "delhivery") return "Delhivery";
  return "Shiprocket";
}
