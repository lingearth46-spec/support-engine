// The cart's price-reducing offers, as pure functions.
//
// Moved out of context/CartContext.tsx unchanged so the SERVER can run the same arithmetic the cart does: the order record needs to say how
// much each offer took off (lib/orderOffers.ts), and a second copy of "the cheaper of every pair is free" is a second place to drift.
// CartContext re-exports everything here, so existing imports keep working.

export interface ChainBundleConfig {
  enabled: boolean;
  requiredQty: number;
  bundlePrice: number;
  categorySlug: string;
  label?: string;
}

export interface StackBundleConfig {
  enabled: boolean;
  tier1Qty: number;
  tier1Percent: number;
  tier2Qty: number;
  tier2Percent: number;
  tier3Qty: number;
  tier3Percent: number;
}

export interface CartItem {
  id: string;          // product id + variant key e.g. "sovereign-chain-silver-20inch"
  productId: string;
  slug?: string;
  name: string;
  category: string;
  price: number;
  color: string;
  size: string;
  quantity: number;
  image?: string;
  sku?: string;
  offerTag?: "b1g1" | "b2g1" | "b2g2";
  /** Added via /build-a-stack. Marks the item out of the chain-bundle, offer-tag
   *  and site-wide-BOGO pools (see their filters below) so it's priced by the
   *  stack tier discount only, never double-discounted by both mechanics. */
  stackBundle?: boolean;
}

// ── Chain bundle discount calculator ─────────────────────────────────────────
export function computeChainBundleDiscount(
  items: CartItem[],
  config: ChainBundleConfig | null
): { discount: number; label: string; chainQty: number } {
  if (!config?.enabled) return { discount: 0, label: "", chainQty: 0 };

  const chainItems = items.filter(
    (i) => i.category.toLowerCase() === config.categorySlug.toLowerCase() && !i.stackBundle
  );
  const chainQty = chainItems.reduce((sum, i) => sum + i.quantity, 0);

  if (chainQty < config.requiredQty) return { discount: 0, label: "", chainQty };

  const bundles = Math.floor(chainQty / config.requiredQty);

  // Expand into individual units sorted desc — bundle takes the most expensive ones
  const units: number[] = [];
  chainItems.forEach((item) => {
    for (let q = 0; q < item.quantity; q++) units.push(item.price);
  });
  units.sort((a, b) => b - a);

  const bundledSubtotal = units.slice(0, bundles * config.requiredQty).reduce((s, p) => s + p, 0);
  const discount = Math.max(0, bundledSubtotal - bundles * config.bundlePrice);
  const label = config.label ?? `${config.requiredQty} Chains for ₹${config.bundlePrice}`;

  return { discount, label, chainQty };
}

// Sorts units by price desc, splits into consecutive groups of `groupSize`,
// and marks the cheapest `freePerGroup` in each complete group as free.
// Shared by the per-product tag offers and the site-wide BOGO — both are the
// same "cheapest of every group is free" mechanic over different item pools.
function groupCheapestFree(
  units: { id: string; price: number }[],
  groupSize: number,
  freePerGroup: number
): { discount: number; freeUnitsByItemId: Record<string, number>; freeCount: number } {
  const sorted = [...units].sort((a, b) => b.price - a.price);
  const completeGroups = Math.floor(sorted.length / groupSize);
  let discount = 0;
  const freeUnitsByItemId: Record<string, number> = {};

  for (let g = 0; g < completeGroups; g++) {
    for (let f = groupSize - freePerGroup; f < groupSize; f++) {
      const unit = sorted[g * groupSize + f];
      discount += unit.price;
      freeUnitsByItemId[unit.id] = (freeUnitsByItemId[unit.id] ?? 0) + 1;
    }
  }

  return { discount, freeUnitsByItemId, freeCount: completeGroups * freePerGroup };
}

