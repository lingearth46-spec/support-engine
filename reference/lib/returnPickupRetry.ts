// "Try again tomorrow" on return_pickup_missed_v1.
//
// Neither courier offers a reschedule for a reverse pickup through its API —
// Shadowfax's reverse product has create, cancel and track, nothing else — so a
// tap cannot book a new slot on its own. What it can do is put the request in
// front of a person who can call the courier, mark the return so the panel shows
// it, and tell the customer honestly what happens next.
//
// The tap opens the 24-hour window, so the reply is free text.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";
import { notify } from "@/lib/telegram";
import { sendWhatsApp } from "@/lib/whatsapp";
import { recordInbound, recordOutbound } from "@/lib/waSupport";
import type { ReturnRequest } from "@/lib/orders";

export const PICKUP_RETRY_BUTTON = "try again tomorrow";

export function isPickupRetryButton(text: string): boolean {
  return text.trim().toLowerCase() === PICKUP_RETRY_BUTTON;
}

/** Stages a retry still makes sense in — not collected yet. */
const WAITING = new Set(["scheduled", "out_for_pickup", "attempt_failed"]);

/**
 * Handle the tap. Returns false when no waiting pickup belongs to this phone,
 * so the caller can hand the message to a person instead.
 */
export async function handlePickupRetryTap(
  db: SupabaseClient,
  args: { phone: string; waMessageId?: string | null },
): Promise<boolean> {
  const { phone } = args;

  const { data } = await db
    .from("orders")
    .select("id, address, return_request")
    .or(`address->>phone.like.%${phone}%,address->>altPhone.like.%${phone}%`)
    .eq("return_request->pickup_shipment->>status", "confirmed")
    .order("created_at", { ascending: false })
    .limit(8);

  const order = (data ?? []).find((o) => {
    const mine = normalizePhone(o.address?.phone ?? "") === phone || normalizePhone(o.address?.altPhone ?? "") === phone;
    const stage = (o.return_request as ReturnRequest | null)?.pickup_shipment?.tracking?.stage ?? "scheduled";
    return mine && WAITING.has(stage);
  });
  if (!order) return false;

  const { duplicate } = await recordInbound(db, {
    phone, body: "Try again tomorrow", waMessageId: args.waMessageId ?? null, orderId: order.id,
  });
  if (duplicate) return true; // Meta redelivered the same tap

  const { data: fresh } = await db.from("orders").select("return_request").eq("id", order.id).single();
  const rr = fresh?.return_request as ReturnRequest | null;
  if (rr) {
    await db.from("orders")
      .update({ return_request: { ...rr, pickup_retry_requested_at: new Date().toISOString() } })
      .eq("id", order.id);
  }

  const ship = rr?.pickup_shipment;
  await notify(
    "OPS",
    `🔁 <b>Customer asked for another pickup attempt · #${order.id}${order.address?.name ? ` · ${order.address.name}` : ""}</b>\n` +
      `${ship?.courier ?? "Courier"} ${ship?.request_id ?? ""}\n` +
      `${ship?.tracking?.raw ? `Last: ${ship.tracking.raw}\n` : ""}` +
      `They tapped <b>Try again tomorrow</b>. Ask the courier to reattempt tomorrow.\n` +
      `→ https://www.ajuki.in/admin/returns`,
  ).catch(() => {});

  const reply =
    "Thank you! We've asked the courier to try again tomorrow. Please keep the item packed and your phone reachable, as the rider will call before coming.";
  if (await sendWhatsApp(phone, reply)) {
    await recordOutbound(db, { phone, body: reply, source: "system", tag: "return", orderId: order.id }).catch(() => {});
  }
  return true;
}
