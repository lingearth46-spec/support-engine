// Carrying out a support action, recording it, and saying so out loud.
//
// The decisions are in lib/supportActions.ts and stay free of Supabase so they
// can be tested. This is the part that writes.
//
// Three things happen on every action and none of them are optional: the order
// is changed, the previous values are kept so it can be undone, and a Telegram
// goes out naming exactly what moved. The bot is editing real orders without
// anyone approving it first, so the audit trail is not paperwork — it is the
// only way anybody finds out.

import type { SupabaseClient } from "@supabase/supabase-js";
import { notify } from "@adapters/notifier/telegram";
import {
  canAct, checkAddress, checkPhone, REFUSAL_TEXT, cancellationAllowedInWindow,
  type ActionKind, type ActionOrder, type ActionRefusal, type AddressPatch,
} from "@engine/supportActions";
import { openOrCreateRefund } from "@commerce/refunds";
import { isPartiallyPaid } from "@commerce/partialCod";
import { decideCancellation } from "@policy/policyEngine";

const ADMIN = "https://www.ajuki.in/admin/orders";

export type ActionRequest =
  | { kind: "cancel_order"; orderId: string }
  | { kind: "change_address"; orderId: string; address: AddressPatch }
  | { kind: "update_phone"; orderId: string; phone: string };

export type ActionOutcome =
  | { ok: true; kind: ActionKind; orderId: string; summary: string }
  | { ok: false; kind: ActionKind; orderId: string; reason: ActionRefusal; message: string };

/** The model's loose object, narrowed to the shape runAction expects. Only the
 *  fields belonging to the named kind are carried across, so a stray `phone` on
 *  an address change cannot arrive somewhere it was not meant to. Channel-
 *  agnostic on purpose — both lib/waSupport.ts and lib/emailSupport.ts call
 *  this on whatever the model returned, since it is the same model output
 *  shape (lib/gemini.ts's SupportDecision) on every channel. */
export function toActionRequest(a: { kind: string; order_id: string } & Record<string, string>): ActionRequest {
  if (a.kind === "cancel_order") return { kind: "cancel_order", orderId: a.order_id };
  if (a.kind === "update_phone") return { kind: "update_phone", orderId: a.order_id, phone: a.phone ?? "" };
  return {
    kind: "change_address",
    orderId: a.order_id,
    address: { line1: a.line1, line2: a.line2, city: a.city, pincode: a.pincode },
  };
}

/** One line a person can read: what changed, from what, to what. */
function describe(kind: ActionKind, before: Record<string, unknown>, after: Record<string, unknown>): string {
  if (kind === "cancel_order") return "cancelled";
  if (kind === "update_phone") return `phone ${before.phone ?? "—"} → ${after.phone}`;
  const parts: string[] = [];
  for (const f of ["line1", "line2", "city"]) {
    if (before[f] !== after[f]) parts.push(`${f}: "${before[f] ?? ""}" → "${after[f] ?? ""}"`);
  }
  return parts.join(" · ") || "address updated";
}

/**
 * Do it, write it down, and tell the team.
 *
 * Never throws. This runs inside a customer conversation, and a failure here
 * should become a sentence the customer can read rather than a dropped reply.
 */
