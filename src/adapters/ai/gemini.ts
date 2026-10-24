// The shared support-reply logic — the system prompt, the response schema, the
// raw-JSON-to-decision step, RAG ranking — used by whichever model actually
// answers. It no longer calls any model API itself: WhatsApp and email replies
// both run through lib/openaiSupport.ts, and embeddings through lib/embeddings.ts
// (OpenAI text-embedding-3-large since 1 Sept 2026 — see that file for why we
// left Gemini). The name is historical; renaming it churns a dozen imports for
// nothing.
//
// Failure design, unchanged: an unset key, an API error, or unparseable output
// ends in ESCALATE, never a guessed answer. For an autonomous bot the failure
// mode has to be silence-to-a-human.

import { BUSINESS_TRUTHS, TRUTHS_PREAMBLE, USE_KNOWLEDGE_BASE } from "@policy/businessTruths";
import { PERSONA_V2 } from "@policy/personaV2";
import {
  DEFAULT_PERSONA,
  DEFAULT_EMAIL_PERSONA,
  coerceTag,
  type SupportTag,
} from "@engine/supportGuardrails";
import { checkReply } from "@engine/replyCheck";
import { ACTION_KINDS, type ActionKind } from "@engine/supportActions";
import { embed } from "@adapters/ai/embeddings";
import type { WaConfig } from "@engine/waSupport";

// ── Knowledge retrieval ──────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export type KnowledgeChunk = {
  id: string;
  kind: "policy" | "suggestion";
  topic: string;
  content: string;
  embedding: number[] | null;
};

/**
 * The few chunks most relevant to this question — never the whole corpus, which
 * is the point: a focused prompt answers better and cheaper. Falls back to
 * returning all chunks when the question can't be embedded or nothing is
 * embedded yet, because at our corpus size the whole set still fits a prompt and
 * a degraded-but-complete context beats an empty one.
 */
