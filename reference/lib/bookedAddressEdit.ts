// A customer's corrected address for a parcel that is ALREADY booked with a courier.
//
// The address can sometimes still be changed at the courier (Delhivery and Shadowfax), but a customer's free-text reply is not something to push to a
// courier unseen. So the WhatsApp flow only records a PROPOSAL on the order, and a Telegram message with an Approve button asks a person
// (lib/telegramActions.ts: "aea" approve, "aes" skip). Only an approval reaches the courier.
//
// The proposal is one line in orders.admin_notes, so nothing new is stored:
//   [addr-edit-proposed <iso> pin=<pincode>] <address text>
// followed, once decided, by [addr-edit-approved <iso>] ... or [addr-edit-skipped <iso>].
//
// What the couriers really accept (NDR_POLICY.md, 17 Oct review of this flow):
//   · Delhivery: name, address text and phone only, NEVER the pincode or city, and the request is asynchronous: a 201 proves nothing, and the edit is
//     usually accepted only while the parcel sits in its failed-delivery window. So a different pincode is refused here, a parcel outside that window
//     carries a warning, and every approved edit is logged in delhivery_ndr_requests so the hourly reconcile pass finds out if it was refused.
//   · Shadowfax: the address text, and a pincode inside the same city, at most twice; the courier answers at once but masks what it applied.
//   · Any other courier: not editable from here.

import type { SupabaseClient } from "@supabase/supabase-js";

const PROPOSED = "[addr-edit-proposed";
const DECIDED = /\[addr-edit-(approved|skipped) /;
const CLOSED = new Set(["delivered", "cancelled", "wa_cancelled", "rto", "returned"]);

export type Partner = "Delhivery" | "Shadowfax" | null;

export interface BookedOrder {
  id?: string;
  status?: string | null;
  awb_code: string | null;
  address: unknown;
  courier_name?: string | null;
  shiprocket_order_id?: string | null;
  admin_notes?: string | null;
}

export const proposalLine = (text: string, pincode: string) =>
  `${PROPOSED} ${new Date().toISOString()} pin=${pincode}] ${text.replace(/\s+/g, " ").trim().slice(0, 240)}`;

/** The newest proposal that has not been decided yet. */
export function openProposal(notes: string | null | undefined): { text: string; pincode: string } | null {
  const lines = String(notes ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\[addr-edit-proposed [^\s]+ pin=(\d{6})\] (.+)$/);
    if (m) {
      const decidedAfter = lines.slice(i + 1).some((l) => DECIDED.test(l));
      return decidedAfter ? null : { pincode: m[1], text: m[2] };
    }
  }
  return null;
}

const pinOf = (address: unknown): string => String(((address ?? {}) as Record<string, unknown>).pincode ?? "").replace(/\D/g, "").slice(0, 6);
const lineOf = (address: unknown): string => {
  const a = (address ?? {}) as Record<string, unknown>;
  return [a.line1, a.city, a.pincode].map((s) => String(s ?? "").trim()).filter(Boolean).join(", ") || "(none on record)";
};

/**
 * Make the customer's NEXT typed message the proposed address for this booked parcel: the same pending action the "Edit address" button parks, which the webhook
 * answers with the proposal flow (record on the order, Telegram Approve / Skip, nothing reaches the courier until a person approves). false when the column is not
 * migrated or the write failed, so the caller can say so. Used when the bot asks a customer of a dispatched parcel for the new address.
 */
export async function parkAddressEditPending(db: SupabaseClient, phone: string, orderId: string): Promise<boolean> {
  const { error } = await db.from("wa_conversations").upsert(
    { phone, pending_action: { kind: "confirm_addr_edit", order_id: orderId, set_at: new Date().toISOString() }, updated_at: new Date().toISOString() },
    { onConflict: "phone" },
  );
  if (error) console.error("[booked-address] could not park the address ask:", error.message);
  return !error;
}

