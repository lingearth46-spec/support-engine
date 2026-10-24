// How an order's money is recorded, and how to tell when it is not.
//
// THE CONVENTION (one meaning per column, whichever code path wrote the order — browser save, Razorpay webhook, admin):
//
//   items[].price    the LIST price of each unit, always.
//   offer_discount   rupees the automatic cart offers took off the list value before any code was typed: site-wide B1G1, the per-product
//                    B1G1 / B2G1 / B2G2 tags, the chain bundle, the Build-a-Stack tiers. `offers` (jsonb) itemises it and sums to it.
//   subtotal         what the goods cost AFTER those offers:   list value − offer_discount.
//   discount         money taken off after that, by a code or a credit: coupons, the prepaid ₹55, a Magic Checkout promotion, AJUKI Wallet.
//   total            subtotal − discount + shipping + cod_fee + gift wrap.
//
// Why this and not "subtotal = list value": every order the Razorpay webhook has ever built already means `subtotal` this way, and every
// consumer that works out money from it (the courier COD amount in lib/ithink.ts, the admin edit forms, the invoice) relies on
// subtotal − discount + shipping = what is charged. Keeping that identity intact is what lets the offer be recorded without touching
// any of them. The browser save used to send list value as `subtotal` and put the offers into `discount`; that was the ambiguity.
//
// Pure: no database, no clock.
import { computeSiteWideBogoDiscount, computeOfferDiscount, type CartItem } from "@commerce/cartOffers";

export const GIFT_WRAP_COST = 30;

export type OfferKind = "site_bogo" | "tag_b1g1" | "tag_b2g1" | "tag_b2g2" | "chain_bundle" | "stack_bundle" | "unclassified";
export type OfferLine = { kind: OfferKind; label: string; amount: number };

export type Line = { price?: number | string | null; quantity?: number | string | null };

const num = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

/** What the items would cost at list price. */
export function listValue(items: Line[] | null | undefined): number {
  return (items ?? []).reduce((s, i) => s + num(i.price) * Math.max(1, num(i.quantity) || 1), 0);
}

export type MoneyFacts = {
  items: Line[] | null | undefined;
  /** Coupons, promotions and credits: everything taken off AFTER the offers. */
  discount: number | null | undefined;
  shipping?: number | null;
  cod_fee?: number | null;
  /** True when gift wrap was bought. */
  gift_wrap?: boolean | null;
  /** What gift wrap actually cost on this order, when known (the webhook has it). Falls back to GIFT_WRAP_COST. */
  gift_wrap_amount?: number | null;
  total: number | null | undefined;
};

/**
 * What the automatic offers took off, worked out from the money that actually changed hands.
 *
 *   offer = list value + shipping + cod_fee + gift wrap − discount − total
 *
 * From `total` and not from `subtotal`, deliberately: the webhook has been subtracting the express fee out of the subtotal (so a ₹499
 * piece with express shipping was stored as ₹464), which made any subtotal-based figure invent a ₹35 offer. `total` is what was charged.
 *
 * Never negative. A negative result means the order was charged MORE than list + fees − discount (an admin edit, a price change), which is
 * a different thing and is reported by `reconcile`, not hidden as an offer.
 */
export function deriveOfferDiscount(f: MoneyFacts): number {
  const raw = listValue(f.items) + num(f.shipping) + num(f.cod_fee) + (f.gift_wrap_amount != null ? num(f.gift_wrap_amount) : f.gift_wrap ? GIFT_WRAP_COST : 0) - num(f.discount) - num(f.total);
  return Math.max(0, Math.round(raw));
}

/**
 * Name what produced `amount`, when the items make it unambiguous.
 *
 * Tried in order: the site-wide BOGO (cheaper of every pair, pooled), then each per-product tag rule applied to the whole basket
 * (B1G1 → pairs, B2G1 → triples, B2G2 → quads). An exact match on the rupee names the offer. Anything else is "unclassified": the amount
 * is real (it was derived from money) but which mechanism made it is not provable from the items alone — the tag and the chain/stack flags
 * are not stored on the order — so it is never given a name it cannot back up.
 */
export function classifyOffer(items: Line[] | null | undefined, amount: number): OfferLine[] {
  const total = Math.round(amount);
  if (total <= 0) return [];
  const a = offerAmounts(items);
  if (a.site_bogo === total) return [{ kind: "site_bogo", label: "Buy 1 Get 1 Free", amount: total }];
  if (a.tag_b1g1 === total) return [{ kind: "tag_b1g1", label: "B1G1", amount: total }];
  if (a.tag_b2g1 === total) return [{ kind: "tag_b2g1", label: "B2G1", amount: total }];
  if (a.tag_b2g2 === total) return [{ kind: "tag_b2g2", label: "B2G2", amount: total }];
  return [{ kind: "unclassified", label: "Offer", amount: total }];
}

