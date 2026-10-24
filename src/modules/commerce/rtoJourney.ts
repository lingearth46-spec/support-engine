// The RTO-reduction customer journey: who gets which message, and when.
//
// This file is the rulebook and nothing else — no Supabase, no network — so every
// rule below can be tested against plain objects. The storage and the sending live
// in lib/rtoJourneyStore.ts; the hourly job is app/api/cron/rto-journey.
//
// Why this exists. September and early October COD parcels came back 47–52% of the
// time, against 0.9% for prepaid. The half of COD customers who never answered the
// confirmation message produced about 57% of the returns (54–55% against 39.8% for
// the ones who tapped Confirm). Admins only ever confirmed those orders 12–24 hours
// later, in bulk, and almost nothing reached the customer in between. The journey
// fills that gap and changes one decision:
//
//   T+0      first message   Confirm / Cancel / Pay online          (step "first")
//   T+4h     reminder        Confirm / Cancel                       (step "reminder")
//   T+10h    pay-online ask  Confirm / Cancel / Pay online, ₹55 off (step "offer")
//   T+12h    high-risk tier, still unconfirmed: HOLD for prepayment (step "hold")
//   paid     receipt         "nothing to pay at the door"           (step "received")
//   transit  heads-up        keep the cash ready, keep your phone on (step "headsup")
//   failed   second nudge    if the first failed-attempt message got no tap (step "ndr")
//   unpaid   payment retry   a Razorpay payment was tried and failed        (step "retry")
//
// NOTHING HERE RUNS UNTIL IT IS SWITCHED ON, and each step is switched on on its
// own, because an unapproved WhatsApp template fails the whole send and the customer
// hears nothing. Set RTO_JOURNEY_ENABLED=true and list the steps in RTO_JOURNEY_STEPS
// only once that step's template shows APPROVED (scripts/create-rto-journey-templates
// --status). An empty list does nothing.
//
// Silence is never read as a refusal, and no message here says that it will confirm
// the order. That is the founder's rule for the confirmation flow, kept.

import type { TemplateMessage } from "@adapters/messaging/whatsapp";
import { codAmountFor, isPartiallyPaid } from "@commerce/partialCod";
import { PREPAID_OFFER_DISCOUNT } from "@commerce/prepaidOffer";

// ── Switches ────────────────────────────────────────────────────────────────

export type JourneyStep = "first" | "reminder" | "offer" | "hold" | "received" | "headsup" | "ndr" | "retry";

export const JOURNEY_STEPS: readonly JourneyStep[] = ["first", "reminder", "offer", "hold", "received", "headsup", "ndr", "retry"];

export type JourneyConfig = {
  enabled: boolean;
  steps: ReadonlySet<JourneyStep>;
  /** Orders placed before this are never touched. A launch guard, like the one on
   *  cart recovery: switching a step on must not message last week's customers. */
  from: number;
  /** IST hours between which nothing is SENT to a customer on a timer, as [from, until)
   *  and wrapping midnight. null switches the guard off. Retry and the post-payment receipt
   *  are exempt: both answer something the customer has just done. */
  quiet: { from: number; until: number } | null;
};

/** 22:00 to 08:00 India time. The old flow never sent anything on a timer overnight; this
 *  job runs every hour round the clock, so without a guard a reminder lands at 3am. */
export const DEFAULT_QUIET = { from: 22, until: 8 } as const;

/** Read "22-8" (or "off"). Anything unreadable falls back to the default, because a typo
 *  that switched the guard off would be the dangerous way to fail. */
export function parseQuiet(raw: string | undefined): JourneyConfig["quiet"] {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return { ...DEFAULT_QUIET };
  if (v === "off" || v === "none" || v === "0") return null;
  const m = v.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return { ...DEFAULT_QUIET };
  const from = Number(m[1]), until = Number(m[2]);
  return from <= 23 && until <= 23 && from !== until ? { from, until } : { ...DEFAULT_QUIET };
}

/** Is it the middle of the night in India? Timer-driven steps wait for the morning. */
export function inQuietHours(now: number, cfg: JourneyConfig): boolean {
  if (!cfg.quiet) return false;
  const h = new Date(now + 5.5 * 3_600_000).getUTCHours();
  const { from, until } = cfg.quiet;
  return from < until ? h >= from && h < until : h >= from || h < until;
}

