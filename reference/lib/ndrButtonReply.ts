// The delivery_attempt_failed_v2 buttons, wired to real courier NDR actions.
//
// v2's four QUICK_REPLY buttons — Deliver tomorrow · Update phone · Update
// address · Contact support — replace v1's one-way "reply here" message. A tap
// arrives at the WhatsApp webhook as the button's own title; the webhook
// resolves the NDR order and hands it here. All courier branching lives in this
// module, not the route.
//
// Button → action matrix (see the per-courier notes on each helper):
//
//   Deliver tomorrow
//     Delhivery  → deferDelhiveryDelivery(awb, nextWorkingDay()); log a
//                  delhivery_ndr_requests row + the admin_notes breadcrumb so
//                  the P0 cron's reconciliation pass verifies it. On failure →
//                  universal fallback.
//     Shadowfax  → best-effort reopenShadowfaxNdr (a silent no-op from `nc`,
//                  confirmed live — never a fallback trigger). Primary response
//                  is an honest "still being attempted" reply. Only if the
//                  parcel has been undelivered > 5 days: raiseShadowfaxIssue +
//                  a case + a Telegram note.
//
//   Update phone / Update address
//     Both       → park wa_conversations.pending_action and ask for the value.
//                  The customer's next non-tap message is validated and applied:
//                    Delhivery → editDelhiveryNdrDetails + deferDelhiveryDelivery
//                    Shadowfax → updateShadowfaxDeliveryDetails (+ best-effort
//                                reopenShadowfaxNdr). Shadowfax masks `contact`
//                                on read-back, so a phone change is "submitted,
//                                unconfirmed" unless a scan proves it.
//                  Validation fails twice, or the reply is a question/complaint
//                  → clear pending, hand to the support bot.
//
//   Contact support
//     Both       → open a support_case (tag late_delivery) + Telegram + holding
//                  reply. Shadowfax → also raiseShadowfaxIssue, but only when
//                  the case was newly opened (dedupe: one escalation per NDR
//                  episode).
//
//   Universal fallback (any courier action throws / hard-rejects): a support
//   case + a Telegram "NDR action failed" alert + an honest reply. A tap is
//   never left unanswered.
//
// Every outbound goes through recordOutbound and every inbound through
// recordInbound so the admin inbox stays coherent. Replies use sendWhatsApp —
// a button tap opens the 24-hour window.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";
import { sendWhatsApp } from "@/lib/whatsapp";
import { notify, tgPhone } from "@/lib/telegram";
import { recordInbound, recordOutbound, patchConversation, handleSupportMessage } from "@/lib/waSupport";
import { openOrReuseCase } from "@/lib/supportCases";
import { isAckOnly } from "@/lib/ackOnly";
import { composeAddress, pincodeOf } from "@/lib/courierAddressEdit";
import { resolveCustomer } from "@/lib/customerIdentity";
import { deferDelhiveryDelivery, editDelhiveryNdrDetails, nextWorkingDay } from "@/lib/delhivery";
import { deferHorizon } from "@/lib/ndrPolicy";
import { reopenShadowfaxNdr, updateShadowfaxDeliveryDetails, raiseShadowfaxIssue } from "@/lib/shadowfax";

export type NdrCourier = "delhivery" | "shadowfax" | "other";

export type NdrOrder = {
  id: string;
  awb_code?: string | null;
  courier_name?: string | null;
  admin_notes?: string | null;
  created_at?: string | null;
  address?: { name?: string | null } | null;
};

/** How a bailed pending-reply is handed to a person. The real implementation is
 *  the support bot; injectable so the pending-reply flow can be tested without
 *  standing up the whole orchestrator. */
export type NdrHandoff = (
  db: SupabaseClient,
  m: { phone: string; message: string; waMessageId?: string },
) => Promise<void>;

const realHandoff: NdrHandoff = (db, m) => handleSupportMessage(db, m);

export type PendingAction = {
  kind: "ndr_phone" | "ndr_address";
  order_id: string;
  awb: string;
  courier: NdrCourier;
  attempts?: number;
  set_at: string;
  /** Set by the one handler that is gathering an address sent as several messages (collectAddressBurst); the others in the burst leave it to that handler. */
  collecting_since?: string;
};

