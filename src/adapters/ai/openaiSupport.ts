// OpenAI: an alternative to lib/gemini.ts for one job only — generating a
// support reply. Embeddings and knowledge retrieval stay on Gemini; switching
// those too would mean re-embedding the whole knowledge base on a different
// model, which nobody asked for and which lib/waSupport.ts's chunk retrieval
// does not need touched to try a different reply model.
//
// On trial from 9 Aug, compared head-to-head against gemini-2.5-flash-lite on
// real production threads replayed with their real order lookups, real
// product-context matches and real conversation history — not synthetic
// prompts. On the case that mattered — a customer's real shipped order sitting
// in context — Gemini discarded it and asked for an order ID three times
// running, on both Gemini generations; gpt-5-nano used it correctly every
// time. Slower (roughly 4-10x) and a little more expensive per reply, both
// accepted deliberately: correctness was asked for, not speed.
//
// systemInstruction() is imported from lib/gemini.ts rather than copied. What
// may be said, what must never be invented and when to escalate cannot be
// allowed to fork between providers — a rule tightened for one model and not
// the other is exactly how a customer gets two different answers depending on
// which one happened to answer their thread. decisionFromModelOutput() is
// shared for the same reason, one level down: once a response's raw JSON text
// is in hand, turning it into a decision (bad-reply checks, tag coercion,
// unknown-action handling, needs_human) is not provider knowledge either.
//
// Structured outputs use OpenAI's strict json_schema mode, which is stricter
// than Gemini's: every property must appear in `required`, so a field that is
// conceptually optional (reason, action) is typed nullable instead of omitted.
// Verified against a live call before this shipped — a malformed strict schema
// is a 400 on every single message, which would have taken the whole bot
// offline the moment the switch flipped.
//
// Same failure design as Gemini: an unset key, a bad response, unparseable
// output, or anything uncertain ends in escalate, never a guessed answer.

import {
  systemInstruction,
  decisionFromModelOutput,
  type GenerateSupportReplyOpts,
  type SupportDecision,
} from "@adapters/ai/gemini";
import { withTimeout } from "@engine/withTimeout";
import { BUSINESS_TRUTHS, FLAG_REPLY, USE_KNOWLEDGE_BASE } from "@policy/businessTruths";
import { groundingViolations, stripPromiseSentences, removeUnsupportedSentences } from "@engine/replyGrounding";
import { judgeReply, JUDGE_MODEL } from "@engine/groundingJudge";
import { withoutApprovedLines } from "@engine/replyVerifier";
import { decisionTraceEnabled, promptFingerprint } from "@engine/decisionTrace";
import { judgeKindsEnabled } from "@engine/pipelineV2";
import { exemptSentences, teamHasItOpen, hasSubstance, unsupportedByKind } from "@engine/replyClaims";
import { SUPPORT_TAGS, matchEscalateKeyword } from "@engine/supportGuardrails";
import { ACTION_KINDS } from "@engine/supportActions";
import { sanitiseModelText } from "@engine/replySanitize";

const BASE = "https://api.openai.com/v1/chat/completions";

// Not lib/gemini.ts's TEXT_TIMEOUT_MS/IMAGE_TIMEOUT_MS. Those were tuned
// against Gemini's ~1-2s baseline, and sharing them silently killed a real
// order: "I want to order clover bracelet" from a real customer took exactly
// 15003ms (ai_meta.usage: null, the timeout signature) and escalated to an
// unanswered human hold, while the surrounding successful replies on the same
// thread — same prompt, same matcher — ran 6.6-8.4s. gpt-5-nano is a
// reasoning model; the successful calls in that same thread spent
// 960-1,280 tokens on reasoning alone before answering, and that overhead is
// the baseline, not an outlier.
//
// 25s gives roughly 2x headroom over the highest normal (non-timeout) latency
// measured anywhere in this investigation (13.6s, in an earlier comparison).
// The image figure is scaled by the same ratio Gemini's own two numbers use
// (28/15 ~= 1.87x) rather than measured directly — no real photo has gone
// through gpt-5-nano's vision path yet, so treat this one as a starting point
// to revisit once ai_meta shows real image-turn latencies on this provider.
// Both stay far under the webhook's own ~300s function ceiling either way.
const TEXT_TIMEOUT_MS = 25_000;
const IMAGE_TIMEOUT_MS = 45_000;