/**
 * Read the switches. Every unknown word is ignored rather than guessed at, so a
 * typo can only ever switch something OFF.
 *
 * RTO_JOURNEY_ENABLED   "true" to allow anything at all.
 * RTO_JOURNEY_STEPS     comma list of steps, or "all".
 * RTO_JOURNEY_FROM      optional ISO date; orders created before it are ignored.
 * RTO_JOURNEY_QUIET      "22-8" (default) IST quiet hours for timer-driven sends, or "off".
 */
export function journeyConfig(env: Record<string, string | undefined> = process.env): JourneyConfig {
  const enabled = String(env.RTO_JOURNEY_ENABLED ?? "").trim().toLowerCase() === "true";
  const raw = String(env.RTO_JOURNEY_STEPS ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const wanted = raw.includes("all") ? [...JOURNEY_STEPS] : raw.filter((s): s is JourneyStep => (JOURNEY_STEPS as readonly string[]).includes(s));
  const from = Date.parse(String(env.RTO_JOURNEY_FROM ?? ""));
  return { enabled, steps: new Set(enabled ? wanted : []), from: Number.isFinite(from) ? from : 0, quiet: parseQuiet(env.RTO_JOURNEY_QUIET) };
}

export const stepOn = (cfg: JourneyConfig, step: JourneyStep): boolean => cfg.enabled && cfg.steps.has(step);

// ── Timings (hours) ─────────────────────────────────────────────────────────
//
// Measured from confirm_wa_sent_at, the moment the first message went out. The job
// runs hourly, so each step really fires within an hour of its threshold.
//
// Every step has an upper bound as well as a lower one. If the job is down for a
// day, the run that fixes it must not send a reminder to everyone who was due a day
// ago — a nudge that arrives late reads as nagging.

export const REMINDER_FROM_H = 4;
export const REMINDER_UNTIL_H = 11.5;
export const OFFER_FROM_H = 10;
export const OFFER_UNTIL_H = 23;
/** The existing order-confirmation job moves unanswered orders to the call queue at
 *  12h and auto-confirms at 24h. A hold at 12h always lands before the 24h step. */
export const HOLD_FROM_H = 12;
export const HOLD_UNTIL_H = 47;
export const HEADSUP_MIN_AGE_H = 30;
/** Fire within this many hours of the end of the promised delivery day. Measured on 21 days of
 *  real parcels: at 30h the out-for-delivery message follows within 6h only 1% of the time, where
 *  firing 30h after booking put them within 6h of each other for 14%, and said "in the next day or
 *  two" to parcels three days out. */
export const HEADSUP_BEFORE_ETA_H = 30;
export const HEADSUP_MAX_AGE_H = 120;
export const NDR_AFTER_H = 3;
export const NDR_UNTIL_H = 20;
/** Measured from the Razorpay order's creation. Most UPI failures settle within minutes and
 *  many customers retry on their own straight away, so waiting 45 minutes avoids messaging
 *  people who are about to pay; three hours keeps it ahead of the four-hour cart-recovery
 *  message, which this one suppresses. */
export const RETRY_FROM_H = 0.75;
export const RETRY_UNTIL_H = 3;

// ── Template names ──────────────────────────────────────────────────────────
// Submitted by scripts/create-rto-journey-templates.mts. The wording, variables and
// button order below must match what was submitted — see that file.

export const TEMPLATES = {
  first: "order_confirm_cod_v4",
  reminder: "order_confirm_reminder_v1",
  offer: "order_prepay_offer_v1",
  received: "order_payment_received_v1",
  hold: "order_prepay_hold_v1",
  headsup: "order_arrival_headsup_v1",
  ndr: "delivery_attempt_reminder_v1",
  retry: "payment_retry_v1",
} as const;

/** Stamped at the front of admin_notes when we hold an order, so a person looking at
 *  it can see why, and so a late "Confirm" tap can tell this hold apart from the
 *  repeat-RTO one (which must still be paid for, whatever the customer replies). */
export const JOURNEY_HOLD_PREFIX = "Held for prepayment (no confirmation, high-risk tier): ";

// ── The order, as far as these rules care ───────────────────────────────────

export type ConfirmReply = { at?: string; text?: string; intent?: "confirm" | "cancel" | "unclear"; tapped?: boolean };

export type JourneyOrder = {
  id: string;
  status: string;
  payment_id?: string | null;
  total?: number | string | null;
  cod_due?: number | null;
  amount_paid_online?: number | null;
  awb_code?: string | null;
  courier_name?: string | null;
  address?: { name?: string; phone?: string } | null;
  items?: Array<{ name?: string; quantity?: number }> | null;
  risk_tier?: string | null;
  risk_reasons?: string[] | null;
  admin_notes?: string | null;
  created_at?: string | null;
  confirm_wa_sent_at?: string | null;
  confirmed_at?: string | null;
  confirm_replies?: ConfirmReply[] | null;
  manifested_at?: string | null;
  courier_status?: string | null;
  courier_status_at?: string | null;
  missed_wa_sent?: boolean | null;
  ofd_wa_sent?: boolean | null;
  delivered_at?: string | null;
  estimated_delivery?: string | null;
};

const HOUR = 3_600_000;
const hoursSince = (iso: string | null | undefined, now: number): number => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? (now - t) / HOUR : Number.NaN;
};