/** The exact button titles on delivery_attempt_failed_v2, lower-cased. */
export const NDR_BUTTON_TITLES = ["deliver tomorrow", "update phone", "update address", "contact support"] as const;

/** How long a parked pending_action stays valid — checked on read, per the
 *  migration. Past this the customer's reply goes to the support bot instead. */
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

/** A Shadowfax parcel undelivered longer than this, on a "Deliver tomorrow" tap,
 *  earns a real escalation rather than only a reassurance reply.
 *  TODO(verify): 5 days is a guess — tune against the auto-retry loop's real
 *  convergence time once there is data. */
const SFX_STUCK_DAYS = 5;

const CASE_TAG = "late_delivery";

export function isNdrButton(text: string): boolean {
  return (NDR_BUTTON_TITLES as readonly string[]).includes(text.trim().toLowerCase());
}

export function ndrCourierOf(courierName?: string | null): NdrCourier {
  const c = (courierName ?? "").toLowerCase();
  if (c.includes("delhivery")) return "delhivery";
  if (c.includes("shadowfax")) return "shadowfax";
  return "other";
}

export function pendingActionFresh(p: PendingAction | null | undefined): p is PendingAction {
  if (!p || (p.kind !== "ndr_phone" && p.kind !== "ndr_address")) return false;
  const t = Date.parse(p.set_at ?? "");
  return Number.isFinite(t) && Date.now() - t < PENDING_TTL_MS;
}

/** Read wa_conversations.pending_action for a phone, tolerating a pre-migration
 *  schema (column absent → null). Does NOT check freshness — the caller does. */
export async function readPendingAction(db: SupabaseClient, phone: string): Promise<PendingAction | null> {
  const { data, error } = await db
    .from("wa_conversations")
    .select("pending_action")
    .eq("phone", phone)
    .maybeSingle();
  if (error || !data) return null;
  const p = (data as { pending_action?: unknown }).pending_action as PendingAction | undefined;
  if (!p || (p.kind !== "ndr_phone" && p.kind !== "ndr_address")) return null;
  return p;
}

// ── Entry points ────────────────────────────────────────────────────────────

/** The same button tapped twice within seconds (two different WhatsApp message ids, so recordInbound does not see a repeat): the second gets no second reply. 22 Oct: "Your parcel is still with the courier" went out twice, a second apart. */
const RECENT_TAPS = new Map<string, number>();
const TAP_REPEAT_MS = 20_000;
export function isRepeatTap(phone: string, button: string, orderId: string, now = Date.now()): boolean {
  for (const [k, t] of RECENT_TAPS) if (now - t > TAP_REPEAT_MS) RECENT_TAPS.delete(k);
  const key = `${phone}|${button}|${orderId}`;
  const seen = RECENT_TAPS.has(key);
  if (!seen) RECENT_TAPS.set(key, now);
  return seen;
}

export async function handleNdrButtonTap(
  db: SupabaseClient,
  args: {
    phone: string;
    buttonText: string;
    order: NdrOrder;
    courier?: NdrCourier;
    waMessageId?: string | null;
  },
): Promise<void> {
  const { phone, order } = args;
  const button = args.buttonText.trim().toLowerCase();
  const courier = args.courier ?? ndrCourierOf(order.courier_name);
  const awb = (order.awb_code ?? "").trim();

  const { duplicate } = await recordInbound(db, {
    phone,
    body: args.buttonText,
    waMessageId: args.waMessageId ?? null,
    orderId: order.id,
  });
  if (duplicate) return;
  if (isRepeatTap(phone, button, order.id)) return;

  if (button === "deliver tomorrow") {
    await deliverTomorrow(db, { phone, order, courier, awb });
  } else if (button === "update phone") {
    await askForValue(db, { phone, order, courier, awb, kind: "ndr_phone" });
  } else if (button === "update address") {
    await askForValue(db, { phone, order, courier, awb, kind: "ndr_address" });
  } else if (button === "contact support") {
    await contactSupport(db, { phone, order, courier, awb });
  } else {
    // The webhook gates on isNdrButton, so this is unreachable — but never leave
    // a tap silent.
    await reply(db, phone, "Thanks — we've noted that and someone will be in touch.");
  }
}

