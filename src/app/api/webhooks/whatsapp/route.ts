// WhatsApp Cloud API webhook.
//
// Required env vars:
//   WHATSAPP_VERIFY_TOKEN — any string; must match what is typed into the
//                           webhook config in the Meta app dashboard
//   WHATSAPP_APP_SECRET   — the app secret, used to verify each POST is really
//                           from Meta. Optional but strongly wanted: without it
//                           anyone who learns this URL can cancel orders.
//
// Two things arrive here:
//
//   messages  — a customer answering the COD confirmation, either by tapping a
//               Yes/No button or by typing. This is what the whole confirmation
//               flow waits on.
//   statuses  — delivery receipts for messages we sent. Only failures are worth
//               acting on, and only to make them visible.
//
// Replaces the Green API receiver. Meta's payload is deeply nested and batches
// several events per request, so everything below is written to tolerate an
// entry that is not what it expects rather than assume shape.

import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { notify, sendWithButtons } from "@adapters/notifier/telegram";
import { encodeCallback } from "@adapters/notifier/telegramCallback";
import { type BookedOrder, type NdrOrder, checkBookedEdit, handleNdrButtonTap, handleNdrPendingReply, handlePickupRetryTap, handlePincodeReply, handlePincodeTap, isNdrButton, isPickupRetryButton, isPincodeButton, ndrCourierOf, partnerOf, pendingActionFresh, proposalLine, readPendingAction, readPincodePending } from "@engine/lateModule";
import { sendWhatsApp, sendWhatsAppButtons } from "@adapters/messaging/whatsapp";
import { isMenuId, menuTapIdOf } from "@engine/menuFlows";
import { normalizePhone } from "@engine/phone";
import { readConfirmReply, type ConfirmIntent } from "@engine/confirmReply";
import { confirmedReplyMessage, cancelledReplyMessage, addressEditPromptMessage, addressUpdatedMessage } from "@adapters/messaging/whatsappTemplates";
import { cancellationAllowedInWindow, type ActionOrder } from "@engine/supportActions";
import { CANCEL_REPLY, CANCEL_TOO_OLD_REPLY } from "@engine/cancelStateReply";
import { getSupportConfig, handleSupportMessage, patchConversation, recordCaseOrAlert, recordInbound, recordOutbound, sentRecently, supersededInBatch } from "@engine/waSupport";
import { matchEscalateKeyword } from "@engine/supportGuardrails";
import { openOrCreateRefund } from "@commerce/refunds";
import { isPartiallyPaid } from "@commerce/partialCod";
import { isJourneyHold } from "@commerce/rtoJourney";
import { isOptOutRequest, isOptInRequest, optOutConfirmation, optInConfirmation } from "@engine/waOptOut";
import { keepsAddress, KEEP_ADDRESS_REPLY, KEEP_ADDRESS_CONFIRM } from "@engine/addressKeep";
import { runInBatchClock } from "@engine/replyDelay";

// A "No" AFTER a yes is a change of mind, and it follows the one cancellation rule (lib/supportActions.ts
// cancellationAllowedInWindow): nothing booked, and placed within the last 24 hours. A first "No" (never confirmed)
// is exempt: that is an answer, not a reversal.


// The batch is processed in after(), off the response path — see POST. A
// 3-photo burst ran ~55-60s inside the response and a 5-sender batch ~250s,
// because every message does a media download plus a model call
// (IMAGE_TIMEOUT_MS = 45s). Meta retries a webhook that answers slowly for days
// and then disables it, re-delivering duplicates the whole time. 300s is the
// ceiling after() is allowed to run to on this platform.
export const maxDuration = 300;

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Meta's subscription handshake. It calls this once, with a challenge, when the
 * webhook is first configured — and refuses to save the webhook unless the
 * challenge comes back as bare text.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;

  if (
    params.get("hub.mode") === "subscribe" &&
    expected &&
    params.get("hub.verify_token") === expected
  ) {
    return new Response(params.get("hub.challenge") ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response("Forbidden", { status: 403 });
}

/**
 * Is this really from Meta?
 *
 * Meta signs the raw body with the app secret. Without this check the endpoint
 * takes anyone's word for it that a customer said "cancel", which is a way to
 * have someone else's orders cancelled for them.
 */
function signatureValid(raw: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // not configured yet — logged by the caller
  if (!header?.startsWith("sha256=")) return false;

  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const given = header.slice("sha256=".length);
  // Constant-time: a plain === leaks how much of the digest matched.
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  // Read the body as text first — the signature is over the exact bytes, so
  // parsing before verifying would mean checking a re-serialised approximation.
  const raw = await req.text();

  if (!signatureValid(raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }
  if (!process.env.WHATSAPP_APP_SECRET) {
    console.warn("[whatsapp] WHATSAPP_APP_SECRET unset — webhook is unauthenticated");
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  // Always 200, and immediately. Meta retries anything slow or non-200 for days
  // and then disables the webhook — and none of the reasons this declines to
  // act improve on a retry. The actual work (media downloads + a per-message
  // model call) took up to ~250s on a multi-sender batch, so it runs in
  // after(), once the 200 is already on the wire. Same pattern as the Delhivery
  // scan webhook, for the same reason.
  after(() => runInBatchClock(() => processBatch(body)));

  return NextResponse.json({ ok: true });
}

/**
 * The per-message work, moved off the response path. Every branch is unchanged
 * from when this ran inline — only where it runs has changed.
 */
async function processBatch(body: WebhookBody) {
  try {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        // Meta batches a burst of messages into one payload, and these are
        // handled one after another — so message 2 is not written to
        // wa_messages until message 1 has finished replying, and the
        // overtaken check inside the handler cannot see what is still queued
        // here. That is how one customer had the same address read back to
        // them twice, nine seconds apart.
        //
        // Only this loop can see the whole batch, so it works out who is last
        // per sender and passes that down. Every message is still stored; only
        // the answering is left to whoever holds the complete conversation.
        const batch = value?.messages ?? [];
        const superseded = supersededInBatch(batch.map((msg) => msg.from), batch.map((msg) => msg.text?.body));
        for (const [i, message] of batch.entries()) {
          await handleMessage(message, value?.contacts ?? [], superseded[i]);
        }
        for (const status of value?.statuses ?? []) {
          await reportFailure(status);
        }
      }
    }
  } catch (err) {
    console.error("[whatsapp] webhook handler failed:", err);
  }
}

// ── Payload shapes (only the parts we read) ──────────────────────────────────

type IncomingMessage = {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string; description?: string } };
  // Media arrives with the caption, if any, on the media object rather than in
  // text — and usually with no caption at all.
  image?: { caption?: string; id?: string };
  video?: { caption?: string; id?: string };
  document?: { caption?: string; filename?: string; id?: string; mime_type?: string };
  location?: Record<string, unknown>;
  contacts?: unknown[];
  audio?: Record<string, unknown>;
};