/** A plain cash-on-delivery order: not prepaid, not partly paid. */
export function isPlainCod(o: JourneyOrder): boolean {
  return o.payment_id === "COD" && !isPartiallyPaid({ amount_paid_online: o.amount_paid_online, cod_due: o.cod_due });
}

/** Has the customer said anything at all to the confirmation message? Any reply,
 *  even a question, means a person is on the other end, so no reminder is sent. */
export function hasReplied(o: JourneyOrder): boolean {
  return Array.isArray(o.confirm_replies) && o.confirm_replies.length > 0;
}

export const isHighRisk = (o: JourneyOrder): boolean => o.risk_tier === "high";

/** The note the repeat-RTO rule writes when it holds an order for payment (app/api/orders/save). */
export const REPEAT_RTO_HOLD_PREFIX = "On hold for prepayment";

/**
 * Was this order put on hold BECAUSE it must be paid for? Both rules that do that write a note
 * saying so; an order on hold for any other reason (a person parked it) has neither.
 *
 * prepay-expiry cancels unpaid held orders after 48h. Before the journey, only payment holds had
 * a pre-dispatch pay link, so "on hold with an unpaid link" meant "held for payment". Every COD
 * order now carries such a link, so the note is what tells the cases apart. Without this check,
 * an order a person had held by hand would be cancelled, with a message saying we had not
 * received payment we never asked for.
 */
export function isPaymentHold(notes: string | null | undefined): boolean {
  const n = String(notes ?? "");
  return n.startsWith(JOURNEY_HOLD_PREFIX) || n.startsWith(REPEAT_RTO_HOLD_PREFIX);
}

/**
 * Is this order held by the journey, as opposed to the repeat-RTO rule?
 *
 * The distinction matters in one place: a customer who taps Confirm on an order we
 * held for being quiet HAS now confirmed, which is exactly what the hold was
 * waiting for, so it is released. A repeat-RTO order (manual_review) is held until
 * it is PAID, whatever the customer replies.
 */
export function isJourneyHold(o: Pick<JourneyOrder, "status" | "risk_tier" | "admin_notes">): boolean {
  return o.status === "on_hold" && o.risk_tier !== "manual_review" && String(o.admin_notes ?? "").startsWith(JOURNEY_HOLD_PREFIX);
}

// ── Which confirmation-window step is due ───────────────────────────────────

/** An order still waiting on a customer's answer, with nothing booked. */
export function awaitingAnswer(o: JourneyOrder): boolean {
  return (
    isPlainCod(o) &&
    (o.status === "processing" || o.status === "call_1") &&
    !o.awb_code &&
    !o.confirmed_at &&
    Boolean(o.confirm_wa_sent_at)
  );
}

/**
 * What, if anything, is due for an order in the confirmation window.
 *
 * `done` is the set of steps already sent for this order; every step is once-only.
 *
 * Order of preference when more than one is due (the job was down): hold, then
 * offer, then reminder. A high-risk order past 12 hours goes straight to the hold,
 * whose message already asks for payment, so a separate offer would only repeat it.
 */
