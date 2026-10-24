// The general conversational path, second version: the three structural fixes from the Phase 6b failure review.
//
// lib/generalReply.ts (v1) is kept unchanged as the comparator. What this version changes, and nothing about what the model is given:
//
//   1. REPAIR, DON'T REPLACE. A refused reply is no longer swapped for the flag line. The statements that were refused are named, the
//      model is asked once to rewrite without them, and if that is refused too the offending sentences alone are dropped. The flag line
//      is the last resort, and every step is recorded (`repair`).
//   2. CLAIMS BY MEANING, NOT BY WORD LIST. The check asks WHO performs what: a sentence in which "I", "we" or the team has done, is
//      doing or will do something (escalated, flagged, checked, arranged, called …) is refused, because this path performs nothing —
//      unless it only describes what the record already shows (an open case, raised on a date, that the order is with the team) or is the
//      approved flag line verbatim. A negated sentence ("we cannot place phone calls", "it will not arrive today") is not a promise.
//   3. HAND-OFF IS A DECISION. needs_human is gone. The model names a reason from a closed list or says "none"; only a listed reason
//      hands off. Thanks, acknowledgements and reactions get one short line and no order details.
//
// Still deterministic around the model: the grounding gate for amounts, ids, dates, links, emails and phones, refund / replacement
// offers and time promises, evaluated per SENTENCE so one bad clause cannot take a good reply with it. No action field. Nothing here is
// called by the live handler and no existing rule module is read for its behaviour beyond the shared gate.

import { BUSINESS_TRUTHS, FLAG_REPLY } from "@/lib/businessTruths";
import { groundingViolations } from "@/lib/replyGrounding";
import { sanitiseModelText, leakedInternalTerms } from "@/lib/replySanitize";
import { teamHasItOpen, splitReplySentences } from "@/lib/replyClaims";
import { RULES } from "@/lib/strategyCatalogue";
import { withoutApprovedLines } from "@/lib/replyVerifier";
import { isAckOnly } from "@/lib/ackOnly";
import { ndrTitleReply } from "@/lib/ndrTitleReply";
import type { GeneralInput } from "@/lib/generalReply";

export const GENERAL_V2_VERSION = 2;
const MODEL = () => process.env.OPENAI_GENERAL_MODEL || "gpt-5-mini";
const TIMEOUT_MS = 25_000;