const MEDIA_TYPES = ["image", "video", "document", "audio", "sticker"];

/** What the customer attached, in words, for the log and the ping. */
function mediaKind(m: IncomingMessage): string | null {
  if (!m.type || !MEDIA_TYPES.includes(m.type)) return null;
  return m.type === "image" ? "a photo"
    : m.type === "video" ? "a video"
    : m.type === "document" ? `a file${m.document?.filename ? ` (${m.document.filename})` : ""}`
    : m.type === "audio" ? "a voice note"
    : "a sticker";
}

type MessageStatus = {
  status?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string }[];
};

type WebhookBody = {
  entry?: {
    changes?: {
      value?: {
        messages?: IncomingMessage[];
        statuses?: MessageStatus[];
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
      };
    }[];
  }[];
};

/**
 * What the customer actually said.
 *
 * A tapped quick-reply arrives as the button's own title rather than free text,
 * which is why this is read before falling back to the message body. The button
 * titles are "Yes" and "No", both of which the reply parser already understands,
 * so a tap and a typed answer converge on the same two words.
 */
function messageText(m: IncomingMessage): string {
  return (
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title ??
    m.button?.text ??
    m.text?.body ??
    m.image?.caption ??
    m.video?.caption ??
    m.document?.caption ??
    ""
  );
}

/**
 * Every answer this customer has given, oldest first.
 *
 * `confirm_reply` holds only the latest, so a customer who wavers erases their
 * own history. AJUKI710040 tapped No and then Yes thirty-two seconds later: the
 * revive did the right thing, but it overwrote the No on its way past and the
 * order ended up reading "Yes" with nothing to show it had ever been anything
 * else. A COD customer who nearly cancelled is exactly what this flow exists to
 * notice.
 *
 * Read-modify-write rather than a jsonb append in SQL. Two replies from one
 * person arrive seconds apart at the very closest, and losing one to a race
 * costs a log line, not a wrong status.
 */
function appendReply(
  existing: unknown,
  text: string,
  intent: ConfirmIntent,
  tapped: boolean,
) {
  const history = Array.isArray(existing) ? existing : [];
  return [
    ...history,
    { at: new Date().toISOString(), text: text.slice(0, 500), intent, tapped },
  ].slice(-20); // a runaway thread must not grow the row without bound
}

// ── "Edit Address" on the order confirmation ────────────────────────────────
//
// The v2 confirmation template has a third button. A tap parks this in
// wa_conversations.pending_action and asks for the new address in one reply; the
// next non-tap message is applied here. Its own tiny state rather than
// lib/ndrButtonReply.ts's pending helpers — that machinery is NDR-shaped (it
// carries an AWB and pushes to the courier), and this order is not yet booked,
// so applying the change is a plain row update plus a Telegram for a person to
// sanity-check the city/state.

type ConfirmAddrPending = { kind: "confirm_addr_edit"; order_id: string; set_at: string };
const CONFIRM_ADDR_TTL_MS = 2 * 60 * 60 * 1000;
/** Statuses where an address is final — nothing left to change at the courier or here. */
const CLOSED_FOR_ADDR_EDIT = new Set(["delivered", "cancelled", "wa_cancelled", "rto", "returned"]);

const ADDR_NOT_EDITABLE = new Set(["shipped", "manifested", "delivered", "cancelled", "wa_cancelled", "rto", "returned", "undelivered"]);

/** Returns false when the pending_action column is not migrated yet, so the
 *  caller can fall back to the support bot. */
async function parkConfirmAddrEdit(phone: string, orderId: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from("wa_conversations").upsert(
    { phone, pending_action: { kind: "confirm_addr_edit", order_id: orderId, set_at: new Date().toISOString() }, updated_at: new Date().toISOString() },
    { onConflict: "phone" },
  );
  if (!error) return true;
  if (error.code === "PGRST204" || error.code === "42703") return false;
  console.error("[confirm] parkConfirmAddrEdit failed:", error.message);
  return false;
}

async function readConfirmAddrPending(phone: string): Promise<ConfirmAddrPending | null> {
  const { data } = await supabaseAdmin.from("wa_conversations").select("pending_action").eq("phone", phone).maybeSingle();
  const p = (data as { pending_action?: unknown } | null)?.pending_action as ConfirmAddrPending | undefined;
  if (!p || p.kind !== "confirm_addr_edit") return null;
  const t = Date.parse(p.set_at ?? "");
  return Number.isFinite(t) && Date.now() - t < CONFIRM_ADDR_TTL_MS ? p : null;
}

async function clearConfirmAddrPending(phone: string): Promise<void> {
  await supabaseAdmin.from("wa_conversations").update({ pending_action: null }).eq("phone", phone).then(() => {}, () => {});
}