export function confirmationStep(
  o: JourneyOrder,
  now: number,
  cfg: JourneyConfig,
  done: ReadonlySet<JourneyStep>,
): "hold" | "offer" | "reminder" | null {
  if (!cfg.enabled || !awaitingAnswer(o)) return null;
  if (inQuietHours(now, cfg)) return null;
  if (cfg.from && Date.parse(String(o.created_at ?? "")) < cfg.from) return null;

  const age = hoursSince(o.confirm_wa_sent_at, now);
  if (!Number.isFinite(age)) return null;

  if (stepOn(cfg, "hold") && !done.has("hold") && isHighRisk(o) && age >= HOLD_FROM_H && age < HOLD_UNTIL_H) return "hold";
  if (stepOn(cfg, "offer") && !done.has("offer") && !hasReplied(o) && age >= OFFER_FROM_H && age < OFFER_UNTIL_H) return "offer";
  // Never a reminder after the offer: the reminder window now outlasts the first night, and an
  // "any update?" message arriving after "pay online and save" would read backwards.
  if (stepOn(cfg, "reminder") && !done.has("reminder") && !done.has("offer") && !hasReplied(o) && age >= REMINDER_FROM_H && age < REMINDER_UNTIL_H) return "reminder";
  return null;
}

/** A parcel in transit that has not yet had its heads-up, and is near enough to arrival to be worth one. */
export function headsUpDue(o: JourneyOrder, now: number, cfg: JourneyConfig, done: ReadonlySet<JourneyStep>): boolean {
  if (!stepOn(cfg, "headsup") || done.has("headsup")) return false;
  if (inQuietHours(now, cfg)) return false;
  if (o.status !== "shipped" || !o.awb_code || o.delivered_at || o.ofd_wa_sent) return false;
  if (cfg.from && Date.parse(String(o.created_at ?? "")) < cfg.from) return false;
  // Only parcels the courier says are moving. "delivered" can lag on a shipped row,
  // and "unknown" is a tracking gap we cannot reason about.
  if (o.courier_status !== "in_transit" && o.courier_status !== "at_facility") return false;
  const age = hoursSince(o.manifested_at, now);
  if (!Number.isFinite(age) || age < HEADSUP_MIN_AGE_H || age > HEADSUP_MAX_AGE_H) return false;
  // Near enough to arrival to be worth it, or no usable date at all. estimated_delivery is a
  // plain date, which parses as midnight UTC; the promise runs to the end of that day in
  // India, which is 18:30 UTC. A parcel not due for days should not be told "any day now".
  const eta = Date.parse(String(o.estimated_delivery ?? "")) + 18.5 * HOUR;
  if (Number.isFinite(eta) && eta - now > HEADSUP_BEFORE_ETA_H * HOUR) return false;
  return true;
}

/**
 * A second nudge after a failed delivery attempt, when the first message got no answer.
 *
 * `lastInboundAt` is when the customer last wrote to us at all. Anything after the
 * failure means they have already responded, by tapping a button or typing, and a
 * reminder would talk over a conversation that is happening.
 */
export function ndrReminderDue(
  o: JourneyOrder,
  now: number,
  cfg: JourneyConfig,
  done: ReadonlySet<JourneyStep>,
  lastInboundAt: string | null | undefined,
): boolean {
  if (!stepOn(cfg, "ndr") || done.has("ndr")) return false;
  if (inQuietHours(now, cfg)) return false;
  if (o.status !== "undelivered" || o.courier_status !== "failed_attempt" || !o.missed_wa_sent) return false;
  if (cfg.from && Date.parse(String(o.created_at ?? "")) < cfg.from) return false;
  const age = hoursSince(o.courier_status_at, now);
  if (!Number.isFinite(age) || age < NDR_AFTER_H || age > NDR_UNTIL_H) return false;
  const failedAt = Date.parse(String(o.courier_status_at));
  const wrote = Date.parse(String(lastInboundAt ?? ""));
  if (Number.isFinite(wrote) && wrote >= failedAt) return false;
  return true;
}

/**
 * A Razorpay checkout that was tried and not paid, as far as the retry rules care.
 *
 * Not an order of ours: nothing has been placed yet, which is the whole point of the
 * message. It is keyed by the Razorpay order id, and the link it carries restores the
 * customer's saved cart (abandoned_carts.id), exactly as the cart-recovery message does.
 */
export type RetryCandidate = {
  razorpayOrderId: string;
  /** Ten digits. */
  phone: string;
  /** Razorpay's: "created" or "attempted". */
  status?: string;
  /** When Razorpay created the order, in ms. */
  createdAt: number;
  /** Rupees. */
  amount: number;
  cart: Array<{ name?: string; quantity?: number }>;
  /** The marketing consent ticked on our cart page; undefined means never asked. */
  waOptin?: boolean;
};

