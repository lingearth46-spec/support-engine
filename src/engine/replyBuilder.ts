// Build the customer-facing text for a chosen strategy — in code, from the facts, with no model writing a word.
//
// Phase 4 of the support-pipeline plan. The selector (lib/strategySelector.ts) says WHAT to do; this says it. Every strategy's text
// comes from one of three places:
//   · an existing fixed constant (the lines the rule modules already send, worded and approved);
//   · a template filled from the order record and the situation's facts (an order id, a status phrase, a refund amount and date);
//   · nothing (stay quiet), or an order action whose outcome is the reply (the live action path owns that text).
// So a built reply can only contain what the record and the approved lines contain. validateBuilt (lib/replyValidate.ts) checks that
// again mechanically before anything is sent.
//
// A strategy whose wording the founder has not approved (`approved: false` in the catalogue) is built so it can be reviewed and
// measured, and comes back flagged `approved: false`: a caller must not send it. Pure: no clock except `now`, no database, no model.

import { GREETING_REPLY, orderLookupReply, orderStatusLine, type LookupOrder } from "@engine/lookupReply";
import { LANGUAGE_REPLY, PAY_LINK_REPLY, AMBIGUOUS_REPLY } from "@engine/clarifyReplies";
import {
  PENDING_REPLY, CHASING_REPLY, RETURN_PAGE_REPLY, WINDOW_CLOSED_EMAIL_REPLY, NO_RETURN_EMAIL_REPLY, EXCHANGE_EMAIL_REPLY,
  APPROVED_APPEAL_REPLY, CANCEL_RETURN_REPLY, CHASING_AGAIN_REPLY, SENIOR_SUPPORT_EMAIL, rejectedReply,
} from "@engine/returnStateReply";
import { CANCEL_REPLY, CANCEL_TOO_OLD_REPLY, CANCEL_INSIST_REPLY } from "@engine/cancelStateReply";
import { LATE_REPLY, LATE_INSIST_TRACK_REPLY, lateFirstText, isOverdue } from "@engine/lateDeliveryReply";
import { topicReply, ADDRESS_FLAG_REPLY } from "@engine/topicReplies";
import { scopeOrders } from "@engine/orderScope";
import { FLAG_REPLY } from "@policy/businessTruths";
import { STRATEGIES, type StrategyId } from "@policy/strategyCatalogue";
import type { Situation, SituationOrder } from "@engine/situation";
import { day } from "@engine/orderLines";

export const BUILDER_VERSION = 1;

export interface BuildContext {
  message: string;
  recent: { direction: "in" | "out"; body: string }[];
  own: SituationOrder[];
  mentioned?: SituationOrder[];
  senderPhone?: string;
  lastBotReply?: string | null;
  now?: number;
}

export interface BuiltReply {
  ok: boolean;
  strategy: StrategyId;
  /** null when nothing is to be sent (stay quiet, an order action) or the reply could not be built. */
  text: string | null;
  /** What the handler should do with it. */
  action: "reply" | "escalate" | "none" | "model_action";
  escalates: boolean;
  /** The wording is approved. A caller must not send an unapproved one. */
  approved: boolean;
  source: "fixed" | "template" | "none" | "action";
  /** Which constants / templates / facts the text rests on, for the trace. */
  refs: string[];
  /** Why it could not be built, or what was missing. */
  reason?: string;
}

const fact = (s: Situation, key: string): string | null => {
  const f = s.facts.find((x) => x.startsWith(`${key}=`));
  return f ? f.slice(key.length + 1) : null;
};
const hasFact = (s: Situation, f: string) => s.facts.includes(f);

/** What each refund state on record may be called to a customer. The ones that need a person are not here: they hand off. */
const REFUND_IN_PROGRESS = new Set(["REFUND_ELIGIBLE", "REFUND_REQUESTED", "REFUND_PROCESSING"]);

function ok(strategy: StrategyId, text: string, source: "fixed" | "template", refs: string[], escalates = false): BuiltReply {
  return { ok: true, strategy, text, action: escalates ? "escalate" : "reply", escalates, approved: STRATEGIES[strategy].approved, source, refs };
}
const fail = (strategy: StrategyId, reason: string): BuiltReply =>
  ({ ok: false, strategy, text: null, action: "none", escalates: false, approved: STRATEGIES[strategy].approved, source: "none", refs: [], reason });

