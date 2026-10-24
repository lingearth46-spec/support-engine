// Check a built reply mechanically before it can be sent.
//
// Phase 4 of the support-pipeline plan. A built reply (lib/replyBuilder.ts) is either an approved fixed line, byte for byte, or a
// template filled from the record. This verifies both claims without a model:
//   · fixed text must BE one of the approved lines (a drifted copy is a violation);
//   · anything else goes through the same mechanical gate the model's text goes through (lib/replyGrounding.ts): every amount, order
//     id, date, link, email and phone number must be in the evidence, and no refund / replacement offer, reply-time or delivery
//     promise, callback or refusal advice may appear;
//   · an action promise, or a wait with nothing open, is caught by kind (lib/replyClaims.ts);
//   · wording the founder has not approved is flagged, so it cannot be sent by accident.
// Evidence is the business truths plus the customer's own order lines as the bot reads them (formatOrders) — nothing else.
// Pure: no model, no database.

import { groundingViolations } from "@/lib/replyGrounding";
import { teamHasItOpen, unsupportedByKind } from "@/lib/replyClaims";
import { BUSINESS_TRUTHS, FLAG_REPLY, LEGACY_FLAG_REPLY } from "@/lib/businessTruths";
import { formatOrders, type OrderRow, type RefundLine } from "@/lib/orderLines";
import { GREETING_REPLY } from "@/lib/lookupReply";
import { LANGUAGE_REPLY, PAY_LINK_REPLY, AMBIGUOUS_REPLY } from "@/lib/clarifyReplies";
import {
  PENDING_REPLY, CHASING_REPLY, RETURN_PAGE_REPLY, WINDOW_CLOSED_EMAIL_REPLY, NO_RETURN_EMAIL_REPLY, EXCHANGE_EMAIL_REPLY,
  APPROVED_APPEAL_REPLY, CANCEL_RETURN_REPLY, CHASING_AGAIN_REPLY,
} from "@/lib/returnStateReply";
import { CANCEL_REPLY, CANCEL_TOO_OLD_REPLY, CANCEL_INSIST_REPLY } from "@/lib/cancelStateReply";
import { LATE_REPLY, LATE_INSIST_REPLY, LATE_INSIST_TRACK_REPLY, LEGACY_LATE_REPLY, LEGACY_LATE_INSIST_REPLY, PREVIOUS_LATE_INSIST_REPLY } from "@/lib/lateDeliveryReply";
import { LATE_REASSURE, COURIER_BLAME, LATE_EFFORT } from "@/lib/lateReassurance";
import {
  QUALITY_REPLY, CARE_REPLY, COMPLAINT_EMAIL_REPLY, PHOTOS_REPLY, WARRANTY_REPLY, SIZE_REPLY, SIZE_INSIST_REPLY, NO_STORE_REPLY, DISCOUNT_REPLY, ADDRESS_FLAG_REPLY, ADDRESS_ASK_REPLY, LEGACY_ADDRESS_FLAG_REPLY, PHONE_GIVEN_REPLY,
} from "@/lib/topicReplies";
import type { BuiltReply } from "@/lib/replyBuilder";
import { STRATEGIES } from "@/lib/strategyCatalogue";

/** The approved fixed lines. A reply whose source is "fixed" must equal one of these (or be built from a rule module's own template). */
export const FIXED_TEXTS: ReadonlySet<string> = new Set([
  GREETING_REPLY, LANGUAGE_REPLY, PAY_LINK_REPLY, AMBIGUOUS_REPLY, FLAG_REPLY,
  PENDING_REPLY, CHASING_REPLY, RETURN_PAGE_REPLY, WINDOW_CLOSED_EMAIL_REPLY, NO_RETURN_EMAIL_REPLY, EXCHANGE_EMAIL_REPLY,
  APPROVED_APPEAL_REPLY, CANCEL_RETURN_REPLY, CHASING_AGAIN_REPLY, CANCEL_REPLY, CANCEL_TOO_OLD_REPLY, CANCEL_INSIST_REPLY, LATE_REPLY, LATE_INSIST_REPLY, LATE_INSIST_TRACK_REPLY,
  QUALITY_REPLY, CARE_REPLY, COMPLAINT_EMAIL_REPLY, PHOTOS_REPLY, WARRANTY_REPLY, SIZE_REPLY, SIZE_INSIST_REPLY, NO_STORE_REPLY, DISCOUNT_REPLY,
  // 14 Oct: the address line is its own sentence now, and the old lines are still recognised wherever an earlier reply is read back.
  ADDRESS_FLAG_REPLY, ADDRESS_ASK_REPLY, LEGACY_ADDRESS_FLAG_REPLY, PHONE_GIVEN_REPLY, LEGACY_FLAG_REPLY, LEGACY_LATE_REPLY, LEGACY_LATE_INSIST_REPLY, PREVIOUS_LATE_INSIST_REPLY,
  // 18 Oct: the reassurance every late-parcel reply carries (lib/lateReassurance.ts). Approved wording, added by code: not a claim for the verifier or the ruler to judge.
  LATE_REASSURE, COURIER_BLAME, LATE_EFFORT,
]);

export interface BuiltViolation { rule: string; detail: string }
export interface BuiltCheck {
  ok: boolean;
  /** Grounding / policy violations: the text must not be sent. */
  violations: BuiltViolation[];
  /** True when the text is an approved fixed line, verbatim. */
  fixedVerbatim: boolean;
  /** The strategy's wording is still a draft. Not a content violation, but the reply must not go to a customer. */
  unapproved: boolean;
}

export interface ValidateInput {
  built: Pick<BuiltReply, "text" | "source" | "strategy" | "approved" | "refs">;
  orders: OrderRow[];
  refunds?: Map<string, RefundLine>;
  message: string;
  history?: string[];
  /** Extra evidence lines (for example the catalogue lines for a product answer). */
  evidence?: string[];
}

export function validateBuilt(i: ValidateInput): BuiltCheck {
  const text = i.built.text;
  const unapproved = !i.built.approved || !STRATEGIES[i.built.strategy].approved;
  if (!text) return { ok: true, violations: [], fixedVerbatim: false, unapproved };
  const verbatim = FIXED_TEXTS.has(text);
  const violations: BuiltViolation[] = [];

  if (i.built.source === "fixed" && !verbatim && !i.built.refs.some((r) => r.startsWith("topic:") || r === "rejectedReply")) {
    violations.push({ rule: "fixed_text_drifted", detail: text.slice(0, 80) });
  }
  if (!verbatim) {
    const record = formatOrders(i.orders, true, true, true, i.refunds, new Map());
    const evidence = [BUSINESS_TRUTHS, record, ...(i.evidence ?? [])];
    const context = [i.message, ...(i.history ?? [])];
    for (const v of groundingViolations(text, evidence, context)) violations.push({ rule: v.rule, detail: v.detail });
    const openCase = teamHasItOpen(evidence);
    for (const claim of unsupportedByKind(text, { openCase, evidence })) violations.push({ rule: "unsupported_by_kind", detail: claim.slice(0, 80) });
  }
  return { ok: violations.length === 0, violations, fixedVerbatim: verbatim, unapproved };
}