// ── an address sent as several messages ─────────────────────────────────────
//
// 21 Oct: a customer sent "Greenfield nagar wat no 7", "201301 greenfield nagar", "Wat no 7", "Temple lane" in a row and only the second reached the courier. The first reply that
// passes validation now CLAIMS the pending action, waits until the customer has been quiet for a few seconds, and sends everything they wrote since we asked, as one address. The other
// messages of the burst find the claim and return (they are already recorded); the claimer's read includes them.
const BURST_QUIET_MS = 5_000;
const BURST_MAX_WAIT_MS = 15_000;
const CLAIM_TTL_MS = 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Is this message part of an address (not a button, an acknowledgement or a question)? */
const partOfAddress = (body: string): boolean => !isNdrButton(body) && !isAckOnly(body) && !looksLikeQuestion(body) && body.length <= 200;

type Claim = "claimed" | "absorbed" | "gone";
async function claimBurst(db: SupabaseClient, phone: string): Promise<Claim> {
  const cur = await readPendingAction(db, phone);
  if (!cur) return "gone"; // the collecting handler has finished and cleared it
  if (cur.collecting_since && Date.now() - Date.parse(cur.collecting_since) < CLAIM_TTL_MS) return "absorbed";
  const claimed: PendingAction = { ...cur, collecting_since: new Date().toISOString() };
  // Only if nobody has claimed it in the meantime (two messages can reach here in the same instant).
  let q = db.from("wa_conversations").update({ pending_action: claimed, updated_at: new Date().toISOString() }).eq("phone", phone);
  if (!cur.collecting_since) q = q.is("pending_action->>collecting_since", null);
  const { data, error } = await q.select("phone");
  if (error) return "claimed"; // a store that cannot do the conditional write: carry on rather than freeze the customer
  return Array.isArray(data) && data.length === 0 ? "absorbed" : "claimed";
}

/** Everything the customer wrote since we asked, once they have gone quiet, as one address. Never throws: any failure returns what was already in hand. */
export async function collectAddressBurst(db: SupabaseClient, phone: string, pending: PendingAction, first: string): Promise<string> {
  try {
    const started = Date.now();
    let bodies: string[] = [first];
    for (;;) {
      const { data } = await db.from("wa_messages").select("body, created_at").eq("phone", phone).eq("direction", "in").gt("created_at", pending.set_at).order("created_at", { ascending: true }).limit(25);
      const rows = (data as { body: string | null; created_at: string }[] | null) ?? [];
      if (rows.length) bodies = rows.map((r) => r.body ?? "");
      const lastAt = rows.length ? Date.parse(rows[rows.length - 1].created_at) : 0;
      const quietFor = Date.now() - lastAt;
      if (quietFor >= BURST_QUIET_MS || Date.now() - started >= BURST_MAX_WAIT_MS) break;
      await sleep(Math.min(1_500, BURST_QUIET_MS - quietFor + 100));
    }
    const address = composeAddress(bodies, partOfAddress);
    return address.length >= first.length && pincodeOf(address) ? address : first;
  } catch {
    return first;
  }
}