export function buildReply(strategy: StrategyId, s: Situation, c: BuildContext): BuiltReply {
  const now = c.now ?? Date.now();
  const msg = c.message.replace(/[‘’]/g, "'");
  const scope = scopeOrders({ message: msg, recent: c.recent, own: c.own, mentioned: c.mentioned });
  const subject = scope.orders.length === 1 ? scope.orders[0] : null;
  const subjectId = s.subject.order ?? subject?.id ?? null;

  switch (strategy) {
    case "greet": return ok(strategy, GREETING_REPLY, "fixed", ["GREETING_REPLY"]);
    case "explain_language": return ok(strategy, LANGUAGE_REPLY, "fixed", ["LANGUAGE_REPLY"]);
    case "point_to_payment": return ok(strategy, PAY_LINK_REPLY, "fixed", ["PAY_LINK_REPLY"]);
    case "ask_clarify": return ok(strategy, AMBIGUOUS_REPLY, "fixed", ["AMBIGUOUS_REPLY"]);
    case "hand_off_team": return ok(strategy, FLAG_REPLY, "fixed", ["FLAG_REPLY"], true);
    case "flag_address_change": return ok(strategy, ADDRESS_FLAG_REPLY, "fixed", ["ADDRESS_FLAG_REPLY"], true);

    case "stay_quiet":
      return { ok: true, strategy, text: null, action: "none", escalates: false, approved: true, source: "none", refs: [] };
    case "cancel_order":
      // The reply is the outcome of the action the system carries out (lib/supportActionRun.ts), not a sentence built here.
      return { ok: true, strategy, text: null, action: "model_action", escalates: false, approved: true, source: "action", refs: ["supportActionRun"] };

    case "state_cancelled": {
      if (!subjectId || !["cancelled", "wa_cancelled"].includes(fact(s, "order.status") ?? "")) return fail(strategy, "no_cancelled_order");
      return ok(strategy, `Your order #${subjectId} is already cancelled.`, "template", [`order=${subjectId}`, `order.status=${fact(s, "order.status")}`]);
    }

    case "refuse_cancel": {
      const lastBot = fact(s, "last_bot");
      if (lastBot === "cancel_dispatched" || lastBot === "cancel_too_old" || s.subtype === "cancel.insist") return ok(strategy, CANCEL_INSIST_REPLY, "fixed", ["CANCEL_INSIST_REPLY"]);
      if (s.subtype === "cancel.too_old" || hasFact(s, "order.cancellable=no:too_old")) return ok(strategy, CANCEL_TOO_OLD_REPLY, "fixed", ["CANCEL_TOO_OLD_REPLY"]);
      if (s.subtype === "cancel.dispatched" || hasFact(s, "order.cancellable=no:booked")) return ok(strategy, CANCEL_REPLY, "fixed", ["CANCEL_REPLY"]);
      return fail(strategy, "cancellation_not_refused_by_the_record");
    }

    case "return_state": {
      const map: Record<string, [string, string]> = {
        "return.pending": [PENDING_REPLY, "PENDING_REPLY"],
        "return.rejected.chasing": [CHASING_REPLY, "CHASING_REPLY"],
        "return.none.window_open": [RETURN_PAGE_REPLY, "RETURN_PAGE_REPLY"],
        "return.none.window_closed": [WINDOW_CLOSED_EMAIL_REPLY, "WINDOW_CLOSED_EMAIL_REPLY"],
        "return.none.insist": [NO_RETURN_EMAIL_REPLY, "NO_RETURN_EMAIL_REPLY"],
        "exchange.email": [EXCHANGE_EMAIL_REPLY, "EXCHANGE_EMAIL_REPLY"],
        "return.approved.appeal": [APPROVED_APPEAL_REPLY, "APPROVED_APPEAL_REPLY"],
        "return.cancel_request": [CANCEL_RETURN_REPLY, "CANCEL_RETURN_REPLY"],
      };
      // Chasing again after we already said "please wait for their reply": the second line, not the same sentence (founder, 11 Oct).
      if (s.subtype === "return.rejected.chasing" && (c.lastBotReply ?? "").startsWith(CHASING_REPLY.slice(0, 40))) {
        return ok(strategy, CHASING_AGAIN_REPLY, "fixed", ["CHASING_AGAIN_REPLY"]);
      }
      const hit = map[s.subtype];
      if (hit) return ok(strategy, hit[0], "fixed", [hit[1]]);
      if (s.subtype === "return.rejected") {
        const rr = (subject ?? c.own.find((o) => o.return_request?.status === "rejected"))?.return_request;
        return ok(strategy, rejectedReply(rr?.resolved_at), "fixed", ["rejectedReply"]);
      }
      // A fault on a delivered order with nothing filed and no rule matched: the same routing the return rule gives.
      if (s.subtype === "return.fault_report" && fact(s, "order.status") === "delivered") {
        return hasFact(s, "return.window=closed")
          ? ok(strategy, WINDOW_CLOSED_EMAIL_REPLY, "fixed", ["WINDOW_CLOSED_EMAIL_REPLY"])
          : ok(strategy, RETURN_PAGE_REPLY, "fixed", ["RETURN_PAGE_REPLY"]);
      }
      return fail(strategy, `no_return_line_for:${s.subtype}`);
    }

    case "topic_answer": {
      const t = topicReply({ message: msg, tag: "unknown", ownOrders: scope.orders, lastBotReply: c.lastBotReply ?? null, v2: true });
      if (!t) return fail(strategy, "no_topic_line");
      return ok(strategy, t.text, "fixed", [`topic:${t.kind}`], t.escalate);
    }

    case "lookup_order": {
      const l = orderLookupReply({ message: msg, senderPhone: c.senderPhone ?? "", ownOrders: c.own as unknown as LookupOrder[], mentionedOrders: (c.mentioned ?? []) as unknown as LookupOrder[], now });
      if (!l) return fail(strategy, "not_a_bare_lookup");
      return ok(strategy, l.text, "template", ["orderLookupReply"], l.escalate);
    }

    case "late_reassure": {
      // The first time it is a flag to the team; once they have been told (our last line was the flag, or a case is open) it is the
      // fixed "already on it" line — the founder's decision of 11 Oct (E1).
      const told = ["flag", "late_first", "late_insist"].includes(fact(s, "last_bot") ?? "") || hasFact(s, "case.open=yes");
      const late = (subject ? [subject] : c.own).find((o) => isOverdue({ id: o.id, status: o.status, estimated_delivery: o.estimated_delivery }, now));
      return told ? ok(strategy, LATE_INSIST_TRACK_REPLY, "fixed", ["LATE_INSIST_TRACK_REPLY"], true)
        : ok(strategy, late ? lateFirstText({ id: late.id, status: late.status, estimated_delivery: late.estimated_delivery }) : LATE_REPLY, "template", ["lateFirstText"], true);
    }

    // ── DRAFT wording: built for review and measurement, not to be sent until approved ─────────────────────────────────────
    case "status_update": {
      const o = subject ?? (subjectId ? [...c.own, ...(c.mentioned ?? [])].find((x) => x.id === subjectId) : null);
      if (!o) return fail(strategy, "no_subject_order");
      const line = orderStatusLine(o as unknown as LookupOrder, now);
      const team = hasFact(s, "case.open=yes") ? "\n\nIt is already with the team." : "";
      return ok(strategy, `${line}${team}`, "template", [`order=${o.id}`, `order.status=${o.status}`, ...(team ? ["case.open=yes"] : [])]);
    }

    case "refund_status": {
      if (!subjectId) return fail(strategy, "no_subject_order");
      const rec = fact(s, "refund.record");
      if (!rec || rec === "none") {
        return ok(strategy, `I can't see a refund on record for order #${subjectId}. Please email our Senior Support Team at ${SENIOR_SUPPORT_EMAIL} with your order number so they can check this.`,
          "template", [`order=${subjectId}`, "refund.record=none", "SENIOR_SUPPORT_EMAIL"]);
      }
      const amount = fact(s, "refund.amount"), since = fact(s, "refund.since");
      if (!amount) return fail(strategy, "refund_amount_unknown");
      if (rec === "REFUND_COMPLETED") return fail(strategy, "completed_refund_needs_processed_date");
      if (!REFUND_IN_PROGRESS.has(rec)) return fail(strategy, `refund_state_needs_a_person:${rec}`);
      const started = since ? `, started on ${day(since)}` : "";
      return ok(strategy, `Your refund of ₹${amount} for order #${subjectId} is in progress${started}.`, "template",
        [`order=${subjectId}`, `refund.record=${rec}`, `refund.amount=${amount}`, ...(since ? [`refund.since=${since}`] : [])]);
    }

    case "collect_address":
      return ok(strategy, "Please send the new full address, including the pincode.", "template", ["address_change"]);
  }
}