async function applyConfirmAddressEdit(
  phone: string,
  text: string,
  pending: ConfirmAddrPending,
  waMessageId: string | undefined,
  name: string | undefined,
): Promise<void> {
  const { duplicate } = await recordInbound(supabaseAdmin, { phone, body: text, waMessageId, name });
  if (duplicate) return;

  const clean = text.replace(/\s+/g, " ").trim();

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, status, awb_code, address, confirmed_at, courier_name, shiprocket_order_id, admin_notes")
    .eq("id", pending.order_id)
    .maybeSingle();

  const handOff = async (reply: string, why: string) => {
    await clearConfirmAddrPending(phone);
    await sendWhatsApp(phone, reply);
    await recordOutbound(supabaseAdmin, { phone, body: reply, source: "system", orderId: pending.order_id, tag: "address_change" });
    await supabaseAdmin.from("wa_conversations").update({ unread: true, updated_at: new Date().toISOString() }).eq("phone", phone).then(() => {}, () => {});
    await notify(
      "LIVE",
      `📍 <b>Address edit needs a person</b> — order <b>${pending.order_id}</b>\n\n` +
      `${name ?? "Customer"} · +91 ${phone}\n<i>${why}</i>\n\nThey replied:\n"${clean.slice(0, 400)}"`,
    );
  };

  if (!order) { await handOff("Thanks. A team member will confirm your updated address with you.", "order not found"); return; }
  // Nothing can change once the parcel is delivered, returned or cancelled.
  if (CLOSED_FOR_ADDR_EDIT.has(order.status)) {
    await handOff(
      "Thanks for that. This order can no longer be changed, so a team member will get back to you here.",
      `order is ${order.status}`,
    );
    return;
  }

  // "Same address", "Yahi address hai", "Ok", "Sorry": the customer kept their address. Say so; do not tell them an address is being updated and do not ping the team (22-23 Oct: 11 of 14 such pings).
  // Before dispatch the order still needs its Confirm, so the reply says that; it never confirms for them.
  if (keepsAddress(clean)) {
    await clearConfirmAddrPending(phone);
    const keep = KEEP_ADDRESS_REPLY + (!order.awb_code && !ADDR_NOT_EDITABLE.has(order.status) ? KEEP_ADDRESS_CONFIRM : "");
    await sendWhatsApp(phone, keep);
    await recordOutbound(supabaseAdmin, { phone, body: keep, source: "system", orderId: pending.order_id, tag: "address_change" });
    return;
  }

  const pincode = clean.match(/\b(\d{6})\b/)?.[1];
  if (clean.length < 15 || !pincode) {
    await handOff(
      "Thanks. I want to be sure your parcel reaches you, so a team member will confirm the updated address with you.",
      "reply too short or no 6-digit pincode",
    );
    return;
  }

  // Already booked with a courier: the address CAN still be changed there, but a customer's
  // free text is not pushed to a courier unseen. Record it as a proposal and ask a person on
  // Telegram to approve (lib/bookedAddressEdit.ts); only the approval reaches the courier.
  if (order.awb_code || ADDR_NOT_EDITABLE.has(order.status)) {
    if (order.awb_code) {
      const line = proposalLine(clean, pincode);
      await supabaseAdmin.from("orders").update({ admin_notes: [order.admin_notes, line].filter(Boolean).join("\n") }).eq("id", order.id);
      await clearConfirmAddrPending(phone);
      // No promise of a confirmation: a person approves or skips it, a skip says nothing to the customer, and some couriers refuse (a different
      // pincode at Delhivery, for one). The approval, when it happens, sends its own message.
      const reply = "Thanks — we've received your updated address and passed it to our team. They will update it with the courier if it can still be changed.";
      const chk = checkBookedEdit(order as BookedOrder, pincode, await partnerOf(order as BookedOrder));
      await sendWhatsApp(phone, reply);
      await recordOutbound(supabaseAdmin, { phone, body: reply, source: "system", orderId: order.id, tag: "address_change" });
      await supabaseAdmin.from("wa_conversations").update({ unread: true, updated_at: new Date().toISOString() }).eq("phone", phone).then(() => {}, () => {});
      // Telegram reads this as HTML: an address with "&" or "<" in it ("Shop 4 & 5") would make the whole message fail and the approver would never see it.
      const tg = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      await sendWithButtons(
        "LIVE",
        `📍 <b>Address change on a booked parcel</b> — <b>${tg(order.id)}</b> (${tg(order.courier_name ?? "courier")} · ${tg(order.awb_code)})

` +
        `${tg(name ?? "Customer")} · +91 ${phone}

Current:
"${tg([(order.address as Record<string, unknown>)?.line1, (order.address as Record<string, unknown>)?.city, (order.address as Record<string, unknown>)?.pincode].filter(Boolean).join(", "))}"

` +
        `Customer wants:
"${tg(clean.slice(0, 400))}"` +
        (chk.ok ? chk.warnings.map((w) => `\n\n⚠️ ${tg(w)}`).join("") : `\n\n🚫 ${tg(chk.reason)}`),
        // A proposal the courier cannot take is offered for skipping only: approving it would just be refused.
        [chk.ok
          ? [{ text: "✅ Send to courier", callback_data: encodeCallback("aea", order.id) }, { text: "⏭️ Skip", callback_data: encodeCallback("aes", order.id) }]
          : [{ text: "⏭️ Skip", callback_data: encodeCallback("aes", order.id) }]],
      );
      return;
    }
    await handOff(
      "Thanks for that. Your order has already moved towards dispatch, so a team member will update the address for you and confirm here.",
      `order is ${order.status}`,
    );
    return;
  }

  const before = (order.address ?? {}) as Record<string, unknown>;
  const beforeStr = [before.line1, before.city, before.pincode].map((s) => String(s ?? "").trim()).filter(Boolean).join(", ") || "(none on record)";

  await supabaseAdmin.from("orders").update({
    address: { ...before, line1: clean.slice(0, 240), line2: "", pincode },
    status: "confirmed",
    confirmed_at: order.confirmed_at ?? new Date().toISOString(),
    confirm_source: "whatsapp",
  }).eq("id", order.id);
  await clearConfirmAddrPending(phone);

  const reply = addressUpdatedMessage(order);
  await sendWhatsApp(phone, reply);
  await recordOutbound(supabaseAdmin, { phone, body: reply, source: "system", orderId: order.id, tag: "address_change" });

  // TODO(spec §6): only send when the derived pincode's city/state disagrees
  // with the order — needs a pincode lookup we do not have yet.
  await notify(
    "OPS",
    `📍 <b>Address edited on the confirmation</b> — order <b>${order.id}</b>\n\n` +
    `${name ?? "Customer"} · +91 ${phone}\n` +
    `<b>Was:</b> ${beforeStr}\n` +
    `<b>Now:</b> ${clean.slice(0, 400)}\n\n` +
    `Pincode ${pincode} taken from the text. Check the city/state on the order before booking. The order is now confirmed.`,
  );
}

