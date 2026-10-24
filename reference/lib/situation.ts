// What situation is this customer in? Decided by code, from the message, the thread and the order record — never from the model.
//
// Phase 2 of the support-pipeline plan. Today the answer to "what is going on here" is spread over a dozen rule modules that each
// ask their own question, and several of them read the MODEL's tag to decide (returnStateReply, lateDeliveryReply, topicReply …):
// when the model tags a turn wrongly, a fixed reply fires on the wrong turn or fails to fire on the right one, and nothing records
// that the tag was what changed the outcome. This module names the situation once, from facts the code can check, with the tag
// out of it, so that:
//   · a later selector chooses a strategy FOR a situation instead of re-deriving the situation from the whole prompt;
//   · where today's overrides disagree with it, the disagreement is visible (compareToActual) and can be explained;
//   · a turn the rules do not cover still gets a typed description (order state, overdue days, open case, refund record,
//     what we last told them) rather than "unknown".
//
// It runs the same rule modules the live path runs, in the same order, with the tag removed (`tag: "unknown"`). A rule that fires
// is the situation's `rule`, in the vocabulary of meta.fixedReply. Where no rule fires, the situation is described from the
// facts. Pure: no clock except `now`, no database, no network. Used in SHADOW only (recorded in the decision trace); it changes
// no reply.

import { greetingReply, orderLookupReply, type LookupOrder } from "@/lib/lookupReply";
import { queuedBareReply } from "@/lib/queuedReply";
import { topicReply, ADDRESS_CHANGE, NEGATED_ADDRESS } from "@/lib/topicReplies";
import { languageReply, payLinkConfirmReply, ambiguousFragmentReply } from "@/lib/clarifyReplies";
import {
  returnStateReply, touchesReturnFlow, REFUND_WORD, REFUND_CHASE, FAULT, WAIT_QUESTION,
  PENDING_REPLY, CHASING_REPLY, CHASING_AGAIN_REPLY, RETURN_PAGE_REPLY, WINDOW_CLOSED_EMAIL_REPLY, NO_RETURN_EMAIL_REPLY, EXCHANGE_EMAIL_REPLY,
  APPROVED_APPEAL_REPLY, CANCEL_RETURN_REPLY, isCanned,
} from "@/lib/returnStateReply";
import { cancelStateReply, CANCEL_REPLY, CANCEL_TOO_OLD_REPLY, CANCEL_INSIST_REPLY } from "@/lib/cancelStateReply";
import { REJECTED_APPEAL_SHORT } from "@/lib/returnStateReply";
import { lateDeliveryReply, isOverdue, isLateFirstText, isLateInsistText, LATE_WORDS, PUSHING } from "@/lib/lateDeliveryReply";
import { alreadyCancelledReply, scopeOrders, orderIdsIn, type ScopeBasis } from "@/lib/orderScope";
import { hasCancellationIntent, hasRefundIntent, hasReturnIntent, hasBillingIntent } from "@/lib/supportGuardrails";
import { cancellationAllowedInWindow } from "@/lib/supportActions";
import { daysLeftToReturn } from "@/lib/returnPolicy";
import { FLAG_REPLY, LEGACY_FLAG_REPLY } from "@/lib/businessTruths";
import type { OrderRow } from "@/lib/orderLines";

export const SITUATION_VERSION = 1;

export type Family =
  | "greeting" | "lookup" | "language" | "payment" | "fragment" | "cancel" | "return" | "exchange" | "refund"
  | "delivery" | "address" | "topic" | "other";

/** The order record exactly as the live path reads it (lib/orderLines.ts), so every rule module accepts it unchanged. */
export type SituationOrder = OrderRow;

export interface SituationInput {
  /** The inbound message as received (curly apostrophes are normalised here, as in waSupport). */
  message: string;
  /** Recent turns, oldest first, WITHOUT the message being answered. */
  recent: { direction: "in" | "out"; body: string }[];
  /** Orders matched to the sender's own number, and orders named in the chat that are not theirs. */
  own: SituationOrder[];
  mentioned?: SituationOrder[];
  senderPhone?: string;
  lastBotReply?: string | null;
  lastOutAt?: string | null;
  /** A refund is on record for one of their orders / per-order refund state, when known. */
  hasRefundRecord?: boolean;
  refunds?: Record<string, { status?: string; amount?: number; since?: string }>;
  /** The team already has something open for them (customerContextBlock's "Already with the team"). */
  openCase?: boolean;
  /** The customer sent a photo, or an NDR button flow owns the next message: the early pass is skipped, as in waSupport. */
  hasImages?: boolean;
  pendingFlow?: boolean;
  /** Answering an overnight message at 11:00. */
  wake?: boolean;
  now?: number;
}