export async function handleNdrPendingReply(
  db: SupabaseClient,
  args: { phone: string; text: string; pending: PendingAction; waMessageId?: string | null },
  handoff: NdrHandoff = realHandoff,
): Promise<void> {
  const { phone, text, pending } = args;
  const waMessageId = args.waMessageId ?? undefined;
  const label = pending.kind === "ndr_phone" ? "phone" : "address";

  // Stale window, or the reply is a question / complaint rather than the value
  // we asked for → hand to the support bot, which does its own inbound logging.
  if (!pendingActionFresh(pending) || looksLikeQuestion(text)) {
    await clearPendingAction(db, phone);
    await handoff(db, { phone, message: text, waMessageId });
    return;
  }

  const validated = pending.kind === "ndr_phone" ? validatePhone(text) : validateAddress(text);

  if (!validated.ok) {
    const attempts = (pending.attempts ?? 0) + 1;
    if (attempts >= 2) {
      // Twice is enough. Clear and let a person take it — the support bot logs
      // this message itself.
      await clearPendingAction(db, phone);
      await handoff(db, { phone, message: text, waMessageId });
      return;
    }
    await recordInbound(db, { phone, body: text, waMessageId: args.waMessageId ?? null, orderId: pending.order_id });
    await setPendingAction(db, phone, { ...pending, attempts });
    await reply(db, phone, validated.hint);
    return;
  }

  await recordInbound(db, { phone, body: text, waMessageId: args.waMessageId ?? null, orderId: pending.order_id });

  // An address may arrive as several messages: one handler gathers them all (above); the rest leave it to that one.
  let value = validated.value;
  if (pending.kind === "ndr_address") {
    const claim = await claimBurst(db, phone);
    if (claim === "absorbed") return;
    if (claim === "gone") { await handoff(db, { phone, message: text, waMessageId }); return; }
    value = await collectAddressBurst(db, phone, pending, validated.value);
  }

  const order = await loadOrder(db, pending.order_id);
  const courier = pending.courier ?? ndrCourierOf(order?.courier_name);
  const awb = pending.awb || order?.awb_code || "";

  try {
    if (courier === "delhivery" && awb) {
      const target = order ?? { id: pending.order_id };
      const why = `customer updated ${label} via WhatsApp`;
      // TODO(verify): the research doc suggests polling Get NDR Status until the
      // EDIT_DETAILS pair lands before submitting DEFER_DLV, since order within a
      // batch is not guaranteed. Sent back-to-back here (two separate calls, edit
      // first) and left to the cron's reconciliation to surface a rejection.
      const edit =
        pending.kind === "ndr_phone"
          ? await editDelhiveryNdrDetails(awb, { phone: value })
          : await editDelhiveryNdrDetails(awb, { address: value });
      const when = nextWorkingDay();
      const { uploadId } = await deferDelhiveryDelivery(awb, when);
      await logDelhiveryNdrRow(db, target.id, awb, "EDIT_DETAILS", why, edit.uploadId);
      await logDelhiveryNdrRow(db, target.id, awb, "DEFER_DLV", why, uploadId);
      await appendNdrBreadcrumb(db, target, why);
      await clearPendingAction(db, phone);
      await reply(
        db,
        phone,
        `Thanks — I've updated the delivery ${label} and the courier will try again on ${weekdayName(when)}. ` +
          `Please keep your phone reachable.`,
      );
      return;
    }

    if (courier === "shadowfax" && awb) {
      const upd =
        pending.kind === "ndr_phone"
          ? await updateShadowfaxDeliveryDetails(awb, { contact: value })
          : await updateShadowfaxDeliveryDetails(awb, { address: value, ...(pincodeOf(value) ? { pincode: pincodeOf(value)! } : {}) });

      // The parcel is on a rider's runsheet — Shadowfax won't take the edit
      // until it is back at a hub (confirmed by their team). Queue the value;
      // the ndr-reattempt cron retries every ~6h. Not a failure — no case.
      if (upd.locked) {
        const queued = await queueCourierEdit(db, pending.order_id, {
          courier: "shadowfax",
          awb,
          ...(pending.kind === "ndr_phone" ? { contact: value } : { address: value }),
        });
        if (queued) {
          await clearPendingAction(db, phone);
          await reply(
            db,
            phone,
            `Thanks — I've saved your correct ${label}. Your parcel is out with the courier right ` +
              `now, so we'll update it with them the moment it's back at their hub and ask them to ` +
              `reattempt. Please keep your phone reachable.`,
          );
          return;
        }
        // Column not migrated — don't lose the value; hand it to a person.
        throw new Error(`shadowfax edit locked (active runsheet) and the retry queue is unavailable — new ${label}: ${value}`);
      }

      if (!upd.ok) throw new Error(upd.note); // a real 400 → universal fallback
      // Best-effort nudge; Shadowfax auto-retries anyway and reopen_ndr is a
      // no-op from nc. Never a failure trigger.
      try {
        await reopenShadowfaxNdr(awb);
      } catch {
        /* best-effort */
      }
      await clearPendingAction(db, phone);
      await reply(
        db,
        phone,
        `Thanks — I've passed your new ${label} to the courier and they'll reattempt delivery. ` +
          `Please keep your phone reachable and answer calls from unknown numbers.`,
      );
      return;
    }

    throw new Error(`no ${courier} AWB to act on`);
  } catch (err) {
    await clearPendingAction(db, phone);
    await universalFallback(db, {
      phone,
      order: order ?? { id: pending.order_id },
      courier,
      awb,
      button: pending.kind === "ndr_phone" ? "Update phone" : "Update address",
      reason: errMsg(err),
    });
  }
}