export async function runAction(
  db: SupabaseClient,
  req: ActionRequest,
  // Exactly one of phone/email is set, matching whichever channel verified
  // the customer — WhatsApp always has a phone, email always has an address,
  // and lib/supportActions.ts's ownsOrder checks whichever arrives.
  ctx: { phone?: string; email?: string; customerName?: string | null },
): Promise<ActionOutcome> {
  const identity = ctx.phone ? `+91 ${ctx.phone}` : (ctx.email ?? "unknown");

  const refuse = (reason: ActionRefusal): ActionOutcome => {
    // Refusals are recorded too. Read as a set they answer "what does the bot
    // keep trying to do that it is not allowed to", which is the next thing
    // worth building — and a refusal nobody logged is a complaint nobody can
    // explain later.
    void db.from("support_actions").insert({
      phone: ctx.phone ?? null, email: ctx.email ?? null, order_id: req.orderId, kind: req.kind,
      payload: req, status: "refused", refuse_reason: reason, source: "ai",
    });
    return { ok: false, kind: req.kind, orderId: req.orderId, reason, message: REFUSAL_TEXT[reason] };
  };

  const { data: row } = await db
    .from("orders").select("id, status, awb_code, address, payment_id, total, amount_paid_online, cod_due, created_at").eq("id", req.orderId).maybeSingle();
  const order = row as ActionOrder | null;

  const allowed = canAct(order, { phone: ctx.phone, email: ctx.email });
  if (!allowed.ok) return refuse(allowed.reason);
  const o = order!;

  const before = { ...(o.address ?? {}), status: o.status };
  let patch: Record<string, unknown>;
  let after: Record<string, unknown>;

  if (req.kind === "cancel_order") {
    // Also written to policy_decisions here, not just support_actions below —
    // canAct above already covers this order via the same underlying rule
    // (lib/supportActions.ts's cancellationAllowed), but support_actions only
    // records applied/refused actions, not the eligibility decision itself,
    // and only for this channel. This is what lets "every cancellation
    // eligibility decision, whichever channel" be one query.
    // The bot cancels only inside the 24 hours we promise; the shared rule below then records the decision.
    const window = cancellationAllowedInWindow(o);
    if (!window.ok) return refuse(window.reason);
    const check = await decideCancellation(db, o);
    if (!check.ok) return refuse(check.reason);
    // wa_cancelled, not cancelled: the customer said no on WhatsApp, and that is
    // a different thing from an order we called off ourselves. The distinction is
    // already load-bearing in the RTO reporting.
    patch = { status: "wa_cancelled" };
    after = { ...before, status: "wa_cancelled" };
  } else if (req.kind === "change_address") {
    const check = checkAddress(o, req.address);
    if (!check.ok) return refuse(check.reason);
    patch = { address: check.next };
    after = check.next;
  } else {
    const check = checkPhone(o, req.phone);
    if (!check.ok) return refuse(check.reason);
    patch = { address: check.next };
    after = check.next;
  }

  const { error } = await db.from("orders").update(patch).eq("id", o.id);
  if (error) {
    console.error(JSON.stringify({ event: "support_action_failed", order: o.id, kind: req.kind, error: error.message }));
    return refuse("invalid");
  }

  // Same Attack 1 fix as the account-page cancel path (app/api/orders/[id]),
  // applied here so a WhatsApp cancellation creates the same durable
  // eligibility record instead of just a status flip and a promise.
  if (req.kind === "cancel_order") {
    const paymentId = (row as { payment_id?: string | null })?.payment_id;
    const total = (row as { total?: number })?.total;
    const partialInfo = row as { amount_paid_online?: number | null; cod_due?: number | null };
    if (paymentId && paymentId !== "COD" && typeof total === "number") {
      try {
        // A partial-COD order only ever captured amount_paid_online against
        // this payment_id — the balance was always meant to be cash at the
        // door, never Razorpay's to refund.
        const refundAmount = isPartiallyPaid(partialInfo) ? partialInfo.amount_paid_online! : total;
        await openOrCreateRefund(db, {
          orderId: o.id, paymentId, amount: refundAmount,
          reasonCategory: "cancellation", requestedBy: "ai",
        });
      } catch (err) {
        console.error(JSON.stringify({ event: "refund_ledger_write_failed", order_id: o.id, error: err instanceof Error ? err.message : String(err) }));
      }
    }
  }

  const summary = describe(req.kind, before, after);
  const { data: saved } = await db.from("support_actions").insert({
    phone: ctx.phone ?? null, email: ctx.email ?? null, order_id: o.id, kind: req.kind,
    payload: req, before, status: "applied", source: "ai",
  }).select("id").maybeSingle();

  // Explicit on purpose. This is a change nobody approved, made to a real order,
  // by a machine — so the message says which order, who asked, exactly what moved
  // and how to put it back, rather than "an action was taken".
  const label: Record<ActionKind, string> = {
    cancel_order: "🛑 Order CANCELLED by the bot",
    change_address: "📍 Delivery address CHANGED by the bot",
    update_phone: "📞 Phone number CHANGED by the bot",
  };
  await notify(
    "OPS",
    `${label[req.kind]}\n\n` +
    `<b>Order</b> #${o.id}\n` +
    `<b>Customer</b> ${ctx.customerName ?? "Unknown"} · ${identity}\n` +
    `<b>Was</b> ${o.status}${req.kind === "cancel_order" ? "" : `\n<b>Change</b> ${summary}`}\n\n` +
    `<i>Nothing was booked with a courier, so no parcel had to be amended.</i>\n` +
    (saved?.id ? `<i>Undo: support_actions ${String(saved.id).slice(0, 8)}</i>\n` : "") +
    `\n<a href="${ADMIN}?q=${o.id}">Open the order</a>`,
  );

  return { ok: true, kind: req.kind, orderId: o.id, summary };
}

/**
 * Put an order back the way it was.
 *
 * Reads `before` off the recorded action rather than reconstructing it, which is
 * the entire reason that column exists: undo has to restore what was actually
 * there, not what someone assumes was there.
 */
export async function undoAction(db: SupabaseClient, actionId: string): Promise<{ ok: boolean; error?: string }> {
  const { data: act } = await db.from("support_actions").select("*").eq("id", actionId).maybeSingle();
  if (!act) return { ok: false, error: "not_found" };
  if (act.status !== "applied") return { ok: false, error: `already ${act.status}` };

  const before = (act.before ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = act.kind === "cancel_order"
    ? { status: before.status }
    : { address: Object.fromEntries(Object.entries(before).filter(([k]) => k !== "status")) };

  const { error } = await db.from("orders").update(patch).eq("id", act.order_id);
  if (error) return { ok: false, error: error.message };

  await db.from("support_actions")
    .update({ status: "undone", undone_at: new Date().toISOString() }).eq("id", actionId);
  // No Telegram ping: an undo is something the founder just triggered, and the
  // support_actions row already records it (spec §5 — idempotent self-confirmation).
  return { ok: true };
}
