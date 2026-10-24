// Taking COD off a parcel that is already moving.
//
// This is the piece the "pay online and save ₹55" offer stands on. Without it a
// customer pays through the link and the rider still asks for cash at the door,
// which is not a bug we would find in testing — it is a bug the customer finds,
// holding the parcel, having paid twice. The note in lib/partialCodOffer.ts
// records that happening on a live order.
//
// `cod_amount` is fixed when the shipment is booked: all three couriers read
// codAmountFor(order) at create time. So the only way to undo it is to ask the
// courier, and whether they will listen depends entirely on which courier.
//
//   Shadowfax   POST /v3/clients/order_update/ with cod_amount 0. Documented,
//               and only valid AFTER pickup — before that, cancel and rebook.
//   Delhivery   POST /api/p/edit with pt: "Pre-paid". Not in their docs; the
//               field name was found by probing a cancelled waybill of ours.
//   Ekart       Nothing. Their integration exposes create, cancel, labels and
//               webhooks, and no edit of any kind. We stopped booking with them
//               in August 2026, so this now only affects parcels already in
//               flight — but the refusal stays, because those parcels are still
//               out there and a historical order can still be looked at.
//
// Both live clients were verified against real parcels rather than documentation,
// and neither behaved as documented. See each one for what was actually true.

import type { Order } from "@engine/orders";
import { shipmentPartner } from "@adapters/couriers/shipmentPartner";
import { clearShadowfaxCod } from "@adapters/couriers/shadowfax";
import { clearDelhiveryCod, trackDelhivery, delhiveryAcceptsCodEdit } from "@adapters/couriers/delhivery";

/** Partners we can actually take COD off, once the parcel is booked. */
export const COD_CLEARABLE = ["Shadowfax", "Delhivery"] as const;

export type CodClearRefusal =
  | "no_awb"          // nothing booked yet, so there is nothing to amend
  | "unsupported";    // this partner has no edit endpoint we know of

/**
 * Everything needed to know who is carrying this parcel.
 *
 * Its own type rather than Pick<Order, …> because the columns come back from
 * Supabase as `string | null` while the Order type declares them optional, and a
 * caller holding a real row should not have to cast to ask this question.
 */
export type CarriedParcel = {
  awb_code?: string | null;
  courier_name?: string | null;
  shiprocket_order_id?: string | null;
};

/**
 * The same question, asked of the courier rather than of our own columns.
 *
 * canClearCod answers "does this partner have an edit endpoint at all", which is
 * a fact about the integration and cheap enough to ask for every order on a
 * listing page. This one answers "will they accept an edit on *this parcel*
 * right now", which costs a tracking call and is only worth making at the moment
 * money is about to change hands.
 *
 * Kept apart deliberately: canOffer runs over every COD order in the account to
 * build the eligible list, and turning that into one API call per parcel would
 * be slow enough that nobody would run it.
 *
 * Shadowfax is allowed through without a live check. Their documented rule is a
 * lower bound — the edit is only valid after pickup — and no upper bound has
 * been observed. That is an absence of evidence rather than evidence of absence,
 * so if a Shadowfax parcel ever refuses the same way a Delhivery one did, this
 * is where the check belongs.
 */
export type LateCodRefusal = "too_late" | "tracking_unavailable";

export async function codStillClearable(
  o: CarriedParcel,
): Promise<{ ok: true } | { ok: false; reason: CodClearRefusal | LateCodRefusal; partner: string }> {
  const base = canClearCod(o);
  if (!base.ok) return base;

  if (base.partner === "Delhivery") {
    let tracking;
    try {
      tracking = await trackDelhivery(o.awb_code!);
    } catch {
      // Refused rather than assumed. An outage and a parcel already on a rider
      // look identical from here, and only one of them is safe to guess at.
      return { ok: false, reason: "tracking_unavailable", partner: base.partner };
    }
    if (!tracking) return { ok: false, reason: "tracking_unavailable", partner: base.partner };
    if (!delhiveryAcceptsCodEdit(tracking)) {
      return { ok: false, reason: "too_late", partner: base.partner };
    }
  }

  return { ok: true };
}

export function canClearCod(
  o: CarriedParcel,
): { ok: true; partner: string } | { ok: false; reason: CodClearRefusal; partner: string } {
  const partner = shipmentPartner(o as Order);
  if (!o.awb_code) return { ok: false, reason: "no_awb", partner };
  if (!(COD_CLEARABLE as readonly string[]).includes(partner)) {
    return { ok: false, reason: "unsupported", partner };
  }
  return { ok: true, partner };
}

export type CodClearResult =
  | { ok: true; partner: string }
  | { ok: false; partner: string; error: string };

/**
 * Tell the courier to stop collecting cash on this parcel.
 *
 * Never throws — the caller is a payment path, and by the time this runs the
 * customer's money has already been taken. Throwing here would turn "we owe an
 * operator one panel edit" into a 500 on a page that has just charged someone.
 * The failure is returned so it can be recorded and shouted about instead.
 */
export async function clearCodAtCourier(o: CarriedParcel): Promise<CodClearResult> {
  const gate = canClearCod(o);
  if (!gate.ok) return { ok: false, partner: gate.partner, error: gate.reason };

  try {
    if (gate.partner === "Shadowfax") await clearShadowfaxCod(o.awb_code!);
    else await clearDelhiveryCod(o.awb_code!);
    return { ok: true, partner: gate.partner };
  } catch (err) {
    return {
      ok: false,
      partner: gate.partner,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