// ── Per-product BOGO discount calculator (Offer Tag) ────────────────────────
// Returns total discount amount and free unit count per cart item id.
export function computeOfferDiscount(items: CartItem[]): {
  discount: number;
  freeUnitsByItemId: Record<string, number>;
  offerLabel: string;
} {
  const tags = ["b1g1", "b2g1", "b2g2"] as const;
  let totalDiscount = 0;
  let freeUnitsByItemId: Record<string, number> = {};
  let offerLabel = "";

  for (const tag of tags) {
    const tagged = items.filter((i) => i.offerTag === tag && !i.stackBundle);
    if (tagged.length === 0) continue;

    const units: { id: string; price: number }[] = [];
    tagged.forEach((item) => {
      for (let q = 0; q < item.quantity; q++) {
        units.push({ id: item.id, price: item.price });
      }
    });

    const groupSize = tag === "b1g1" ? 2 : tag === "b2g1" ? 3 : 4;
    const freePerGroup = tag === "b2g2" ? 2 : 1;
    const { discount, freeUnitsByItemId: tagFree, freeCount } = groupCheapestFree(units, groupSize, freePerGroup);

    totalDiscount += discount;
    freeUnitsByItemId = { ...freeUnitsByItemId, ...tagFree };

    if (freeCount > 0) {
      const tagLabel = tag === "b1g1" ? "B1G1" : tag === "b2g1" ? "B2G1" : "B2G2";
      offerLabel = `${tagLabel} — ${freeCount} item${freeCount > 1 ? "s" : ""} free`;
    }
  }

  return { discount: totalDiscount, freeUnitsByItemId, offerLabel };
}

// ── Site-wide BOGO discount calculator ───────────────────────────────────────
// Buy any 2 items storewide (no tag needed) — the cheaper of every complete
// pair, pooled across the entire cart, is free. Replaces computeOfferDiscount
// while the Sanity `siteWideBogo.enabled` toggle is on — see CartProvider.
export function computeSiteWideBogoDiscount(
  items: CartItem[],
  label?: string
): { discount: number; freeUnitsByItemId: Record<string, number>; offerLabel: string } {
  const units: { id: string; price: number }[] = [];
  items.filter((i) => !i.stackBundle).forEach((item) => {
    for (let q = 0; q < item.quantity; q++) {
      units.push({ id: item.id, price: item.price });
    }
  });

  const { discount, freeUnitsByItemId, freeCount } = groupCheapestFree(units, 2, 1);
  const offerLabel =
    freeCount > 0
      ? `${label || "Buy 1 Get 1 Free"} — ${freeCount} item${freeCount > 1 ? "s" : ""} free`
      : "";

  return { discount, freeUnitsByItemId, offerLabel };
}

// ── Build-a-Stack tiered discount calculator ────────────────────────────────
// Only ever looks at items tagged `stackBundle` (added via /build-a-stack) —
// never the rest of the cart — so it can never collide with the chain-bundle,
// offer-tag or site-wide-BOGO mechanics above, whatever combination is active.
export function computeStackBundleDiscount(
  items: CartItem[],
  config: StackBundleConfig | null
): { discount: number; label: string; percent: number; qty: number } {
  if (!config?.enabled) return { discount: 0, label: "", percent: 0, qty: 0 };

  const stackItems = items.filter((i) => i.stackBundle);
  const qty = stackItems.reduce((sum, i) => sum + i.quantity, 0);

  const percent =
    qty >= config.tier3Qty
      ? config.tier3Percent
      : qty >= config.tier2Qty
        ? config.tier2Percent
        : qty >= config.tier1Qty
          ? config.tier1Percent
          : 0;
  if (percent === 0) return { discount: 0, label: "", percent: 0, qty };

  const stackSubtotal = stackItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const discount = Math.round((stackSubtotal * percent) / 100);
  const label = `Stack discount — ${percent}% off`;

  return { discount, label, percent, qty };
}