/**
 * What each offer rule would take off these items, if it applied to the whole basket. The tag and the chain/stack flags are not stored on an
 * order, so this is the set of amounts the items can PROVE; an order's real offer is one of them or it is unexplained.
 */
export function offerAmounts(items: Line[] | null | undefined): { site_bogo: number; tag_b1g1: number; tag_b2g1: number; tag_b2g2: number } {
  const cart: CartItem[] = (items ?? []).map((i, n) => ({
    id: `i${n}`, productId: `p${n}`, name: "", category: "", price: num(i.price), color: "", size: "",
    quantity: Math.max(1, num(i.quantity) || 1),
  }));
  const tag = (t: "b1g1" | "b2g1" | "b2g2") => computeOfferDiscount(cart.map((c) => ({ ...c, offerTag: t }))).discount;
  return { site_bogo: computeSiteWideBogoDiscount(cart).discount, tag_b1g1: tag("b1g1"), tag_b2g1: tag("b2g1"), tag_b2g2: tag("b2g2") };
}

export type Reconciliation = {
  ok: boolean;
  listValue: number;
  /** What `total` should be if every column means what the convention says. */
  expectedTotal: number;
  /** subtotal expected from list value and the recorded offer. */
  expectedSubtotal: number;
  issues: string[];
};

export type RecordedOrder = MoneyFacts & {
  subtotal: number | null | undefined;
  offer_discount?: number | null;
  offers?: OfferLine[] | null;
};

/**
 * Do the recorded columns agree with each other and with the convention? Used by the backfill's verification, the daily check, and tests.
 * It checks the identities, it does not decide who is right: a failing order is one a person should look at.
 */
export function reconcile(o: RecordedOrder, tolerance = 1): Reconciliation {
  const list = listValue(o.items);
  const offer = num(o.offer_discount);
  const expectedSubtotal = list - offer;
  const expectedTotal = num(o.subtotal) - num(o.discount) + num(o.shipping) + num(o.cod_fee) + (o.gift_wrap ? GIFT_WRAP_COST : 0);
  const issues: string[] = [];

  if (Math.abs(num(o.subtotal) - expectedSubtotal) > tolerance) {
    issues.push(`subtotal ${num(o.subtotal)} is not list value ${list} minus offers ${offer}`);
  }
  if (Math.abs(num(o.total) - expectedTotal) > tolerance) {
    issues.push(`total ${num(o.total)} is not subtotal − discount + shipping + fees (${expectedTotal})`);
  }
  if (o.offers && o.offers.length) {
    const sum = o.offers.reduce((s, l) => s + num(l.amount), 0);
    if (Math.abs(sum - offer) > tolerance) issues.push(`offers itemise ${sum} but offer_discount is ${offer}`);
  }
  if (offer < 0) issues.push("offer_discount is negative");
  return { ok: issues.length === 0, listValue: list, expectedTotal, expectedSubtotal, issues };
}

/**
 * The browser's save used to send `subtotal` = list value and `discount` = offers + coupons. Given what it sends, return the recorded
 * columns under the convention above.
 *
 * `offerDiscount` is what the cart took off (the same figure it showed the customer and folded into the basket it sent to Razorpay), bounded
 * by what is possible: never more than the discount it arrived inside, nor more than the goods. `agreed` says whether the money then adds up
 * (list - offers - codes + fees = total). When it does not, the order is still recorded and the caller should log it: a record that is
 * slightly off is better than a lost sale.
 */
export function normaliseBrowserMoney(input: {
  items: Line[]; discount: number; offerDiscount?: number | null; shipping?: number | null; cod_fee?: number | null;
  gift_wrap?: boolean | null; total: number;
}): { subtotal: number; discount: number; offer_discount: number; offers: OfferLine[]; agreed: boolean } {
  const list = listValue(input.items);
  const sent = Math.max(0, num(input.discount));
  const offer = Math.min(Math.max(0, Math.round(num(input.offerDiscount))), sent, list);
  const codes = sent - offer;
  const subtotal = Math.round(list - offer);
  const expected = subtotal - codes + num(input.shipping) + num(input.cod_fee) + (input.gift_wrap ? GIFT_WRAP_COST : 0);
  return {
    subtotal,
    discount: codes,
    offer_discount: offer,
    offers: classifyOffer(input.items, offer),
    agreed: Math.abs(expected - num(input.total)) <= 1,
  };
}
