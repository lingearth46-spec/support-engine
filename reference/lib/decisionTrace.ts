// Why was this message answered, or not, the way it was?
//
// Every reply the support pipeline sends, holds or blocks leaves one small structured record: which path produced the final text
// (a fixed rule, a verified model draft, the fallback line), what the model drafted if a rule overrode it, which mechanical rules and
// verifier verdicts it passed through, and what finally happened to it. With that on file a wrong reply can be put in one bucket from
// the record alone — selector, generator, verifier false-block, verifier miss, bad override or bad data — instead of being rebuilt by
// replaying the case.
//
// Storage: the existing wa_messages.ai_meta jsonb, no migration.
//   · a reply that is sent carries the trace in its own row's ai_meta.trace (it rides the decision's meta, no extra write);
//   · a message that gets NO outbound row (held repeat, stood down, silent exits) has it written to the INBOUND row's ai_meta.trace.
//
// The record holds identifiers, verdicts and short fragments, never the order context: addresses and phone numbers are not copied.
// The model draft is kept only when it was not what was sent (overridden or withheld), capped at DRAFT_CAP characters.
//
// Pure builders here; the two writers take a client and never throw — a trace must never change what the customer is told.
// DEFAULT OFF (SUPPORT_DECISION_TRACE), and implied by SUPPORT_PIPELINE_V2 so a V2 replay is always traceable.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pipelineV2Enabled } from "@/lib/pipelineV2";
import { mergeAiMeta } from "@/lib/inboundMeta";
import type { Agreement, Situation } from "@/lib/situation";
import type { Selection } from "@/lib/strategySelector";

export const TRACE_VERSION = 1;
const DRAFT_CAP = 500;
const CLAIM_CAP = 240;

export function decisionTraceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.SUPPORT_DECISION_TRACE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || pipelineV2Enabled(env);
}

/** What finally happened to the message. */
export type TraceOutcome =
  | "sent"             // a reply went out
  | "action_refused"   // the reply was replaced by the refusal text of an order action
  | "escalated_ack"    // the customer got the hand-off line and the team was flagged
  | "escalated_quiet"  // flagged to the team, customer sent nothing (already told someone is coming)
  | "held_repeat"      // the same fixed answer was already sent; nothing sent, the team was pinged
  | "superseded"       // a newer message from the same customer took over
  | "taken_over"       // a person took the thread (or the bot was switched off) while this was being decided
  | "silent";          // deliberately no reply (see `reason`)

export interface DecisionTrace {
  v: number;
  outcome: TraceOutcome;
  /** `code:<rule>` a fixed rule wrote the text · `llm:verified` / `llm:repaired` the model's text passed the checks · `fallback:flag` the
   *  fixed flag line · `none` nothing was drafted (a silent exit). */
  path: string;
  /** Why: the silent exit, the hold, or the fallback's reason. */
  reason?: string;
  /** What situation the code reads this turn as (lib/situation.ts), independent of the model's tag, and whether what was sent agrees. */
  situation: {
    subtype: string | null; family: string | null;
    /** The fixed rule the situation names (meta.fixedReply vocabulary), or null when the model answers. */
    rule: string | null; handler: string | null;
    /** compareToActual: same · model_both · rule_suppressed · rule_needs_tag · conflict · reply_to_ack. */
    agree: string | null;
    scope: string | null; subject: string | null; orders: number | null;
    facts: string[]; signals: string[];
  };
  /** The strategy chosen from the catalogue (lib/strategySelector.ts), and where the choice came from. Null until the selector runs. */
  selection: {
    strategy: string | null; rule_ids: string[]; fact_ids: string[];
    /** code · selector · fallback */
    source?: string | null; confidence?: string | null; rejected?: string | null; candidates?: string[];
  };
  checks: { gate: string[]; sanitised: string[]; leak: string[] };
  verifier: {
    judge: "ok" | "claims" | "unavailable" | "not_run" | null;
    claims: number; kind_claims: number; exempt: number;
    regen: "none" | "cut_unsupported" | "flag_line" | null;
    second: "ok" | "claims" | "unavailable" | null;
    removed: string[];
    completeness: { holds: boolean; issue: string } | null;
  };
  /** The model's own draft, when something other than it was sent. */
  draft: { action: string | null; tag: string | null; provenance: string | null; text: string | null } | null;
  model: { generator: string | null; judge: string | null; ms: number | null; tokens: number | null; prompt: string | null };
  flags: { v2: boolean; wake: boolean; fast: boolean };
  quietWaitMs: number;
}

