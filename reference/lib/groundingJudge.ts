// A second, independent reader for the one kind of invention a pattern cannot see: prose.
//
// lib/replyGrounding.ts catches an amount, a link, a date or a promise that was never in the sources. It cannot
// catch "many customers with sensitive skin find stainless steel comfortable" or a four-step plating-care routine —
// both fluent, both plausible, neither written anywhere in the founder's business truths. So the finished reply is
// handed to a separate call that has ONE job: list every factual statement, piece of advice or promise in it that
// the EVIDENCE does not support. Any such statement and the reply is not sent (see openaiSupport.ts).
//
// Two things this module is strict about, both from a review of the first version:
//
//  1. It FAILS CLOSED. If the verifier cannot run (error, timeout, unparseable answer) the result is `ok: false`
//     and the caller does not send the reply. The first version returned "no unsupported claims" on error, which
//     meant "could not check" read as "checked, fine" — the opposite of the guarantee it exists to give. One retry
//     first, because a single transient 5xx should not cost a customer their answer. Measured on 36 concurrent
//     calls: no failures, median 2.1 s, so failing closed costs next to nothing when the provider is healthy; when
//     it is not, the main model call fails too and the message escalates anyway.
//
//  2. Evidence is not context. The customer's own words, and what an earlier reply said, are given to the judge
//     as CONTEXT so it can follow the conversation — but they never make a statement "supported". Otherwise a
//     customer writing "your agent told me I'd get a refund" would let the reply "yes, your refund will be
//     processed" pass as grounded in the conversation.
//
// It is a verifier, not a writer: it never produces text for a customer, so it cannot add the very thing it exists
// to remove. LLM judges are not perfect (published work puts recall on real errors well below human), which is
// why this is the LAST of several checks and not the only one.

import { withTimeout } from "@/lib/withTimeout";
import { FLAG_REPLY } from "@/lib/businessTruths";
import { judgeKindsEnabled } from "@/lib/pipelineV2";

const BASE = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_JUDGE_MODEL || "gpt-5-mini";
/** The model that judges replies, for the decision trace (lib/decisionTrace.ts). */
export const JUDGE_MODEL = MODEL;
const TIMEOUT_MS = 12_000;
const ATTEMPTS = 2;

const SCHEMA = {
  name: "grounding_check",
  strict: true,
  schema: {
    type: "object",
    properties: { unsupported: { type: "array", items: { type: "string" } } },
    required: ["unsupported"],
    additionalProperties: false,
  },
};

export const INSTRUCTIONS =
  "You are a strict but fair fact-checker for a customer-support reply. EVIDENCE is the only source of allowed facts: " +
  "the business truths, the customer's own order record and the product catalogue. " +
  "CONVERSATION is what the customer and earlier replies said. It is context only and is NEVER evidence: " +
  "a statement is not supported because the customer said it, or because an earlier reply said it. " +
  "List every statement in the REPLY that asserts a fact, gives advice or instructions, makes a recommendation, " +
  "generalises about customers or products, or makes a promise or commitment, and is NOT supported by EVIDENCE. " +
  "A statement IS supported if EVIDENCE says it, paraphrases it, or it is an obvious direct implication (e.g. 'waterproof' supports 'safe in water'; " +
  "'we deliver only within India' supports 'we cannot ship abroad'). " +
  "Saying that an order, item or ID the customer named does NOT appear in EVIDENCE is supported when it indeed does not appear there. " +
  "Examples of UNSUPPORTED: care or cleaning tips, claims about skin or allergies, what a team will share or do beyond flagging, " +
  "how a process works, any price, policy or timing not written in EVIDENCE, and confirming something only the customer claimed. " +
  "IGNORE entirely: greetings, apologies, empathy, compliments, emojis, questions put to the customer, offers of further help " +
  "('let me know if you need anything'), restating what the customer asked, and any sentence saying the matter has been flagged to the team " +
  "or that the team is working on it. " +
  "Return each unsupported statement as a short quote. Return an empty list if every statement is supported.";

/**
 * The same job with the kinds of statement spelled out (lib/replyClaims.ts). Used only when SUPPORT_PIPELINE_V2 is on.
 *
 * What changed, and what deliberately did not:
 *  - A REQUEST for what the customer's own request needs (address details, an order number, a photo) is not a claim. The first
 *    version listed it as "an instruction not supported by evidence", which blocked "please send the new full address".
 *  - "X is not on record" is judged AGAINST the evidence: supported when the evidence really lacks X, unsupported when it has X.
 *  - "Please wait for their reply" is supported when the evidence shows something open with the team (the caller says so in
 *    EXEMPT; it is not decided here).
 *  - Promises, outcome claims ("I'll update it", "it will not be cancelled") and every fact, policy and amount still need evidence.
 *    Nothing here is a bypass for unsupported claims.
 */