export interface Situation {
  v: number;
  /** Closed vocabulary, `family.detail[.detail]`. */
  subtype: string;
  family: Family;
  /** A fixed rule covers this situation (in the vocabulary of meta.fixedReply), else null: the model's to answer. */
  rule: string | null;
  /** Other rules that also match this message, when more than one does (a return chase that is also a late parcel). */
  also: string[];
  /** "code": a fixed rule answers · "model": the model answers · "none": nothing needs saying (an acknowledgement). */
  handler: "code" | "model" | "none";
  subject: { order: string | null; basis: ScopeBasis; orders: number };
  /** Checkable facts the situation rests on, as `key=value` ids. */
  facts: string[];
  /** Which wording or intent signals fired in the message / thread. */
  signals: string[];
}

const n = (s: string | undefined | null) => (s ?? "").replace(/[‘’]/g, "'");
const SETTLED = new Set(["delivered", "cancelled", "wa_cancelled", "returned", "rto"]);
const IN_FLIGHT_STATUS = /^(shipped|undelivered|out_for_delivery|in_transit|manifested|packed|confirmed|processing|on_hold|call_1|call_2)$/;
const STATUS_WORDS = /\b(status|track(ing)?|where|when|kab|kahan|update|eta|delivery date|dispatch|shipped|reach)\b/i;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]+/g, " ").replace(/\s+/g, " ").trim();
const wordCount = (s: string) => norm(s).split(" ").filter(Boolean).length;

/** What we last said to this customer, as a short kind. */
export function lastBotKind(last: string | null | undefined): string {
  const t = last ?? "";
  if (!t) return "none";
  const is = (c: string) => t.startsWith(c.slice(0, 30));
  if (is(FLAG_REPLY) || is(LEGACY_FLAG_REPLY)) return "flag";
  if (isLateFirstText(t)) return "late_first";
  if (isLateInsistText(t)) return "late_insist";
  if (is(CANCEL_REPLY)) return "cancel_dispatched";
  if (is(CANCEL_TOO_OLD_REPLY)) return "cancel_too_old";
  if (is(CANCEL_INSIST_REPLY)) return "cancel_insist";
  if (isCanned(t)) return "return_canned";
  return "model";
}

function returnKind(text: string): string {
  if (text === PENDING_REPLY) return "return.pending";
  if (text === CHASING_REPLY || text === CHASING_AGAIN_REPLY) return "return.rejected.chasing";
  if (text.includes("Your return request was reviewed and rejected") || text.startsWith(REJECTED_APPEAL_SHORT.slice(0, 30))) return "return.rejected";
  if (text === RETURN_PAGE_REPLY) return "return.none.window_open";
  if (text === WINDOW_CLOSED_EMAIL_REPLY) return "return.none.window_closed";
  if (text === NO_RETURN_EMAIL_REPLY) return "return.none.insist";
  if (text === EXCHANGE_EMAIL_REPLY) return "exchange.email";
  if (text === APPROVED_APPEAL_REPLY) return "return.approved.appeal";
  if (text === CANCEL_RETURN_REPLY) return "return.cancel_request";
  return "return.other";
}

const TOPIC_SUBTYPE: Record<string, string> = {
  address_flag: "address.change.dispatched", address_ask: "address.change.dispatched", phone_given: "address.change.dispatched", size: "topic.size", size_insist: "topic.size.insist", discount: "topic.discount",
  complaint_email: "topic.complaint_email", no_store: "topic.no_store", warranty: "topic.warranty", photos: "topic.photos",
  care: "topic.care", quality: "topic.quality",
};

type Hit = { subtype: string; rule: string };

/** A one-word agreement or a statement relaying what someone told them: nothing in it asks us for anything. */
const ACK_SHORT = /^(?:sure|ok(?:ay)?(?: sure)?|yes|yeah|yep|yup|fine|alright|all right|done|hmm+|k|thik hai|theek hai|haan|ji|got it|noted|understood)[\s.!]*$/i;
const RELAY = /\b(?:they|he|she|team|agent|support|someone|person)\b.{0,20}\b(?:said|told|replied|informed|mentioned|promised)\b/i;