// ── Deliver tomorrow ────────────────────────────────────────────────────────

async function deliverTomorrow(
  db: SupabaseClient,
  a: { phone: string; order: NdrOrder; courier: NdrCourier; awb: string },
): Promise<void> {
  const { phone, order, courier, awb } = a;

  if (courier === "delhivery" && awb) {
    try {
      const when = nextWorkingDay();
      // 22 Oct (AJUKI710006): Delhivery takes a delivery day only up to a fixed date per parcel (estimated delivery + 5 days, lib/ndrPolicy.ts) and rejected "'dfd' is beyond 2026-10-16", yet the
      // customer was told "Done". Past that date nothing is submitted and nobody is promised a day: a person looks at it.
      const { data: eddRow } = await db.from("orders").select("estimated_delivery").eq("id", order.id).maybeSingle();
      const horizon = deferHorizon({ estimated_delivery: (eddRow as { estimated_delivery?: string | null } | null)?.estimated_delivery ?? null });
      if (horizon && when > horizon) {
        await openNdrCase(db, phone, order, `Delhivery will not take another delivery day for this parcel (the last it accepts was ${horizon}); customer tapped Deliver tomorrow`);
        await notify("OPS", `🚚 <b>NDR — no delivery day can be booked</b> — <b>${order.id}</b>\n${tgPhone(phone)} · AWB ${awb} — the last day Delhivery accepts for this parcel was ${horizon}; the customer tapped Deliver tomorrow and was NOT told it was done. Support case opened.`);
        await reply(db, phone, "I cannot book another delivery day for this parcel any more, because the courier's window for it has passed. I have passed it to our team to look into.");
        return;
      }
      const { uploadId } = await deferDelhiveryDelivery(awb, when);
      await logDelhiveryNdrRow(db, order.id, awb, "DEFER_DLV", "customer tapped Deliver tomorrow", uploadId);
      await appendNdrBreadcrumb(db, order, "customer tapped Deliver tomorrow");
      await reply(
        db,
        phone,
        `Done — the courier will try again on ${weekdayName(when)}. Please keep your phone reachable.`,
      );
    } catch (err) {
      await universalFallback(db, { phone, order, courier, awb, button: "Deliver tomorrow", reason: errMsg(err) });
    }
    return;
  }

  if (courier === "shadowfax" && awb) {
    // reopen_ndr is a silent no-op from nc (confirmed live) — fire it anyway
    // (works on the rare on_hold parcel, harmless otherwise) and IGNORE the
    // result. Shadowfax re-attempts NDR parcels on its own.
    try {
      await reopenShadowfaxNdr(awb);
    } catch {
      /* best-effort */
    }
    await reply(
      db,
      phone,
      "Your parcel is still with the courier and they're attempting delivery. Please keep your phone reachable " +
        "and answer calls from unknown numbers — that's usually all it takes. If the number or address is wrong, " +
        "reply and let us know.",
    );
    // Been cycling a while with no success → get a person and Shadowfax on it.
    if (orderAgeDays(order) > SFX_STUCK_DAYS) {
      let issueOk = true;
      try {
        await raiseShadowfaxIssue(awb, "delayed_delivery");
      } catch (err) {
        issueOk = false;
        console.error(JSON.stringify({ event: "ndr_sfx_issue_failed", order: order.id, error: errMsg(err) }));
      }
      await openNdrCase(db, phone, order, `Shadowfax parcel undelivered >${SFX_STUCK_DAYS}d, customer tapped Deliver tomorrow`);
      await notify(
        "OPS",
        `🚚 <b>NDR — Shadowfax parcel stuck &gt;${SFX_STUCK_DAYS}d</b> — <b>${order.id}</b>\n` +
          `${tgPhone(phone)} · AWB ${awb} — customer tapped Deliver tomorrow.\n` +
          (issueOk ? "Shadowfax escalation raised (delayed_delivery)." : "⚠️ Shadowfax escalation call FAILED — raise it by hand.") +
          " Support case opened.",
      );
    }
    return;
  }

  await universalFallback(db, { phone, order, courier, awb, button: "Deliver tomorrow", reason: `no ${courier} AWB to act on` });
}

