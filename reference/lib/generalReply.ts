// A general conversational reply path — the open lane for turns no typed strategy covers.
//
// EXPERIMENT (Phase 6b). Phase 6 found that on real traffic a closed strategy catalogue answers only about a third of turns; the rest
// are conversation about the customer's own order or a product, an acknowledgement, a short follow-up. This path tests the opposite
// design for those turns: no strategy gate. A model is given the thread, the customer's trusted record, the product facts and the
// business policies, and writes the reply. What stays deterministic is the SAFETY around it, not the choice of answer:
//   · it may state only what it was given (the mechanical grounding gate, lib/replyGrounding.ts, checks every amount, id, date, link,
//     email and phone, and refuses refund / replacement offers, reply-time and delivery promises, callbacks);
//   · it cannot act: the output has no action field, and a claim that something was done is refused;
//   · what it says is checked by kind (lib/replyClaims.ts) and for leaked internal names (lib/replySanitize.ts);
//   · anything refused is replaced by the fixed flag line — and that replacement is RECORDED, so a correct answer lost to code is
//     visible, not silent.
// Nothing here is called by the live handler. It reads no rule or override and changes none.

import { BUSINESS_TRUTHS, FLAG_REPLY } from "@/lib/businessTruths";
import { groundingViolations, stripPromiseSentences } from "@/lib/replyGrounding";
import { sanitiseModelText, leakedInternalTerms } from "@/lib/replySanitize";
import { teamHasItOpen, unsupportedByKind } from "@/lib/replyClaims";
import { RULES } from "@/lib/strategyCatalogue";

export const GENERAL_VERSION = 1;
const MODEL = () => process.env.OPENAI_GENERAL_MODEL || "gpt-5-mini";
const TIMEOUT_MS = 25_000;

export interface GeneralInput {
  message: string;
  /** Recent turns, oldest first, INCLUDING the message being answered as the last customer turn. */
  thread: { direction: "in" | "out"; body: string }[];
  /** The customer block and the lines of the orders in scope, as the bot reads them. */
  record: string;
  /** The same for every order they have: what the claims may rest on, wider than what the model is shown. */
  fullRecord?: string;
  /** Product / catalogue facts for what the message names. */
  products: string;
  /** What the message is to the conversation (lib/followUp.ts), written for the model; empty when it is a first question. */
  note?: string;
}

export interface GeneralResult {
  /** What the model wrote, before any check. */
  draft: string | null;
  /** What would be sent: the draft, the draft with a promise sentence cut, or the flag line. */
  final: string | null;
  /** The reply is the hand-off (the model asked for a person, or a check refused its text). */
  handOff: boolean;
  needsHuman: boolean;
  reason: string | null;
  /** Why the draft was not used as written; null when it was. */
  blocked: string[] | null;
  /** The draft was replaced by the flag line, or cut, by a deterministic check. */
  replacedByCode: boolean;
  repaired: boolean;
  sanitised: string[];
  model?: string;
  ms?: number;
  tokens?: number;
  error?: string;
}

export const GENERAL_INSTRUCTIONS =
  "You are AJUKI's WhatsApp customer-support assistant. AJUKI is an online jewellery shop in India. Reply to the customer's latest message " +
  "in their language (English, or Hinglish in Latin letters), in one to three short, warm, plain sentences.\n\n" +
  "You may state ONLY: (1) the BUSINESS FACTS, (2) the CUSTOMER'S RECORD, (3) the PRODUCT FACTS. Anything else you do not know.\n\n" +
  "How to answer:\n" +
  "- Use the conversation to understand a short or broken message. A message that continues a thread is about that thread's order or product.\n" +
  "- Answer from the facts whenever you can. Do not ask a question whose answer is in the facts or the thread. Ask ONE specific question only " +
  "when you truly cannot tell which order or product is meant.\n" +
  "- A thank-you, an acknowledgement or a reaction needs at most a short friendly line.\n" +
  "- Set needs_human to true, with a one-line reason, only when a person's judgement is needed: damage, a refund decision, a complaint about " +
  "how it was handled, a legal threat, or a request you cannot do. Otherwise false.\n" +
  "- You CANNOT perform actions (cancel, change an address, refund, book anything). Never say something was done. If asked for one, say what the " +
  "policy is from the facts, or that the team will handle it.\n" +
  `- ${RULES.NO_REFUND_PROMISE}\n- ${RULES.NO_TIME_PROMISE}\n- ${RULES.RECORD_ONLY}\n` +
  "- Never mention internal field names, order-line markers or that you are an AI unless asked.";

export function generalSchema() {
  return {
    name: "general_reply",
    strict: true,
    schema: {
      type: "object",
      properties: { reply: { type: "string" }, needs_human: { type: "boolean" }, reason: { type: ["string", "null"] } },
      required: ["reply", "needs_human", "reason"],
      additionalProperties: false,
    },
  };
}

