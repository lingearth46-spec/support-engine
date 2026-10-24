// The closed list of things the support bot may DO about a customer message — the catalogue.
//
// Phase 3 of the support-pipeline plan. Today the model is handed everything and left to decide what to say, and a rule module then
// patches the result. Here the decision is made on its own, from a closed list: the code has already named the situation
// (lib/situation.ts); this file says which strategies may answer a situation, what each one needs to be true before it is used, which
// business rules bind it, and where its text comes from. A selector (lib/strategySelector.ts) chooses among the candidates when the
// situation is not already decided by a rule; the choice is validated against the preconditions here, and anything that does not
// validate becomes a clarifying question or a hand-off, never free text.
//
// Nothing here writes a customer-facing sentence. `text` names where the sentence comes from (an existing fixed constant, a template
// to be built from facts in Phase 4, an order action, or silence). Wording that does not exist yet is marked `approved: false`.
// Pure and data-only, so it is unit-tested end to end. Used in shadow and in the offline harness only; the live path does not read it.

import type { Situation } from "@/lib/situation";

export const CATALOGUE_VERSION = 1;

export type StrategyId =
  | "greet" | "lookup_order" | "explain_language" | "point_to_payment" | "ask_clarify"
  | "state_cancelled" | "refuse_cancel" | "cancel_order"
  | "return_state" | "topic_answer" | "late_reassure" | "status_update" | "refund_status"
  | "collect_address" | "flag_address_change" | "stay_quiet" | "hand_off_team";

/** The business rules a strategy's reply is bound by. Each is a standing rule from the founder's policy (see lib/businessTruths.ts). */
export const RULES = {
  RECORD_ONLY: "State only what the order record, the catalogue or the business truths say.",
  NO_REFUND_PROMISE: "Never promise or offer a refund, replacement, exchange or discount.",
  NO_TIME_PROMISE: "Never promise a reply time, a callback or a delivery date of your own. A timeline the record itself states (a refund's working days, an expected-around date) may be repeated as the record gives it.",
  NO_ACTION_CLAIM: "Never say something was done unless an action actually ran.",
  SENIOR_EMAIL: "Anything that needs a person's judgement goes to the Senior Support Team by email.",
  LANGUAGE: "Reply in English or Hinglish only.",
  NO_POST_DISPATCH_CANCEL: "An order cannot be cancelled once dispatched.",
  ONE_ESCALATION: "When the team already has a case open, do not open a second one.",
} as const;
export type RuleId = keyof typeof RULES;

export type TextSource =
  | { kind: "fixed"; ref: string }      // an existing fixed constant, by name
  | { kind: "template"; ref: string }   // built in code from the selected facts (Phase 4)
  | { kind: "action" }                  // the reply is the outcome of an order action (lib/supportActionRun.ts)
  | { kind: "none" };                   // nothing is sent

export interface Precondition { id: string; ok: (s: Situation) => boolean }

export interface Strategy {
  id: StrategyId;
  /** One line for the selector: when this is the right thing to do. */
  when: string;
  /** Situation subtypes it may answer: exact (`cancel.dispatched`) or a family wildcard (`topic.*`). */
  for: string[];
  text: TextSource;
  /** What must be true of the facts before it may be used. A selection that fails one is rejected. */
  requires: Precondition[];
  /**
   * Also a candidate when this holds, whatever the situation's subtype. The subtype is the code's single best reading; a clear signal
   * in the message (a money word, a cancel word, an address) is a second reading the selector should be able to choose. Without it a
   * wrongly-primary rule (10 Oct: "where is my money" read as a late parcel) would leave the selector choosing among wrong options.
   */
  alsoWhen?: (s: Situation) => boolean;
  rules: RuleId[];
  /** The reply also flags the team (a real escalation: case + ping). */
  escalates: boolean;
  /** The founder has approved the wording (false = a draft that must not be sent). */
  approved: boolean;
}

const has = (s: Situation, fact: string) => s.facts.includes(fact);
const hasPrefix = (s: Situation, prefix: string) => s.facts.some((f) => f.startsWith(prefix));
const sig = (s: Situation, name: string) => s.signals.includes(name);
const status = (s: Situation) => s.facts.find((f) => f.startsWith("order.status="))?.slice("order.status=".length) ?? null;
const hasOrder = (s: Situation) => status(s) !== null;

const req = (id: string, ok: (s: Situation) => boolean): Precondition => ({ id, ok });