/** Which courier holds the parcel, for the edit: null when it is one we cannot edit through. */
export async function partnerOf(order: BookedOrder): Promise<Partner> {
  if (!order.awb_code) return null;
  const { shipmentPartner } = await import("@/lib/shipmentPartner");
  const p = shipmentPartner(order as never);
  return p === "Delhivery" || p === "Shadowfax" ? p : null;
}

export interface EditCheck { ok: boolean; reason?: string; warnings: string[]; partner: Partner }

/** What can be done with this proposal, before anyone is asked to approve it. Pure. */
export function checkBookedEdit(order: BookedOrder, proposalPincode: string, partner: Partner): EditCheck {
  const warnings: string[] = [];
  const status = String(order.status ?? "");
  if (CLOSED.has(status)) return { ok: false, reason: `The order is ${status}: nothing to change.`, warnings, partner };
  if (!order.awb_code) return { ok: false, reason: "The parcel is not booked yet: the ordinary address edit applies.", warnings, partner };
  if (!partner) return { ok: false, reason: "This courier cannot be edited from here: update the address with them by hand.", warnings, partner };
  const current = pinOf(order.address);
  const differs = !!proposalPincode && !!current && proposalPincode !== current;
  if (partner === "Delhivery") {
    if (differs) return { ok: false, reason: `Delhivery cannot change the pincode (${current} to ${proposalPincode}): ask their account manager or update it by hand.`, warnings, partner };
    if (status !== "undelivered") warnings.push(`Delhivery usually accepts an edit only while the parcel is in its failed-delivery window; this one is "${status || "unknown"}", so the courier may refuse it later.`);
  } else if (differs) {
    warnings.push(`Shadowfax takes a pincode change (${current} to ${proposalPincode}) only inside the same city, and at most twice.`);
  }
  return { ok: true, warnings, partner };
}

export interface ApproveDeps {
  partnerOf: (order: BookedOrder) => Promise<Partner>;
  delhiveryEdit: (awb: string, text: string) => Promise<{ uploadId?: string }>;
  shadowfaxEdit: (awb: string, text: string, pincode?: string) => Promise<{ ok: boolean; note: string }>;
  /** Log the request so the hourly reconcile pass verifies it. */
  logDelhivery: (db: SupabaseClient, orderId: string, awb: string, uploadId?: string) => Promise<void>;
  send: (phone: string, text: string) => Promise<boolean>;
  record: (db: SupabaseClient, row: { phone: string; body: string; orderId: string }) => Promise<void>;
}

async function logDelhiveryEditRow(db: SupabaseClient, orderId: string, awb: string, uploadId?: string): Promise<void> {
  const { error } = await db.from("delhivery_ndr_requests").insert({
    order_id: orderId, waybill: awb, act: "EDIT_DETAILS", upl_id: uploadId ?? null, live_status: "customer address edit (approved)", live_status_code: null,
    raw: { source: "booked_address_edit", request_id: uploadId ?? null },
  });
  if (error && error.code !== "42P01") console.error("[booked-address] delhivery_ndr_requests insert failed:", error.message);
}

const realDeps: ApproveDeps = {
  partnerOf,
  delhiveryEdit: async (awb, text) => { const { editDelhiveryNdrDetails } = await import("@/lib/delhivery"); return editDelhiveryNdrDetails(awb, { address: text }); },
  shadowfaxEdit: async (awb, text, pincode) => { const { updateShadowfaxDeliveryDetails } = await import("@/lib/shadowfax"); const r = await updateShadowfaxDeliveryDetails(awb, { address: text, ...(pincode ? { pincode } : {}) }); return { ok: r.ok, note: r.note }; },
  logDelhivery: logDelhiveryEditRow,
  send: async (phone, text) => { const { sendWhatsApp } = await import("@/lib/whatsapp"); return sendWhatsApp(phone, text); },
  // Lazy: waSupport pulls in the Sanity client at load, which would break importing this module in tests.
  record: async (db, row) => { const { recordOutbound } = await import("@/lib/waSupport"); await recordOutbound(db, { phone: row.phone, body: row.body, source: "system", orderId: row.orderId, tag: "address_change" }); },
};

