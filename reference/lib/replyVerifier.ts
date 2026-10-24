// The verifier: a model reads a candidate reply against the record, the rules that bind it and the customer's message, and says three
// separate things about it.
//
// Phase 5 of the support-pipeline plan. It replaces the single "list the unsupported claims" judge (lib/groundingJudge.ts) for the
// new pipeline, for three reasons the 10 Oct replay gave:
//   · It SKIPS what needs no checking. A fixed approved line, verbatim, is not judged (the old judge was asked to vouch for the flag
//     line and the like); nor is a reply that sends nothing.
//   · It is given ALL the rules that apply to the strategy — the strategy's own and the always-on ones — not whichever few the prompt
//     happened to mention, so a rule is checked because it applies, not because it was remembered.
//   · It returns THREE verdicts, kept apart: facts_ok (is every specific supported), rules_ok (is any rule broken, and which),
//     answers_intent (does it answer what was asked). The first two may block. The third is RECORDED, NOT ENFORCED, until its
//     agreement with a person has been measured (scripts/eval-support-verifier.mts) — the earlier second-reader check held 17 of 23
//     good replies, and a check that blocks good replies is worse than none.
//
// It never rewrites. What happens to a blocked reply is lib/replyPipeline.ts's decision (re-select once, then ask, never the flag
// line when a question would do). Pure but for the one model call, which is injectable for tests.

import { RULES, STRATEGIES, type RuleId, type StrategyId } from "@/lib/strategyCatalogue";
import { FIXED_TEXTS } from "@/lib/replyValidate";
import type { Situation } from "@/lib/situation";

export const VERIFIER_VERSION = 1;
const MODEL = () => process.env.OPENAI_VERIFIER_MODEL || "gpt-5-mini";
const TIMEOUT_MS = 15_000;
const CAP = 280;

/** Rules that bind every reply, whatever the strategy. */
export const ALWAYS_ON: RuleId[] = ["RECORD_ONLY", "NO_REFUND_PROMISE", "NO_TIME_PROMISE", "NO_ACTION_CLAIM"];

/** Every rule that applies to a strategy: its own, then the always-on ones, once each. */
export function applicableRules(strategy: StrategyId): RuleId[] {
  return [...new Set<RuleId>([...STRATEGIES[strategy].rules, ...ALWAYS_ON])];
}

export interface VerifierInput {
  text: string | null;
  strategy: StrategyId;
  situation: Situation;
  message: string;
  recent: { direction: "in" | "out"; body: string }[];
  /** The customer's order lines as the bot reads them (formatOrders), for the orders in scope. */
  record: string;
}

export interface Verdict {
  facts_ok: boolean;
  rules_ok: boolean;
  /** Recorded, not enforced (see above). */
  answers_intent: boolean;
  violated: RuleId[];
  unsupported: string[];
  issue: string;
  /** No model was asked: why. */
  skipped?: "fixed_verbatim" | "nothing_to_send" | "rule_decided";
  /** The model could not be asked or answered unusably. The verdicts are then neutral (true) and `error` says why. */
  error?: string;
  model?: string;
  ms?: number;
  tokens?: number;
}

const NEUTRAL = { facts_ok: true, rules_ok: true, answers_intent: true, violated: [] as RuleId[], unsupported: [] as string[], issue: "" };

export function verifierSchema() {
  return {
    name: "reply_verdict",
    strict: true,
    schema: {
      type: "object",
      properties: {
        facts_ok: { type: "boolean" },
        rules_ok: { type: "boolean" },
        answers_intent: { type: "boolean" },
        violated_rules: { type: "array", items: { type: "string", enum: Object.keys(RULES) } },
        unsupported: { type: "array", items: { type: "string" } },
        issue: { type: "string" },
      },
      required: ["facts_ok", "rules_ok", "answers_intent", "violated_rules", "unsupported", "issue"],
      additionalProperties: false,
    },
  };
}