/** The only reasons a reply may hand off to a person. Anything else is answerable from the facts or needs one question. */
export const HANDOFF_REASONS = [
  "none", "damage_or_defect", "refund_or_return_decision", "legal_or_threat", "complaint_about_handling", "action_only_a_person_can_do", "cannot_answer_from_facts",
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export interface GeneralV2Result {
  draft: string | null;
  final: string | null;
  handOff: boolean;
  handoffReason: HandoffReason;
  /** Why the first draft was not used as written; null when it was. */
  firstBlocked: string[] | null;
  /** How the reply came to be: as written, rewritten by the model once, offending sentences dropped, or the flag line. */
  repair: "none" | "regenerated" | "dropped" | "flag";
  calls: number;
  tokens: number;
  ms: number;
  model?: string;
  error?: string;
}

export const GENERAL_V2_INSTRUCTIONS =
  "You are AJUKI's WhatsApp customer-support assistant. AJUKI is an online jewellery shop in India. Reply to the customer's latest message " +
  "in their language (English, or Hinglish in Latin letters), in one to three short, warm, plain sentences.\n\n" +
  "You may state ONLY: (1) the BUSINESS FACTS, (2) the CUSTOMER'S RECORD, (3) the PRODUCT FACTS. Anything else you do not know. Do not infer " +
  "a status the record does not state (a parcel that is 'shipped' is not 'out for delivery' unless the record says so).\n\n" +
  "How to answer:\n" +
  "- Use the conversation to understand a short or broken message. A message that continues a thread is about that thread's order or product.\n" +
  "- Answer from the facts whenever you can. Do not ask a question whose answer is in the facts, in the thread, or in the customer's own message. " +
  "Ask ONE specific question only when you truly cannot tell which order or product is meant.\n" +
  "- A thank-you, an acknowledgement or a reaction gets ONE short friendly line. Do not restate order details unless they asked.\n" +
  "- You CANNOT perform actions and you are not a person on the team. Never say that you or the team have done, are doing, or will do " +
  "something (escalated, flagged, checked, arranged, updated, called, cancelled). You may say what the RECORD shows: that an order is with the " +
  "team, that a support case was raised on a date, a status, a date, a link. If the customer asks for an action, say what the policy is from the facts.\n" +
  `- ${RULES.NO_REFUND_PROMISE}\n- ${RULES.NO_TIME_PROMISE}\n- ${RULES.RECORD_ONLY}\n` +
  "- Never offer to 'check' or 'look into' anything. Never mention internal field names, order-line markers or that you are an AI unless asked.\n" +
  "- handoff_reason: use 'none' unless a person's judgement is genuinely needed: 'damage_or_defect' (a damaged / wrong / faulty item), " +
  "'refund_or_return_decision', 'legal_or_threat', 'complaint_about_handling' (upset about how it was handled), 'action_only_a_person_can_do', " +
  "or 'cannot_answer_from_facts' (the facts do not contain the answer and a question would not help). A thank-you, a status question, a price, a " +
  "policy question and a follow-up are NOT hand-offs.\n\n" +
  "Conversation and tone (from the founder's review of real chats):\n" +
  "- Always read your own last reply. If the customer is following up on it (a reaction like 'Oohh', 'ok do it soon', 'please keep me updated', 'now how many days', " +
  "'not showing', or the same question again), do NOT say the same thing again. Move it forward: say the one new thing the facts allow, or the next step " +
  "(the Senior Support email), or, if there is truly nothing new, say so in one short line. Never paste the same answer twice.\n" +
  "- Answer what they actually said. If they talk about something else than your last reply (their home is near our warehouse, a different courier, " +
  "why it was cancelled), answer THAT, not the order status again.\n" +
  "- A late parcel is in the courier's hands: you may say the delay is on the courier's side or with the courier, but never quote the courier's own reason or note. Do not add a reassurance sentence yourself ('no need to worry', 'we are doing everything we can'): it is added to every late-parcel reply for you. " +
  "- NEVER mention courier scans, scan times, scan locations or courier scan texts (such as 'Manifest uploaded' or 'Item OFD at ...'). Customers do not understand them. " +
  "Give the order status in plain words, the expected date from the record, and www.ajuki.in/track. If the record says the parcel is stuck or overdue, say it is delayed, apologise once, and give the tracking page.\n" +
  "- If the order is returning to us (RTO, 'on its way back to our warehouse'): say so in one sentence, do NOT give the tracking link, do not offer to update the phone or address, " +
  "and tell them they can place a new order at www.ajuki.in. If they ask again for delivery, say the same kindly and briefly (a new order is the way), do not repeat the status.\n" +
  "- If a customer asks to cancel a dispatched order after complaining about the delay or service, say it cannot be cancelled after dispatch and use handoff_reason 'action_only_a_person_can_do' " +
  "with the Senior Support email. Do not just repeat the policy.\n" +
  "- A customer who says they have already emailed: thank them and ask which email address they wrote from; do not send them to email again. You cannot see the mailbox: " +
  "never say 'we see you have emailed' or that an email was received, seen or read.\n" +
  "- Never promise not to contact or disturb the customer ('we won't disturb you'). If they ask to be left alone, say 'Noted.' and nothing more.\n" +
  "- An address or phone change request you cannot do: ask for the details only to pass on, never say it is confirmed or updated; say the team will handle it only if the record shows an open case.\n" +
  "- Do not state a return pickup charge unless they ask about charges or are already raising a return.\n" +
  "- When the customer asks for something the facts do not cover and only a person can decide (choosing or avoiding a courier, a special delivery arrangement, a call), say plainly that you cannot promise it here, " +
  "give the Senior Support email, and use handoff_reason 'action_only_a_person_can_do'. Do not answer with the order status instead.\n" +
  "- Out of stock: say it once, with no restock date, then offer the in-stock variant and any matching combo with links. A follow-up on the same item ('not showing', 'Oohh', '499') gets one short line that moves on (a price if they asked for one, the same offer in a few words), never the whole answer again.\n" +
  "- Never answer a forwarded advert or chain message with 'Thanks for sharing'; code stays silent on those before you are asked.";

export function generalV2Schema() {
  return {
    name: "general_reply_v2",
    strict: true,
    schema: {
      type: "object",
      properties: { reply: { type: "string" }, handoff_reason: { type: "string", enum: [...HANDOFF_REASONS] } },
      required: ["reply", "handoff_reason"],
      additionalProperties: false,
    },
  };
}

// ── the checks, per sentence ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A cue that the sentence says it CANNOT or WILL NOT, so a call / delivery / time word in it is a statement, not a promise. */
const NEGATION = /\b(?:can(?:no|'|’)?t|cannot|can not|won(?:'|’)?t|will not|do not|don(?:'|’)?t|does not|doesn(?:'|’)?t|isn(?:'|’)?t|is not|are not|aren(?:'|’)?t|unable|not able|never|nahi|nahin|no longer)\b/i;
/** The rules the gate raises that are about a PROMISE; a negated sentence does not make one. */
const PROMISE_RULES = new Set(["callback", "delivery_promise", "reply_time"]);

/** Who did what. A performer ("I", "we", the team) with an action verb, in past, perfect, progressive or future. */
const PERFORMER = "(?:i|we|they|our (?:support |senior support )?team|the (?:support |senior support )?team|team members?|the agent|ajuki|support)";
const ACTION = "(?:escalat\\w*|flag\\w*|rais\\w*|forward\\w*|pass\\w*|inform\\w*|notif\\w*|updat\\w*|chang\\w*|cancel\\w*|book\\w*|arrang\\w*|refund\\w*|process\\w*|reschedul\\w*|contact\\w*|call\\w*|check\\w*|look\\w*|investigat\\w*|sort\\w*|resolv\\w*|fix\\w*|follow\\w*|get back|reach\\w*|send\\w*|saved?|noted?|register\\w*|record\\w*|confirm\\w*|respond\\w*|handl\\w*|repl(?:y|ies)|take care|work(?:ing)? on)";
const PERFORMED = new RegExp(
  `\\b${PERFORMER}\\s+(?:(?:has|have|had|'ve|’ve|already|just|also|am|are|is|was|were|will|shall|can|could|would|'ll|’ll)\\s+){1,3}${ACTION}\\b` +
  `|\\b${PERFORMER}(?:'ve|’ve|'ll|’ll)\\s+(?:already\\s+|just\\s+)?${ACTION}\\b` +
  `|\\b${PERFORMER}\\s+(?:escalated|flagged|raised|forwarded|informed|notified|updated|changed|cancell?ed|booked|arranged|refunded|processed|rescheduled|contacted|called|checked|investigated|noted|saved|registered)\\b` +
  `|\\bi(?:'ve|’ve)\\s+${ACTION}\\b`, "i");
/** What the record may legitimately say about the team: it already has it, a case was raised on a date. */
const RECORD_STATE = /\b(?:already|currently|now)\b[^.?!]{0,40}\bwith (?:the|our) (?:support |senior support )?team\b|\bwith (?:the|our) team\b[^.?!]{0,20}\b(?:raised|since|on)\b|\b(?:support )?case\b[^.?!]{0,50}\b(?:raised|open|opened)\b|\braised on\b|\b(?:the team|our team|they|it)\b[^.?!]{0,20}\b(?:is|are|has)\b[^.?!]{0,12}\b(?:handling|working on|looking at|got|with)\b/i;

const PASSIVE_ACTION = /\b(?:has|have|had) (?:already |now )?been (?:escalated|flagged|forwarded|passed(?: on| along| to)?|raised with)\b/i;

export interface SentenceIssue { sentence: string; reasons: string[] }
export interface AnalysisV2 { ok: boolean; issues: SentenceIssue[]; sanitised: string[]; text: string }

/** Check a draft sentence by sentence. Pure. */
export function analyseV2(draft: string, evidence: string[], context: string[]): AnalysisV2 {
  const san = sanitiseModelText(draft, [...evidence, ...context]);
  const openCase = teamHasItOpen(evidence);
  const issues: SentenceIssue[] = [];
  const keep = (s: string) => s;
  // Approved fixed lines inside the reply (the flag line, the pending-return line …) are ours and are not judged as claims.
  for (const sent of splitReplySentences(withoutApprovedLines(san.text)).map(keep)) {
    const why: string[] = [];
    const negated = NEGATION.test(sent);
    for (const v of groundingViolations(sent, evidence, context)) {
      if (negated && PROMISE_RULES.has(v.rule)) continue;
      why.push(`${v.rule}: ${v.detail}`);
    }
    // Negation is read per CLAUSE, not per sentence: "if you can't open the link, I'll confirm what the page shows" is negated only in its first half.
    const performerClause = sent.split(/[;,:—–]|\s-\s|\b(?:but|and|so)\b/i).find((c) => PERFORMED.test(c) && !NEGATION.test(c) && !(openCase && RECORD_STATE.test(c)));
    if (performerClause) why.push("performer_claim: says the team or the assistant did / does / will do something");
    // The passive says the same thing without naming who: "it has been escalated" (12 Oct: said of a stuck parcel with no case on record).
    else if (PASSIVE_ACTION.test(sent) && !openCase) why.push("performer_claim: says it has been escalated or passed on, and no open case in the record shows that");
    // "It is with the team" is a statement about the record: it needs a case in the record to rest on.
    else if (!openCase && !negated && RECORD_STATE.test(sent)) why.push("team_state_unsupported: says the team has this, but the record shows no open case");
    const leaks = leakedInternalTerms(sent);
    if (leaks.length) why.push(`internal_term: ${leaks.slice(0, 2).join(", ")}`);
    if (why.length) issues.push({ sentence: sent, reasons: why });
  }
  return { ok: issues.length === 0, issues, sanitised: san.changes, text: san.text };
}

/** The reply with the offending sentences removed, or null when nothing worth sending is left. */
export function dropOffending(text: string, issues: SentenceIssue[]): string | null {
  const bad = new Set(issues.map((i) => i.sentence));
  const kept = splitReplySentences(text).filter((s) => !bad.has(s));
  const out = kept.join(" ").trim();
  return out.length >= 20 ? out : null;
}

// ── the model ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GeneralV2Options { fetchImpl?: typeof fetch; model?: string }

function promptMessages(i: GeneralInput) {
  const system =
    `${GENERAL_V2_INSTRUCTIONS}\n\n=== BUSINESS FACTS ===\n${BUSINESS_TRUTHS.trim()}\n\n=== CUSTOMER'S RECORD ===\n${i.record || "(no orders found for this number)"}\n\n` +
    `=== PRODUCT FACTS ===\n${i.products || "(none matched this message)"}` + (i.note ? `\n\n${i.note}` : "");
  const turns = i.thread.slice(-10).map((t) => ({ role: (t.direction === "in" ? "user" : "assistant") as "user" | "assistant", content: t.body }));
  if (!turns.length || turns[turns.length - 1].role !== "user") turns.push({ role: "user", content: i.message });
  return [{ role: "system" as const, content: system }, ...turns];
}

export async function generalReplyV2(i: GeneralInput, o: GeneralV2Options = {}): Promise<GeneralV2Result> {
  const base: GeneralV2Result = { draft: null, final: FLAG_REPLY, handOff: true, handoffReason: "cannot_answer_from_facts", firstBlocked: null, repair: "flag", calls: 0, tokens: 0, ms: 0 };
  // Two cases decided in code, before any model call (zero tokens): a bare acknowledgement gets no reply, exactly as the live handler
  // does (lib/ackOnly.ts); and a typed button title ("Update phone", "Deliver tomorrow") gets a request or a statement from the record,
  // never an action promise (lib/ndrTitleReply.ts).
  if (isAckOnly(i.message)) return { ...base, final: "", handOff: false, handoffReason: "none", repair: "none" };
  const titled = ndrTitleReply(i.message, i.fullRecord ?? i.record);
  if (titled) return { ...base, draft: titled, final: titled, handOff: false, handoffReason: "none", repair: "none" };
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ...base, error: "no_key" };
  const model = o.model ?? MODEL();
  const started = Date.now();
  const f = o.fetchImpl ?? fetch;
  const messages = promptMessages(i);
  const evidence = [BUSINESS_TRUTHS, i.fullRecord ?? i.record, i.products].filter(Boolean);
  const context = [i.message, ...i.thread.map((t) => t.body)];
  let tokens = 0, calls = 0;

  const ask = async (extra?: string): Promise<{ reply: string; reason: HandoffReason } | { error: string }> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      calls++;
      const res = await f("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model, reasoning_effort: process.env.OPENAI_GENERAL_EFFORT || "low",
          response_format: { type: "json_schema", json_schema: generalV2Schema() },
          messages: extra ? [...messages, { role: "user", content: extra }] : messages,
        }),
        signal: ctl.signal,
      });
      if (!res.ok) return { error: `http_${res.status}` };
      const j: any = await res.json();
      tokens += j?.usage?.total_tokens ?? 0;
      let p: any = null;
      try { p = JSON.parse(j?.choices?.[0]?.message?.content ?? "null"); } catch { p = null; }
      if (!p || typeof p.reply !== "string" || !p.reply.trim()) return { error: "unparseable" };
      const reason = (HANDOFF_REASONS as readonly string[]).includes(p.handoff_reason) ? (p.handoff_reason as HandoffReason) : "cannot_answer_from_facts";
      return { reply: String(p.reply).trim(), reason };
    } catch (e) {
      return { error: e instanceof Error && e.name === "AbortError" ? "timeout" : "error" };
    } finally {
      clearTimeout(timer);
    }
  };
  const done = (r: Partial<GeneralV2Result>): GeneralV2Result => ({ ...base, ...r, calls, tokens, ms: Date.now() - started, model });

  const first = await ask();
  if ("error" in first) return done({ error: first.error });
  const a1 = analyseV2(first.reply, evidence, context);
  const handOff = (r: HandoffReason) => r !== "none";
  if (a1.ok) return done({ draft: first.reply, final: a1.text, handOff: handOff(first.reason), handoffReason: first.reason, repair: "none" });

  const blocked = a1.issues.flatMap((x) => x.reasons.map((r) => `${r} ← "${x.sentence.slice(0, 80)}"`));
  // 1. Ask once more, naming exactly what was refused.
  const feedback =
    "Your reply was refused for these statements:\n" + a1.issues.map((x) => `- "${x.sentence}" (${x.reasons.map((r) => r.split(":")[0]).join(", ")})`).join("\n") +
    "\nWrite the reply again. Keep everything that was fine. Remove or rephrase those statements using only the facts: state only what the record shows, " +
    "do not say that you or the team did or will do anything, and do not infer a status the record does not state.";
  const second = await ask(feedback);
  if (!("error" in second)) {
    const a2 = analyseV2(second.reply, evidence, context);
    if (a2.ok) return done({ draft: first.reply, final: a2.text, handOff: handOff(second.reason), handoffReason: second.reason, firstBlocked: blocked, repair: "regenerated" });
    // 2. Drop only the sentences that are still refused, if something worth sending is left.
    const kept = dropOffending(a2.text, a2.issues);
    if (kept && analyseV2(kept, evidence, context).ok) return done({ draft: first.reply, final: kept, handOff: handOff(second.reason), handoffReason: second.reason, firstBlocked: blocked, repair: "dropped" });
  }
  const kept1 = dropOffending(a1.text, a1.issues);
  if (kept1 && analyseV2(kept1, evidence, context).ok) return done({ draft: first.reply, final: kept1, handOff: handOff(first.reason), handoffReason: first.reason, firstBlocked: blocked, repair: "dropped" });
  // 3. Nothing usable.
  return done({ draft: first.reply, final: FLAG_REPLY, handOff: true, handoffReason: "cannot_answer_from_facts", firstBlocked: blocked, repair: "flag" });
}
