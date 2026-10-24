// Which addresses carry a COD fee — and whether the fee is actually switched on.
//
// Worth testing rather than eyeballing, because every failure here is money in
// the wrong direction: a false positive charges a real customer ₹49 they were
// never quoted, and a false negative gives away the fee in exactly the states
// it exists to cover.
//
// The fee itself is currently OFF (COD_FEE_REGION_ENABLED in codFee.ts) — the
// founder asked for it removed while Razorpay's account-level Partial COD gets
// sorted out. Region detection (isCodFeeRegion) is tested on its own so the
// underlying WB/Punjab/Odisha matching logic stays exercised and doesn't rot
// while it's dormant; codFeeFor/codFeePaiseFor are tested separately to
// confirm they return 0 everywhere regardless of region while the switch is
// off, and would need re-checking against the money-charged expectations
// below if it's ever turned back on.

import { codFeeFor, isCodFeeRegion, COD_FEE, COD_FEE_PAISE, codFeePaiseFor } from "@policy/codFee";

let passed = 0;
let failed = 0;

function eq(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
  }
}

const region = (label: string, addr: Parameters<typeof isCodFeeRegion>[0]) =>
  eq(label, isCodFeeRegion(addr), true);
const notRegion = (label: string, addr: Parameters<typeof isCodFeeRegion>[0]) =>
  eq(label, isCodFeeRegion(addr), false);

// ── The three fee states, by ISO code ──────────────────────────────────────────
region("West Bengal by code", { state_code: "WB" });
region("Punjab by code", { state_code: "PB" });
region("Odisha by code", { state_code: "OD" });
region("Odisha by its pre-2011 code", { state_code: "OR" });
region("lowercase code", { state_code: "wb" });
region("padded code", { state_code: " PB " });

// ── Everywhere else ───────────────────────────────────────────────────────────
notRegion("Maharashtra", { state_code: "MH" });
notRegion("Delhi", { state_code: "DL" });
notRegion("Karnataka", { state_code: "KA" });

// J&K is blocked outright rather than charged, so it must never read as a fee region.
notRegion("Jammu & Kashmir is blocked, not charged", { state_code: "JK" });

// ── state_code is authoritative when present ──────────────────────────────────
// A Kolkata pincode on an address Razorpay says is Maharashtra must not read as
// a fee region: trusting the looser signal over the explicit one is how a
// customer in the wrong state gets billed.
notRegion("code beats a fee-region pincode", { state_code: "MH", zipcode: "700001" });
region("code beats a non-fee pincode", { state_code: "WB", zipcode: "400070" });

// ── Falling back to the state name ────────────────────────────────────────────
region("name: West Bengal", { state: "West Bengal" });
region("name: unspaced", { state: "WestBengal" });
region("name: Orissa, the old spelling", { state: "Orissa" });
region("name: odisha lowercase", { state: "odisha" });
region("name: Punjab", { state: "Punjab" });
notRegion("name: Maharashtra", { state: "Maharashtra" });

// ── Falling back to the pincode ───────────────────────────────────────────────
region("Kolkata 700001", { zipcode: "700001" });
region("West Bengal upper bound 743711", { zipcode: "743711" });
region("Ludhiana 141001", { zipcode: "141001" });
region("Amritsar 143001", { zipcode: "143001" });
region("Bathinda 151001", { zipcode: "151001" });
region("Bhubaneswar 751001", { zipcode: "751001" });
region("Odisha upper bound 770076", { zipcode: "770076" });

// The neighbours that sit next to, or inside, those ranges.
notRegion("Sikkim 737101 sits inside the WB block", { zipcode: "737101" });
notRegion("Andaman 744101 is just past WB", { zipcode: "744101" });
notRegion("Chandigarh 160017 is just past Punjab", { zipcode: "160017" });
notRegion("Haryana 134109", { zipcode: "134109" });
notRegion("Mumbai 400070", { zipcode: "400070" });
notRegion("149 is not Punjab", { zipcode: "149001" });
notRegion("750 is just below Odisha", { zipcode: "750001" });
notRegion("771 is just past Odisha", { zipcode: "771001" });

// ── Junk in ───────────────────────────────────────────────────────────────────
notRegion("empty address", {});
notRegion("blank strings", { state: "", state_code: "", zipcode: "" });
notRegion("short pincode", { zipcode: "70" });
notRegion("non-numeric pincode", { zipcode: "ABCDEF" });
region("spaced pincode still reads", { zipcode: "700 001" });

// ── The switch: fee is off everywhere, region or not ───────────────────────────
eq("fee off in a fee region (WB)", codFeeFor({ state_code: "WB" }), 0);
eq("fee off in a fee region (Punjab)", codFeeFor({ state_code: "PB" }), 0);
eq("fee off in a fee region (Odisha)", codFeeFor({ state_code: "OD" }), 0);
eq("fee off outside a fee region too", codFeeFor({ state_code: "MH" }), 0);
eq("callback gets zero in a fee region", codFeePaiseFor({ state_code: "WB" }), 0);
eq("callback gets zero elsewhere", codFeePaiseFor({ state_code: "MH" }), 0);

// ── Units ─────────────────────────────────────────────────────────────────────
// The constant itself is untouched — still read by the risk engine's own
// per-order surcharge (Part 7, "high" risk tier), which this switch does not
// affect.
eq("fee constant is still ₹49", COD_FEE, 49);
eq("fee constant in paise", COD_FEE_PAISE, 4900);

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