// ── Update phone / Update address ───────────────────────────────────────────

async function askForValue(
  db: SupabaseClient,
  a: { phone: string; order: NdrOrder; courier: NdrCourier; awb: string; kind: PendingAction["kind"] },
): Promise<void> {
  const { phone, order, courier, awb, kind } = a;
  const stored = await setPendingAction(db, phone, {
    kind,
    order_id: order.id,
    awb,
    courier,
    attempts: 0,
    set_at: new Date().toISOString(),
  });
  if (!stored) {
    // Cannot persist the wait (pre-migration, or a write error) — do not leave
    // the customer expecting a follow-up that will go nowhere.
    await universalFallback(db, {
      phone,
      order,
      courier,
      awb,
      button: kind === "ndr_phone" ? "Update phone" : "Update address",
      reason: "pending_action could not be stored",
    });
    return;
  }
  await reply(
    db,
    phone,
    kind === "ndr_phone"
      ? "Please reply with the correct 10-digit mobile number for the delivery."
      : "Please reply with the full delivery address, including area, city and 6-digit pincode.",
  );
}

// ── Contact support ─────────────────────────────────────────────────────────

async function contactSupport(
  db: SupabaseClient,
  a: { phone: string; order: NdrOrder; courier: NdrCourier; awb: string },
): Promise<void> {
  const { phone, order, courier, awb } = a;
  const { isNew } = await openNdrCase(db, phone, order, "customer tapped Contact support on a failed delivery");

  // Shadowfax escalation, deduped: only when this call opened the case. A
  // re-tap while the case is still open does not re-file the ticket.
  let sfxNote = "";
  if (courier === "shadowfax" && awb && isNew) {
    try {
      await raiseShadowfaxIssue(awb, "delayed_delivery");
      sfxNote = "\nShadowfax escalation raised (delayed_delivery).";
    } catch (err) {
      sfxNote = "\n⚠️ Shadowfax escalation call failed — raise it by hand.";
      console.error(JSON.stringify({ event: "ndr_sfx_issue_failed", order: order.id, error: errMsg(err) }));
    }
  }

  await notify(
    "OPS",
    `🚚 <b>NDR — customer tapped Contact support</b> — <b>${order.id}</b>\n` +
      `${tgPhone(phone)} · ${order.courier_name ?? courier}${awb ? ` · AWB ${awb}` : ""}\n` +
      `Failed delivery, customer wants a person. Support case ${isNew ? "opened" : "already open"} (${CASE_TAG}).${sfxNote}`,
  );

  await reply(
    db,
    phone,
    "Thanks for letting us know 🙏 We've flagged this with our team and the courier — someone will be in touch " +
      "to get your order to you.",
  );
}

// ── Universal fallback ──────────────────────────────────────────────────────

async function universalFallback(
  db: SupabaseClient,
  a: { phone: string; order: NdrOrder; courier: NdrCourier; awb: string; button: string; reason: string },
): Promise<void> {
  const { phone, order, courier, awb, button, reason } = a;
  await openNdrCase(db, phone, order, `NDR action failed: ${button} (${courier})`);
  await notify(
    "OPS",
    `⚠️ <b>NDR action failed for ${order.id}</b> — customer tapped <b>${button}</b>, ` +
      `${order.courier_name ?? courier}${awb ? ` AWB ${awb}` : ""}: ${reason}. Needs manual follow-up.\n` +
      `${tgPhone(phone)}`,
  );
  await reply(
    db,
    phone,
    "We've asked the courier to try again and flagged this with our team — someone will confirm with you.",
  );
}

