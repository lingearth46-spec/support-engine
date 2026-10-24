// Run with `npx tsx lib/orderOffers.test.ts`.
// The cases are real orders (ids in the comments) read from the database on 2026-10-09, so the convention is checked against what
// customers actually paid and not against numbers invented to fit.
import { listValue, deriveOfferDiscount, classifyOffer, reconcile, normaliseBrowserMoney } from "@commerce/orderOffers";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const it = (price: number, quantity = 1) => ({ price, quantity });

// ── list value ──────────────────────────────────────────────────────────────
eq("list value multiplies by quantity", listValue([it(499), it(699, 2)]), 1897);
eq("a missing quantity counts as one", listValue([{ price: 299 }]), 299);
eq("no items", listValue(null), 0);

// ── deriving the offer from the money charged ───────────────────────────────
// AJUKI710059: 499 + 2 x 699, paid 1198, nothing else.
eq("B1G1 order: list 1897, paid 1198", deriveOfferDiscount({ items: [it(499), it(699, 2)], discount: 0, total: 1198 }), 699);
// AJUKI710025: 499 + 699 + 399, paid 1198.
eq("three items, cheapest free", deriveOfferDiscount({ items: [it(499), it(699), it(399)], discount: 0, total: 1198 }), 399);
// AJUKI710056: 499, AJUKI10 (50), express 35, paid 484. NO offer: the webhook had stored subtotal 464 and a phantom 35 would follow.
eq("express fee is not an offer", deriveOfferDiscount({ items: [it(499)], discount: 50, shipping: 35, total: 484 }), 0);
eq("an order with no offer at all", deriveOfferDiscount({ items: [it(499)], discount: 0, total: 499 }), 0);
eq("gift wrap is not an offer", deriveOfferDiscount({ items: [it(499)], discount: 0, gift_wrap: true, total: 529 }), 0);
eq("COD fee is not an offer", deriveOfferDiscount({ items: [it(499)], discount: 0, cod_fee: 49, total: 548 }), 0);
eq("charged MORE than expected is never a negative offer", deriveOfferDiscount({ items: [it(499)], discount: 0, total: 599 }), 0);
eq("offer plus a coupon: 2 x 499, B1G1 frees 499, AJUKI10 takes 50", deriveOfferDiscount({ items: [it(499, 2)], discount: 50, total: 449 }), 499);

// ── naming the offer ────────────────────────────────────────────────────────
eq("site-wide BOGO named when it matches to the rupee", classifyOffer([it(499), it(699, 2)], 699), [{ kind: "site_bogo", label: "Buy 1 Get 1 Free", amount: 699 }]);
eq("a three-item cheapest-free shape is named by the tag rule", classifyOffer([it(499), it(699), it(399)], 399)[0].kind, "tag_b2g1");
eq("an amount no rule explains is 'unclassified', never guessed", classifyOffer([it(499)], 35), [{ kind: "unclassified", label: "Offer", amount: 35 }]);
eq("no offer, no lines", classifyOffer([it(499)], 0), []);

// ── reconcile ───────────────────────────────────────────────────────────────
const good = { items: [it(499), it(699, 2)], subtotal: 1198, discount: 0, shipping: 0, cod_fee: 0, total: 1198, offer_discount: 699, offers: [{ kind: "site_bogo" as const, label: "B1G1", amount: 699 }] };
eq("a correctly recorded B1G1 order reconciles", reconcile(good).ok, true);
eq("an express order under the convention reconciles", reconcile({ items: [it(499)], subtotal: 499, discount: 50, shipping: 35, total: 484, offer_discount: 0 }).ok, true);
eq("the old webhook shape (express fee taken out of subtotal) does NOT", reconcile({ items: [it(499)], subtotal: 464, discount: 50, shipping: 35, total: 484, offer_discount: 0 }).ok, false);
eq("an unrecorded offer does NOT (subtotal below list value, no offer_discount)", reconcile({ ...good, offer_discount: 0, offers: [] }).ok, false);
eq("offers that do not add up to offer_discount are reported", reconcile({ ...good, offers: [{ kind: "site_bogo", label: "B1G1", amount: 100 }] }).issues.some((m) => m.includes("itemise")), true);
eq("gift wrap and COD fee are part of the identity", reconcile({ items: [it(499)], subtotal: 499, discount: 0, shipping: 0, cod_fee: 49, gift_wrap: true, total: 578, offer_discount: 0 }).ok, true);

// ── the browser's old shape, normalised ─────────────────────────────────────
// The browser sent subtotal = list 1897 and discount = 699 (the offer), total 1198.
const b = normaliseBrowserMoney({ items: [it(499), it(699, 2)], discount: 699, offerDiscount: 699, total: 1198 });
eq("browser B1G1: subtotal becomes net, discount becomes codes only", [b.subtotal, b.discount, b.offer_discount, b.agreed], [1198, 0, 699, true]);
// Offer AND a coupon: list 998, B1G1 frees 499, AJUKI10 takes 50 -> discount sent 549, total 449.
const c = normaliseBrowserMoney({ items: [it(499, 2)], discount: 549, offerDiscount: 499, total: 449 });
eq("browser offer + coupon are separated", [c.subtotal, c.discount, c.offer_discount, c.agreed], [499, 50, 499, true]);
eq("and the result reconciles", reconcile({ items: [it(499, 2)], subtotal: c.subtotal, discount: c.discount, total: 449, offer_discount: c.offer_discount, offers: c.offers }).ok, true);
const n = normaliseBrowserMoney({ items: [it(499)], discount: 50, offerDiscount: 0, total: 449 });
eq("no offer: nothing moves", [n.subtotal, n.discount, n.offer_discount], [499, 50, 0]);
eq("a claimed offer larger than the discount it arrived in is cut back", normaliseBrowserMoney({ items: [it(499)], discount: 50, offerDiscount: 900, total: 449 }).offer_discount, 50);
eq("money that does not add up is flagged, not rejected", normaliseBrowserMoney({ items: [it(499)], discount: 0, offerDiscount: 0, total: 300 }).agreed, false);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
