// Who decides that a person must look at this? Code does, from what the customer said and what the record shows — not the model.
//
// Phase 6b found that when the model owns the hand-off flag, it flips between draws of the same turn (20–31% of turns) even when the text it
// writes is nearly identical, and the reason it picks ("complaint about handling", "refund decision") is close to arbitrary. The reply TEXT is
// what a model is good at; whether to open a case and ping the team is a policy, and the policy already has inputs the code can read:
//   · the escalation keyword list (legal / chargeback / fraud language — never for a model to answer);
//   · a fault, return or refund-decision request in the customer's latest message;
//   · whether the team ALREADY has it open (the record says so, and says "do NOT open a second escalation");
//   · the model's own admission that the facts do not contain the answer (the one thing only the model can know).
// Pure. Used by the experiment harness; the live handler does not call it.

import { DEFAULT_ESCALATE_KEYWORDS, matchEscalateKeyword, hasReturnIntent, hasRefundIntent } from "@engine/supportGuardrails";
import { FAULT } from "@engine/returnStateReply";
import { teamHasItOpen } from "@engine/replyClaims";

export type HandoffSource = "keyword" | "fault_no_case" | "refund_decision_no_case" | "model_cannot_answer" | "none";

export interface HandoffDecision {
  handOff: boolean;
  source: HandoffSource;
  /** True when the team already has something open: a hand-off is then "it is with the team", never a second case. */
  alreadyOpen: boolean;
}

/** Asking where a refund stands, not asking for one. */
const REFUND_STATUS_QUESTION = /\b(?:status|updates?|received|receive|when|kab|how (?:long|much (?:more )?time)|still|yet|pending|processed|credited|credit|completed|showing|any news|not (?:come|came|reflect\w*)|days?|weeks?|ago|been)\b/i;
/** The record holds the refund and says where it is: completed, or in progress. ("needs the team" is not here: that one is for a person.) */
const REFUND_ON_RECORD = /refund:\s*₹\s?\d[^\n]{0,30}\b(?:completed|in progress)\b/i;

export function decideHandoff(i: {
  message: string;
  /** The order context / record text the reply was written from. */
  record: string;
  /** What the model said about whether the facts contain the answer. */
  modelReason?: string | null;
  keywords?: string[];
}): HandoffDecision {
  const msg = (i.message ?? "").replace(/[‘’]/g, "'");
  const alreadyOpen = teamHasItOpen([i.record ?? ""]);
  if (matchEscalateKeyword(msg, i.keywords ?? [...DEFAULT_ESCALATE_KEYWORDS])) return { handOff: true, source: "keyword", alreadyOpen };
  // An open case is the team's already; nothing below opens a second one.
  if (alreadyOpen) return { handOff: false, source: "none", alreadyOpen };
  if (FAULT.test(msg) || /\b(?:damag\w*|broken|defect\w*|wrong (?:item|product)|not as described|fake|rash|allerg\w*)\b/i.test(msg)) return { handOff: true, source: "fault_no_case", alreadyOpen };
  // "Any update on my refund?" is a status question, and when the record already holds that refund (completed, or in progress) the answer is on
  // it. hasReturnIntent matches the word "refund" too, so every refund message used to hand off (17 Oct review: 7 of 8 refund hand-offs were
  // answered in the reply and escalated anyway). A refund REQUEST, a refund with nothing on record, or one that "needs the team" still does.
  if (hasRefundIntent(msg) && hasReturnIntent(msg) && !(REFUND_STATUS_QUESTION.test(msg) && REFUND_ON_RECORD.test(i.record ?? ""))) return { handOff: true, source: "refund_decision_no_case", alreadyOpen };
  if (i.modelReason === "cannot_answer_from_facts") return { handOff: true, source: "model_cannot_answer", alreadyOpen };
  return { handOff: false, source: "none", alreadyOpen };
}