// ── Shared helpers ─────────────────────────────────────────────────────────

async function reply(db: SupabaseClient, phone: string, body: string): Promise<void> {
  await sendWhatsApp(phone, body);
  await recordOutbound(db, { phone, body, source: "system", tag: CASE_TAG });
}

async function loadOrder(db: SupabaseClient, orderId: string): Promise<NdrOrder | null> {
  const { data } = await db
    .from("orders")
    .select("id, awb_code, courier_name, admin_notes, created_at, address")
    .eq("id", orderId)
    .maybeSingle();
  return (data as NdrOrder) ?? null;
}

async function setPendingAction(db: SupabaseClient, phone: string, value: PendingAction): Promise<boolean> {
  const { error } = await db
    .from("wa_conversations")
    .upsert({ phone, pending_action: value, updated_at: new Date().toISOString() }, { onConflict: "phone" });
  if (!error) return true;
  if (error.code === "PGRST204" || error.code === "42703") {
    console.warn("[ndr] wa_conversations.pending_action missing — run supabase-migration-wa-pending-action.sql");
    return false;
  }
  console.error("[ndr] setPendingAction failed:", error.message);
  return false;
}

/** A consignee detail change the customer gave us that the courier will not take
 *  yet. Drained by the ndr-reattempt cron. See
 *  supabase-migration-courier-edit-queue.sql. */
export type CourierEdit = {
  courier: NdrCourier;
  awb: string;
  contact?: string;
  address?: string;
  set_at: string;
  /** Retry passes that hit the lock. */
  attempts: number;
  /** Throttle — the drain pass tries one queued edit at most once per ~6h. */
  last_attempt_at: string | null;
  last_note: string | null;
};

/** Stash a courier edit for later, merging onto any existing one (a customer may
 *  fix the phone, then the address). Returns false if the column is not migrated
 *  — the caller must then not silently drop the value. */
async function queueCourierEdit(
  db: SupabaseClient,
  orderId: string,
  patch: { courier: NdrCourier; awb: string; contact?: string; address?: string },
): Promise<boolean> {
  let existing: CourierEdit | null = null;
  try {
    const { data } = await db.from("orders").select("pending_courier_edit").eq("id", orderId).maybeSingle();
    existing = (data as { pending_courier_edit?: CourierEdit | null } | null)?.pending_courier_edit ?? null;
  } catch {
    /* fall through — the update below reports the missing column */
  }

  const value: CourierEdit = {
    courier: patch.courier,
    awb: patch.awb,
    contact: patch.contact ?? existing?.contact,
    address: patch.address ?? existing?.address,
    set_at: existing?.set_at ?? new Date().toISOString(),
    attempts: existing?.attempts ?? 0,
    last_attempt_at: existing?.last_attempt_at ?? null,
    last_note: existing?.last_note ?? null,
  };

  const { error } = await db.from("orders").update({ pending_courier_edit: value }).eq("id", orderId);
  if (!error) return true;
  if (error.code === "PGRST204" || error.code === "42703") {
    console.warn("[ndr] orders.pending_courier_edit missing — run supabase-migration-courier-edit-queue.sql");
    return false;
  }
  console.error("[ndr] queueCourierEdit failed:", error.message);
  return false;
}

async function clearPendingAction(db: SupabaseClient, phone: string): Promise<void> {
  const { error } = await db
    .from("wa_conversations")
    .update({ pending_action: null, updated_at: new Date().toISOString() })
    .eq("phone", phone);
  if (error && error.code !== "PGRST204" && error.code !== "42703") {
    console.warn("[ndr] clearPendingAction failed:", error.message);
  }
}

/** Open (or reuse) a durable support case for this NDR, and remember the order on
 *  the conversation. Best-effort — a customer's reply must still go out if the
 *  identity / case writes fail. */