/**
 * The order a delivery_attempt_failed_v2 button tap is about.
 *
 * The most recent order for this phone that is `undelivered`, else one that
 * RTO'd in the last ~3 days (still worth intercepting — the parcel is on its way
 * back but a re-book can still catch it). Phone matched the same dual-field way
 * the confirm lookup does. Null when there is nothing plausible to attach the
 * tap to — the caller then routes to the support bot rather than guessing.
 */
async function findNdrOrder(phone: string): Promise<NdrOrder | null> {
  const { data } = await supabaseAdmin
    .from("orders")
    .select("id, status, address, awb_code, courier_name, admin_notes, created_at")
    .or(`address->>phone.like.%${phone}%,address->>altPhone.like.%${phone}%`)
    .in("status", ["undelivered", "rto"])
    .order("created_at", { ascending: false })
    .limit(8);

  const mine = (data ?? []).filter(
    (o) =>
      normalizePhone(o.address?.phone ?? "") === phone ||
      normalizePhone(o.address?.altPhone ?? "") === phone,
  );
  // TODO(verify): there is no "became RTO at" column, so an RTO's recency is
  // approximated by the order's created_at — a genuinely recent RTO on an old
  // order will be missed here. undelivered (the common case) is unaffected.
  const recentRtoCutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const pick =
    mine.find((o) => o.status === "undelivered") ??
    mine.find((o) => o.status === "rto" && Date.parse(o.created_at ?? "") >= recentRtoCutoff) ??
    null;
  return pick as NdrOrder | null;
}

