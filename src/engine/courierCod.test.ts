// Which couriers will let us stop collecting cash on a parcel already in flight.
//
// This is the gate the whole "pay online and save ₹55" offer hangs on. Get it
// wrong in the permissive direction and a customer pays through the link, the
// rider still asks for cash, and they pay twice — a failure they discover
// holding the parcel, not one we find in testing.
//
// Only network-free logic is tested here; the two clients themselves are
// verified against the live APIs and documented where they are defined.

import { canClearCod, COD_CLEARABLE } from "@engine/courierCod";
import { delhiveryAcceptsCodEdit } from "@adapters/couriers/delhivery";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  good ? pass++ : fail++;
  if (!good) console.error(`FAIL ${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const reason = (o: Parameters<typeof canClearCod>[0]) => {
  const r = canClearCod(o);
  return r.ok ? "ok" : r.reason;
};

// ── Who we can amend ──────────────────────────────────────────────────────────
eq("two partners, no more", [...COD_CLEARABLE], ["Shadowfax", "Delhivery"]);

// Shadowfax: POST /v3/clients/order_update/ with cod_amount 0, documented and
// probed. Their courier_name arrives with service suffixes.
eq("shadowfax", reason({ courier_name: "Shadowfax", awb_code: "SF00000000010" }), "ok");
eq("shadowfax with a suffix", reason({ courier_name: "Shadowfax Surface", awb_code: "SF1" }), "ok");

// Delhivery direct: /api/p/edit with pt "Pre-paid". Only the bare name is a
// direct booking — "Delhivery Surface" is a service Shiprocket assigned, and
// Shiprocket's parcels are Shiprocket's to amend.
eq("delhivery direct", reason({ courier_name: "Delhivery", awb_code: "60000000000002" }), "ok");
eq("delhivery via shiprocket", reason({ courier_name: "Delhivery Surface", awb_code: "1" }), "unsupported");
eq("delhivery with a shiprocket id",
  reason({ courier_name: "Delhivery", awb_code: "1", shiprocket_order_id: "9" }), "unsupported");

// ── Who we cannot ─────────────────────────────────────────────────────────────
// Ekart exposes create, cancel, labels and webhooks and no edit of any kind, and
// is no longer booked with. Parcels already in flight must still be refused.
eq("ekart", reason({ courier_name: "Ekart Logistics Surface", awb_code: "LUAC0001358739" }), "unsupported");
eq("amazon", reason({ courier_name: "Amazon COD Surface 500gm", awb_code: "371100475037" }), "unsupported");
eq("xpressbees via shiprocket", reason({ courier_name: "Xpressbees Surface", awb_code: "1" }), "unsupported");
eq("an unknown carrier", reason({ courier_name: "Blue Dart", awb_code: "1" }), "unsupported");
eq("no courier at all", reason({ awb_code: "1" }), "unsupported");

// ── Nothing booked ────────────────────────────────────────────────────────────
// Checked before the partner, because "we have not booked this yet" is the more
// useful answer than "that partner is unsupported" — and there is no AWB to
// amend it by either way.
eq("no awb", reason({ courier_name: "Shadowfax" }), "no_awb");
eq("null awb", reason({ courier_name: "Shadowfax", awb_code: null }), "no_awb");
eq("blank awb", reason({ courier_name: "Shadowfax", awb_code: "" }), "no_awb");
eq("no awb outranks unsupported", reason({ courier_name: "Ekart" }), "no_awb");

// ── The partner is reported either way, so a refusal can be acted on ──────────
eq("partner on success", canClearCod({ courier_name: "Shadowfax", awb_code: "SF1" }).partner, "Shadowfax");
eq("partner on refusal", canClearCod({ courier_name: "Ekart", awb_code: "L1" }).partner, "Ekart");

// ── The edit window, found on a live parcel ───────────────────────────────────
//
// Knowing a courier *has* an edit endpoint is not the same as knowing it will
// accept one now. AJUKI710016, 16 Aug 2026: out for delivery at 10:30, paid at
// 11:51, and Delhivery refused — "Current status is UD Dispatched" — leaving
// ₹449 on the waybill against ₹394 taken online, with the rider already
// carrying it. Their docs never said the window closed at dispatch.
eq("out for delivery is too late", delhiveryAcceptsCodEdit({ status: "Dispatched" }), false);
eq("delivered is too late", delhiveryAcceptsCodEdit({ status: "Delivered" }), false);
eq("rto is too late", delhiveryAcceptsCodEdit({ status: "RTO" }), false);

// Everything up to a rider taking it out is still amendable.
eq("in transit is fine", delhiveryAcceptsCodEdit({ status: "In Transit" }), true);
eq("pending is fine", delhiveryAcceptsCodEdit({ status: "Pending" }), true);
eq("manifested is fine", delhiveryAcceptsCodEdit({ status: "Manifested" }), true);
eq("case does not matter", delhiveryAcceptsCodEdit({ status: "in transit" }), true);
eq("a qualified status still matches", delhiveryAcceptsCodEdit({ status: "In Transit - At Hub" }), true);

// An allowlist, so anything unrecognised is refused. Wrong in this direction
// costs a missed conversion; wrong in the other takes money for a parcel the
// rider will still collect cash on.
eq("an unknown status is refused", delhiveryAcceptsCodEdit({ status: "Something New" }), false);
eq("no tracking at all is refused", delhiveryAcceptsCodEdit(null), false);
eq("an empty status is refused", delhiveryAcceptsCodEdit({ status: "" }), false);
eq("nothing lets dispatched through", delhiveryAcceptsCodEdit({ status: "Dispatched to rider" }), false);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