export const STRATEGIES: Record<StrategyId, Strategy> = {
  greet: {
    id: "greet", when: "A bare greeting with nothing else in it.", for: ["greeting.*"],
    text: { kind: "fixed", ref: "GREETING_REPLY" }, requires: [], rules: [], escalates: false, approved: true,
  },
  lookup_order: {
    id: "lookup_order", when: "A bare order id or phone number: say where that order stands, from the record.", for: ["lookup.*"],
    text: { kind: "template", ref: "orderLookupReply" }, requires: [], rules: ["RECORD_ONLY", "NO_TIME_PROMISE"], escalates: false, approved: true,
  },
  explain_language: {
    id: "explain_language", when: "They ask whether we speak a language other than English or Hinglish.", for: ["language.unsupported"],
    text: { kind: "fixed", ref: "LANGUAGE_REPLY" }, requires: [], rules: ["LANGUAGE"], escalates: false, approved: true,
  },
  point_to_payment: {
    id: "point_to_payment", when: "They answer our prepaid-only payment message with 'confirm' / 'yes': point back to the payment button.", for: ["payment.confirm_prepaid"],
    text: { kind: "fixed", ref: "PAY_LINK_REPLY" }, requires: [req("payment_prompt_before", (s) => s.subtype === "payment.confirm_prepaid")],
    rules: ["RECORD_ONLY"], escalates: false, approved: true,
  },
  ask_clarify: {
    id: "ask_clarify", when: "The message is a fragment or too unclear to act on: ask what they need, offer the order id.", for: ["fragment.*", "other.fragment", "other.unclassified", "cancel.unscoped"],
    text: { kind: "fixed", ref: "AMBIGUOUS_REPLY" }, requires: [], rules: [], escalates: false, approved: true,
  },
  state_cancelled: {
    id: "state_cancelled", when: "They ask to cancel / say they do not want an order that is already cancelled: say it is already cancelled, nothing more.", for: ["cancel.already_cancelled"],
    text: { kind: "template", ref: "alreadyCancelledReply" },
    requires: [req("order_is_cancelled", (s) => ["cancelled", "wa_cancelled"].includes(status(s) ?? ""))],
    rules: ["RECORD_ONLY", "NO_REFUND_PROMISE"], escalates: false, approved: true,
  },
  refuse_cancel: {
    id: "refuse_cancel", when: "They ask to cancel an order that has been dispatched or is past the 24-hour window.", for: ["cancel.dispatched", "cancel.too_old", "cancel.insist"],
    text: { kind: "fixed", ref: "CANCEL_REPLY | CANCEL_TOO_OLD_REPLY | CANCEL_INSIST_REPLY" },
    requires: [req("cannot_cancel", (s) => hasPrefix(s, "order.cancellable=no") || s.subtype.startsWith("cancel."))],
    rules: ["NO_POST_DISPATCH_CANCEL", "SENIOR_EMAIL"], escalates: false, approved: true,
  },
  cancel_order: {
    id: "cancel_order", when: "They ask to cancel an order that can still be cancelled: the system cancels it, then confirms.", for: ["cancel.possible"],
    text: { kind: "action" },
    requires: [req("order_cancellable", (s) => has(s, "order.cancellable=yes")), req("asked_to_cancel", (s) => sig(s, "intent.cancel"))],
    alsoWhen: (s) => sig(s, "intent.cancel") && has(s, "order.cancellable=yes"),
    rules: ["NO_ACTION_CLAIM"], escalates: false, approved: true,
  },
  return_state: {
    id: "return_state", when: "A return, exchange or fault on a delivered order: state where the return stands, or send them to the returns page / senior support.", for: ["return.pending", "return.rejected", "return.rejected.*", "return.none.*", "return.approved.*", "return.cancel_request", "return.other", "return.fault_report", "exchange.*"],
    text: { kind: "fixed", ref: "PENDING_REPLY | CHASING_REPLY | CHASING_AGAIN_REPLY | RETURN_PAGE_REPLY | WINDOW_CLOSED_EMAIL_REPLY | NO_RETURN_EMAIL_REPLY | EXCHANGE_EMAIL_REPLY | rejectedReply | APPROVED_APPEAL_REPLY | CANCEL_RETURN_REPLY" },
    requires: [], rules: ["NO_REFUND_PROMISE", "SENIOR_EMAIL", "RECORD_ONLY"], escalates: false, approved: true,
  },
  topic_answer: {
    id: "topic_answer", when: "A product or policy question with a standing answer: size, quality, care, warranty, photos, no store, discount, complaint by email.", for: ["topic.*"],
    text: { kind: "fixed", ref: "SIZE_REPLY | QUALITY_REPLY | CARE_REPLY | WARRANTY_REPLY | PHOTOS_REPLY | NO_STORE_REPLY | DISCOUNT_REPLY | COMPLAINT_EMAIL_REPLY" },
    requires: [], rules: ["NO_REFUND_PROMISE", "SENIOR_EMAIL"], escalates: false, approved: true,
  },
  late_reassure: {
    id: "late_reassure", when: "A parcel that is overdue: flag it to the team the first time; after that say the team is already on it, no need to worry.", for: ["delivery.late.*"],
    text: { kind: "fixed", ref: "LATE_REPLY | LATE_INSIST_TRACK_REPLY" },
    requires: [req("order_overdue_or_case_open", (s) => has(s, "order.overdue=yes") || has(s, "case.open=yes"))],
    rules: ["NO_TIME_PROMISE", "ONE_ESCALATION", "RECORD_ONLY"], escalates: true, approved: true,
  },
  status_update: {
    id: "status_update", when: "They ask where an in-flight or delivered order is: state its status, dates and tracking link from the record.", for: ["delivery.status", "delivery.delivered_query", "delivery.late.followup", "return.fault_report.not_delivered", "other.unclassified"],
    text: { kind: "template", ref: "orderStatusLine" },
    requires: [req("subject_order_known", hasOrder)], rules: ["RECORD_ONLY", "NO_TIME_PROMISE"], escalates: false, approved: true,
  },
  refund_status: {
    id: "refund_status", when: "They ask about a refund: state the refund on record if there is one; if there is none, send them to the Senior Support Team by email.", for: ["refund.chase.record", "refund.chase.no_record"],
    text: { kind: "template", ref: "refundLine | refundNoRecordEmail" },
    requires: [req("asked_about_refund", (s) => sig(s, "intent.refund"))],
    alsoWhen: (s) => sig(s, "intent.refund"),
    rules: ["RECORD_ONLY", "NO_REFUND_PROMISE", "NO_TIME_PROMISE", "SENIOR_EMAIL"], escalates: false, approved: true,
  },
  collect_address: {
    id: "collect_address", when: "They want to change the delivery address on an order that has not been dispatched: ask for the new full address with pincode.", for: ["address.change.possible"],
    text: { kind: "template", ref: "askNewAddress" },
    requires: [req("address_change_asked", (s) => sig(s, "address_change")), req("order_not_dispatched", (s) => !hasPrefix(s, "order.cancellable=no:booked"))],
    alsoWhen: (s) => sig(s, "address_change") && !hasPrefix(s, "order.cancellable=no:booked"),
    rules: ["NO_ACTION_CLAIM"], escalates: false, approved: true,
  },
  flag_address_change: {
    id: "flag_address_change", when: "They want to change the address on an order that is already with the courier: flag it to the team.", for: ["address.change.dispatched", "address.change.settled"],
    text: { kind: "fixed", ref: "ADDRESS_FLAG_REPLY" }, requires: [], rules: ["NO_ACTION_CLAIM", "NO_TIME_PROMISE"], escalates: true, approved: true,
  },
  stay_quiet: {
    id: "stay_quiet", when: "An acknowledgement or relayed information that asks for nothing: send nothing.", for: ["other.ack"],
    text: { kind: "none" }, requires: [req("is_ack", (s) => s.subtype === "other.ack")], rules: [], escalates: false, approved: true,
  },
  hand_off_team: {
    id: "hand_off_team", when: "Nothing above is safely supported by the facts: say it is flagged to the team.", for: ["*"],
    text: { kind: "fixed", ref: "FLAG_REPLY" }, requires: [], rules: ["NO_TIME_PROMISE", "ONE_ESCALATION"], escalates: true, approved: true,
  },
};