type Meta = Record<string, unknown>;
const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : []);
const clip = (s: string | null | undefined, n: number): string | null => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

/** Short, stable fingerprint of a prompt, so two traces can be told to have used the same wording without storing it. */
export function promptFingerprint(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 10);
}

/** The path that produced the text actually sent, from the decision's meta. */
export function pathOf(meta: Meta | undefined, hasText = true): string {
  const m = meta ?? {};
  if (!hasText) return "none";
  const fixed = str(m.fixedReply);
  if (fixed) return `code:${m.fastPath === true ? "fast:" : ""}${fixed}`;
  if (str(m.keyword)) return "code:keyword";
  const prov = str(m.provenance);
  if (prov === "fixed:flag") return "fallback:flag";
  if (prov === "model_verified") return "llm:verified";
  if (prov === "model_repaired_verified") return "llm:repaired";
  return prov ? `other:${prov}` : "unknown";
}

export interface BuildTraceInput {
  /** The decision as it stands when the reply is about to be sent (after overrides and the final guard). */
  decision: { action: string; tag?: string | null; reason?: string | null; text?: string | null; meta?: unknown };
  /** What the model drafted before any override replaced it; null on the fast path (the model never ran). */
  modelDraft?: { action: string; tag?: string | null; text?: string | null; provenance?: string | null } | null;
  scope?: { basis: string | null; subject: string | null; orders: number | null };
  /** The code's reading of the turn, and its agreement with what actually went out. Shadow only. */
  situation?: { s: Situation; agree: Agreement } | null;
  /** The selector's (or the code's) strategy choice for this turn. Shadow only. */
  selection?: Selection | null;
  v2: boolean;
  wake: boolean;
  quietWaitMs?: number;
}

/** The record for a decision that reached the send stage. Outcome starts as "sent"; the terminal site sets the real one. */
export function buildTrace(i: BuildTraceInput): DecisionTrace {
  const meta = (i.decision.meta ?? {}) as Meta;
  const verify = (meta.verify ?? {}) as Meta;
  const grounding = Array.isArray(meta.grounding) ? (meta.grounding as { rule?: unknown }[]) : [];
  const completeness = ((meta.shadow ?? {}) as Meta).completeness as Meta | undefined;
  const usage = (meta.usage ?? {}) as Meta;
  const path = pathOf(meta, Boolean(i.decision.text));
  const sentIsModelText = path.startsWith("llm:");
  const drafted = i.modelDraft ?? null;
  // The draft is worth keeping when the customer was NOT sent it: a fixed rule overrode it, or the checks withheld it.
  const withheld = str(meta.withheld);
  const overridden = !!drafted && !sentIsModelText && !!(drafted.text || withheld);
  // A repaired reply was cut before it went out: keep what the model wrote, so a cut that took the answer with it can be seen.
  const preRepair = path === "llm:repaired" ? str(meta.preRepair) : null;
  const draftText = withheld ?? preRepair ?? (overridden ? drafted?.text ?? null : null);

  return {
    v: TRACE_VERSION,
    outcome: "sent",
    path,
    ...(str(i.decision.reason) ? { reason: clip(str(i.decision.reason), CLAIM_CAP)! } : {}),
    situation: {
      subtype: i.situation?.s.subtype ?? null, family: i.situation?.s.family ?? null,
      rule: i.situation?.s.rule ?? null, handler: i.situation?.s.handler ?? null, agree: i.situation?.agree ?? null,
      scope: i.situation?.s.subject.basis ?? i.scope?.basis ?? null,
      subject: i.situation?.s.subject.order ?? i.scope?.subject ?? null,
      orders: i.situation?.s.subject.orders ?? i.scope?.orders ?? null,
      facts: (i.situation?.s.facts ?? []).slice(0, 16), signals: (i.situation?.s.signals ?? []).slice(0, 10),
    },
    selection: i.selection
      ? {
        strategy: i.selection.strategy, rule_ids: [...i.selection.rule_ids], fact_ids: i.selection.fact_ids.slice(0, 12),
        source: i.selection.source, confidence: i.selection.confidence ?? null, rejected: i.selection.rejected ?? null, candidates: i.selection.candidates,
      }
      : { strategy: null, rule_ids: [], fact_ids: [] },
    checks: {
      gate: grounding.map((g) => str(g.rule)).filter((r): r is string => !!r).slice(0, 6),
      sanitised: strs(meta.sanitised).slice(0, 4).map((s) => clip(s, 80)!),
      leak: strs(meta.finalTextLeak).slice(0, 4),
    },
    verifier: {
      judge: (str(verify.judge) as DecisionTrace["verifier"]["judge"]) ?? null,
      claims: num(verify.claims) ?? 0,
      kind_claims: num(verify.kind_claims) ?? 0,
      exempt: num(verify.exempt) ?? 0,
      regen: (str(verify.regen) as DecisionTrace["verifier"]["regen"]) ?? null,
      second: (str(verify.second) as DecisionTrace["verifier"]["second"]) ?? null,
      removed: strs(meta.removed).slice(0, 4).map((s) => clip(s, CLAIM_CAP)!),
      completeness: completeness && typeof completeness.holds === "boolean"
        ? { holds: completeness.holds, issue: clip(str(completeness.issue), CLAIM_CAP) ?? "" } : null,
    },
    draft: drafted
      ? { action: drafted.action ?? null, tag: str(drafted.tag), provenance: str(drafted.provenance), text: clip(draftText, DRAFT_CAP) }
      : null,
    model: {
      generator: str(meta.model),
      judge: str(verify.judgeModel),
      ms: num(meta.latencyMs),
      tokens: num(usage.total_tokens),
      prompt: str(meta.promptHash),
    },
    flags: { v2: i.v2, wake: i.wake, fast: meta.fastPath === true },
    quietWaitMs: i.quietWaitMs ?? 0,
  };
}

