// The selector: when the code has named the situation but no fixed rule decides it, ask a model which strategy from the catalogue
// fits — and only that. It never writes a customer-facing word.
//
// Phase 3 of the support-pipeline plan. What it is given is narrow on purpose: the situation the code computed (subtype and
// `key=value` facts, no addresses or order-context text), the customer's latest message and the last few turns, and the short list
// of strategies allowed for this situation. What it returns is a strategy id, the fact ids that justify it, a confidence and one
// sentence. Everything it returns is then validated (validateSelection): an id outside the list, a fact that was not offered, a
// precondition that does not hold or a low confidence all become a clarifying question or the hand-off — never a guess.
//
// The model is asked only when `decidedByCode` is null (a rule already covers the situation, or nothing needs saying). Used in the
// offline harness and, later, in live shadow; the live reply path does not call it.

import {
  STRATEGIES, candidatesFor, decidedByCode, failedPrecondition, fallbackFor, ruleIdsFor,
  type RuleId, type StrategyId,
} from "@policy/strategyCatalogue";
import type { Situation } from "@engine/situation";

export const SELECTOR_VERSION = 1;
const MODEL = () => process.env.OPENAI_SELECTOR_MODEL || "gpt-5-mini";
const TIMEOUT_MS = 15_000;
const TURN_CAP = 280;

export interface SelectorInput {
  situation: Situation;
  message: string;
  /** Recent turns, oldest first, WITHOUT the message being answered. */
  recent: { direction: "in" | "out"; body: string }[];
  /** A second attempt: strategies already tried and rejected, and why. The hand-off is never excluded. */
  exclude?: StrategyId[];
  feedback?: string;
}

/** The strategies this input may choose from: the situation's candidates less any already rejected (the hand-off always stays). */
export function allowedFor(i: Pick<SelectorInput, "situation" | "exclude">): StrategyId[] {
  const drop = new Set(i.exclude ?? []);
  return candidatesFor(i.situation).filter((id) => id === "hand_off_team" || !drop.has(id));
}

export type Confidence = "high" | "medium" | "low";