async function handleMessage(
  m: IncomingMessage,
  contacts: { wa_id?: string; profile?: { name?: string } }[],
  /** A later message from this sender is queued behind this one in the same
   *  payload — store this, but leave the answering to that one. */
  supersededInBatch = false,
) {
  const text = messageText(m).trim();
  const phone = normalizePhone(m.from ?? "");
  if (phone.length !== 10) return;

  // A photo with no caption used to end here: messageText returned "", the
  // guard below dropped it, and nothing was logged, answered or pinged. The
  // people most likely to send media are the ones in the middle of a return, so
  // the silence fell on exactly the customers who could least afford it.
  //
  // Images now go to the support bot with the picture attached, so it answers
  // about what was actually sent rather than about the fact that something was.
  // Anything we cannot look at — video, audio, a non-image document — still gets
  // the honest reply pointing at the website return form.
  const kind = mediaKind(m);

  // Android's "send as file / without compression" delivers a photo as
  // type:"document" with an image/* mime_type and a real downloadable id — it
  // used to fall through to handleIncomingMedia's "email it" dead end, or, with
  // a caption, get answered text-only-blind. fetchWhatsAppMedia resolves by id
  // regardless of type and its size cap still guards, so an image document goes
  // down the same path as a real image.
  const isImageDocument =
    m.type === "document" &&
    (/^image\//i.test(m.document?.mime_type ?? "") ||
      /\.(jpe?g|png|webp|heic|heif)$/i.test(m.document?.filename ?? ""));
  const imageId =
    m.type === "image" ? m.image?.id : isImageDocument ? m.document?.id : undefined;

  if (imageId) {
    await handleSupportMessage(supabaseAdmin, {
      phone,
      message: text,
      waMessageId: m.id,
      profileName: contacts[0]?.profile?.name,
      mediaIds: [imageId],
      mediaKind: "image",
      supersededInBatch,
    });
    return;
  }

  if (!text && kind) {
    await handleIncomingMedia(phone, kind, m.type, m.id, contacts[0]?.profile?.name);
    return;
  }

  // Message types with no text and no attachment we can name: location and
  // contacts are treated as support input; everything else (reaction,
  // unsupported/errors, system customer-changed-number) used to hit a bare
  // `return` — nothing logged, answered or pinged. Now they land in the inbox.
  if (!text) {
    if (m.type === "location" || m.type === "contacts") {
      await handleSupportMessage(supabaseAdmin, {
        phone,
        message:
          m.type === "location"
            ? "[customer shared a location pin]"
            : "[customer shared a contact card]",
        waMessageId: m.id,
        profileName: contacts[0]?.profile?.name,
        supersededInBatch,
      });
      return;
    }
    const t = m.type ?? "unknown";
    const { duplicate } = await recordInbound(supabaseAdmin, {
      phone,
      body: `[unhandled message type: ${t}]`,
      waMessageId: m.id,
      name: contacts[0]?.profile?.name,
    });
    if (!duplicate) {
      await notify(
        "OPS",
        `❓ <b>Unhandled WhatsApp message type: ${t}</b>\n` +
        `${contacts[0]?.profile?.name ?? "Unknown"} · +91 ${phone}\n\n` +
        `Nothing was sent back automatically — someone should take a look.\n\n` +
        `<a href="https://www.ajuki.in/admin/support?phone=${phone}">Open in support inbox</a>`
      );
    }
    return;
  }

  // "Stop sending me offers" is answered before anything else looks at the
  // message, because it is the one request that must never be missed: the
  // privacy policy promises it works, and a customer who cannot opt out blocks
  // the number instead — which costs us the order notifications too.
  //
  // Only unambiguous phrasing lands here. A bare "stop" is left alone so it can
  // still mean "cancel my order" in the confirmation flow below, which is what
  // it almost always means from someone with an order in flight.
  if (isOptOutRequest(text)) {
    await supabaseAdmin.from("wa_optouts").upsert(
      { phone, source: "reply", note: text.slice(0, 200) },
      { onConflict: "phone" },
    );
    // Any cart already captured for this number stops being a target too, so
    // the recovery cron does not have to reach across tables to be correct.
    await supabaseAdmin.from("abandoned_carts").update({ wa_optin: false }).eq("phone", phone);
    await sendWhatsApp(phone, optOutConfirmation());
    // No ping: the opt-out is fully handled here (optout row + cart), nothing
    // for a person to do (spec §5).
    return;
  }

  // The way back. An opt-out that cannot be undone is a customer lost for good
  // over a message they regretted sending.
  if (isOptInRequest(text)) {
    const { data: wasOut } = await supabaseAdmin
      .from("wa_optouts").select("phone").eq("phone", phone).maybeSingle();
    // Only answer when they had actually opted out. Otherwise "start" is just a
    // word, and replying to it would be a non-sequitur.
    if (wasOut) {
      await supabaseAdmin.from("wa_optouts").delete().eq("phone", phone);
      await supabaseAdmin.from("abandoned_carts").update({ wa_optin: true }).eq("phone", phone);
      await sendWhatsApp(phone, optInConfirmation());
      return;
    }
  }

  // Escalation-keyword backstop, before the confirm/cancel fast-path below.
  //
  // matchEscalateKeyword otherwise runs only deep inside generateSupportReply.
  // A customer with a pending COD confirmation whose message parses as a
  // cancel/confirm ("cancel it, I've already sent a legal notice") would be
  // handled entirely by the fast-path and the legal/chargeback guard would
  // never fire. Cheap flag-only read, then hand straight to the support bot,
  // which re-runs the backstop and opens a durable case.
  const cfg = await getSupportConfig(supabaseAdmin);
  if (matchEscalateKeyword(text, cfg.escalate_keywords)) {
    await handleSupportMessage(supabaseAdmin, {
      phone,
      message: text,
      waMessageId: m.id,
      profileName: contacts[0]?.profile?.name,
      supersededInBatch,
    });
    return;
  }

  // A tap is unambiguous by construction — it can only be one of the two
  // buttons we defined — so it skips the guessing that typed replies need.
  const tapped = Boolean(m.interactive?.button_reply || m.interactive?.list_reply || m.button);

  // ── Guided-flow taps (lib/menuHandler.ts) ──────────────────────────────────
  // A row of the topic list or one of its buttons carries an id that starts "m:". Matched on the id, never the title, so no title can be
  // mistaken for an NDR or COD-confirm button. Off (SUPPORT_MENU) or not answerable here, it falls through as the typed title would.
  const menuTapId = menuTapIdOf(m);
  if (isMenuId(menuTapId)) {
    const { handleMenuTap } = await import("@engine/menuHandler");
    if (await handleMenuTap(supabaseAdmin, { phone, id: menuTapId, title: text, waMessageId: m.id, name: contacts[0]?.profile?.name })) return;
  }

  // ── Failed-delivery (delivery_attempt_failed_v2) buttons ───────────────────
  //
  // The four NDR quick-reply buttons drive real courier actions (defer / edit
  // details / escalate) via lib/ndrButtonReply.ts — intercepted here, ahead of
  // the COD-confirm candidate lookup, the same pattern the confirm flow uses.
  // "Pincode is correct" on ndr_pincode_confirm_v1 (lib/ndrPincode.ts). Matched on
  // the title AND a live parked question, so an unrelated tap is never swallowed.
  if (tapped && isPincodeButton(text)) {
    if (await handlePincodeTap(supabaseAdmin, { phone, text, waMessageId: m.id })) return;
  }

  if (tapped && isNdrButton(text)) {
    const ndrOrder = await findNdrOrder(phone);
    if (ndrOrder) {
      await handleNdrButtonTap(supabaseAdmin, {
        phone,
        buttonText: text,
        order: ndrOrder,
        courier: ndrCourierOf(ndrOrder.courier_name),
        waMessageId: m.id,
      });
    } else {
      // A v2 button but nothing undelivered/recently-RTO to attach it to — don't
      // guess, let a person read it.
      await handleSupportMessage(supabaseAdmin, {
        phone,
        message: text,
        waMessageId: m.id,
        profileName: contacts[0]?.profile?.name,
        supersededInBatch,
      });
    }
    return;
  }

  // ── Missed return pickup (return_pickup_missed_v1) ─────────────────────────
  // "Try again tomorrow" flags the return and alerts ops (lib/returnPickupRetry).
  // With no waiting pickup on this phone it falls through to a person.
  if (tapped && isPickupRetryButton(text)) {
    if (await handlePickupRetryTap(supabaseAdmin, { phone, waMessageId: m.id })) return;
  }

  // A typed reply to a button-parked pending action. Only a NON-tap message
  // counts; a stale one (>2h) falls through to the normal flow.
  if (!tapped) {
    // A typed pincode (or "yes") answering ndr_pincode_confirm_v1. Anything that
    // is not an answer falls through to the normal flow with the window left open.
    const pinPending = await readPincodePending(supabaseAdmin, phone);
    if (pinPending && (await handlePincodeReply(supabaseAdmin, { phone, text, pending: pinPending, waMessageId: m.id }))) return;

    // "Edit Address" on the order confirmation — checked before the NDR pending
    // action and before the confirm-order lookup.
    const addrPending = await readConfirmAddrPending(phone);
    if (addrPending) {
      await applyConfirmAddressEdit(phone, text, addrPending, m.id, contacts[0]?.profile?.name);
      return;
    }
    // "Update phone" / "Update address" from the failed-delivery template.
    const pending = await readPendingAction(supabaseAdmin, phone);
    if (pendingActionFresh(pending)) {
      await handleNdrPendingReply(supabaseAdmin, { phone, text, pending, waMessageId: m.id });
      return;
    }
  }

  // The number is stored inside the address blob in two places, the delivery
  // contact and the OTP-verified one, and the reply may come from either. The
  // LIKE is a prefilter because stored formats are mixed (+91…, 0…, spaced);
  // the exact match is confirmed in JS below.
  // Already-confirmed orders are deliberately included.
  //
  // They were not, and it cost a real cancellation: a customer answered "Yes",
  // then thought better of it and wrote "i want to cancel". Because confirmed_at
  // was set the order failed this filter, the message was treated as an
  // unrelated question, and the order stayed live. The reverse case was allowed
  // for — wa_cancelled is here so a "no" can be undone — but not the direction
  // that actually loses money.
  //
  // How far the parcel has travelled is judged below, not here. Anything past
  // dispatch cannot simply be flipped, but it still has to be *found* to be
  // reasoned about.
  const { data: candidates } = await supabaseAdmin
    .from("orders")
    .select("id, status, address, confirm_wa_sent_at, confirmed_at, created_at, total, awb_code, courier_name, confirm_replies, payment_id, amount_paid_online, cod_due, risk_tier, admin_notes")
    .or(`address->>phone.like.%${phone}%,address->>altPhone.like.%${phone}%`)
    .not("confirm_wa_sent_at", "is", null)
    // on_hold is here for one reason: an order the RTO journey held for being quiet is
    // waiting for exactly this reply, and a Confirm tap releases it. The find() below
    // lets only journey holds through; a repeat-RTO hold must be paid for, whatever
    // the customer replies, and carries no confirm_wa_sent_at so never matched anyway.
    .in("status", ["processing", "call_1", "call_2", "on_hold", "confirmed", "packed", "manifested", "wa_cancelled"])
    .order("confirm_wa_sent_at", { ascending: false })
    .limit(5);

  const order = (candidates ?? []).find(
    (o) =>
      (o.status !== "on_hold" || isJourneyHold(o)) &&
      (normalizePhone(o.address?.phone ?? "") === phone ||
        normalizePhone(o.address?.altPhone ?? "") === phone)
  );

  // Nothing waiting on an answer — they are asking about something else. This
  // must not act on it (an unrelated "no" is not a cancellation), but it must
  // not swallow it either: the number they are messaging runs on the Cloud API,
  // so it cannot be opened in the WhatsApp app and nobody would ever see this.
  //
  // This is the support path. The orchestrator logs it, dedupes on Meta's
  // message id, and either answers with the AI or escalates to a human — or, if
  // the bot is switched off, just pings, exactly as this branch used to.
  if (!order) {
    await handleSupportMessage(supabaseAdmin, {
      phone,
      message: text,
      waMessageId: m.id,
      profileName: contacts[0]?.profile?.name,
      supersededInBatch,
    });
    return;
  }

  const intent: ConfirmIntent = readConfirmReply(text);
  const name = contacts[0]?.profile?.name ?? order.address?.name ?? "";

  // A label exists, so a cancellation is no longer only ours to make — the
  // booking has to be voided with the courier as well.
  const booked = Boolean(order.awb_code) || order.status === "manifested";

  // Recorded on every path below, including the two that change nothing else —
  // a repeated no and a second yes are both worth being able to see later.
  const replies = appendReply(order.confirm_replies, text, intent, tapped);

  // The v2 confirmation template (order_confirm_cod_v2) carries a third button.
  // "Edit Address" parks a pending action and asks for the new address in one
  // reply; the next message is applied by applyConfirmAddressEdit() near the top
  // of this handler. If the pending_action column is not migrated yet, this
  // falls back to the support bot, which collects an address conversationally.
  if (tapped && /^\s*edit address\s*$/i.test(text)) {
    await supabaseAdmin.from("orders").update({ confirm_replies: replies }).eq("id", order.id);
    if (await parkConfirmAddrEdit(phone, order.id)) {
      const prompt = addressEditPromptMessage();
      await sendWhatsApp(phone, prompt);
      await recordOutbound(supabaseAdmin, { phone, body: prompt, source: "system", orderId: order.id, tag: "address_change" });
    } else {
      await handleSupportMessage(supabaseAdmin, {
        phone,
        message: `I need to correct the delivery address on my order ${order.id} before it ships.`,
        waMessageId: m.id,
        profileName: contacts[0]?.profile?.name,
        supersededInBatch,
      });
    }
    return;
  }

  if (intent === "unclear") {
    // Kept verbatim. People reply "ok but send the gold one" or "call me after
    // 6", and acting on the first word would ship the wrong thing.
    //
    // Asking a question is not the same as going silent, and only silence earns
    // a phone call. This used to move any unconfirmed order to the call queue
    // the moment a reply could not be parsed, which filled it with customers who
    // had simply asked where their parcel was — ten of seventeen at one point,
    // most already answered by the bot before anyone looked. They stay in
    // Awaiting Reply and finish their window like anyone else; the cron moves
    // them on if they really do fall silent, and a question the bot cannot
    // handle escalates on its own.
    const movedToCallQueue = false;
    await supabaseAdmin
      .from("orders")
      // An order already confirmed keeps its status: pulling one back to Call #1
      // because someone asked a question would undo a decision the customer
      // already made, and un-book work that is under way.
      .update({
        confirm_reply: text.slice(0, 500),
        confirm_replies: replies,
        ...(movedToCallQueue ? { status: "call_1" } : {}),
      })
      .eq("id", order.id);

    // This used to stop here: the order was annotated, a Telegram ping went out,
    // and the customer got nothing at all. One customer asked about his delivery
    // address three times in sixty seconds and was answered by silence — and
    // because his messages never reached the conversation store, the thread was
    // invisible in the support inbox too. Anyone with a pending COD confirmation
    // fell into this, which is precisely the group most likely to be asking, since
    // our own confirmation message is what prompted them to write.
    //
    // A reply that is not a yes or a no is simply a support question that happens
    // to have arrived during a confirmation, so it is handed to the support bot
    // like any other: logged, answered from the order's own details where it can
    // be, escalated where it cannot. The order-side decision above is unchanged.
    // No "moved to Call #1" ping: handleSupportMessage below fires the
    // escalation ping for the same customer message (spec §5, duplicate view).
    await handleSupportMessage(supabaseAdmin, {
      phone,
      message: text,
      waMessageId: m.id,
      profileName: contacts[0]?.profile?.name,
      supersededInBatch,
    });
    return;
  }

  if (intent === "cancel") {
    // Already parked and they have said no twice — acknowledged without a second
    // goodbye. The order stays where it is and nobody needs telling again, but
    // the second no is still logged: saying it twice is a firmer no than once.
    if (order.status === "wa_cancelled") {
      await supabaseAdmin.from("orders").update({ confirm_replies: replies }).eq("id", order.id);
      return;
    }

    // A no AFTER a yes is a change of mind, and the window for that is the
    // site's own stated policy: 24 hours from placement, and nothing booked. One customer tapped
    // Yes, we moved the order along, and a day and a half later tapped No —
    // which un-books real work and, once a label exists, starts a void-the-AWB
    // fire drill. Outside the window nothing is flipped: the customer gets a
    // warm explanation and the request goes to a human to decide.
    //
    // Deliberately NOT applied to a first no. An unconfirmed order's "No" is
    // the answer to the question we asked, not a change of mind — and refusing
    // it would ship a parcel the customer has already said they won't take.
    const cancelVerdict = cancellationAllowedInWindow({ status: order.status as ActionOrder["status"], awb_code: order.awb_code ?? undefined, created_at: order.created_at });
    if (order.confirmed_at && !cancelVerdict.ok) {
      await supabaseAdmin
        .from("orders")
        .update({ confirm_reply: text.slice(0, 500), confirm_replies: replies })
        .eq("id", order.id);

      // Fixed wording, no promise of a reply time: dispatched, or simply past the 24 hours we promise.
      await sendWhatsApp(phone, !cancelVerdict.ok && cancelVerdict.reason === "too_old" ? CANCEL_TOO_OLD_REPLY : CANCEL_REPLY);

      // A booked label about to ship against a cancellation can't wait for the
      // muted OPS chat (spec §9); an unbooked one is a today job.
      await notify(
        booked ? "LIVE" : "OPS",
        `⏳ <b>Cancel request outside the cancellation rule</b> — <b>${order.id}</b>\n` +
        `${name} · ₹${order.total ?? 0}${tapped ? " · tapped No" : `\nReplied: "${text.slice(0, 100)}"`}\n\n` +
        `Order is <b>${order.status}</b>, placed ${new Date(order.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} — ` +
        `<b>left as it is</b>, customer told the team will decide.\n` +
        (booked
          ? `A label exists${order.courier_name ? ` with <b>${order.courier_name}</b>` : ""}${order.awb_code ? ` (AWB ${order.awb_code})` : ""}.\n`
          : "") +
        `Cancel it by hand if you want to honour the request.`
      );
      return;
    }

    // "WA Cancelled", not "Cancelled". A tap is a cheap way to end an order and
    // some of these will be a change of mind, a wrong number, or a misread.
    // Its own status keeps them where someone will look at them.
    await supabaseAdmin
      .from("orders")
      .update({ status: "wa_cancelled", confirm_reply: text.slice(0, 500), confirm_replies: replies })
      .eq("id", order.id);

    // Only a partial-COD order reaches this "No" with real money already
    // captured online — an ordinary COD confirm-ask has nothing to refund.
    // Same Attack 1 fix as the other two cancellation paths (app/api/orders/
    // [id], lib/supportActionRun.ts): open a REFUND_ELIGIBLE row for the
    // advance rather than leaving it as a status flip and no ledger trace.
    if (order.payment_id && order.payment_id !== "COD" && isPartiallyPaid(order)) {
      try {
        await openOrCreateRefund(supabaseAdmin, {
          orderId: order.id, paymentId: order.payment_id, amount: order.amount_paid_online!,
          reasonCategory: "cancellation", requestedBy: "customer",
        });
      } catch (err) {
        console.error(JSON.stringify({ event: "refund_ledger_write_failed", order_id: order.id, error: err instanceof Error ? err.message : String(err) }));
      }
    }

    await sendWhatsApp(phone, cancelledReplyMessage(order));

    // Worth seeing as it happens. A run of these is the signal that the message
    // Only the booked case is worth a ping, and it can't wait for the muted
    // chat: the parcel physically ships against a cancelled order unless the AWB
    // is voided (spec §5/§9). An unbooked "no" auto-parks in wa_cancelled with
    // nothing for anyone to do.
    if (booked) {
      await notify(
        "LIVE",
        `🔴 <b>Booked parcel — customer cancelled on WhatsApp</b>\n` +
        `${name} · +91 ${phone}\n` +
        `#${order.id} · ${order.courier_name ?? "courier"}${order.awb_code ? ` · AWB ${order.awb_code}` : ""}\n` +
        `Void the AWB or it ships against a cancelled order.\n` +
        `→ https://www.ajuki.in/admin/orders?focus=${order.id}`,
      );
    }
    return;
  }

  // Already confirmed and they have said yes again — or said yes to an order an
  // admin confirmed for them. Nothing to change, and repeating the
  // acknowledgement would send a message they already have. Still logged.
  if (order.confirmed_at && order.status !== "wa_cancelled") {
    await supabaseAdmin.from("orders").update({ confirm_replies: replies }).eq("id", order.id);
    return;
  }

  // Taken before the write, which is about to erase it.
  const reviving = order.status === "wa_cancelled";

  await supabaseAdmin
    .from("orders")
    .update({
      // A yes after a no revives the order, so the status is written rather than
      // left alone — wa_cancelled has to be walked back.
      status: "confirmed",
      confirmed_at: order.confirmed_at ?? new Date().toISOString(),
      confirm_source: "whatsapp",
      confirm_reply: text.slice(0, 500),
      confirm_replies: replies,
    })
    .eq("id", order.id);

  // The retraction of the alarm we raised a moment ago.
  //
  // Without this the reversal is silent: the cancel alert says "cancel it with
  // the courier, or the parcel goes out against a cancelled order", someone acts
  // on that, and the order then walks itself back to confirmed with no label and
  // no notice — sitting in Confirmed looking perfectly healthy. Whoever was told
  // to void a booking has to be told it is needed after all.
  // Only ping when a booking may have been voided on the earlier "no" and now
  // needs rebooking — the unbooked reversal is a silent status flip (spec §5).
  if (reviving && booked) {
    await notify(
      "LIVE",
      `🔴 <b>Rebook the parcel — customer un-cancelled</b>\n` +
      `${name} · +91 ${phone}\n` +
      `#${order.id} · ${order.courier_name ?? "courier"}${order.awb_code ? ` · AWB ${order.awb_code}` : ""}\n` +
      `If you voided the booking on the earlier "no", it needs rebooking. Back in Confirmed.\n` +
      `→ https://www.ajuki.in/admin/orders?focus=${order.id}`,
    );
  }

  // After the write, not before. sendWhatsApp resolves either way and never
  // throws, so the worst case is a confirmed order whose customer got no
  // acknowledgement — never an order stuck unconfirmed because a send failed.
  // With an address on file the reply carries an "Edit address" button: its title is
  // what the existing tap handler above matches, so a tap parks the edit and asks for
  // the corrected address. No address, no button.
  const confirmedMsg = confirmedReplyMessage(order);
  if (confirmedMsg.includes("Edit address")) {
    await sendWhatsAppButtons(phone, confirmedMsg, [{ id: "edit_address", title: "Edit address" }]);
  } else {
    await sendWhatsApp(phone, confirmedMsg);
  }
}