export const STRATEGY_IDS = Object.keys(STRATEGIES) as StrategyId[];

const matches = (pattern: string, subtype: string): boolean =>
  pattern === "*" || pattern === subtype || (pattern.endsWith(".*") && subtype.startsWith(pattern.slice(0, -1)));

/**
 * Strategies that may answer this situation, most specific first, `hand_off_team` always last (the safe exit). A strategy whose
 * preconditions do not hold is not a candidate.
 */
export function candidatesFor(s: Situation): StrategyId[] {
  const out = STRATEGY_IDS.filter((id) => id !== "hand_off_team"
    && (STRATEGIES[id].for.some((p) => matches(p, s.subtype)) || STRATEGIES[id].alsoWhen?.(s) === true)
    && failedPrecondition(id, s) === null);
  return [...out, "hand_off_team"];
}

/** The first precondition of `id` that does not hold for this situation, or null. */
export function failedPrecondition(id: StrategyId, s: Situation): string | null {
  for (const p of STRATEGIES[id].requires) if (!p.ok(s)) return p.id;
  return null;
}

/**
 * Is the strategy already decided by code? True when a fixed rule covers the situation (or nothing needs saying) and exactly one
 * strategy answers it. Then no model is asked.
 */
export function decidedByCode(s: Situation): StrategyId | null {
  if (s.handler === "model") return null;
  const c = candidatesFor(s).filter((id) => id !== "hand_off_team");
  return c.length === 1 ? c[0] : null;
}

/** What to do when a selection cannot be used: a question where the message is unclear, otherwise the hand-off. */
export function fallbackFor(s: Situation): StrategyId {
  return candidatesFor(s).includes("ask_clarify") ? "ask_clarify" : "hand_off_team";
}

export const ruleIdsFor = (id: StrategyId): RuleId[] => STRATEGIES[id].rules;