export function buildGeneralPrompt(i: GeneralInput): { system: string; messages: { role: "system" | "user" | "assistant"; content: string }[] } {
  const system =
    `${GENERAL_INSTRUCTIONS}\n\n=== BUSINESS FACTS ===\n${BUSINESS_TRUTHS.trim()}\n\n=== CUSTOMER'S RECORD ===\n${i.record || "(no orders found for this number)"}\n\n` +
    `=== PRODUCT FACTS ===\n${i.products || "(none matched this message)"}`;
  const turns = i.thread.slice(-10).map((t) => ({ role: (t.direction === "in" ? "user" : "assistant") as "user" | "assistant", content: t.body }));
  if (!turns.length || turns[turns.length - 1].role !== "user") turns.push({ role: "user", content: i.message });
  return { system, messages: [{ role: "system", content: system }, ...turns] };
}

/** A claim that something WAS DONE. The general path performs nothing, so none of these can be true. */
const ACTION_DONE = /\b(?:i|we)(?:'ve|\s+have|\s+had)\s+(?:already\s+)?(?:updated|changed|cancell?ed|booked|refunded|arranged|processed|rescheduled)\b|\byour (?:address|order|request) (?:has|have) been (?:updated|changed|cancell?ed|rescheduled)\b/i;

export interface GeneralCheck { text: string | null; blocked: string[] | null; repaired: boolean; sanitised: string[] }

/** The deterministic safety stage. Pure. `evidence` is what a claim may rest on. */
export function checkGeneralText(draft: string, evidence: string[], context: string[]): GeneralCheck {
  const san = sanitiseModelText(draft, [...evidence, ...context]);
  let text = san.text;
  const why: string[] = [];
  let repaired = false;

  let violations = groundingViolations(text, evidence, context);
  if (violations.length && violations.every((v) => v.rule === "reply_time" || v.rule === "delivery_promise")) {
    const kept = stripPromiseSentences(text);
    if (kept && !groundingViolations(kept, evidence, context).length) { text = kept; repaired = true; violations = []; }
  }
  for (const v of violations) why.push(`${v.rule}: ${v.detail}`);
  if (ACTION_DONE.test(text)) why.push("action_claim: says something was done; this path performs nothing");
  const openCase = teamHasItOpen(evidence);
  for (const c of unsupportedByKind(text, { openCase, evidence })) why.push(`unsupported_by_kind: ${c.slice(0, 80)}`);
  const leaks = leakedInternalTerms(text);
  if (leaks.length) why.push(`internal_term: ${leaks.slice(0, 3).join(", ")}`);
  return { text: why.length ? null : text, blocked: why.length ? why : null, repaired, sanitised: san.changes };
}

export interface GeneralOptions { fetchImpl?: typeof fetch; model?: string }

/** Write and check one reply. Never throws. */
export async function generalReply(i: GeneralInput, o: GeneralOptions = {}): Promise<GeneralResult> {
  const empty = { draft: null, final: null, handOff: true, needsHuman: false, reason: null, blocked: null, replacedByCode: false, repaired: false, sanitised: [] as string[] };
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ...empty, final: FLAG_REPLY, error: "no_key" };
  const p = buildGeneralPrompt(i);
  const model = o.model ?? MODEL();
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await (o.fetchImpl ?? fetch)("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, reasoning_effort: process.env.OPENAI_GENERAL_EFFORT || "low", response_format: { type: "json_schema", json_schema: generalSchema() }, messages: p.messages }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ...empty, final: FLAG_REPLY, error: `http_${res.status}`, model, ms: Date.now() - started };
    const j: any = await res.json();
    let parsed: any = null;
    try { parsed = JSON.parse(j?.choices?.[0]?.message?.content ?? "null"); } catch { parsed = null; }
    const tokens = j?.usage?.total_tokens ?? 0;
    if (!parsed || typeof parsed.reply !== "string" || !parsed.reply.trim()) return { ...empty, final: FLAG_REPLY, error: "unparseable", model, ms: Date.now() - started, tokens };
    const draft = String(parsed.reply).trim();
    const needsHuman = parsed.needs_human === true;
    const evidence = [BUSINESS_TRUTHS, i.fullRecord ?? i.record, i.products].filter(Boolean);
    const context = [i.message, ...i.thread.map((t) => t.body)];
    const chk = checkGeneralText(draft, evidence, context);
    if (chk.blocked) {
      return { draft, final: FLAG_REPLY, handOff: true, needsHuman, reason: parsed.reason ?? null, blocked: chk.blocked, replacedByCode: true, repaired: false, sanitised: chk.sanitised, model, ms: Date.now() - started, tokens };
    }
    return { draft, final: chk.text, handOff: needsHuman, needsHuman, reason: parsed.reason ?? null, blocked: null, replacedByCode: chk.repaired, repaired: chk.repaired, sanitised: chk.sanitised, model, ms: Date.now() - started, tokens };
  } catch (err) {
    return { ...empty, final: FLAG_REPLY, error: err instanceof Error && err.name === "AbortError" ? "timeout" : "error", model, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
