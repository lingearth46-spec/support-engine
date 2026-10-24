// What the support bot is allowed to change, and what it must refuse.
//
// The gate is one fact: no AWB. Once a parcel is booked, a change has to reach
// the courier too — and today showed exactly how that fails. `cod_amount` is
// frozen at booking, Shadowfax answers "Request accepted." for changes it never
// makes, and a customer who paid ₹244 online was still set to be charged ₹299 at
// the door. An unbooked order is only a row, and a row can be edited.

import {
  ACTION_KINDS, canAct, ownsOrder, checkAddress, checkPhone, checkCancel,
  REFUSAL_TEXT, type ActionOrder, type ActionRefusal,
} from "@engine/supportActions";
import type { OrderStatus } from "@engine/orders";

let passed = 0;
let failed = 0;
const eq = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${e}, got ${a}`); }
};

const MINE = "9000100020";
const order = (over: Partial<ActionOrder> = {}): ActionOrder => ({
  id: "AJUKI710058",
  status: "confirmed" as OrderStatus,
  awb_code: undefined,
  address: {
    name: "Tarun", line1: "17-212 Ganesh nagar port stadium back side", line2: "Akkaya",
    city: "Visakhapatnam", state: "Andhra Pradesh", pincode: "530014", phone: MINE,
  },
  ...over,
});

eq("three actions and no more", [...ACTION_KINDS], ["cancel_order", "change_address", "update_phone"]);

// ── Ownership ─────────────────────────────────────────────────────────────────
//
// The audit found two order ids typed into WhatsApp by people who were not that
// order's customer. formatOrders already withholds the address on anything found
// by a typed id; an action is far stronger, so it inherits the same rule.
eq("their own order", ownsOrder(order(), MINE), true);
eq("the OTP-verified second number counts",
  ownsOrder(order({ address: { ...order().address!, phone: "9999999999", altPhone: MINE } }), MINE), true);
eq("somebody else's number", ownsOrder(order(), "9000000001"), false);
eq("a half-typed number is nobody", ownsOrder(order(), "12345"), false);
eq("acting on a stranger's order is refused", canAct(order(), "9000000001"), { ok: false, reason: "not_owner" });

// ── The gate that carries the design ──────────────────────────────────────────
eq("an unbooked order is fair game", canAct(order(), MINE), { ok: true });
eq("a booked one is not",
  canAct(order({ awb_code: "SF00000000011" }), MINE), { ok: false, reason: "booked" });
// Status can lag reality; an AWB cannot appear without a booking. Both are
// checked, and either one is enough to stop.
eq("shipped with no AWB is still too late",
  canAct(order({ status: "shipped" as OrderStatus }), MINE), { ok: false, reason: "booked" });
eq("manifested is too late", canAct(order({ status: "manifested" as OrderStatus }), MINE), { ok: false, reason: "booked" });
eq("packed is still in time", canAct(order({ status: "packed" as OrderStatus }), MINE), { ok: true });
for (const s of ["processing", "call_1", "call_2", "on_hold", "confirmed"] as OrderStatus[]) {
  eq(`${s} is in time`, canAct(order({ status: s }), MINE), { ok: true });
}
for (const s of ["delivered", "cancelled", "wa_cancelled", "returned", "rto"] as OrderStatus[]) {
  eq(`${s} is settled`, canAct(order({ status: s }), MINE), { ok: false, reason: "settled" });
}
eq("no order at all", canAct(null, MINE), { ok: false, reason: "not_found" });

// ── Address ───────────────────────────────────────────────────────────────────
{
  const r = checkAddress(order(), { line1: "17-212 Ganesh nagar, opposite the port stadium" });
  eq("a corrected line is applied", r.ok, true);
  eq("and keeps everything else", r.ok && (r.next.city as string), "Visakhapatnam");
  eq("and does not touch the pincode", r.ok && (r.next.pincode as string), "530014");
}
// A pincode change moves the parcel between courier zones, which changes freight
// and can change who carries it. Shadowfax refuses inter-city pincode edits
// outright anyway. Correcting a house number is not the same act as redirecting
// a parcel to another city.
eq("a new pincode is refused",
  checkAddress(order(), { pincode: "560001" }), { ok: false, reason: "zone_change" });
eq("the same pincode restated is fine, if something else changed",
  checkAddress(order(), { pincode: "530014", line1: "17-212 Ganesh nagar, gate 4" }).ok, true);
eq("nothing actually different", checkAddress(order(), { city: "Visakhapatnam" }), { ok: false, reason: "no_change" });
eq("whitespace is not a change", checkAddress(order(), { city: "  Visakhapatnam  " }), { ok: false, reason: "no_change" });
eq("a two-character street is a typo", checkAddress(order(), { line1: "17" }), { ok: false, reason: "invalid" });
eq("an empty patch changes nothing", checkAddress(order(), {}), { ok: false, reason: "no_change" });

// ── Phone ─────────────────────────────────────────────────────────────────────
{
  const r = checkPhone(order(), "+91 90001 00014");
  eq("a new number is normalised", r.ok && (r.next.phone as string), "9000100014");
  eq("and the rest of the address survives", r.ok && (r.next.city as string), "Visakhapatnam");
}
// altPhone is Razorpay's OTP-verified second number and is the one contact that
// demonstrably answered. Replacing the delivery contact must not touch it.
{
  const withAlt = order({ address: { ...order().address!, altPhone: "9000100026" } });
  const r = checkPhone(withAlt, "9000100014");
  eq("altPhone is left alone", r.ok && (r.next.altPhone as string), "9000100026");
}
eq("the number they already have", checkPhone(order(), MINE), { ok: false, reason: "no_change" });
eq("too short", checkPhone(order(), "90000"), { ok: false, reason: "invalid" });
eq("not a number", checkPhone(order(), "call me"), { ok: false, reason: "invalid" });

// ── Cancel ────────────────────────────────────────────────────────────────────
eq("an open order can be cancelled", checkCancel(order()), { ok: true });
eq("a delivered one cannot", checkCancel(order({ status: "delivered" as OrderStatus })), { ok: false, reason: "settled" });

// ── What the customer hears ───────────────────────────────────────────────────
// Never the enum, and never an apology for a rule that protects them.
const REASONS: ActionRefusal[] = ["not_found", "not_owner", "booked", "settled", "zone_change", "no_change", "invalid"];
for (const r of REASONS) {
  eq(`${r} has wording`, typeof REFUSAL_TEXT[r] === "string" && REFUSAL_TEXT[r].length > 10, true);
  eq(`${r} does not leak the code`, REFUSAL_TEXT[r].includes(r), false);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