export interface Selection {
  strategy: StrategyId;
  /** "code": a rule decided it, no model asked · "selector": the model chose it and it validated · "fallback": the choice was unusable. */
  source: "code" | "selector" | "fallback";
  candidates: StrategyId[];
  fact_ids: string[];
  rule_ids: RuleId[];
  confidence?: Confidence;
  reason?: string;
  /** Why a selection was not used (a fallback), or what was dropped from a used one. */
  rejected?: string;
  invalid_fact_ids?: string[];
  model?: string;
  ms?: number;
  tokens?: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function selectorSchema(candidates: StrategyId[]) {
  return {
    name: "strategy_selection",
    strict: true,
    schema: {
      type: "object",
      properties: {
        strategy: { type: "string", enum: candidates },
        fact_ids: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        reason: { type: "string" },
      },
      required: ["strategy", "fact_ids", "confidence", "reason"],
      additionalProperties: false,
    },
  };
}

export const SELECTOR_INSTRUCTIONS =
  "You are the routing step of AJUKI's customer support, an online jewellery shop. You DO NOT write replies. The system has already " +
  "worked out the situation from the order record. Choose the one strategy, from the allowed list only, that best deals with what the " +
  "customer needs in their latest message.\n" +
  "- Use earlier turns to understand a short or broken message. A message that continues a thread about an undelivered order is about " +
  "THAT order, not a new purchase.\n" +
  "- Choose the strategy whose 'when' describes what the customer is actually asking now, not the topic of the whole thread.\n" +
  "- If the facts do not clearly support any strategy, choose hand_off_team (or ask_clarify, when it is allowed and the message is " +
  "genuinely unclear). A cautious choice is always better than a guess.\n" +
  "- fact_ids: the ids of the facts that justify your choice, copied exactly from the list. Never invent one.\n" +
  "- confidence: high, medium or low. reason: one short sentence.";

export function buildSelectorPrompt(i: SelectorInput): { system: string; user: string; candidates: StrategyId[] } {
  const candidates = allowedFor(i);
  const options = candidates.map((id) => `- ${id}: ${STRATEGIES[id].when}`).join("\n");
  const turns = i.recent.slice(-4).map((t) => `${t.direction === "in" ? "Customer" : "AJUKI"}: ${clip(t.body.replace(/\s+/g, " "), TURN_CAP)}`).join("\n");
  const user =
    `SITUATION (computed by the system): ${i.situation.subtype}\n` +
    `FACTS (cite them exactly as written, one per line):\n${i.situation.facts.join("\n") || "(none)"}\n` +
    `SIGNALS IN THE MESSAGE: ${i.situation.signals.join(", ") || "(none)"}\n\n` +
    `RECENT CONVERSATION:\n${turns || "(none)"}\n` +
    `LATEST CUSTOMER MESSAGE: ${clip(i.message.replace(/\s+/g, " "), 600)}\n\n` +
    `ALLOWED STRATEGIES:\n${options}` +
    (i.feedback ? `\n\nA PREVIOUS CHOICE WAS REJECTED (${i.exclude?.join(", ") ?? "?"}): ${clip(i.feedback, 240)}\nChoose a different strategy.` : "");
  return { system: SELECTOR_INSTRUCTIONS, user, candidates };
}

/** Turn a raw model answer into a usable selection or a fallback. Pure. */
export function validateSelection(raw: unknown, s: Situation, allowed?: StrategyId[]): Selection {
  const candidates = allowed ?? candidatesFor(s);
  const fb = (rejected: string): Selection => {
    const strategy = fallbackFor(s);
    return { strategy, source: "fallback", candidates, fact_ids: [], rule_ids: ruleIdsFor(strategy), rejected };
  };
  if (!raw || typeof raw !== "object") return fb("not_an_object");
  const r = raw as Record<string, unknown>;
  const strategy = r.strategy;
  if (typeof strategy !== "string" || !(candidates as string[]).includes(strategy)) return fb(`strategy_not_allowed:${String(strategy).slice(0, 40)}`);
  const id = strategy as StrategyId;
  const failed = failedPrecondition(id, s);
  if (failed) return fb(`precondition:${failed}`);
  const confidence = (["high", "medium", "low"] as const).find((c) => c === r.confidence);
  if (!confidence) return fb("no_confidence");
  // A low-confidence pick is never acted on; the safe strategy for this situation is used instead.
  if (confidence === "low" && id !== "hand_off_team" && id !== "ask_clarify") return { ...fb("low_confidence"), confidence, reason: typeof r.reason === "string" ? clip(r.reason, 200) : undefined };
  const offered = new Set([...s.facts, ...s.signals, s.subtype]);
  // A model sometimes copies a list bullet along with the id; that is the same id, not an invented one.
  const given = Array.isArray(r.fact_ids)
    ? r.fact_ids.filter((x): x is string => typeof x === "string").map((x) => x.replace(/^[-•*\s]+/, "").replace(/^(?:SITUATION|SIGNALS)[^:]*:\s*/i, "").trim())
    : [];
  const fact_ids = [...new Set(given.filter((f) => offered.has(f)))];
  const invalid = [...new Set(given.filter((f) => !offered.has(f)))];
  return {
    strategy: id, source: "selector", candidates, fact_ids, rule_ids: ruleIdsFor(id), confidence,
    reason: typeof r.reason === "string" ? clip(r.reason, 200) : undefined,
    ...(invalid.length ? { invalid_fact_ids: invalid.slice(0, 6) } : {}),
  };
}

export interface SelectOptions {
  /** Ask the model even when a rule already decides (for measuring the selector against the code). */
  force?: boolean;
  fetchImpl?: typeof fetch;
  model?: string;
}

/** Choose a strategy. Never throws: any failure is a fallback with the reason. */
export async function selectStrategy(i: SelectorInput, o: SelectOptions = {}): Promise<Selection> {
  const s = i.situation;
  const decided = i.exclude?.length ? null : decidedByCode(s);
  const candidates = allowedFor(i);
  if (decided && !o.force) return { strategy: decided, source: "code", candidates, fact_ids: [], rule_ids: ruleIdsFor(decided) };

  const key = process.env.OPENAI_API_KEY;
  if (!key) return { strategy: fallbackFor(s), source: "fallback", candidates, fact_ids: [], rule_ids: ruleIdsFor(fallbackFor(s)), rejected: "no_key" };
  const p = buildSelectorPrompt(i);
  const model = o.model ?? MODEL();
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await (o.fetchImpl ?? fetch)("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, reasoning_effort: process.env.OPENAI_SELECTOR_EFFORT || "low",
        response_format: { type: "json_schema", json_schema: selectorSchema(p.candidates) },
        messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) return withMeta({ ...validateSelection(null, s, candidates), rejected: `http_${res.status}` }, model, started, 0);
    const j: any = await res.json();
    const content = j?.choices?.[0]?.message?.content;
    let parsed: unknown = null;
    try { parsed = content ? JSON.parse(content) : null; } catch { parsed = null; }
    return withMeta(parsed ? validateSelection(parsed, s, candidates) : { ...validateSelection(null, s, candidates), rejected: "unparseable" }, model, started, j?.usage?.total_tokens ?? 0);
  } catch (err) {
    return withMeta({ ...validateSelection(null, s, candidates), rejected: err instanceof Error && err.name === "AbortError" ? "timeout" : "error" }, model, started, 0);
  } finally {
    clearTimeout(timer);
  }
}

function withMeta(sel: Selection, model: string, started: number, tokens: number): Selection {
  return { ...sel, model, ms: Date.now() - started, tokens };
}