/**
 * A customer sent something we cannot read — almost always return photos.
 *
 * Logged so the thread in the inbox shows that something arrived rather than an
 * unexplained gap, answered so the customer knows it did not reach the people
 * who need it, and pinged so a human can chase it. The reply is fixed text, not
 * the model: there is no question to answer here, only one fact to state.
 */
async function handleIncomingMedia(
  phone: string,
  kind: string,
  /** The raw WhatsApp type — stored so "did they send us something" is a column
   *  test rather than a pattern-match against the sentence in `body`. */
  rawKind: string | undefined,
  waMessageId: string | undefined,
  profileName: string | undefined,
) {
  const { duplicate } = await recordInbound(supabaseAdmin, {
    phone,
    body: `[customer sent ${kind}]`,
    waMessageId,
    name: profileName,
    mediaKind: rawKind ?? null,
  });
  if (duplicate) return;

  // Evidence goes on /returns/start: order number + phone, no sign-in. This
  // said "sign in → My Account → Orders → Request Return" until 16 Sep 2026,
  // four days after that login-gated flow was replaced — and it kept going out
  // because it is fixed text, not the model, so no persona edit reached it.
  const reply =
    `Thanks for sending that 🙏\n\n` +
    `We can't open voice notes, videos or files here in chat. I have escalated this to the team. If this is about a *return, or a damaged, wrong or missing item*, ` +
    `please also raise it on our website so the team can see your photos:\n\n` +
    `*www.ajuki.in/returns/start*\n\n` +
    `There's no sign-in, just your order number and this phone number, and the form takes your photos. ` +
    `If it's about something else, please type it here.`;

  // Silent while the bot is off, like every other automatic reply to something
  // a customer sent. This path sat outside handleSupportMessage, so it kept
  // answering after wa_support_config.enabled was switched off on 12 Sep —
  // the one voice of the bot still talking. The founder answers these by hand
  // off the Telegram ping below.
  const botOn = (await getSupportConfig(supabaseAdmin)).enabled;

  // Sent at most once per 6h — a customer sending three voice notes in a row
  // used to get this exact sentence three times, which taught them nothing new
  // twice over. The Telegram alert below still fires every time: each voice
  // note might carry different content even if the canned reply doesn't change.
  // The reply says the team has it, so make that true: the thread is escalated and a case is opened (a Telegram ping alone left nothing in
  // the queue). 12 Oct review: "unsupported format should simply be escalated, and the bot should tell the customer the same".
  if (botOn) {
    await patchConversation(supabaseAdmin, phone, { status: "escalated", escalated: true, escalate_reason: `customer sent ${kind} we cannot read`, unread: true }).catch(() => {});
    await recordCaseOrAlert(supabaseAdmin, { phone, tag: "other", reason: `customer sent ${kind} we cannot read`, name: profileName ?? null }).catch(() => {});
  }
  if (botOn && !(await sentRecently(supabaseAdmin, phone, reply, 6))) {
    await sendWhatsApp(phone, reply);
    // Recorded, like every other outbound. This used to send and write nothing,
    // which left the thread showing a customer message with no answer under it and
    // — worse — left last_out_at untouched, so the 24-hour window shown in the
    // inbox and the re-acknowledgement quiet period were both computed from a
    // conversation the database believed we had never replied to.
    await recordOutbound(supabaseAdmin, { phone, body: reply, source: "system", tag: "other" });
  }

  await notify(
    "LIVE",
    `📎 <b>Customer sent ${kind}</b>\n${profileName ?? "Unknown"} · +91 ${phone}\n\n` +
    (botOn
      ? `We can't read media here — told them the team has it and pointed them to www.ajuki.in/returns/start.\n\n`
      : `Bot is off — <b>no reply was sent</b>. Answer by hand.\n\n`) +
    `<a href="https://www.ajuki.in/admin/support?phone=${phone}">Open in support inbox</a>`
  );
}

/**
 * Delivery receipts. Only failures are surfaced, and only to the server log.
 *
 * `sent` and `delivered` arrive for every message and would drown the log. A
 * failure is different: it usually means something structural — an unapproved
 * template, a spent quota, a number that has blocked us.
 *
 * This used to also page HEALTH on Telegram (throttled 1/code/hour). Removed
 * 2026-09-23: it wasn't changing day-to-day behaviour. The structured log line
 * below is still there for anyone who goes looking (e.g. via cron-watchdog or
 * a log query), and is easy to re-wire to notify() if that changes.
 */
async function reportFailure(s: MessageStatus) {
  if (s.status !== "failed" || !s.errors?.length) return;
  const e = s.errors[0];
  console.error(JSON.stringify({
    event: "whatsapp_delivery_failed",
    to: s.recipient_id,
    code: e.code,
    title: e.title,
    detail: e.message?.slice(0, 200),
  }));
}