export function classifySituation(i: SituationInput): Situation {
  const now = i.now ?? Date.now();
  const msg = n(i.message);
  const own = i.own ?? [];
  const mentioned = i.mentioned ?? [];
  const recent = i.recent ?? [];
  const last = i.lastBotReply ?? null;
  const scope = scopeOrders({ message: msg, recent, own, mentioned });
  const scoped = scope.orders;
  const recentCustomer = recent.filter((t) => t.direction === "in").map((t) => n(t.body));
  const hasRefundRecord = i.hasRefundRecord ?? !!(i.refunds && Object.keys(i.refunds).length);
  const touchesReturn = touchesReturnFlow(msg);
  const cancelIntent = hasCancellationIntent(msg);
  const lookupOrders = (list: SituationOrder[]): LookupOrder[] => list as unknown as LookupOrder[];

  // ── signals: what the words say, without the model's reading of them ──────────────────────────────────────────────────────
  const signals: string[] = [];
  const sig = (cond: boolean, name: string) => { if (cond) signals.push(name); };
  sig(cancelIntent, "intent.cancel");
  sig(hasRefundIntent(msg) || REFUND_WORD.test(msg), "intent.refund");
  sig(hasReturnIntent(msg), "intent.return");
  sig(hasBillingIntent(msg), "intent.billing");
  sig(FAULT.test(msg), "fault");
  sig(LATE_WORDS.test(msg), "late_words");
  sig(PUSHING.test(msg), "pushing");
  sig(ADDRESS_CHANGE.test(msg) && !NEGATED_ADDRESS.test(msg), "address_change");
  sig(STATUS_WORDS.test(msg), "status_words");
  const threadLate = recentCustomer.slice(-3).some((t) => LATE_WORDS.test(t));
  sig(threadLate, "thread.late_words");

  // ── facts: what the record says about the order(s) this is about ─────────────────────────────────────────────────────────
  const facts: string[] = [`scope=${scope.basis}`];
  const subject = scoped.length === 1 ? scoped[0] : null;
  if (subject) {
    facts.push(`order=${subject.id}`, `order.status=${subject.status}`);
    if (subject.payment_id) facts.push(`pay=${subject.payment_id === "COD" ? "cod" : "prepaid"}`);
    if (isOverdue(subject as never, now)) {
      facts.push("order.overdue=yes");
      // Days past the promised date, when there is a date and it has passed. "undelivered" is overdue by status whatever the date says.
      const od = subject.estimated_delivery ? Math.floor((now - Date.parse(subject.estimated_delivery)) / 86_400_000) : NaN;
      if (Number.isFinite(od) && od > 0) facts.push(`order.overdue_days=${od}`);
      if (subject.status === "undelivered") facts.push("order.delivery_failed=yes");
    }
    if (subject.delivered_at) {
      facts.push(`order.delivered_days=${Math.floor((now - Date.parse(subject.delivered_at)) / 86_400_000)}`);
      const left = daysLeftToReturn(subject.delivered_at, new Date(now));
      facts.push(left !== null && left > 0 ? `return.window_open=${left}d` : "return.window=closed");
    }
    if (subject.return_request?.status) facts.push(`return.request=${subject.return_request.status}`);
    const verdict = cancellationAllowedInWindow({ status: subject.status as never, awb_code: subject.awb_code ?? undefined, created_at: subject.created_at }, now);
    facts.push(`order.cancellable=${verdict.ok ? "yes" : `no:${verdict.reason}`}`);
    // Per-order when the map is known; otherwise all we know is whether ANY of their orders has a refund, and we say only that.
    const rf = i.refunds?.[subject.id];
    if (rf) {
      facts.push(`refund.record=${rf.status ?? "yes"}`);
      if (typeof rf.amount === "number") facts.push(`refund.amount=${rf.amount}`);
      if (rf.since) facts.push(`refund.since=${rf.since.slice(0, 10)}`);
    }
    else if (i.refunds) facts.push("refund.record=none");
    else facts.push(`refund.record=${hasRefundRecord ? "some_order" : "none"}`);
  } else {
    facts.push(`orders_in_scope=${scoped.length}`);
  }
  if (i.openCase) facts.push("case.open=yes");
  facts.push(`last_bot=${lastBotKind(last)}`);
  const repeats = recentCustomer.filter((t) => norm(t) === norm(msg) && norm(msg)).length + 1;
  if (repeats > 1) facts.push(`msg.repeat=${repeats}`);

  // ── 1. the rules, in the live order, with the model's tag taken out ──────────────────────────────────────────────────────
  const matches: Hit[] = [];
  const add = (subtype: string, rule: string) => { if (!matches.some((m) => m.rule === rule && m.subtype === subtype)) matches.push({ subtype, rule }); };

  // (a) the overnight bare reply
  if (i.wake) {
    const q = queuedBareReply(msg, { ownOrderCount: own.length });
    if (q) add(q.kind === "queued_greeting" ? "greeting.queued" : "lookup.queued_track", q.kind);
  }
  // (b) the early pass: only when nothing touches returns / cancellation and no photo or button flow owns the message
  const early = !i.hasImages && !i.pendingFlow && !own.some((o) => o.return_request) && !touchesReturn && !cancelIntent;
  const greet = greetingReply({ message: msg, lastOutAt: i.lastOutAt ?? undefined, now });
  const look = greet ? null : orderLookupReply({ message: msg, senderPhone: i.senderPhone ?? "", ownOrders: lookupOrders(own), mentionedOrders: lookupOrders(mentioned), now });
  const topic = greet || look ? null : topicReply({ message: msg, tag: "unknown", ownOrders: scoped, lastBotReply: last, v2: true });
  const topicFound = (t: NonNullable<typeof topic>) => add(TOPIC_SUBTYPE[t.kind] ?? `topic.${t.kind}`, t.kind);
  if (early) {
    if (greet) add("greeting.bare", "greeting");
    else if (look) add(look.escalate ? "lookup.late" : "lookup.order", look.escalate ? "lookup_late" : "lookup");
    else if (topic) topicFound(topic);
    else {
      const lang = languageReply(msg);
      const pay = payLinkConfirmReply({ message: msg, recentOut: recent.filter((t) => t.direction === "out").map((t) => t.body), orderStatus: scope.basis === "none" ? null : scoped[0]?.status });
      if (lang) add("language.unsupported", "language");
      else if (pay) add("payment.confirm_prepaid", "pay_link");
      else if (orderIdsIn(msg).length === 0 && ambiguousFragmentReply(msg)) add("fragment.ambiguous", "clarify");
    }
  }
  // (c) after the model: settled → return state → cancel state, then the first-touch lines, the topic lines, the late parcel
  const settled = alreadyCancelledReply({ scoped, message: msg, recentCustomer });
  const ret = returnStateReply({ ownOrders: scoped, message: msg, tag: "unknown", hasRefundRecord, lastBotReply: last, v2: true });
  const canc = cancelStateReply({ ownOrders: scoped, message: msg, tag: "unknown", lastBotReply: last, now });
  const late = lateDeliveryReply({ ownOrders: scoped, message: msg, tag: "unknown", lastBotReply: last, now, v2: true });
  if (settled) add("cancel.already_cancelled", "already_cancelled");
  if (ret) add(returnKind(ret), "return_state");
  if (canc) add(canc === CANCEL_REPLY ? "cancel.dispatched" : canc === CANCEL_TOO_OLD_REPLY ? "cancel.too_old" : "cancel.insist", "return_state");
  if (!settled && !ret && !canc) {
    if (greet) add("greeting.bare", "greeting");
    else if (look) add(look.escalate ? "lookup.late" : "lookup.order", look.escalate ? "lookup_late" : "lookup");
    else if (topic) topicFound(topic);
  }
  if (late) add(late.kind === "insist" ? "delivery.late.insist" : "delivery.late.first", `late_${late.kind}`);

  // ── 2. the first match is the situation; the rest are what else the message also matches ─────────────────────────────────
  const primary = matches[0];
  const also = matches.slice(1).map((m) => m.rule).filter((r, ix, a) => a.indexOf(r) === ix && r !== primary?.rule);
  let subtype: string;
  let rule: string | null = null;
  // After one of our fixed return lines, an acknowledgement or a relayed "they said 1-2 days" asks for nothing. The return rule would
  // still answer it (it continues our own canned line); the situation is that no reply is needed.
  const cannedThread = lastBotKind(last) === "return_canned";
  const needsNothing = !msg.includes("?") && (ACK_SHORT.test(msg.trim()) || (RELAY.test(msg) && wordCount(msg) <= 25));
  let handler: Situation["handler"] | null = null;
  if (primary && primary.rule === "return_state" && cannedThread && needsNothing) {
    subtype = "other.ack"; rule = null; handler = "none";
    signals.push("ack_in_canned_thread");
  } else if (primary) {
    subtype = primary.subtype; rule = primary.rule;
    // The shared chase wording does not know "how long should I wait"; the situation does, the wording of the live reply does not move.
    if (subtype === "return.rejected" && WAIT_QUESTION.test(msg)) { subtype = "return.rejected.chasing"; signals.push("waiting_question"); }
  } else {
    subtype = describe();
  }

  /** No rule covers this turn: say what it is from the facts, so the model's answer has a type to be judged against. */
  function describe(): string {
    const cancellable = scoped.some((o) => cancellationAllowedInWindow({ status: o.status as never, awb_code: o.awb_code ?? undefined, created_at: o.created_at }, now).ok);
    if (cancelIntent && cancellable) return "cancel.possible";
    if (cancelIntent && scoped.length === 0) return "cancel.unscoped";
    if (signals.includes("intent.refund")) {
      const rec = subject ? facts.some((f) => f.startsWith("refund.record=") && !f.endsWith("=none")) : hasRefundRecord;
      return rec ? "refund.chase.record" : "refund.chase.no_record";
    }
    if (signals.includes("address_change")) return cancellable || scoped.some((o) => !SETTLED.has(o.status)) ? "address.change.possible" : "address.change.settled";
    if (signals.includes("fault") || signals.includes("intent.return")) {
      return scoped.some((o) => o.status === "delivered") ? "return.fault_report" : "return.fault_report.not_delivered";
    }
    const overdue = scoped.some((o) => isOverdue(o as never, now));
    const botSaidLate = ["flag", "late_first", "late_insist"].includes(lastBotKind(last)) || (!!i.openCase && /with the team|support case|raised/i.test(last ?? ""));
    if (overdue && (signals.includes("late_words") || threadLate || botSaidLate)) return "delivery.late.followup";
    if (scoped.some((o) => IN_FLIGHT_STATUS.test(o.status)) && (signals.includes("status_words") || threadLate)) return "delivery.status";
    if (scoped.some((o) => o.status === "delivered") && signals.includes("status_words")) return "delivery.delivered_query";
    if (wordCount(msg) <= 4) return "other.fragment";
    return "other.unclassified";
  }

  return {
    v: SITUATION_VERSION,
    subtype,
    family: subtype.split(".")[0] as Family,
    rule,
    also: handler === "none" && primary ? [primary.rule, ...also] : also,
    handler: handler ?? (rule ? "code" : "model"),
    subject: { order: subject?.id ?? null, basis: scope.basis, orders: scoped.length },
    facts,
    signals,
  };
}