/** A message that never reached a reply decision (a silent exit, a stand-down). */
export function silentTrace(outcome: TraceOutcome, reason: string, o: { v2: boolean; wake: boolean }): DecisionTrace {
  return {
    v: TRACE_VERSION, outcome, path: "none", reason,
    situation: { subtype: null, family: null, rule: null, handler: null, agree: null, scope: null, subject: null, orders: null, facts: [], signals: [] },
    selection: { strategy: null, rule_ids: [], fact_ids: [] },
    checks: { gate: [], sanitised: [], leak: [] },
    verifier: { judge: null, claims: 0, kind_claims: 0, exempt: 0, regen: null, second: null, removed: [], completeness: null },
    draft: null,
    model: { generator: null, judge: null, ms: null, tokens: null, prompt: null },
    flags: { v2: o.v2, wake: o.wake, fast: false },
    quietWaitMs: 0,
  };
}

/** The decision's meta with the trace's outcome stamped, for the sites that send (the trace rides the outbound row). */
export function withTraceOutcome<M extends Meta>(meta: M | undefined, outcome: TraceOutcome, reason?: string): M {
  const base = (meta ?? {}) as M;
  const t = base.trace as DecisionTrace | undefined;
  if (!t) return base;
  return { ...base, trace: { ...t, outcome, ...(reason ? { reason } : {}) } };
}

/** Write a trace onto the INBOUND row, for outcomes that produce no outbound row. Best-effort; never throws, never blocks a reply. */
export async function writeInboundTrace(db: SupabaseClient, inboundId: string | undefined, trace: DecisionTrace | undefined): Promise<void> {
  if (!inboundId || !trace) return;
  // Merged, not replaced: other best-effort writers (the general-path shadow) share this row's ai_meta.
  await mergeAiMeta(db, inboundId, { trace });
}

/** The bucket a reviewer's verdict puts a reply in, given its trace. Used by the review script, not by the pipeline. */
export type FailureBucket =
  | "ok" | "override_error" | "verifier_false_block" | "passed_but_wrong" | "generator_error" | "selector_error" | "data_error";

/**
 * A reply is judged by a person (or a rubric): was what was SENT acceptable, and would the model's draft have been acceptable?
 * From the trace and those two answers the cause follows. `selectorWrong` is for a later phase; it is false until then.
 */
export function bucketOf(t: Pick<DecisionTrace, "path" | "draft">, v: { sentAcceptable: boolean; draftAcceptable?: boolean; dataWrong?: boolean; selectorWrong?: boolean }): FailureBucket {
  if (v.sentAcceptable) return "ok";
  if (v.dataWrong) return "data_error";
  if (v.selectorWrong) return "selector_error";
  const code = t.path.startsWith("code:");
  const flagged = t.path === "fallback:flag";
  if (flagged && v.draftAcceptable) return "verifier_false_block";
  if (code) return "override_error"; // a fixed rule wrote the text, and it was wrong for this message
  // A model text got through every check and was wrong. Until a selector exists there is nothing to tell a generator that wrote the
  // wrong thing from a verifier that should have caught it, so this stays one bucket (a reviewer, or Phase 3, splits it).
  if (t.path.startsWith("llm:")) return "passed_but_wrong";
  return "generator_error";
}