export const VERIFIER_INSTRUCTIONS =
  "You check a customer-support reply for AJUKI, an online jewellery shop, BEFORE it is sent. You do not rewrite it. Judge three things " +
  "independently.\n" +
  "1. facts_ok: every specific the reply states (an order id, a status, a date, an amount, a link, an email address, a policy) is " +
  "supported by the RECORD or the FACTS. Apologies, requests for the customer to do something, and statements about what we cannot " +
  "see are not claims. Quote any unsupported statement in `unsupported`.\n" +
  "2. rules_ok: the reply breaks none of the RULES listed. Name each broken rule's id in `violated_rules`. Judge the reply's words, not " +
  "its intent: a rule is broken only if the text actually does it.\n" +
  "3. answers_intent: the reply responds to what the customer is asking in their latest message (use the earlier turns to understand a " +
  "short or broken message). A reply that is accurate but about something else, or that answers a different question, is false. A " +
  "holding line that says the team has it is true only when this is a matter the team must handle.\n" +
  "Be strict on 1 and 2 where the reply says something specific, and do not flag harmless wording. `issue`: one sentence on what is " +
  "false, or empty when everything is.";

/** Contact points and pages the business itself gives out. A reply may send a customer to these; they are not "in the record". */
export const APPROVED_ROUTES = [
  "ajukisupport@gmail.com — the Senior Support Team's email",
  "www.ajuki.in/returns/start — raise a return",
  "www.ajuki.in/track — track an order",
  "www.ajuki.in — the website, product pages, photos",
  "@ajuki.in — the Instagram page",
];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildVerifierPrompt(i: VerifierInput): { system: string; user: string; rules: RuleId[] } {
  const rules = applicableRules(i.strategy);
  const turns = i.recent.slice(-4).map((t) => `${t.direction === "in" ? "Customer" : "AJUKI"}: ${clip(t.body.replace(/\s+/g, " "), CAP)}`).join("\n");
  const user =
    `STRATEGY CHOSEN: ${i.strategy} — ${STRATEGIES[i.strategy].when}\n` +
    `SITUATION: ${i.situation.subtype}\n` +
    `FACTS:\n${i.situation.facts.join("\n") || "(none)"}\n\n` +
    `APPROVED ROUTES (the business gives these out; a reply may point to them):\n${APPROVED_ROUTES.join("\n")}\n\n` +
    `RECORD (the customer's orders as we hold them):\n${clip(i.record || "(no orders)", 2500)}\n\n` +
    `RULES THAT APPLY:\n${rules.map((r) => `${r}: ${RULES[r]}`).join("\n")}\n\n` +
    `RECENT CONVERSATION:\n${turns || "(none)"}\n` +
    `LATEST CUSTOMER MESSAGE: ${clip(i.message.replace(/\s+/g, " "), 600)}\n\n` +
    `REPLY TO CHECK (our approved fixed lines are not shown; they are not claims to judge):\n${i.text ?? ""}`;
  return { system: VERIFIER_INSTRUCTIONS, user, rules };
}

/**
 * What is left of a reply once the approved fixed lines inside it are taken out. A draft that ends "I have flagged this to the team and
 * we are working on it." contains our own approved sentence; judging that sentence as a claim is the old judge's mistake.
 */