// ── comparing the code's reading with what actually went out ──────────────────────────────────────────────────────────────────

export type Agreement =
  | "same"             // the rule the situation names is the one that fired
  | "model_both"       // no rule here and none fired: the model's text went out (or the flag line)
  | "rule_suppressed"  // a rule covers this turn without the tag, but the model's text went out — the tag (or all-orders scope) stopped it
  | "rule_needs_tag"   // an override fired that the situation does not name — it needed the model's tag, or read the wrong orders
  | "conflict"         // a different rule fired than the one the situation names
  | "reply_to_ack";    // the turn asks for nothing, and something was sent anyway

/**
 * `actual` is the decision's meta.fixedReply (the rule that wrote the text), or null when the model's text (or the flag line) went out.
 * `return_and_late` counts as the return rule firing together with the late rule.
 */
export function compareToActual(s: Pick<Situation, "rule" | "also"> & { handler?: Situation["handler"] }, actual: string | null, held = false): Agreement {
  if (s.handler === "none") return held ? "same" : "reply_to_ack";
  const actualRules = actual === "return_and_late" ? ["return_state", "late_first"] : actual ? [actual] : [];
  if (!s.rule && !actualRules.length) return "model_both";
  if (!s.rule) return "rule_needs_tag";
  if (!actualRules.length) return "rule_suppressed";
  if (actualRules.includes(s.rule)) return "same";
  if (s.also.some((r) => actualRules.includes(r))) return "same";
  return "conflict";
}

/** For tests and reports: is a subtype in the closed vocabulary's shape (family.detail)? */
export const isSubtype = (s: string): boolean => /^[a-z_]+(\.[a-z_]+)+$/.test(s);
