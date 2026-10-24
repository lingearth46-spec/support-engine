// Where Cash on Delivery costs extra, and how much.
//
// The fee is quoted per address in the Magic Checkout shipping callback, and
// Razorpay renders exactly what we send ("Cash on Delivery +₹49 extra charge")
// then echoes it back on the order as `cod_fee`. Verified live on
// order_TLSvmXjn4OvVSD: amount 79900, cod_fee 4900, COD payment 84800.
//
// That makes the fee entirely ours to set, and — because the callback answers
// per address — ours to vary by region without anything being enabled on
// Razorpay's side. It is the one COD lever we control outright, unlike partial
// COD, which only Razorpay can switch on.
//
// Charged in West Bengal, Punjab and Odisha, and nowhere else. These are the
// states where enough COD parcels come back RTO that the round-trip freight
// outweighs what a fee costs in conversion. Everywhere else COD stays free,
// because a fee there would lose sales while offsetting nothing.
//
// Jammu & Kashmir is deliberately absent. It is not a fee case: COD is refused
// there outright (isJammuKashmir, in the shipping callback), so there is no fee
// to quote — the option is never offered in the first place.

/**
 * Whether the regional fee below is actually charged. Off — the founder asked
 * for it removed while Razorpay's account-level Partial COD mess gets sorted
 * out, and this is the one switch that controls it. Flip to `true` to bring the
 * West Bengal / Punjab / Odisha fee back.
 *
 * As of 2026-09-03 this is the *only* COD fee in the codebase: the risk
 * engine's `high`-tier ₹49 surcharge was removed (repeat-RTO numbers now lose
 * COD outright — riskEngine.ts manual_review — rather than paying more).
 */
const COD_FEE_REGION_ENABLED = false;

/** The COD handling fee, in rupees, in the regions that carry one. */
export const COD_FEE = 49;

/** The same fee in paise, which is the unit the shipping callback speaks. */
export const COD_FEE_PAISE = COD_FEE * 100;

export type FeeAddress = {
  state?: string;
  state_code?: string;
  zipcode?: string;
};

/**
 * ISO 3166-2:IN codes for the three states.
 *
 * Odisha appears twice on purpose. It was IN-OR until the 2011 rename and both
 * codes are still emitted in the wild, so matching only the current one would
 * quietly let half of Odisha through free.
 */
const FEE_STATE_CODES = new Set(["WB", "PB", "OD", "OR"]);

const FEE_STATE_NAMES = /west\s*bengal|punjab|odisha|orissa/i;

/**
 * First three digits of the pincode, as inclusive ranges.
 *
 * Punjab is listed as two ranges rather than 140-152 because 149 and 150 are
 * not Punjab, and Chandigarh's 160 sits just past the end — a single sweep
 * would have charged a union territory we never meant to touch.
 */
const FEE_PIN_RANGES: Array<[number, number]> = [
  [700, 743], // West Bengal
  [140, 148], // Punjab (Mohali through Sangrur)
  [151, 152], // Punjab (Bathinda, Ferozepur)
  [751, 770], // Odisha
];

/**
 * Sikkim's 737 block sits inside West Bengal's 700-743 range. Without this,
 * every Sikkim order would be charged a West Bengal fee.
 */
const FEE_PIN_EXCLUDED: Array<[number, number]> = [[737, 737]];

/**
 * Does this address carry a COD fee?
 *
 * `state_code` is authoritative when present: if Razorpay tells us the state and
 * it is not one of the three, that settles it, and the looser checks below are
 * not consulted at all.
 *
 * This is the opposite of how isJammuKashmir reads the same address, and the
 * asymmetry is intentional. There, any hint of J&K blocks COD, because wrongly
 * allowing it costs a round trip of freight. Here, a wrong match charges a real
 * customer money they were never meant to pay, so the burden of proof is the
 * other way round: charge only when the address is positively one of the three.
 */
export function isCodFeeRegion(addr: FeeAddress): boolean {
  const code = (addr.state_code ?? "").trim().toUpperCase();
  if (code) return FEE_STATE_CODES.has(code);

  if (FEE_STATE_NAMES.test(addr.state ?? "")) return true;

  const digits = String(addr.zipcode ?? "").replace(/\D/g, "");
  if (digits.length < 3) return false;
  const prefix = parseInt(digits.slice(0, 3), 10);

  if (FEE_PIN_EXCLUDED.some(([lo, hi]) => prefix >= lo && prefix <= hi)) return false;
  return FEE_PIN_RANGES.some(([lo, hi]) => prefix >= lo && prefix <= hi);
}

/** The COD fee for this address, in rupees. 0 everywhere outside the three states, and 0 everywhere while the switch above is off. */
export function codFeeFor(addr: FeeAddress): number {
  return (COD_FEE_REGION_ENABLED && isCodFeeRegion(addr)) ? COD_FEE : 0;
}

/** The COD fee for this address, in paise, ready for the shipping callback. */
export function codFeePaiseFor(addr: FeeAddress): number {
  return codFeeFor(addr) * 100;
}