async function openNdrCase(
  db: SupabaseClient,
  phone: string,
  order: NdrOrder,
  reason: string,
): Promise<{ isNew: boolean }> {
  try {
    const customerId = await resolveCustomer(db, { phone });
    if (!customerId) return { isNew: false };
    const { isNew } = await openOrReuseCase(db, {
      customerId,
      channel: "whatsapp",
      waPhone: phone,
      tag: CASE_TAG,
      reason,
    });
    if (order.id) await patchConversation(db, phone, { order_id: order.id });
    return { isNew };
  } catch (err) {
    console.error(JSON.stringify({ event: "ndr_case_write_failed", order: order.id, error: errMsg(err) }));
    return { isNew: false };
  }
}

/**
 * Log a customer-driven Delhivery NDR request in delhivery_ndr_requests — the
 * durable record the P0 cron's first-pass reconciles against (keyed on
 * `upl_id`), so a defer/edit asked for from a button is verified against Get NDR
 * Status just like one the cron asked for.
 */
async function logDelhiveryNdrRow(
  db: SupabaseClient,
  orderId: string,
  awb: string,
  act: "DEFER_DLV" | "EDIT_DETAILS",
  why: string,
  uploadId?: string,
): Promise<void> {
  const { error } = await db.from("delhivery_ndr_requests").insert({
    order_id: orderId,
    waybill: awb,
    act,
    upl_id: uploadId ?? null,
    live_status: why,
    live_status_code: null,
    raw: { source: "customer", note: why, request_id: uploadId ?? null },
  });
  // 42P01 = relation does not exist — the migration is applied by hand and the
  // code ships first (same tolerance the cron has).
  if (error && error.code !== "42P01") {
    console.error("[ndr] delhivery_ndr_requests insert failed:", error.message);
  }
}

/**
 * Append the admin_notes breadcrumb — ONCE per NDR episode — the same line the
 * P0 cron writes and counts, so the cron's per-order cap (MAX_REQUESTS_PER_ORDER)
 * and its scoreboard include button-driven requests.
 *
 * The line MUST stay parseable by lib/adminNotes.ts's anchored regex
 * (`NDR reattempt requested <date> — live status was "<text>"[ (<code>)].`).
 */
async function appendNdrBreadcrumb(db: SupabaseClient, order: NdrOrder, why: string): Promise<void> {
  const line = `NDR reattempt requested ${todayIso()} — live status was "${why}".`;
  const note = [order.admin_notes, line].filter(Boolean).join("\n");
  const { error } = await db.from("orders").update({ admin_notes: note }).eq("id", order.id);
  if (error) console.error("[ndr] admin_notes breadcrumb failed:", error.message);
}

function validatePhone(text: string): { ok: true; value: string } | { ok: false; hint: string } {
  const p = normalizePhone(text);
  if (p.length === 10 && /^[6-9]/.test(p)) return { ok: true, value: p };
  return {
    ok: false,
    hint: "That doesn't look like a 10-digit mobile number. Please reply with just the 10 digits, e.g. 9876543210.",
  };
}

function validateAddress(text: string): { ok: true; value: string } | { ok: false; hint: string } {
  const t = text.trim().replace(/\s+/g, " ");
  const hasPin = /(?<!\d)\d{6}(?!\d)/.test(t);
  if (t.length >= 15 && hasPin) return { ok: true, value: t };
  return {
    ok: false,
    hint: "Please send the full address in one message — house/flat, area, city, and the 6-digit pincode.",
  };
}

/** A reply that is a question or a complaint is not the value we asked for. */
function looksLikeQuestion(text: string): boolean {
  if (text.includes("?")) return true;
  return /\b(why|what|when|where|how come|help|complain|complaint|refund|cancel|worst|terrible|useless|rubbish|scam|cheat|fraud|angry|not received|haven'?t received|kab|kyun|kaha)\b/i.test(
    text,
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekdayName(isoDate: string): string {
  const t = Date.parse(`${isoDate}T12:00:00+05:30`);
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString("en-IN", { weekday: "long", timeZone: "Asia/Kolkata" })
    : "the next working day";
}

function orderAgeDays(order: NdrOrder): number {
  const t = Date.parse(order.created_at ?? "");
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : 0;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