// gpt-5-mini since 2026-09-03. It was rejected on the original trial for
// reproducing the photo-continuity wrong-product answer — but that bug was
// fixed at the shared layer afterwards (matchProducts drops bare dimension
// tokens; systemInstruction says a catalogue match can be wrong), so the axis
// it lost on is gone. The move up is for grounding headroom: the order context
// grew a lot (the payment fact, the refund line, the === CUSTOMER === block,
// the money breakdown) and a nano model has less room to read a dense prompt
// correctly. Smoke-tested at 6.9s / 448 reasoning tokens — inside TEXT_TIMEOUT
// with margin, no schema or temperature rejection. Both -mini and -nano sit in
// OpenAI's 2.5M-tokens/day shared-traffic free tier; the bot runs ~1.5M/day, so
// the 250k/day full-model tier was never an option. Revert = this one line, or
// OPENAI_MODEL in the env with no deploy.
const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

function apiKey(): string | null {
  return process.env.OPENAI_API_KEY || null;
}

// Strict mode requires every property in `required`; a field that Gemini's
// schema leaves optional (reason, action) is typed nullable here instead, and
// the model is expected to send null rather than omit it. additionalProperties
// is spelled out at both levels a nested object appears — strict mode enforces
// it per-object, not once for the whole schema.
// Exported for lib/openaiSupport.test.ts only: a malformed strict schema is a
// 400 on every single message (CLAUDE.md), so it is worth asserting statically
// that every property is in `required` and additionalProperties:false is set at
// each object level.
export const RESPONSE_SCHEMA = {
  name: "support_reply",
  strict: true,
  schema: {
    type: "object",
    properties: {
      reply: { type: "string" },
      tag: { type: "string", enum: [...SUPPORT_TAGS] },
      needs_human: { type: "boolean" },
      reason: { type: ["string", "null"] },
      action: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...ACTION_KINDS] },
              order_id: { type: "string" },
              phone: { type: ["string", "null"] },
              line1: { type: ["string", "null"] },
              line2: { type: ["string", "null"] },
              city: { type: ["string", "null"] },
              pincode: { type: ["string", "null"] },
            },
            required: ["kind", "order_id", "phone", "line1", "line2", "city", "pincode"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["reply", "tag", "needs_human", "reason", "action"],
    additionalProperties: false,
  },
};

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export async function generateSupportReply(opts: GenerateSupportReplyOpts): Promise<SupportDecision> {
  const { message, history, orderContext, productContext = "", chunks, chunksRanked = true, config, images = [], catalogue = "", channel = "whatsapp" } = opts;

  // Hard backstop first — identical to lib/gemini.ts, and has to run again
  // here rather than once upstream: whichever provider lib/waSupport.ts calls,
  // a legal threat or a chargeback must never reach a model at all.
  const kw = matchEscalateKeyword(message, config.escalate_keywords);
  if (kw) {
    return { action: "escalate", tag: "complaint", reason: `keyword: ${kw}`, meta: { keyword: kw } };
  }

  const key = apiKey();
  if (!key) {
    return { action: "escalate", tag: "other", reason: "ai_unconfigured", meta: {} };
  }

  const messages: { role: "system" | "user" | "assistant"; content: string | Part[] }[] = [
    { role: "system", content: systemInstruction(config, chunks, orderContext, productContext, catalogue, channel, chunksRanked) },
    ...history.map((t) => ({ role: (t.direction === "in" ? "user" : "assistant") as "user" | "assistant", content: t.body })),
  ];
  // Unlike Gemini, OpenAI has no requirement that the first turn be the
  // customer's — a system message always leads, so there is nothing to trim.
  // Still guarantee the message being answered is the final user turn, exactly
  // as the Gemini path does.
  if (!messages.length || messages[messages.length - 1].role !== "user" || messages[messages.length - 1].content !== message) {
    messages.push({ role: "user", content: message });
  }

  // Photos ride on the turn they arrived with, converted to a content-parts
  // array only when there is a photo to add — a plain string content is what
  // every other message keeps, matching how the API is normally used.
  if (images.length) {
    const last = messages[messages.length - 1];
    const text = typeof last.content === "string" ? last.content : message;
    last.content = [
      { type: "text", text },
      ...images.slice(0, 4).map((img): Part => ({
        type: "image_url",
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      })),
    ];
  }

  const started = Date.now();
  const raw = await withTimeout(async (signal) => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        // THE LATENCY LEVER.
        //
        // gpt-5-mini is a reasoning model and, left to its default budget, it
        // thinks for a long time before writing a word. Measured over 448 live
        // calls in the seven days to 2026-09-12: p50 11.4s, p90 20.5s, p99
        // 25.0s — which is TEXT_TIMEOUT_MS exactly — with 31% of calls over 15s
        // and 4% timing out into the canned holding message. The comment below
        // sized that timeout against a 6.9s smoke test and a 13.6s worst case;
        // both are now well under what this model actually does.
        //
        // Same prompt, same schema, measured against a real return question
        // with an order and five knowledge chunks:
        //   default   10.9s, 512 reasoning tokens
        //   low        5.3s,  64 reasoning tokens
        //   minimal    3.3s,   0 reasoning tokens
        // All three answered correctly. "low" keeps some deliberation for the
        // genuinely ambiguous turns — whether to escalate is a judgement, and
        // that is the call worth paying a little thinking for — while halving
        // the wait and putting p90 back inside the timeout.
        //
        // If escalation quality drops, this is the line to revisit before the
        // model choice: raise to "medium" (the default) rather than changing
        // MODEL, so only one variable moves.
        reasoning_effort: "low",
        // No temperature. gpt-5-nano rejects anything but its default (1) —
        // "Unsupported value: 'temperature' does not support 0.3 with this
        // model" — caught by a live smoke test before this ever reached a
        // customer. Gemini's 0.3 has no equivalent here.
        response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
      }),
      signal,
    });
    if (!res.ok) {
      console.error(JSON.stringify({ event: "openai_error", status: res.status, body: (await res.text()).slice(0, 300) }));
      return null;
    }
    return res.json();
  // Provider-specific ceiling — see this file's own TEXT_TIMEOUT_MS comment
  // for why it is not Gemini's. A request that blows even this wider budget
  // still has to fail into the same canned escalation rather than hang the
  // webhook.
  }, images.length ? IMAGE_TIMEOUT_MS : TEXT_TIMEOUT_MS);

  const usage = raw?.usage ?? null;
  const meta: Record<string, unknown> = {
    model: MODEL,
    latencyMs: Date.now() - started,
    chunkIds: chunks.map((c) => c.id),
    // Native OpenAI field names (prompt_tokens/completion_tokens), not
    // remapped to Gemini's (promptTokenCount/candidatesTokenCount). Nothing in
    // the app reads these by name today — grepped before relying on that —
    // and remapping would make ai_meta.usage lie about which provider actually
    // produced the numbers.
    usage,
    // The wording of the prompt this answer was written from, as a fingerprint (lib/decisionTrace.ts). Trace only.
    ...(decisionTraceEnabled() ? { promptHash: promptFingerprint(String(messages[0].content)) } : {}),
  };

  if (!raw) return { action: "escalate", tag: "other", reason: "ai_error", meta };

  const decision = decisionFromModelOutput(raw?.choices?.[0]?.message?.content, meta);
  if (!decision.text) return decision;

  // Tidy two harmless things BEFORE any check, so the text that is verified is the text that is sent (lib/replySanitize.ts): an
  // internal tag name written into a sentence, and a sample order number. Both used to cost the customer the whole answer.
  {
    const san = sanitiseModelText(decision.text, [BUSINESS_TRUTHS, orderContext, productContext, message, ...history.map((t) => t.body)]);
    if (san.changes.length) {
      decision.text = san.text;
      decision.meta = { ...decision.meta, sanitised: san.changes };
    }
  }

  // The founder's rule: the model states only the business truths, the customer's own order record and the
  // catalogue. Everything it was given is a legitimate source; anything else in the reply (an amount, order
  // number, date, link, email or phone it was never shown, a reply-time promise, an offer of a refund or
  // replacement, a callback, advice to refuse a parcel) means the reply is not sent. The customer gets the
  // fixed flag line instead and the team is pinged — see lib/replyGrounding.ts.
  // EVIDENCE is what AJUKI knows to be true; CONTEXT is what was said. The customer's words and earlier replies help the
  // verifier follow the thread but never make a statement supported (lib/groundingJudge.ts).
  const evidence = [
    BUSINESS_TRUTHS, orderContext, productContext, catalogue,
    ...(USE_KNOWLEDGE_BASE ? chunks.map((c) => c.content) : []),
  ];
  // An action the model is asking the system to perform (cancel, change address, change phone) is carried out by runAction
  // BEFORE the reply is sent, and the reply is replaced by the refusal text if it is refused. So a reply that says "your order has
  // been cancelled" is true by construction — but it is not written anywhere in the sources, and the verifier used to flag it.
  // Tell it what is happening, in the evidence, not the context.
  if (decision.orderAction) {
    const a = decision.orderAction;
    const fields = ["phone", "line1", "line2", "city", "pincode"].filter((k) => a[k]).map((k) => `${k}=${a[k]}`).join(", ");
    evidence.push(
      `ACTION BEING PERFORMED: the system is carrying out "${a.kind}" on order ${a.order_id}${fields ? ` (${fields})` : ""} as part of sending this reply, ` +
      `and sends the reply only if the action succeeds (if it is refused, the refusal reason is sent instead). A reply saying this change has been made is therefore supported.`,
    );
  }
  // What each check said, kept next to the reply (lib/decisionTrace.ts). The object is shared by reference, so the verdicts written
  // below reach every meta spread from this decision, including the flag line's. Trace only: nothing here changes a decision.
  const verify: Record<string, unknown> | null = decisionTraceEnabled() ? { judge: "not_run", judgeModel: JUDGE_MODEL, regen: "none" } : null;
  if (verify) decision.meta = { ...decision.meta, verify };
  const context = [message, ...history.map((t) => t.body)];
  const labelled = [`Customer: ${message}`, ...history.map((t) => `${t.direction === "in" ? "Customer" : "Earlier reply"}: ${t.body}`)];

  // Anything the checks cannot vouch for becomes the fixed flag line and a real escalation — never a repaired guess.
  const flag = (reason: string, extra: Record<string, unknown>): SupportDecision => {
    if (verify && verify.regen === "none") verify.regen = "flag_line"; // nothing was salvaged: the fixed line goes out
    return {
      action: "escalate", tag: decision.tag, text: FLAG_REPLY, reason,
      meta: { ...decision.meta, ...extra, withheld: decision.text, provenance: "fixed:flag" },
    };
  };

  let candidate: SupportDecision = decision;
  const violations = groundingViolations(decision.text, evidence, context);
  if (verify) verify.gate = violations.map((v) => v.rule).slice(0, 6);
  if (violations.length) {
    // Only a time promise is wrong (the persona's own "within 3-5 business working hours" closing line): cut that
    // sentence and keep the rest, provided what is left is clean. A hand-off is then closed with the flag line.
    if (violations.every((v) => v.rule === "reply_time" || v.rule === "delivery_promise")) {
      const kept = stripPromiseSentences(decision.text);
      if (kept && !groundingViolations(kept, evidence, context).length) {
        const text = decision.action === "escalate" && !/\b(?:flagged|escalated)\b/i.test(kept) ? `${kept} ${FLAG_REPLY}` : kept;
        candidate = { ...decision, text, meta: { ...decision.meta, grounding: violations, repaired: true, ...(verify ? { preRepair: decision.text } : {}) } };
      }
    }
    if (candidate === decision) {
      console.error(JSON.stringify({ event: "reply_ungrounded", rules: violations.map((v) => v.rule), detail: violations.map((v) => v.detail).slice(0, 4) }));
      return flag(`ungrounded: ${violations.map((v) => v.rule).join(",")}`, { grounding: violations });
    }
  }

  // The independent read. FAIL CLOSED: if it cannot run, the reply is not sent.
  const v2 = judgeKindsEnabled();
  const openCase = v2 && teamHasItOpen(evidence);
  const exemptOf = (t: string) => (v2 ? exemptSentences(t, { openCase, evidence }) : undefined);
  const kindClaims = (t: string) => (v2 ? unsupportedByKind(t, { openCase, evidence }) : []);
  const exemptFirst = exemptOf(candidate.text ?? "");
  // Our own approved sentences ("I have flagged this to the team and we are working on it.", "I have escalated this to the team.") are not claims
  // for the judge to check: on 15-17 Oct it listed them as unsupported and the customer got the flag line instead of the answer.
  const judged = await judgeReply(withoutApprovedLines(candidate.text ?? ""), { evidence, context: labelled, exempt: exemptFirst });
  if (!judged.ok) {
    console.error(JSON.stringify({ event: "reply_unverified", reason: judged.reason }));
    if (verify) verify.judge = "unavailable";
    return flag(`verifier_unavailable: ${judged.reason}`, { grounding: [{ rule: "verifier_unavailable", detail: judged.reason }] });
  }
  // Claims that are unsupported by their KIND (an action promise with no action in progress, a wait with nothing open) are added
  // here, so the judge's attention is not what stands between them and the customer.
  const kindFirst = kindClaims(candidate.text ?? "");
  const claims = [...new Set([...kindFirst, ...judged.claims])];
  if (verify) {
    verify.judge = claims.length ? "claims" : "ok";
    verify.claims = judged.claims.length;
    verify.kind_claims = kindFirst.length;
    verify.exempt = exemptFirst?.length ?? 0;
  }
  if (claims.length) {
    console.error(JSON.stringify({ event: "reply_unsupported", claims: claims.slice(0, 4) }));
    // One repair at most: cut the quoted sentences, then check what is LEFT in full — the mechanical gate and the
    // verifier again. A remainder the verifier missed an unsupported claim in must not be sent just because the
    // first pass did not quote it.
    const unsupportedFlag = () => flag("ungrounded: unsupported_claim", { grounding: [{ rule: "unsupported_claim", detail: claims.join(" | ").slice(0, 300) }] });
    // A reply that is already a hand-off to the team is not worth repairing: once its unsupported part is cut, what is
    // left is usually a true but irrelevant line ("we offer Cash on Delivery" in answer to an open-box question).
    // The flag line says everything that is needed.
    const kept = removeUnsupportedSentences(candidate.text ?? "", claims);
    // A hand-off whose unsupported part is cut used to be thrown away whole, however useful the rest was (10 Oct: "your original
    // order #AJUKI710078 is with the team, raised 9 Oct" was lost with one unsupported closing line). With the pipeline fixes on, the
    // remainder is kept when it still carries something specific to THIS customer — an order number, an amount, a date or a link —
    // and it then goes through the gate and the judge again like any repair. A remainder that is only a generic line still flags.
    if ((candidate.action as string) === "escalate" && !(v2 && kept && hasSubstance(kept))) return unsupportedFlag();
    if (!kept) return unsupportedFlag();
    const text = candidate.action === "escalate" && !/\b(?:flagged|escalated)\b/i.test(kept) ? `${kept} ${FLAG_REPLY}` : kept;
    if (groundingViolations(text, evidence, context).length) return unsupportedFlag();
    const again = await judgeReply(withoutApprovedLines(text), { evidence, context: labelled, exempt: exemptOf(text) });
    if (!again.ok && verify) { verify.regen = "cut_unsupported"; verify.second = "unavailable"; }
    if (!again.ok) return flag(`verifier_unavailable: ${again.reason}`, { grounding: [{ rule: "verifier_unavailable", detail: again.reason }] });
    const againClaims = [...new Set([...kindClaims(text), ...again.claims])];
    if (verify) { verify.regen = "cut_unsupported"; verify.second = againClaims.length ? "claims" : "ok"; }
    if (againClaims.length) return flag("ungrounded: unsupported_claim_after_repair", { grounding: [{ rule: "unsupported_claim", detail: againClaims.join(" | ").slice(0, 300) }] });
    candidate = { ...candidate, text, meta: { ...candidate.meta, repaired: true, removed: claims.slice(0, 4), ...(verify && !candidate.meta.preRepair ? { preRepair: candidate.text } : {}) } };
  }
  return { ...candidate, meta: { ...candidate.meta, provenance: candidate.meta.repaired ? "model_repaired_verified" : "model_verified" } };
}