export async function retrieve(
  question: string,
  chunks: KnowledgeChunk[],
  k = 5,
  /**
   * Skip this function's own embed() call when the caller already has the
   * answer. retrieveChunks() in waSupport.ts embeds the question once to try
   * the pgvector RPC first; without this, its fallback path embedded the exact
   * same question a second time — same failure when Gemini is down, same cost
   * when it isn't. `undefined` (the default) preserves the old self-contained
   * behaviour for any other caller.
   */
  precomputedEmbedding?: number[] | null,
): Promise<KnowledgeChunk[]> {
  const usable = chunks.filter((c) => c.content.trim());
  if (usable.length <= k) return usable;

  const qv = precomputedEmbedding !== undefined ? precomputedEmbedding : await embed(question);
  const embedded = usable.filter((c) => Array.isArray(c.embedding) && c.embedding.length);
  if (!qv || !embedded.length) return usable.slice(0, Math.max(k, 8));

  return embedded
    .map((c) => ({ c, score: cosineSimilarity(qv, c.embedding!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.c);
}

// ── Reply generation ─────────────────────────────────────────────────────────

export type ConversationTurn = { direction: "in" | "out"; body: string };

export type SupportDecision = {
  action: "reply" | "escalate";
  /**
   * On "reply": the answer. On "escalate": the model's own acknowledgement to the
   * customer — apology plus the relevant facts (delivery date, window state) —
   * which beats a canned line precisely when the customer is upset. Absent when
   * the escalation came from a failure (API error, parse fail, keyword backstop),
   * where nothing model-written exists or is trusted; the caller falls back to
   * the fixed holding message.
   */
  text?: string;
  tag: SupportTag;
  reason?: string;             // present on escalate
  /**
   * An action the model wants taken on an order. Named apart from `action` above,
   * which is this module's own reply-or-escalate verdict.
   *
   * A request, not a decision: the caller re-checks ownership, whether anything
   * is booked and whether the value stands up before writing, and refuses far
   * more often than it obliges.
   */
  orderAction?: { kind: ActionKind; order_id: string } & Record<string, string>;
  meta: Record<string, unknown>;
};

// The response schema lives in lib/openaiSupport.ts now (OpenAI strict mode is
// stricter than Gemini's was). decisionFromModelOutput() below still validates
// the model's proposed order action against ACTION_KINDS.

// Exported, and shared verbatim with lib/openaiSupport.ts — see that file's
// header for why the prompt is the one thing that must never fork between
// providers. Everything else about a support reply (the model call, the
// schema, the timeout) is provider-specific by necessity; what may be said,
// what must never be invented and when to escalate is not, and forking it
// would mean every future fix landing on one provider and quietly not the
// other.
export function systemInstruction(
  config: WaConfig,
  chunks: KnowledgeChunk[],
  orderContext: string,
  productContext: string,
  catalogue: string,
  channel: "whatsapp" | "email" = "whatsapp",
  /**
   * Whether `chunks` came back ranked by relevance. False when the embeddings
   * API was down and retrieveChunks() fell back to the first ~8 chunks in
   * insertion order — injected below under "answer only from these" as if
   * authoritative when they may be nothing of the sort. Defaults true so every
   * existing caller and the ranked path are unaffected.
   */
  ranked = true,
): string {
  // Appended, not swapped. What may be said, what must never be invented and
  // when to escalate are the same job on both channels — forking that would mean
  // every future fix landing on one half and quietly not the other. Only the
  // medium differs, and that is all the email block covers.
  // Example order numbers inside the persona ("AJUKI710013") were being copied into real replies as if they were the
  // customer's. They are placeholders; make them look like placeholders.
  const base = (config.persona.trim() || PERSONA_V2).replace(/\bAJUKI\d{4,10}\b/g, "AJUKIxxxxxx");
  const persona = channel === "email"
    ? `${base}

=== THIS REPLY IS AN EMAIL ===
${config.email_persona.trim() || DEFAULT_EMAIL_PERSONA}`
    : base;
  const knowledge = chunks.length
    ? chunks.map((c) => `[${c.kind}${c.topic ? `: ${c.topic}` : ""}]\n${c.content}`).join("\n\n") +
      // Same shape as the empty-case hint below, and for the same reason: when
      // embeddings are down these snippets are the first few in insertion order,
      // not the best match, and the model was treating them as gospel. One line,
      // no hard gate — a blunt escalate-on-degraded would silence every reply
      // for the duration of an OpenAI blip.
      (ranked
        ? ""
        : "\n\n(Knowledge retrieval is degraded right now and these snippets may not be the most relevant — if you cannot answer confidently from them and the order details, set needs_human.)")
    : "(no policy snippets matched — if you cannot answer from the order details alone, set needs_human)";
  return (
    `${persona}\n\n` +
    `=== BUSINESS TRUTHS ===\n${USE_KNOWLEDGE_BASE ? knowledge : TRUTHS_PREAMBLE + "\n\n" + BUSINESS_TRUTHS}\n\n` +
    // The exact wording of the empty case is load-bearing. It used to read "ask
    // for their order ID or the phone number they ordered with" with no
    // condition attached — and a bare "Ya", with nothing else in the prompt to
    // answer, got that line recited as if it were the greeting itself.
    // Reproduced on one real customer three times across five days, on two
    // different models and both Gemini generations, which is what proves it was
    // the wording and not either model's judgement. Scoped to "only if this
    // message is actually about..." so an empty result stops reading as an
    // invitation to ask about orders on every quiet message.
    `=== ORDERS FOUND ===\n${orderContext || "(none registered, and none mentioned in this chat. Only ask for an order ID or WhatsApp number if THIS message is actually about an order, a delivery, or a return — never on a greeting, a product question, or small talk.)"}\n\n` +
    `=== CATALOGUE MATCHES (products this message may be about) ===\n${productContext || "(none matched — if they ask about a specific product you cannot see here, ask which product they mean; never invent prices or stock)"}\n\n` +
    // Plain keyword scoring (lib/productContext.ts), not understanding — a
    // short word shared with an unrelated product's name is enough to surface
    // it. Proven on a real thread: a photo established a silver snake chain
    // bracelet, and two turns later "there is 2mm size only" pulled in a wholly
    // different 2mm rope chain, which was then answered about confidently — on
    // both Gemini and GPT. Named here because the fix belongs in the prompt as
    // well as in the matcher: a fresh match must never outrank a product the
    // conversation has already established.
    `A catalogue match above may be wrong. If a product was already established ` +
    `earlier in this conversation — from a photo, a link, or an earlier message — ` +
    `and this message does not clearly name a different one, keep answering about ` +
    `THAT product and ignore a catalogue match that contradicts it. If you are not ` +
    `sure which product is meant, say so and ask, rather than naming one.\n\n` +
    // A real thread: the bot matched "Franco Chain - (silver)" correctly, whose
    // real slug is fox-chain-silver (a leftover from a rename), but sent
    // https://www.ajuki.in/products/franco-chain-silver-free-size instead —
    // it built a plausible-looking URL from the product's own name and the
    // size shown rather than copying the link actually given. "Never invent
    // prices or stock" above never named links, so this is named on purpose:
    // a product URL is the one piece of catalogue data that fails silently —
    // a wrong price gets questioned, a 404 gets clicked and reported hours
    // later as "the bot sent a broken link".
    `Any product link given above is the exact URL — copy it character for ` +
    `character. Never construct, guess, or reformat one from a product's name, ` +
    `size or colour, even if it looks like it would follow the same pattern.\n\n` +
    // Retrieval and the model's own memory point at the same policy chunk from
    // every angle on a running thread, and without this line each turn was
    // treated as a cold start: fade, then "is it waterproof", then "what about
    // sweat" drew the same paragraph three times, reworded each time, to one
    // real customer inside three minutes.
    `Check the conversation history before answering. If you already told this ` +
    `customer something in this thread, do not restate it — build on it, or ` +
    `answer only what is actually new in their latest message.` +
    // Fixed in code rather than in the live persona row, so they ship with the deploy and cannot drift from it.
    `\n\n=== HARD RULES (override everything above) ===\n` +
    `1. Never say or imply that the team will review, reconsider, look again at, or pass on a decision, and never promise any follow-up, ` +
    `reminder, chase, prioritisation or timeline, and never offer to resend a link or message — you cannot. A decision that has been made stays made.\n` +
    `2. Never claim an email, appeal, ticket or case exists unless it is stated in ORDERS FOUND. If the customer says they already emailed, ` +
    `do not confirm it: say "Our Senior Support Team is already working on your issue. Please wait for their reply."\n` +
    `3. Never offer or suggest a refund, a replacement or an exchange, not even as an alternative or a safety net. Mention one only to confirm a fact in ORDERS FOUND that the customer asked about.\n` +
    `4. Never describe the return policy, the return window conditions or the pickup-fee rules. For any question about them, say "You can find the details at www.ajuki.in/returns".` +
    `
5. If ORDERS FOUND shows a return filed on any order, never use the words "return window" or talk about days left to return, for any order, even to say it does not apply.` +
    `
6. Cancel an order only if its line in ORDERS FOUND says "can be cancelled by you directly" — that means nothing is booked and it was placed within the last 24 hours. For any other order do not cancel, and do not offer to.` +
    // Only sent when the customer has attached a picture, because there are no
    // words to narrow it down with. Format: name | price | stock | link.
    (catalogue
      ? `\n\n=== FULL CATALOGUE (every product we sell — the picture is almost certainly one of these) ===\n${catalogue}`
      : "")
  );
}

/**
 * Decide what to do with a customer message: reply, or escalate to a human.
 *
 * `chunks` are already retrieved (see retrieve). `history` is the recent thread
 * oldest-first, ending with the message being answered. Every uncertain path
 * ends in escalate — an unset key, an API error, unparseable output, the model's
 * own needs_human, a backstop keyword, or an empty reply.
 */
export type InlineImage = { base64: string; mimeType: string };

// Exported so lib/openaiSupport.ts takes the exact same call, and the two are
// interchangeable at the call site in lib/waSupport.ts behind one switch.
export type GenerateSupportReplyOpts = {
  message: string;
  history: ConversationTurn[];
  orderContext: string;
  productContext?: string;
  chunks: KnowledgeChunk[];
  /** Whether `chunks` are relevance-ranked. False when embeddings were down and
   *  retrieveChunks() returned them unranked — passed through to
   *  systemInstruction() so the prompt can say so. Defaults true. */
  chunksRanked?: boolean;
  config: WaConfig;
  /** Photos the customer just sent, attached to this turn so the model can look
   *  at them rather than being told one arrived. */
  images?: InlineImage[];
  /** Every product, for picture messages — see catalogueIndex. */
  catalogue?: string;
  /** Which medium the reply is for. Decides whether the email voice is applied. */
  channel?: "whatsapp" | "email";
};

// generateSupportReply() moved to lib/openaiSupport.ts — it is the only model
// call left, and there is no second provider to keep it neutral for. This file
// keeps the pieces that call site still shares: systemInstruction() above and
// decisionFromModelOutput() below.

/**
 * Raw JSON text → the decision. Shared with lib/openaiSupport.ts: once an HTTP
 * response has been received and its text extracted, everything after that —
 * what counts as a bad reply, an unknown action kind, an empty answer, whether
 * needs_human wins — is not provider knowledge, and forking it would mean a
 * rule tightened here silently staying loose on the other model. Each provider
 * is responsible only for detecting whether a response was received at all
 * (network failure, non-200, timeout) before calling this — that stays
 * provider-specific because the shapes of those failures differ.
 */
export function decisionFromModelOutput(textOut: string | undefined, meta: Record<string, unknown>): SupportDecision {
  let parsed: {
    reply?: string; tag?: string; needs_human?: boolean; reason?: string;
    action?: { kind?: string; order_id?: string } & Record<string, string>;
  } | null = null;
  try {
    parsed = textOut ? JSON.parse(textOut) : null;
  } catch {
    return { action: "escalate", tag: "other", reason: "ai_parse_fail", meta };
  }
  if (!parsed) return { action: "escalate", tag: "other", reason: "ai_parse_fail", meta };

  const tag = coerceTag(parsed?.tag);
  const reply = (parsed?.reply ?? "").trim();
  // Kept only when it names something we can actually do. An unknown kind is a
  // model hallucinating a capability, and is dropped rather than passed on.
  const rawAction = parsed?.action;
  const orderAction = rawAction && (ACTION_KINDS as readonly string[]).includes(rawAction.kind ?? "") && rawAction.order_id
    ? (rawAction as { kind: ActionKind; order_id: string } & Record<string, string>)
    : undefined;

  // Last gate before a customer sees it. The schema being satisfied says nothing
  // about whether the string is fit to send — two replies went out carrying the
  // model's own "[no tracking link available in provided data]". Checked here
  // rather than in either caller so both channels are covered by one rule.
  const bad = checkReply(reply);
  if (bad) {
    console.error(JSON.stringify({ event: "reply_rejected", rule: bad.rule, detail: bad.detail, tag }));
    Object.assign(meta, { rejected: bad });
  }

  if (parsed?.needs_human || !reply) {
    // The reply the model wrote alongside needs_human is its acknowledgement to
    // the customer. It has passed the same schema and rules as any answer, so it
    // is carried out for the caller to send in place of the canned holding line —
    // unless it was rejected above, in which case dropping it here is what makes
    // the caller fall back to the fixed holding message.
    return {
      action: "escalate",
      text: bad ? undefined : (reply || undefined),
      tag,
      reason: parsed?.reason || "needs_human",
      meta,
    };
  }
  // A reply we cannot vouch for is not repaired and sent. It takes the same
  // degrade as an API error: the holding line, and a person.
  if (bad) return { action: "escalate", tag, reason: `reply_rejected:${bad.rule}`, meta };

  return { action: "reply", text: reply, tag, meta, ...(orderAction ? { orderAction } : {}) };
}