/**
 * Is a payment-retry message due for this checkout?
 *
 * Only for a payment that was actually TRIED. A checkout that was merely opened is a
 * browser who left, and telling them "your payment didn't go through" would be untrue.
 * Someone who explicitly declined WhatsApp on our cart page (waOptin === false) is left
 * alone even though this message is transactional: an explicit no is not ours to
 * reinterpret, and a blocked number costs more than a missed recovery.
 */
export function retryDue(c: RetryCandidate, now: number, cfg: JourneyConfig, done: ReadonlySet<JourneyStep>): boolean {
  if (!stepOn(cfg, "retry") || done.has("retry")) return false;
  if (c.status !== "attempted" || c.waOptin === false) return false;
  if (cfg.from && c.createdAt < cfg.from) return false;
  const age = (now - c.createdAt) / HOUR;
  return age >= RETRY_FROM_H && age < RETRY_UNTIL_H;
}

// ── Messages ────────────────────────────────────────────────────────────────
// Variables are in the order the templates were submitted. The URL button's position
// counts ALL buttons, quick replies included, which is why the Pay online token sits
// at index 2 on the three-button templates and index 0 on the hold template.

const inr = (n: number | string | null | undefined): string => Math.round(Number(n) || 0).toLocaleString("en-IN");

export function firstNameOf(o: Pick<JourneyOrder, "address">): string {
  const name = String(o.address?.name ?? "").trim();
  const first = name ? name.split(/\s+/)[0] : "";
  return /[\p{L}]/u.test(first) ? first.slice(0, 40) : "there";
}

export function itemsInline(o: Pick<JourneyOrder, "items">): string {
  const items = Array.isArray(o.items) ? o.items : [];
  return items.map((i) => `${i.name ?? "Item"}${(i.quantity ?? 1) > 1 ? ` × ${i.quantity}` : ""}`).join(", ");
}

/** What is owed in cash at the door. */
export const cashDue = (o: JourneyOrder): number => codAmountFor({ payment_id: o.payment_id, total: Number(o.total) || 0, cod_due: o.cod_due });

export type OfferTerms = { token: string; discount: number; amountOnline: number };

/** order_confirm_cod_v4: the opening message, with a Pay online button. */
export function firstMessage(o: JourneyOrder, token: string): TemplateMessage {
  return {
    template: TEMPLATES.first,
    variables: [firstNameOf(o), o.id, itemsInline(o), inr(cashDue(o))],
    urlButtonParam: [null, null, token],
  };
}

/** order_confirm_reminder_v1 */
export function reminderMessage(o: JourneyOrder): TemplateMessage {
  return { template: TEMPLATES.reminder, variables: [firstNameOf(o), o.id, itemsInline(o), inr(cashDue(o))] };
}

/** order_prepay_offer_v1: pay online and save, or confirm cash on delivery. */
export function offerMessage(o: JourneyOrder, t: OfferTerms): TemplateMessage {
  return {
    template: TEMPLATES.offer,
    variables: [firstNameOf(o), o.id, inr(t.discount), inr(t.amountOnline), inr(t.amountOnline + t.discount)],
    urlButtonParam: [null, null, t.token],
  };
}

/** order_prepay_hold_v1: we need payment online to send this one. */
export function holdMessage(o: JourneyOrder, t: OfferTerms): TemplateMessage {
  return { template: TEMPLATES.hold, variables: [firstNameOf(o), o.id, inr(t.amountOnline)], urlButtonParam: t.token };
}

/** order_payment_received_v1: only meaningful when something was saved. */
export function receivedMessage(o: JourneyOrder, paid: number, saved: number): TemplateMessage {
  return { template: TEMPLATES.received, variables: [firstNameOf(o), o.id, itemsInline(o), inr(paid), inr(saved)] };
}

/** The payment line the arrival heads-up carries, one template for COD and prepaid, as order_out_for_delivery does. */
export function paymentLine(o: JourneyOrder): string {
  const cash = cashDue(o);
  return cash > 0 ? `₹${inr(cash)} in cash on delivery` : "Already paid, nothing to collect";
}

/** order_arrival_headsup_v1 */
export function headsUpMessage(o: JourneyOrder): TemplateMessage {
  return { template: TEMPLATES.headsup, variables: [firstNameOf(o), o.id, o.courier_name || "our courier partner", paymentLine(o)] };
}