/** The Approve tap: re-check, push the proposal to the courier, record it, tell the customer. */
export async function approveAddressEdit(db: SupabaseClient, orderId: string, deps: Partial<ApproveDeps> = {}): Promise<{ ok: boolean; toast: string; edit?: string }> {
  const d: ApproveDeps = { ...realDeps, ...deps };
  const { data: order } = await db
    .from("orders")
    .select("id, status, awb_code, address, courier_name, shiprocket_order_id, admin_notes")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return { ok: false, toast: "Order not found" };
  const proposal = openProposal(order.admin_notes);
  if (!proposal) return { ok: false, toast: "Already handled", edit: `Address edit for ${orderId} was already handled.` };

  const partner = await d.partnerOf(order as BookedOrder);
  const chk = checkBookedEdit(order as BookedOrder, proposal.pincode, partner);
  if (!chk.ok) return { ok: false, toast: String(chk.reason).slice(0, 190), edit: `${orderId}: ${chk.reason} Not changed.` };

  const awb = String(order.awb_code);
  let note: string;
  try {
    if (partner === "Shadowfax") {
      const r = await d.shadowfaxEdit(awb, proposal.text, proposal.pincode !== pinOf(order.address) ? proposal.pincode : undefined);
      if (!r.ok) return { ok: false, toast: `Shadowfax: ${r.note}`.slice(0, 190), edit: `${orderId}: Shadowfax refused: ${r.note}. Not changed.` };
      note = `Shadowfax: ${r.note}`;
    } else {
      const r = await d.delhiveryEdit(awb, proposal.text);
      await d.logDelhivery(db, orderId, awb, r.uploadId);
      note = `Delhivery: edit submitted${r.uploadId ? ` (request ${r.uploadId})` : ""}; applied asynchronously, the hourly NDR check will flag a refusal`;
    }
  } catch (err) {
    const msg = `${partner}: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, toast: msg.slice(0, 190), edit: `${orderId}: courier refused: ${msg}. Not changed.` };
  }

  const was = lineOf(order.address);
  const before = (order.address ?? {}) as Record<string, unknown>;
  await db.from("orders").update({
    // Approved by a person, so our copy follows the courier's. The old address is kept in the note so it can be put back.
    address: { ...before, line1: proposal.text.slice(0, 240), line2: "", pincode: proposal.pincode },
    admin_notes: [order.admin_notes, `[addr-edit-approved ${new Date().toISOString()}] ${note} | was: ${was}`].filter(Boolean).join("\n"),
  }).eq("id", orderId);

  const phone = String((before as { phone?: string }).phone ?? "").replace(/\D/g, "").slice(-10);
  if (phone.length === 10) {
    const reply = "Your updated address has been sent to the courier. Please keep your phone reachable for the delivery.";
    if (await d.send(phone, reply)) await d.record(db, { phone, body: reply, orderId });
  }
  return { ok: true, toast: "Sent to the courier", edit: `✅ Address for ${orderId} sent to the courier (${note}). Our copy is updated; it was: ${was}.${chk.warnings.length ? ` ⚠️ ${chk.warnings.join(" ")}` : ""}` };
}

/** The Skip tap: leave the courier alone; a person will handle it. */
export async function skipAddressEdit(db: SupabaseClient, orderId: string): Promise<{ toast: string; edit: string }> {
  const { data: order } = await db.from("orders").select("admin_notes").eq("id", orderId).maybeSingle();
  const notes = [order?.admin_notes, `[addr-edit-skipped ${new Date().toISOString()}]`].filter(Boolean).join("\n");
  await db.from("orders").update({ admin_notes: notes }).eq("id", orderId);
  return { toast: "Skipped", edit: `⏭️ Address edit for ${orderId} skipped — handle it by hand.` };
}