export function withoutApprovedLines(text: string): string {
  let t = text;
  for (const f of [...FIXED_TEXTS].sort((a, b) => b.length - a.length)) t = t.split(f).join(" ");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * The record for the verifier: the customer block (identity, any open case) and the lines of the orders IN SCOPE only. A customer with
 * five orders must not push the order the message is about out of a length limit, and a verifier handed four irrelevant orders has more
 * to be confused by, not less.
 */
export function recordFor(orderContext: string, orderIds: string[]): string {
  const keep = new Set(orderIds.map((x) => x.toUpperCase()));
  return orderContext.split(/\r?\n/).filter((line) => {
    const m = /^#?(AJUKI\d+)\b/i.exec(line.trim());
    return !m || keep.has(m[1].toUpperCase());
  }).join("\n");
}

/** Turn a raw model answer into a verdict. Pure. An unusable answer is neutral and carries an error — the caller decides what that costs. */
export function parseVerdict(raw: unknown, applicable: RuleId[]): Verdict {
  if (!raw || typeof raw !== "object") return { ...NEUTRAL, error: "not_an_object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.facts_ok !== "boolean" || typeof r.rules_ok !== "boolean" || typeof r.answers_intent !== "boolean") return { ...NEUTRAL, error: "bad_shape" };
  const allowed = new Set<string>(applicable);
  const violated = (Array.isArray(r.violated_rules) ? r.violated_rules : []).filter((x): x is RuleId => typeof x === "string" && x in RULES);
  const unsupported = (Array.isArray(r.unsupported) ? r.unsupported : []).filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 4).map((x) => clip(x, CAP));
  // A rule the model names that is not one of the rules it was shown cannot be what blocks the reply.
  const named = violated.filter((v) => allowed.has(v));
  return {
    // A verdict that says "fine" and quotes something unsupported is not fine.
    facts_ok: r.facts_ok && unsupported.length === 0,
    // A rule the model names that was not one of those shown cannot be what blocks the reply; "not ok" with no rule named at all still does.
    rules_ok: !(r.rules_ok === false && (named.length > 0 || violated.length === 0)),
    answers_intent: r.answers_intent,
    violated: named,
    unsupported,
    issue: typeof r.issue === "string" ? clip(r.issue, 240) : "",
  };
}

export interface VerifyOptions { fetchImpl?: typeof fetch; model?: string }

/** Verify one candidate reply. Never throws. */
export async function verifyReply(i: VerifierInput, o: VerifyOptions = {}): Promise<Verdict> {
  if (!i.text) return { ...NEUTRAL, skipped: "nothing_to_send" };
  if (FIXED_TEXTS.has(i.text)) return { ...NEUTRAL, skipped: "fixed_verbatim" };
  const checked = withoutApprovedLines(i.text);
  if (!/[A-Za-z0-9]{3}/.test(checked)) return { ...NEUTRAL, skipped: "fixed_verbatim" };
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ...NEUTRAL, error: "no_key" };
  const p = buildVerifierPrompt({ ...i, text: checked });
  const model = o.model ?? MODEL();
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await (o.fetchImpl ?? fetch)("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, reasoning_effort: process.env.OPENAI_VERIFIER_EFFORT || "low",
        response_format: { type: "json_schema", json_schema: verifierSchema() },
        messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ...NEUTRAL, error: `http_${res.status}`, model, ms: Date.now() - started };
    const j: any = await res.json();
    const content = j?.choices?.[0]?.message?.content;
    let parsed: unknown = null;
    try { parsed = content ? JSON.parse(content) : null; } catch { parsed = null; }
    const v = parsed ? parseVerdict(parsed, p.rules) : { ...NEUTRAL, error: "unparseable" };
    return { ...v, model, ms: Date.now() - started, tokens: j?.usage?.total_tokens ?? 0 };
  } catch (err) {
    return { ...NEUTRAL, error: err instanceof Error && err.name === "AbortError" ? "timeout" : "error", model, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export interface VerdictPolicy {
  /** The reply must not be sent as it stands. */
  block: boolean;
  /** Why, in words the caller can hand to the selector as feedback. */
  reasons: string[];
  /** Recorded but not enforced. */
  shadow: string[];
}

/**
 * What a verdict means for the reply. Facts and rules block; `answers_intent` is shadow. A verifier that could not run blocks nothing:
 * a built reply has already passed the mechanical validator (lib/replyValidate.ts), so an outage must not cost the customer an answer.
 */
export function policyOf(v: Verdict, o: { enforceIntent?: boolean } = {}): VerdictPolicy {
  const reasons: string[] = [];
  const shadow: string[] = [];
  if (v.skipped) return { block: false, reasons, shadow };
  if (v.error) { shadow.push(`verifier_error:${v.error}`); return { block: false, reasons, shadow }; }
  if (!v.facts_ok) reasons.push(`unsupported: ${v.unsupported.join(" | ") || v.issue || "a statement is not in the record"}`);
  if (!v.rules_ok) reasons.push(`rule broken: ${v.violated.join(", ") || v.issue || "unspecified"}`);
  if (!v.answers_intent) (o.enforceIntent ? reasons : shadow).push(`does not answer: ${v.issue || "the reply is about something else"}`);
  return { block: reasons.length > 0, reasons, shadow };
}