/** delivery_attempt_reminder_v1 */
export function ndrReminderMessage(o: JourneyOrder): TemplateMessage {
  return { template: TEMPLATES.ndr, variables: [firstNameOf(o), o.id] };
}

/**
 * payment_retry_v1. The cart table stores no name, so it greets "there", as cart recovery
 * does. The URL button's tail is the saved cart's id; the page behind it rebuilds the cart
 * and Magic Checkout offers cash on delivery again.
 *
 * `&nocode=1` matters. The /cart?recover= page applies the cart-recovery code (COMEBACK50,
 * ₹50 off) to whoever opens it, because the recovery message advertises that offer. This
 * message does not, so without the flag every failed-payment customer would quietly get ₹50
 * off. The cart page honours the flag by restoring the cart and skipping the code.
 */
export function retryMessage(c: RetryCandidate, cartId: string): TemplateMessage {
  return { template: TEMPLATES.retry, variables: ["there", itemsInline({ items: c.cart }), inr(c.amount)], urlButtonParam: `${cartId}&nocode=1` };
}

/**
 * The text the customer actually received, for the support thread and the admin
 * panel. Mirrors the approved bodies, so what the team reads is what was delivered.
 */
export function describeMessage(m: TemplateMessage): string {
  const v = m.variables;
  switch (m.template) {
    case TEMPLATES.first:
      return `Hi ${v[0]} 👋\n\nThank you for choosing AJUKI ✨\n\n📦 Order #${v[1]}\n🛍️ Items: ${v[2]}\n💰 Cash on delivery: ₹${v[3]}\n\nConfirm below and our workshop will start packing your pieces.\n\n💳 Prefer to pay online? Tap *Pay online* — it's secure and your order is packed first.`;
    case TEMPLATES.reminder:
      return `Hi ${v[0]} 👋\n\nA quick reminder from AJUKI ✨\n\n📦 Order #${v[1]}\n🛍️ Items: ${v[2]}\n💰 Amount due: ₹${v[3]}\n\nYour pieces are ready to be packed — just tap Confirm below and we'll get started.`;
    case TEMPLATES.offer:
      return `Hi ${v[0]} 👋\n\nYour AJUKI order #${v[1]} is still waiting to be packed.\n\n💳 Pay online now and save ₹${v[2]} — your total becomes ₹${v[3]} instead of ₹${v[4]}.\n\nPrefer cash on delivery? Tap Confirm and we'll send it as planned.`;
    case TEMPLATES.hold:
      return `Hi ${v[0]}, about your AJUKI order #${v[1]}.\n\nWe haven't been able to confirm this order yet, so to send it we need payment online. Tap below to pay ₹${v[2]} and we'll pack it today.\n\nIf you'd rather cancel, or something looks wrong, just reply here.`;
    case TEMPLATES.received:
      return `Hi ${v[0]}, payment received — thank you! 🙏\n\nOrder #${v[1]}\n${v[2]}\nPaid online: ₹${v[3]} (you saved ₹${v[4]})\n\nThere's nothing to pay at the door. We'll pack it today and send your tracking link here as soon as it ships.`;
    case TEMPLATES.headsup:
      return `Hi ${v[0]} 👋\n\nYour AJUKI order #${v[1]} is on its way and should reach you in the next day or two.\n\n🚚 Courier: ${v[2]}\n💰 Payment: ${v[3]}\n\nPlease keep your phone on so the delivery agent can reach you. If your number needs changing, tap below.`;
    case TEMPLATES.ndr:
      return `Hi ${v[0]}, we still haven't been able to deliver your AJUKI order #${v[1]}.\n\nThe courier will try again, and a quick reply now helps them reach you. Tell us what works:`;
    case TEMPLATES.retry:
      return `Hi ${v[0]}, your payment for your AJUKI order didn't go through, so the order hasn't been placed yet.\n\n🛍️ ${v[1]}\n💰 Amount: ₹${v[2]}\n\nTap below to try again. You can also choose cash on delivery at checkout.`;
    default:
      return `[Sent] WhatsApp template "${m.template}" for order ${v[1] ?? ""}.`;
  }
}

/** The discount a pay-online ask carries. One number, shared with the checkout coupon. */
export const JOURNEY_DISCOUNT = PREPAID_OFFER_DISCOUNT;