export const INSTRUCTIONS_V2 =
  "You are a strict but fair fact-checker for a customer-support reply. EVIDENCE is the only source of allowed facts: " +
  "the business truths, the customer's own order record and the product catalogue. " +
  "CONVERSATION is context only and is NEVER evidence: a statement is not supported because the customer said it or an earlier reply said it. " +
  "Check ONLY these four kinds of statement, and list each one the EVIDENCE does not support: " +
  "(1) a FACT about an order, parcel, payment, refund, return, support case or product (a status, date, amount, courier, scan, link); " +
  "(2) a POLICY statement (what AJUKI allows, refuses, charges, or how a process works); " +
  "(3) a PROMISE or COMMITMENT (what we or the team will do, or when); " +
  "(4) an OUTCOME claim: that AJUKI has made, is making or will make a change to the order — cancelled it, changed its address, refunded, replaced or rescheduled it. " +
  "(A status the record already shows, such as 'delivered on 5 Oct' or 'refund in progress', is a FACT under (1): it is supported when EVIDENCE says it.) " +
  "A statement is supported if EVIDENCE says it, paraphrases it, or it is an obvious direct implication (e.g. 'waterproof' supports 'safe in water'). " +
  "An outcome claim about a change is supported only by EVIDENCE that says that change was made, or by an 'ACTION BEING PERFORMED' line for exactly that change. " +
  "These are NOT claims — never list them: a request for details needed to handle the customer's own request (their new address, " +
  "order number, a photo); a question put to the customer; a greeting, apology, thanks or empathy; an offer of further help; any sentence " +
  "saying the matter has been flagged to the team; and every sentence given under EXEMPT. " +
  "A statement that something is NOT on record (no reference number, no refund, no such order) is supported when EVIDENCE truly does not contain it, " +
  "and UNSUPPORTED only when EVIDENCE does contain it. " +
  "Examples of UNSUPPORTED: care or cleaning tips, claims about skin or allergies, what a team will share or do beyond flagging, " +
  "'I'll update it', 'it will not be cancelled', any price, policy or timing not written in EVIDENCE, and confirming something only the customer claimed. " +
  "Return each unsupported statement as a short quote. Return an empty list if every statement is supported.";

export type JudgeResult = { ok: true; claims: string[] } | { ok: false; reason: string };

/** What the judge is given, split by how far it may be trusted. `exempt` is the sentences the caller has already classified as
 *  not needing evidence (lib/replyClaims.ts); only read when SUPPORT_PIPELINE_V2 is on. */
export type JudgeSources = { evidence: string[]; context: string[]; exempt?: string[] };

async function once(reply: string, src: JudgeSources, key: string): Promise<JudgeResult> {
  const v2 = judgeKindsEnabled();
  try {
    const raw = await withTimeout(async (signal) => {
      const res = await fetch(BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MODEL,
          reasoning_effort: process.env.OPENAI_JUDGE_EFFORT || "low",
          response_format: { type: "json_schema", json_schema: SCHEMA },
          messages: [
            { role: "system", content: v2 ? INSTRUCTIONS_V2 : INSTRUCTIONS },
            {
              role: "user",
              content:
                `EVIDENCE:\n${src.evidence.filter(Boolean).join("\n\n")}\n\n` +
                `CONVERSATION (context only, not evidence):\n${src.context.filter(Boolean).join("\n") || "(none)"}\n\n` +
                (v2 && src.exempt?.length ? `EXEMPT (not claims; do not list):\n${src.exempt.map((e) => `- ${e}`).join("\n")}\n\n` : "") +
                `REPLY:\n${reply}`,
            },
          ],
        }),
        signal,
      });
      if (!res.ok) return { httpStatus: res.status } as const;
      return res.json();
    }, TIMEOUT_MS);
    if (!raw) return { ok: false, reason: "timeout" };
    if ("httpStatus" in raw) return { ok: false, reason: `http_${raw.httpStatus}` };
    const content = raw?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, reason: "empty_response" };
    const parsed = JSON.parse(content) as { unsupported?: unknown };
    if (!Array.isArray(parsed.unsupported)) return { ok: false, reason: "bad_shape" };
    return { ok: true, claims: parsed.unsupported.filter((x): x is string => typeof x === "string" && !!x.trim()) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 80) : "error" };
  }
}

/** Judge `reply` against the evidence. `ok: false` means "could not check" — never treat that as "fine". */
export async function judgeReply(reply: string, src: JudgeSources): Promise<JudgeResult> {
  const checked = reply.split(FLAG_REPLY).join(" ").trim();
  if (!checked) return { ok: true, claims: [] };
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, reason: "no_key" };
  let last: JudgeResult = { ok: false, reason: "not_run" };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    last = await once(checked, src, key);
    if (last.ok) return last;
    console.error(JSON.stringify({ event: "grounding_judge_failed", attempt, reason: last.reason }));
  }
  return last;
}
