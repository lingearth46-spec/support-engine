// AI WhatsApp customer support — storage + orchestration.
//
// This module owns the four wa_* tables (see supabase-migration-wa-support.sql).
// It is split from the webhook so the logic is testable without a live Meta
// callback, and so both the webhook and the admin API write conversations the
// same way rather than each inventing its own shape.
//
// Everything keys on the last-10-digit phone (normalizePhone), which is the same
// key orders, conversations and messages all join on.
//
// Phase 0 is the storage primitives below. The orchestrator that decides between
// an AI reply and an escalation is added in a later phase and lives here too, so
// there is one place that knows how a customer message becomes a conversation.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";
import { sendWhatsApp, sendWhatsAppCta, fetchWhatsAppMedia } from "@/lib/whatsapp";
import { notify, sendWithButtons, tgPhone, waLink, type InlineKeyboard } from "@/lib/telegram";
import { encodeCallback } from "@/lib/telegramCallback";
import {
  classifyFaultClaim, gateProposal, matchItemChoice,
  holdingMessage, askItemMessage, askPhotoMessage,
  type FaultKind,
} from "@/lib/assistedResolution";
import { retrieve, type ConversationTurn, type KnowledgeChunk } from "@/lib/gemini";
import { embed } from "@/lib/embeddings";
// The reply model. Was a provider switch (Gemini vs OpenAI) from 9 Aug; Gemini
// dropped entirely 1 Sept — its key's project sat on Google's free tier (20
// requests/day) with no working billing, and on the head-to-head it discarded
// the customer's order from context and asked for an order ID three times
// running where gpt-5-nano used it every time. workflows/support-bot.md has the
// comparison. Embeddings also moved off Gemini — see lib/embeddings.ts.
import { generateSupportReply } from "@/lib/openaiSupport";
import { isAckOnly, isAckAfterClose } from "@/lib/ackOnly";
import { phoneChangeNumber } from "@/lib/phoneChange";
import { recentCourierAddressEdit } from "@/lib/courierAddressEdit";
import { notACustomer } from "@/lib/autoReply";
import { isAbusive } from "@/lib/abuse";
import { newRequestKind } from "@/lib/newRequest";
import { FLAG_REPLY, USE_KNOWLEDGE_BASE } from "@/lib/businessTruths";
import { finalGuard } from "@/lib/finalGuard";
import { isWithinSupportHours, OUT_OF_HOURS_MESSAGE, OUT_OF_HOURS_MESSAGE_LEGACY } from "@/lib/supportHours";
import { configuredReplyDelayMs, delayToApply, elapsedInBatchMs, withQuietWait } from "@/lib/replyDelay";

import {
  parseScanInstant, recordScan,
  normalizeDelhiveryScan, normalizeShadowfaxScan, type NormalizedScan,
} from "@/lib/parcelScan";
import { trackDelhivery } from "@/lib/delhivery";
import { trackShadowfax } from "@/lib/shadowfax";
// OrderRow, the column lists and formatOrders moved to lib/orderLines.ts — an
// import-free module — so the per-order text the model reads can be unit-tested
// (this module throws at import: productContext builds a Sanity client with no
// projectId). Re-exported below so lib/emailSupport.ts and the admin support
// routes keep importing them from here unchanged.
import {
  formatOrders, ORDER_COLUMNS, ORDER_COLUMNS_WITH_SCAN, day, type OrderRow, type RefundLine,
} from "@/lib/orderLines";
import { catalogueIndex, productContext } from "@/lib/productContext";
import {
  DEFAULT_ESCALATE_KEYWORDS, hasReturnIntent, hasRefundIntent, hasBillingIntent,
  hasCancellationIntent, matchEscalateKeyword,
} from "@/lib/supportGuardrails";
import { alreadyAcknowledged, repeatsLastReply, repeatsRecentReply, addsNewContent, hasAnswerable, HELD_NEW_INFO_ACK } from "@/lib/waBurst";
import { pipelineV2Enabled } from "@/lib/pipelineV2";
import { menuMayApply } from "@/lib/menuFlows";
import { scopeOrders } from "@/lib/orderScope";
import { completenessShadow, completenessShadowEnabled } from "@/lib/completenessShadow";
import { generalShadowEnabled, runGeneralShadow, sampled as shadowSampled, storeGeneralShadow } from "@/lib/generalShadow";
import { deliveryAgentMode, deliverySampled, runDeliveryShadow, runDeliveryLive, storeDeliveryShadow, hasAwaitingCase } from "@/lib/deliveryShadow";
import { dateFromMessage, deferLine } from "@/lib/deliveryActionReply";
import { lateEscalation } from "@/lib/lateEscalate";
import { phoneAnyHour } from "@/lib/phoneAnyHour";
import { updatesMode } from "@/lib/deliveryUpdatesRun";
import { bookedOrderForAddressEdit, ADDRESS_FLAG_REPLY } from "@/lib/topicReplies";
import { runTicketRequest } from "@/lib/deliveryTicketExecutor";
import { suppressionAlert } from "@/lib/deliveryAlert";
import { runCourierAction } from "@/lib/deliveryCourierAction";
import { withAgentFacts } from "@/lib/deliveryFacts";
import { parkAddressEditPending } from "@/lib/bookedAddressEdit";
import { generalLiveEnabled, liveSampled, eligibleForLive, generalLiveDecision, withoutScanText } from "@/lib/generalLive";
import { recordFor } from "@/lib/replyVerifier";
import { applyOverrides, firstTouchDecision, lastBotReplyOf, type OverrideInput } from "@/lib/replyOverrides";
import { classifySituation, compareToActual } from "@/lib/situation";
import { teamHasItOpen } from "@/lib/replyClaims";
import { buildTrace, decisionTraceEnabled, silentTrace, withTraceOutcome, writeInboundTrace, type DecisionTrace, type TraceOutcome } from "@/lib/decisionTrace";
import { resolveCustomer } from "@/lib/customerIdentity";
import { openOrReuseCase, closedStatusFilter } from "@/lib/supportCases";
import { MEDIA_ON_R2, WA_MEDIA, putMedia } from "@/lib/r2Media";
import { signTrackLink } from "@/lib/trackLink";

// Re-exported so the webhook and the admin API keep importing conversation
// behaviour from one place, even though the decisions themselves live in a
// module that imports nothing and can therefore be tested.
export { alreadyAcknowledged, supersededInBatch, RE_ACK_QUIET_MS } from "@/lib/waBurst";

const ADMIN_INBOX = "https://www.ajuki.in/admin/support";

/**
 * How long a reply should take, counted from the moment the message arrived.
 *
 * An answer that lands the instant a customer hits send announces a machine.
 * This is a floor, not an added pause: the model already spends two to four
 * seconds thinking, so only the remainder is waited out — the reply feels
 * considered without pushing the webhook towards Meta's retry timeout.
 */
const REPLY_FLOOR_MS = 5000;

/** Wait out the remainder of the reply floor, if any. */
async function pace(startedAt: number): Promise<void> {
  const left = REPLY_FLOOR_MS - (Date.now() - startedAt);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

/**
 * Who produced an outbound row.
 *
 * 'agent' is the supervisor agent (app/api/mcp) reporting a conclusion about a
 * case — deliberately distinct from 'ai', the reply bot answering a customer,
 * and from 'system', a template or automated notification. The first time one of
 * these reads badly the question will be "which of our things sent that", and
 * the answer has to be in the row.
 */
export type MessageSource = "customer" | "ai" | "admin" | "system" | "agent";

/** Everything the bot needs to decide *whether* to answer. Deliberately without
 *  the persona blobs: those are 21 KB of prompt text on a row that every gating
 *  read used to pull in full. `select("*")` here measured 8.9 KB compressed and
 *  was fetched once per thread per email-poll pass — about 32 MB of Supabase
 *  egress a day for text that the gating path never reads. */
export type WaConfigFlags = {
  id: number;
  enabled: boolean;
  escalate_keywords: string[];
  holding_message: string;
  /** Email channel on at all. Separate from `enabled`, which is the master
   *  switch for every channel. */
  email_enabled: boolean;
  /** Whether an email reply goes out on its own or waits to be approved.
   *  Defaults false: email is permanent, forwardable and quotable in a way a
   *  chat message is not. */
  email_auto_reply: boolean;
};

/** The flags plus the prompt text, for the one job that needs it: generating a
 *  reply. `systemInstruction` takes this type and not `WaConfigFlags`, so a path
 *  that reaches the model without having loaded the personas is a type error
 *  rather than a silent fall back to DEFAULT_PERSONA — which is exactly the
 *  failure `workflows/` already records once, where a persona edited in code did
 *  nothing because the stored row was what actually ran. */
export type WaConfig = WaConfigFlags & {
  persona: string;
  /** Extra instructions applied only to email, appended to `persona` rather
   *  than replacing it — the rules about what may be said are the same job on
   *  both channels; only the medium differs. Blank falls back to the code
   *  default. */
  email_persona: string;
  /** Extra instructions applied only to Instagram DMs. Same layering as
   *  `email_persona`. Blank falls back to the code default. */
  instagram_persona: string;
};

export type WaConversation = {
  phone: string;
  name: string | null;
  last_in_at: string | null;
  last_out_at: string | null;
  status: "open" | "ai_handled" | "escalated";
  escalated: boolean;
  escalate_reason: string | null;
  last_tag: string | null;
  taken_over: boolean;
  unread: boolean;
  last_preview: string | null;
  updated_at: string;
  /** A note a human left on this thread. Never shown to the customer. */
  admin_note?: string | null;
  /** The order the conversation turned out to be about, once identified. */
  order_id?: string | null;
  /** "We asked for a value and are waiting for their next message" — the NDR
   *  button flows (lib/ndrButtonReply.ts, kind ndr_phone / ndr_address) and the
   *  out-of-hours wake queue (kind wake_reply). Absent before the migration. */
  pending_action?: { kind: string; [k: string]: unknown } | null;
};

// A conversation preview is the last thing said, trimmed to a line — long enough
// to recognise the thread, short enough to list a hundred of them.
const preview = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 120);

/** The columns the gating path reads. Named explicitly rather than `*` because
 *  `*` drags the three persona blobs along — 21 KB of prompt text that only
 *  `systemInstruction` ever looks at. */
const FLAG_COLUMNS = "id, enabled, escalate_keywords, holding_message, email_enabled, email_auto_reply";

const flagFallback = (): WaConfigFlags => ({
  // The backstop is armed by default, in both the fallback and the read below.
  // It used to default to [] here while only the admin GET substituted the real
  // list, which meant the legal-threat and chargeback guard was live purely
  // because somebody had once opened the Knowledge tab and pressed Save —
  // clearing that column, or losing the row, disarmed it in silence. A safety
  // net whose default is "off" is not a safety net.
  id: 1, enabled: false, escalate_keywords: [...DEFAULT_ESCALATE_KEYWORDS],
  // Email defaults to drafting rather than sending, and the fallback used when
  // the config row cannot be read must agree — a deploy that loses the row
  // should not start emailing customers unreviewed.
  email_enabled: true, email_auto_reply: false,
  holding_message:
    "I'm really sorry for the trouble 🙏 I'm not able to fully resolve this " +
    "myself right now, I've escalated it to my senior, who will get back to " +
    "you. Thank you for your patience.",
});

function toFlags(data: Record<string, unknown>): WaConfigFlags {
  const fallback = flagFallback();
  return {
    id: 1,
    enabled: Boolean(data.enabled),
    // An empty stored array is treated as "never configured", not as "configured
    // to nothing": [] is the column's own migration default, so the two are
    // indistinguishable, and of the two readings only one is safe. Someone who
    // genuinely wants no backstop can disable the bot.
    escalate_keywords: Array.isArray(data.escalate_keywords) && data.escalate_keywords.length
      ? (data.escalate_keywords as string[])
      : [...DEFAULT_ESCALATE_KEYWORDS],
    holding_message: (data.holding_message as string) || fallback.holding_message,
    // `?? fallback` rather than Boolean(): before the email migration runs these
    // columns do not exist, and reading undefined as false would silently switch
    // the email channel off rather than leaving it at its default.
    email_enabled: (data.email_enabled as boolean) ?? fallback.email_enabled,
    email_auto_reply: (data.email_auto_reply as boolean) ?? fallback.email_auto_reply,
  };
}

/** The single-row brain, without the prompt text. Falls back to a safe disabled
 *  default if the row or the table is missing, so a misconfigured deploy stays
 *  silent rather than throwing inside a webhook that must always return 200.
 *
 *  Read fresh every time on purpose — `enabled` is the master kill switch and
 *  lives in the database precisely so it can be flipped without a deploy the
 *  second something goes wrong. Caching it would put a delay on that. Dropping
 *  the persona columns is what makes reading it every time cheap. */
export async function getSupportConfig(db: SupabaseClient): Promise<WaConfigFlags> {
  const { data } = await db.from("wa_support_config").select(FLAG_COLUMNS).eq("id", 1).maybeSingle();
  if (!data) return flagFallback();
  return toFlags(data as Record<string, unknown>);
}

/** The config *with* the persona blobs, for the reply-generating path only.
 *  Every other caller wants `getSupportConfig`. */
export async function getSupportConfigWithPersonas(db: SupabaseClient): Promise<WaConfig> {
  const { data } = await db.from("wa_support_config").select("*").eq("id", 1).maybeSingle();
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    ...(data ? toFlags(row) : flagFallback()),
    persona: (row.persona as string) ?? "",
    email_persona: (row.email_persona as string) ?? "",
    // Undefined until supabase-migration-instagram-persona.sql is run, and the
    // code ships before the column exists — so this degrades to the built-in
    // default rather than to an empty persona, which would strip every
    // Instagram-specific rule while still answering customers.
    instagram_persona: (row.instagram_persona as string) ?? "",
  };
}

export async function getConversation(
  db: SupabaseClient,
  phone: string,
): Promise<WaConversation | null> {
  const { data } = await db.from("wa_conversations").select("*").eq("phone", phone).maybeSingle();
  return (data as WaConversation) ?? null;
}

/**
 * The key every wa_* table uses: the bare ten digits. Senders that held the number as stored on an order ("+91…") used to
 * write it as-is, which split one customer into two conversations. Anything that is not a ten-digit number is left alone.
 */
export const waKey = (phone: string): string => { const k = normalizePhone(phone); return k.length === 10 ? k : phone; };

/** Upsert the conversation row, merging only the fields given so state the caller
 *  did not touch — taken_over, escalated — is preserved across messages. */
export async function patchConversation(
  db: SupabaseClient,
  phone: string,
  patch: Partial<Omit<WaConversation, "phone" | "updated_at">>,
): Promise<void> {
  await db
    .from("wa_conversations")
    .upsert({ phone: waKey(phone), ...patch, updated_at: new Date().toISOString() }, { onConflict: "phone" });
}

/**
 * Insert one message. Returns { duplicate: true } when wa_message_id has been
 * seen before — Meta retries webhooks, and for an autonomous bot a duplicate is
 * a second reply to the same question, so the caller must bail on it.
 */
async function insertMessage(
  db: SupabaseClient,
  row: {
    phone: string;
    direction: "in" | "out";
    body: string;
    source: MessageSource;
    wa_message_id?: string | null;
    tag?: string | null;
    order_id?: string | null;
    ai_meta?: unknown;
    media_path?: string | null;
    media_kind?: string | null;
  },
): Promise<{ duplicate: boolean; createdAt?: string; id?: string }> {
  // created_at comes back from the database rather than being taken from this
  // process's clock, because it is compared against other rows' timestamps to
  // decide whether a reply has been overtaken — a comparison a few seconds of
  // skew would silently corrupt.
  //
  // The id comes back so the caller can go on to stamp order_id on this row once
  // it knows which order the message turned out to be about — which is only
  // knowable after the orders have been resolved, several steps later.
  const { data, error } = await db.from("wa_messages").insert({
    phone: waKey(row.phone),
    direction: row.direction,
    body: row.body,
    source: row.source,
    wa_message_id: row.wa_message_id ?? null,
    tag: row.tag ?? null,
    order_id: row.order_id ?? null,
    ai_meta: row.ai_meta ?? null,
    media_path: row.media_path ?? null,
    media_kind: row.media_kind ?? null,
  }).select("id, created_at").maybeSingle();
  // 23505 = unique_violation on wa_message_id: a retry of a message we handled.
  if (error?.code === "23505") return { duplicate: true };

  // The media column arrives by migration, and a migration is run by hand while
  // a deploy is not. If the code lands first, every insert here would fail and
  // every customer message would be dropped — the whole inbox, for a column that
  // only matters to photos. So drop the column and store the message instead.
  // PGRST204 is PostgREST's "column not in schema cache", 42703 is Postgres's
  // own "undefined column".
  if (error && (error.code === "PGRST204" || error.code === "42703")) {
    console.warn(
      "[support] a wa_messages media column is missing — run " +
      "supabase-migration-wa-media.sql and supabase-migration-wa-media-kind.sql",
    );
    const core = {
      phone: waKey(row.phone),
      direction: row.direction,
      body: row.body,
      source: row.source,
      wa_message_id: row.wa_message_id ?? null,
      tag: row.tag ?? null,
      order_id: row.order_id ?? null,
      ai_meta: row.ai_meta ?? null,
    };
    // Give up the columns one at a time, newest first, rather than both at once.
    // media_path has been live for a while and media_kind has not, so the common
    // case here is that only the second is missing — and dropping both would
    // throw away the pointer to a customer's return photo for every message sent
    // between the deploy and the migration. Losing the message is unthinkable;
    // losing more than we have to is merely careless.
    for (const attempt of [
      { ...core, media_path: row.media_path ?? null },
      core,
    ]) {
      const retry = await db.from("wa_messages").insert(attempt).select("id, created_at").maybeSingle();
      if (retry.error?.code === "23505") return { duplicate: true };
      if (!retry.error) return { duplicate: false, createdAt: retry.data?.created_at, id: retry.data?.id };
      if (retry.error.code !== "PGRST204" && retry.error.code !== "42703") throw retry.error;
    }
    throw error;
  }

  if (error) throw error;
  return { duplicate: false, createdAt: data?.created_at, id: data?.id };
}

/**
 * Keep a customer's photo where the admin panel can show it.
 *
 * The bot's description of an image is enough to answer with and not enough to
 * decide a return on — the person approving a damage claim needs the picture.
 * The bucket is private; the panel signs a short-lived link when it draws the
 * thread. Returns null on any failure, because losing the file is a smaller
 * problem than dropping the message it came with.
 */
export async function storeMedia(
  db: SupabaseClient,
  phone: string,
  bytes: Buffer,
  mimeType: string,
): Promise<string | null> {
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
  const path = `${phone}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  // The path returned is identical either way — it is bucket-relative, and R2
  // takes the old bucket name as a key prefix — so a row written before the
  // switch and one written after are indistinguishable, and reading either
  // needs no knowledge of which store it landed in.
  if (MEDIA_ON_R2) {
    return (await putMedia(WA_MEDIA, path, bytes, mimeType)) ? path : null;
  }

  const { error } = await db.storage.from("wa-media").upload(path, bytes, { contentType: mimeType, upsert: false });
  if (error) {
    console.error("[support] media upload failed:", error.message);
    return null;
  }
  return path;
}

/**
 * A customer message arrived. Logs it and moves the conversation to the top of
 * the inbox as unread. Returns { duplicate } so a retried webhook is a no-op.
 */
export async function recordInbound(
  db: SupabaseClient,
  m: { phone: string; body: string; waMessageId?: string | null; name?: string | null; orderId?: string | null; mediaPath?: string | null; mediaKind?: string | null },
): Promise<{ duplicate: boolean; createdAt?: string; id?: string }> {
  const { duplicate, createdAt, id } = await insertMessage(db, {
    phone: m.phone, direction: "in", body: m.body, source: "customer",
    wa_message_id: m.waMessageId, order_id: m.orderId, media_path: m.mediaPath, media_kind: m.mediaKind,
  });
  if (duplicate) return { duplicate: true };

  // wa_record_activity, not patchConversation's plain upsert: two messages
  // arriving close together race on which one's write lands last, and the
  // DB function is what keeps last_preview from going backwards when that
  // happens (see supabase-migration-wa-activity-order.sql).
  const { error } = await db.rpc("wa_record_activity", {
    p_phone: waKey(m.phone), p_direction: "in", p_at: new Date().toISOString(),
    p_preview: preview(m.body), p_name: m.name ?? null,
  });
  if (error) console.warn("[support] wa_record_activity (in) failed:", error.message);
  await clearSnooze(db, m.phone);
  return { duplicate: false, createdAt, id };
}

/**
 * Wake a snoozed conversation because the customer wrote again.
 *
 * A snooze is an operator saying "later"; the one thing it must not survive is
 * the customer sending a new message. Kept out of patchConversation's fixed
 * upsert on purpose: snoozed_until arrives by a hand-run migration and the bot
 * ships before it, so this is best-effort — a missing column (PGRST204 / 42703)
 * is swallowed, since losing a snooze-clear is nothing next to dropping the
 * message it came with. The `is not null` filter means an un-snoozed thread is
 * not rewritten at all.
 */
export async function clearSnooze(db: SupabaseClient, phone: string): Promise<void> {
  const { error } = await db
    .from("wa_conversations")
    .update({ snoozed_until: null })
    .eq("phone", waKey(phone))
    .not("snoozed_until", "is", null);
  if (error && error.code !== "PGRST204" && error.code !== "42703") {
    console.warn("[support] clearSnooze failed:", error.message);
  }
}

/**
 * Stamp the order a message turned out to be about.
 *
 * Which order a message concerns is only known after the orders have been
 * resolved, by which point the row is already written — so it is filled in
 * afterwards rather than at insert time. `wa_messages.order_id` had been plumbed
 * through three functions and passed by nobody since the table was created, so
 * every one of the first 1,763 messages carries null.
 */
async function stampOrder(db: SupabaseClient, messageId: string | undefined, orderId: string | null): Promise<void> {
  if (!messageId || !orderId) return;
  await db.from("wa_messages").update({ order_id: orderId }).eq("id", messageId);
}

/**
 * A message went out — from the bot, a human, or the system. Logs it and updates
 * the conversation's last-reply time, preview and tag. Does not touch unread /
 * escalated / taken_over: those are the caller's to set, because "handled by AI"
 * and "escalated to a human" are opposite meanings for the same outbound row.
 */
export async function recordOutbound(
  db: SupabaseClient,
  m: {
    phone: string; body: string; source: MessageSource; tag?: string | null; aiMeta?: unknown; orderId?: string | null;
    /** A photo we sent, in the same store and shape as a customer's (storeMedia). */
    mediaPath?: string | null; mediaKind?: string | null;
    /**
     * This message is not a reply — log it, but leave the conversation's reply
     * clock exactly where it was.
     *
     * For the automatic receipt (lib/supportAuto.ts), and nothing else so far.
     * Moving last_out_at would make "have we answered this person?" read as yes
     * everywhere it is asked, and the answer is no — a receipt says only that
     * the message arrived. Concretely it would have dropped the thread out of
     * the Unread chip (isUnread stands down once we have spoken last) and
     * replaced the customer's own question in the list preview with our own
     * boilerplate. The queue's state machine was already safe, because
     * replyCounts only counts "admin" and "ai"; this makes the rest agree.
     */
    notAReply?: boolean;
  },
): Promise<void> {
  await insertMessage(db, {
    phone: m.phone, direction: "out", body: m.body, source: m.source, tag: m.tag, ai_meta: m.aiMeta,
    order_id: m.orderId ?? null, media_path: m.mediaPath ?? null, media_kind: m.mediaKind ?? null,
  });
  if (m.notAReply) return;
  const { error } = await db.rpc("wa_record_activity", {
    p_phone: waKey(m.phone), p_direction: "out", p_at: new Date().toISOString(),
    p_preview: preview(m.body), p_tag: m.tag ?? null,
  });
  if (error) console.warn("[support] wa_record_activity (out) failed:", error.message);
}

// ── Orchestration ────────────────────────────────────────────────────────────
//
// The one function that turns a customer message into a conversation. It owns
// the whole decision — log, dedupe, honour the kill switch and human takeover,
// ask Gemini, and either auto-reply or escalate. Kept here rather than in the
// webhook so it can be reasoned about (and later tested) without a live callback,
// and so the escalation ping and the auto-reply write conversations identically.

// Re-exported so lib/emailSupport.ts and the admin support routes keep importing
// the row shape, the column list and the order-line formatter from here. The
// definitions now live in the import-free lib/orderLines.ts (see the import at
// the top of this file for why).
export { formatOrders, ORDER_COLUMNS, type OrderRow };

/** Orders placed from a number, newest first. Matched in JS on the normalised
 *  number because stored formats are mixed (+91…, 0…, spaced). */
export async function ordersByPhone(db: SupabaseClient, phone: string): Promise<OrderRow[]> {
  if (phone.length !== 10) return [];
  const q = (cols: string) => db
    .from("orders")
    .select(cols)
    .or(`address->>phone.like.%${phone}%,address->>altPhone.like.%${phone}%`)
    .order("created_at", { ascending: false })
    .limit(5);
  // Try with the scan snapshot; drop back to the base set if the column is not
  // there yet (migration run by hand, code ships first).
  let res = await q(ORDER_COLUMNS_WITH_SCAN);
  if (res.error && /column .* does not exist|could not find/i.test(res.error.message)) {
    res = await q(ORDER_COLUMNS);
  }
  return ((res.data as unknown as OrderRow[]) ?? []).filter(
    (o) => normalizePhone(o.address?.phone ?? "") === phone || normalizePhone(o.address?.altPhone ?? "") === phone,
  );
}

/**
 * The refund-ledger state for a set of orders, keyed by order id.
 *
 * Kept here rather than in lib/orderLines.ts, which stays pure — this is a
 * table read. Called only when the message looks like a return / refund /
 * cancellation (an extra read on every "where is it" is not worth it), and the
 * result is rendered on own-phone lines only. Best-effort: a failed read means
 * the refund fact is simply absent, never a throw inside the webhook.
 *
 * Keys on `original_order_id` — the refunds table has NO `order_id` column
 * (introspected 2026-09-03). The most recent refund per order wins.
 */
export async function refundsByOrder(
  db: SupabaseClient,
  orderIds: string[],
): Promise<Map<string, RefundLine>> {
  const out = new Map<string, RefundLine>();
  const ids = [...new Set(orderIds)].filter(Boolean);
  if (!ids.length) return out;
  const { data, error } = await db
    .from("refunds")
    .select("original_order_id, amount, execution_status, created_at, processed_at")
    .in("original_order_id", ids);
  if (error || !data) return out;
  for (const r of data as Array<Record<string, unknown>>) {
    const orderId = String(r.original_order_id ?? "");
    if (!orderId) continue;
    const since = String(r.created_at ?? "");
    const prev = out.get(orderId);
    if (prev && Date.parse(prev.since) >= Date.parse(since)) continue;
    out.set(orderId, {
      status: r.execution_status as RefundLine["status"],
      amount: Number(r.amount ?? 0),
      since,
      processedAt: (r.processed_at as string) ?? null,
    });
  }
  return out;
}

/**
 * The `=== CUSTOMER ===` header the model reads before the order lines.
 *
 * Who they are, how many orders, and — the point of it — whether a support case
 * is already open, so a customer chasing something is told "it's with the team,
 * raised on X" instead of drawing a second escalation. RTO / refusal history
 * deliberately does NOT belong here (founder decision) — that is Telegram-only.
 * Best-effort: a failed case read drops just the case line.
 *
 * Shared by WhatsApp (`{ phone }`) and email (`{ email, threadId }`) so the two
 * channels cannot drift.
 */
export async function customerContextBlock(
  db: SupabaseClient,
  who: { phone?: string; email?: string; threadId?: string },
  name: string,
  senderOrders: OrderRow[],
): Promise<string> {
  const lines = ["=== CUSTOMER ==="];
  lines.push(who.phone ? `+91 ${who.phone} · ${name}` : `${who.email ?? "unknown"} · ${name}`);

  if (senderOrders.length) {
    const earliest = senderOrders.reduce((a, b) =>
      Date.parse(a.created_at) <= Date.parse(b.created_at) ? a : b);
    const delivered = senderOrders.filter((o) => o.status === "delivered").length;
    const returning = senderOrders.filter((o) => o.status === "rto" || o.status === "returned").length;
    lines.push(
      `${senderOrders.length} order(s) · first ${day(earliest.created_at)}` +
      (delivered ? ` · ${delivered} delivered` : "") +
      (returning ? ` · ${returning} returning` : ""),
    );
  }

  try {
    const base = db
      .from("support_cases")
      .select("tag, status, escalate_reason, created_at, sla_deadline")
      .not("status", "in", closedStatusFilter());
    const { data } = who.phone
      ? await base.eq("wa_phone", who.phone)
      : await base.eq("email_thread_id", who.threadId ?? "");
    if (data && data.length) {
      const c = data[0] as Record<string, unknown>;
      lines.push(
        `Already with the team: ${data.length} open support case${data.length === 1 ? "" : "s"} (topic: ${String(c.tag).replace(/_/g, " ")}), raised ${day(String(c.created_at))}` +
        (c.escalate_reason ? `, reason: ${c.escalate_reason}` : "") +
        `. If they chase this, say it is with the team and give that date; do NOT open a second escalation. ` +
        `This is a SUPPORT CASE, not a refund, a return or an order action: never describe it as a refund being raised, started or processed — ` +
        `a refund exists only where an order line has a "refund:" fact.`,
      );
    }
  } catch (err) {
    console.warn("[support] open-case lookup failed:", err instanceof Error ? err.message : String(err));
  }

  return lines.join("\n");
}

// ── Order lookup for the support Queue thread pane ───────────────────────────
//
// Separate from ordersByPhone / ORDER_COLUMNS above, which are tuned for what
// the *model* needs to answer a message. The Queue's read-only order panel
// (components/admin/CustomerOrderPanel, OrderView) needs the money breakdown and
// the delivery-failure fields instead. Verified against a live orders row on
// 2026-09-01: every column below exists; `items` carries `color` (not `colour`).

export const ORDER_PANEL_COLUMNS =
  "id, status, items, subtotal, discount, offer_discount, offers, total, coupon, address, payment_id, " +
  "amount_paid_online, cod_due, awb_code, courier_name, tracking_url, " +
  "estimated_delivery, delivered_at, created_at, attempt_count, ndr_reason, rto_reason, shipping_method";

/** One order as the Queue thread pane reads it. Mirrors OrderView in
 *  components/admin/CustomerOrderPanel — a missing field just hides its row. */
export interface OrderPanelRow {
  id: string;
  status: string | null;
  items: Array<{ name?: string; color?: string; size?: string; quantity?: number; price?: number }> | null;
  subtotal: number | null;
  discount: number | null;
  offer_discount: number | null;
  offers: { label?: string }[] | null;
  total: number | null;
  coupon: string | null;
  address: {
    name?: string; line1?: string; line2?: string; city?: string; state?: string;
    pincode?: string; phone?: string; altPhone?: string;
  } | null;
  payment_id: string | null;
  amount_paid_online: number | null;
  cod_due: number | null;
  awb_code: string | null;
  courier_name: string | null;
  tracking_url: string | null;
  estimated_delivery: string | null;
  delivered_at: string | null;
  created_at: string | null;
  attempt_count: number | null;
  ndr_reason: string | null;
  rto_reason: string | null;
  shipping_method: string | null;
}

/**
 * Every order placed from a phone number, newest first, with the panel columns.
 *
 * Matched on the number itself — address.phone or address.altPhone, the same
 * dual-phone rule app/api/admin/tickets/route.ts uses — not on
 * wa_conversations.order_id, which only ever holds the single order the bot last
 * resolved. Razorpay keeps the delivery contact and the OTP-verified number
 * separately and they disagree on about one order in ten.
 */
export async function ordersByPhoneDetailed(
  db: SupabaseClient,
  phone: string,
  limit = 11,
): Promise<OrderPanelRow[]> {
  const p = normalizePhone(phone);
  if (p.length !== 10) return [];
  const { data } = await db
    .from("orders")
    .select(ORDER_PANEL_COLUMNS)
    .or(`address->>phone.like.%${p}%,address->>altPhone.like.%${p}%`)
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data as unknown as OrderPanelRow[]) ?? []).filter(
    (o) => normalizePhone(o.address?.phone ?? "") === p || normalizePhone(o.address?.altPhone ?? "") === p,
  );
}

/**
 * One order by its id, panel columns — the fallback when matching on the
 * conversation's phone or email finds nothing but the thread still carries an
 * order_id (guest checkout with a different number, a typed-in id the bot
 * resolved). Admin-read only, so the "a typed id is not proof of ownership"
 * rule does not bite here — nobody is being shown someone else's data, the
 * operator already has the whole thread open.
 */
export async function orderByIdDetailed(db: SupabaseClient, id: string): Promise<OrderPanelRow | null> {
  const clean = id.trim().toUpperCase();
  if (!clean) return null;
  const { data } = await db.from("orders").select(ORDER_PANEL_COLUMNS).eq("id", clean).maybeSingle();
  return (data as unknown as OrderPanelRow) ?? null;
}

/** Every order placed with an email address, newest first, panel columns.
 *  Mirrors the private ordersByEmail in lib/emailSupport.ts (address->>email,
 *  case-insensitive) with the columns the Queue order panel reads. */
export async function ordersByEmailDetailed(
  db: SupabaseClient,
  email: string,
  limit = 11,
): Promise<OrderPanelRow[]> {
  const clean = email.trim().toLowerCase();
  if (!clean.includes("@")) return [];
  const { data } = await db
    .from("orders")
    .select(ORDER_PANEL_COLUMNS)
    .ilike("address->>email", clean)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data as unknown as OrderPanelRow[]) ?? [];
}

/** Order ids the customer typed, e.g. "AJUKI710040" — the handle they have when
 *  they are messaging from a number they did not order with. */
function extractOrderIds(text: string): string[] {
  const hits = text.toUpperCase().match(/AJUKI\s*\d{4,}/g) ?? [];
  return [...new Set(hits.map((s) => s.replace(/\s+/g, "")))].slice(0, 5);
}

/** Ten-digit Indian mobiles mentioned in the text, excluding the sender's own —
 *  "I ordered from 98765 43210". Pincodes and totals are shorter, so they do not
 *  match. */
function extractPhones(text: string, exclude: string): string[] {
  const hits = text.match(/(?:\+?91[-\s]?)?[6-9]\d{9}/g) ?? [];
  const phones = hits.map((h) => normalizePhone(h)).filter((p) => p.length === 10 && p !== exclude);
  return [...new Set(phones)].slice(0, 3);
}

/** Orders the customer pointed us to by id or by another number, across the
 *  recent thread — so "where's my order" works even from a different handset. */
export async function ordersFromMentions(db: SupabaseClient, text: string, senderPhone: string): Promise<OrderRow[]> {
  const ids = extractOrderIds(text);
  const phones = extractPhones(text, senderPhone);
  const out: OrderRow[] = [];
  if (ids.length) {
    const { data } = await db.from("orders").select(ORDER_COLUMNS).in("id", ids);
    out.push(...((data as OrderRow[]) ?? []));
  }
  for (const p of phones) out.push(...(await ordersByPhone(db, p)));
  return out;
}

const IN_FLIGHT_STATUS = new Set(["shipped", "manifested", "undelivered"]);

/**
 * For the customer's own in-flight parcels that are overdue (or due within two
 * days) and have NO courier scan in our DB, ask the courier directly, once,
 * and fold the answer into the order rows in memory.
 *
 * The scan pipeline (parcel_scans + orders.courier_status*) is fed by the
 * courier push webhooks, reconciled once a day by /api/cron/parcel-scan-sync.
 * That leaves a real gap: Delhivery drops a push that overruns its 500ms
 * budget, Shadowfax's push covers only about half of in-flight parcels, and
 * the daily reconcile can be up to 24h behind. A customer asking "where is
 * it" about one of those parcels was getting "no scans yet" while the courier
 * knew it was sitting at a named hub — AJUKI710004, 2 Sept, was at
 * Cochin_Kdvantra_D and the bot could not say so.
 *
 * Bounded: their own orders only (never one matched by a typed id — that is
 * not proof it is theirs, and this spends a courier API call), at most three,
 * 6s each, fully parallel, best-effort. A dark parcel is rare, so this almost
 * never runs; when it does, one added call on a reply that already takes
 * several seconds is worth a location.
 */
async function hydrateDarkParcels(db: SupabaseClient, orders: OrderRow[]): Promise<void> {
  const soon = Date.now() + 2 * 86_400_000;
  const dark = orders.filter((o) =>
    IN_FLIGHT_STATUS.has(o.status) && o.awb_code && !o.courier_status_at &&
    (!o.estimated_delivery || Date.parse(o.estimated_delivery) < soon),
  ).slice(0, 3);
  if (!dark.length) return;

  const race = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 6000))]);

  await Promise.all(dark.map(async (o) => {
    const courier = (o.courier_name ?? "").toLowerCase();
    const awb = o.awb_code as string;
    const isDelhivery = courier.includes("delhivery");
    const isShadowfax = courier.includes("shadowfax");
    if (!isDelhivery && !isShadowfax) return;

    try {
      let scan: NormalizedScan | null = null;
      let rawStatus = "";

      if (isDelhivery) {
        const t = await race(trackDelhivery(awb));
        if (t?.status) {
          rawStatus = t.status;
          scan = normalizeDelhiveryScan({
            rawStatus: t.status, statusType: t.statusType,
            instructions: t.instructions, location: t.location,
            scannedAt: parseScanInstant(t.statusDateTime),
          });
        }
      } else {
        const t = await race(trackShadowfax(awb));
        if (t?.status) {
          rawStatus = t.statusDisplay || t.status;
          scan = normalizeShadowfaxScan({
            event: t.status, comments: t.remark, status: t.statusDisplay,
            location: t.location, scannedAt: t.scannedAt,
          });
        }
      }

      if (!scan?.scannedAt) return;
      await recordScan(db, {
        orderId: o.id, awb,
        courier: isDelhivery ? "delhivery" : "shadowfax",
        rawStatus, scan,
      });
      // Fold it into the row this turn, so formatOrders sees a scan and
      // lateParcelVerdict flips from "dark" to "moving"/"stuck".
      o.courier_status = scan.event;
      o.courier_status_detail = scan.remark ?? rawStatus;
      o.courier_status_location = scan.location;
      o.courier_status_at = scan.scannedAt;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "parcel_hydrate_failed", order: o.id, awb,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }));
}

/**
 * Has the customer said something newer than the message we are about to answer?
 *
 * People type on WhatsApp the way they talk — a photo, then "I want this", two
 * seconds apart. Each arrives as its own webhook and each used to get its own
 * reply, so one thought drew two answers, and because the second handler had
 * started before the first finished it answered without the photo: "that's a
 * lovely bracelet" immediately followed by "could you tell me the name of this
 * product?". Six such pairs in that conversation.
 *
 * Whoever is last has the whole burst in their history and answers it properly,
 * so anyone overtaken should simply stand down. The five-second reply floor
 * makes this cheap — it is nearly always still waiting when the next message
 * lands.
 */
export async function overtaken(db: SupabaseClient, phone: string, arrivedAt?: string): Promise<boolean> {
  if (!arrivedAt) return false; // no timestamp to compare, answer rather than go silent
  const { data } = await db
    .from("wa_messages")
    .select("body")
    .eq("phone", phone)
    .eq("direction", "in")
    .gt("created_at", arrivedAt)
    .limit(10);
  // A newer message that is only an "Okay", a thank-you or an emoji is never answered, so it cannot take over from the real message before
  // it (16 Oct: "my hand is small" / "the bracelet won't fit" were stood down for an "Okay" and nobody replied).
  return hasAnswerable(((data as { body: string | null }[] | null) ?? []).map((r) => r.body));
}

/**
 * Claim the right to answer this message, atomically.
 *
 * `overtaken` above is a read, and a read cannot settle a race: two handlers can
 * both look, both see nothing newer, and both speak. This is the same rule
 * expressed as a write, so Postgres decides rather than timing.
 *
 * The comparison runs newest-wins, which is what makes this the opposite of a
 * mutex. A mutex would hand the reply to whoever arrived first and silence the
 * handler holding the complete conversation; here an older handler is precisely
 * the one that loses, because the newer one has the whole burst in its history.
 *
 * Returns false when someone is already answering a message at least as new as
 * this one — stand down, they will cover it.
 */
async function claimAnswer(db: SupabaseClient, phone: string, arrivedAt?: string): Promise<boolean> {
  if (!arrivedAt) return true; // nothing to compare; answering beats going silent
  // A plain `lt`, not an `or(is.null, lt)`. The column defaults to the epoch
  // precisely so this stays one filter: an or-filter goes to PostgREST as a
  // query-string fragment with the timestamp inlined, and a timestamp carries a
  // `+` in its offset — the one character that decodes back to a space.
  const { data, error } = await db
    .from("wa_conversations")
    .update({ answering_for: arrivedAt })
    .eq("phone", phone)
    .lt("answering_for", arrivedAt)
    .select("phone");

  // The column arrives by migration, run by hand while the bot is already live.
  // Until it exists every claim errors, and refusing to answer would take the
  // whole bot down for a missing safety net — so an error means fall through to
  // the read-based check, which is what we had before this and is no worse.
  if (error) {
    console.warn("[support] wa_conversations.answering_for missing, run supabase-migration-support-answering.sql");
    return true;
  }
  return Boolean(data?.length);
}

// ── Assisted resolution ──────────────────────────────────────────────────────
//
// The non-pure half (the rules are in lib/assistedResolution.ts). Spots a small
// product-fault claim, holds the customer, and proposes a replacement to the
// founder as one Telegram tap. Nothing that sends a parcel happens without that
// tap — the button handler is lib/assistedResolutionActions.ts.

const ASSISTED_DELIVERED = new Set(["delivered", "completed"]);
const ASSISTED_RTO = new Set(["rto", "rto_in_transit", "rto_delivered", "returned"]);
// How long the customer waits in silence after the holding message before
// normal handling resumes — the founder has had the card that long.
const ASSISTED_PROPOSAL_QUIET_MS = 6 * 3_600_000;

type AssistedItem = { name?: string; price?: number | string; quantity?: number };
type ResolvePA = {
  kind: "resolve_await_item" | "resolve_await_photo" | "resolve_proposal";
  order_id: string;
  item_index?: number;
  fault: FaultKind;
  set_at: string;
};

const assistedItems = (o: OrderRow): AssistedItem[] => (o.items ?? []) as AssistedItem[];
const assistedLineValue = (i: AssistedItem | undefined): number => Number(i?.price) || 0;
const assistedDaysSince = (iso: string | null | undefined): number | null =>
  iso ? Math.floor((Date.now() - Date.parse(iso)) / 86_400_000) : null;

function assistedSubjectOrder(orders: OrderRow[]): OrderRow | null {
  // orders are newest-first; the fault is almost always on the latest parcel.
  return orders.find((o) => ASSISTED_DELIVERED.has(o.status) && o.delivered_at) ?? null;
}

function assistedPriorTrouble(orders: OrderRow[], exceptId: string): number {
  return orders.filter(
    (o) => o.id !== exceptId && (o.return_request != null || ASSISTED_RTO.has(o.status)),
  ).length;
}

async function assistedProposedBefore(db: SupabaseClient, orderId: string): Promise<boolean> {
  try {
    const { data } = await db
      .from("policy_decisions")
      .select("id")
      .eq("policy", "assisted_resolution")
      .eq("order_id", orderId)
      .limit(1);
    return Boolean(data?.length);
  } catch {
    return false; // table absent → treat as not-proposed, the gate has other guards
  }
}

async function assistedFetchOrder(db: SupabaseClient, orderId: string): Promise<OrderRow | null> {
  const { data } = await db.from("orders").select(ORDER_COLUMNS).eq("id", orderId).maybeSingle();
  return (data as unknown as OrderRow) ?? null;
}

interface AssistedCtx {
  phone: string;
  name: string;
  message: string;
  arrivedAt?: string;
  senderOrders: OrderRow[];
  conv: WaConversation | null;
  hasPhoto: boolean;
}

// OFF by founder decision (2026-10-09). A damaged / wrong / missing-item claim now follows the return workflow like
// any other (returns page, wait, or appeal by email — see lib/returnStateReply.ts) instead of a one-tap Telegram
// replacement. The code and its button handlers (lib/assistedResolutionActions.ts) are kept so proposals already
// sitting in Telegram still work; flip this to true to bring the proposing step back.
const ASSISTED_RESOLUTION_ENABLED = false;

/**
 * @returns true when the message has been handled here (caller must return) —
 * either a hold+propose, a "which item?"/"send a photo?" ask, or a deliberate
 * quiet while the founder holds the card. false = fall through to the model.
 */
async function tryAssistedResolution(db: SupabaseClient, ctx: AssistedCtx): Promise<boolean> {
  const pa = ctx.conv?.pending_action as ResolvePA | null | undefined;

  if (pa?.kind === "resolve_await_item") return assistedContinueItem(db, ctx, pa);
  if (pa?.kind === "resolve_await_photo") return assistedContinuePhoto(db, ctx, pa);
  if (pa?.kind === "resolve_proposal") {
    return Date.now() - Date.parse(pa.set_at) < ASSISTED_PROPOSAL_QUIET_MS;
  }

  const fault = classifyFaultClaim(ctx.message);
  if (!fault) return false;

  const order = assistedSubjectOrder(ctx.senderOrders);
  if (!order) return false;

  const items = assistedItems(order);
  const single = items.length === 1;
  return assistedApplyGate(db, ctx, {
    fault,
    order,
    itemIndex: single ? 0 : -1,
    itemValue: single ? assistedLineValue(items[0]) : null,
    itemCount: items.length,
    priorTrouble: assistedPriorTrouble(ctx.senderOrders, order.id),
    alreadyProposed: await assistedProposedBefore(db, order.id),
  });
}

async function assistedContinueItem(db: SupabaseClient, ctx: AssistedCtx, pa: ResolvePA): Promise<boolean> {
  const order = ctx.senderOrders.find((o) => o.id === pa.order_id) ?? await assistedFetchOrder(db, pa.order_id);
  if (!order) {
    await patchConversation(db, ctx.phone, { pending_action: null });
    return false;
  }
  const items = assistedItems(order);
  const idx = matchItemChoice(ctx.message, items.map((i) => i.name ?? "item"));
  if (idx === null) {
    // Could not read which item — hand to a person rather than guess.
    await patchConversation(db, ctx.phone, { pending_action: null });
    return false;
  }
  return assistedApplyGate(db, ctx, {
    fault: pa.fault,
    order,
    itemIndex: idx,
    itemValue: assistedLineValue(items[idx]),
    itemCount: items.length,
    priorTrouble: assistedPriorTrouble(ctx.senderOrders, order.id),
    alreadyProposed: await assistedProposedBefore(db, order.id),
  });
}

async function assistedContinuePhoto(db: SupabaseClient, ctx: AssistedCtx, pa: ResolvePA): Promise<boolean> {
  if (!ctx.hasPhoto) return true; // still waiting on the photo — stay quiet
  const order = ctx.senderOrders.find((o) => o.id === pa.order_id) ?? await assistedFetchOrder(db, pa.order_id);
  if (!order) {
    await patchConversation(db, ctx.phone, { pending_action: null });
    return false;
  }
  const items = assistedItems(order);
  const idx = typeof pa.item_index === "number" ? pa.item_index : 0;
  return assistedApplyGate(db, ctx, {
    fault: pa.fault,
    order,
    itemIndex: idx,
    itemValue: assistedLineValue(items[idx]),
    itemCount: items.length,
    priorTrouble: assistedPriorTrouble(ctx.senderOrders, order.id),
    alreadyProposed: await assistedProposedBefore(db, order.id),
  });
}

interface AssistedGate {
  fault: FaultKind;
  order: OrderRow;
  itemIndex: number;
  itemValue: number | null;
  itemCount: number;
  priorTrouble: number;
  alreadyProposed: boolean;
}

async function assistedApplyGate(db: SupabaseClient, ctx: AssistedCtx, g: AssistedGate): Promise<boolean> {
  const outcome = gateProposal({
    fault: g.fault,
    escalationKeyword: false, // a keyword hit already returned upstream
    orderDelivered: true, // assistedSubjectOrder only returns delivered orders
    daysSinceDelivery: assistedDaysSince(g.order.delivered_at),
    priorReturnsOrRtos: g.priorTrouble,
    alreadyProposed: g.alreadyProposed,
    itemCount: g.itemCount,
    faultyItemValue: g.itemValue,
    hasPhoto: ctx.hasPhoto,
  });

  if (!outcome.ok) {
    if (ctx.conv?.pending_action) await patchConversation(db, ctx.phone, { pending_action: null });
    return false;
  }

  const items = assistedItems(g.order);
  const itemName = items[g.itemIndex]?.name ?? "item";

  if (outcome.next === "ask_item") {
    if (!(await claimAnswer(db, ctx.phone, ctx.arrivedAt))) return true;
    const msg = askItemMessage(g.fault, items.map((i) => i.name ?? "item"));
    await sendWhatsApp(ctx.phone, msg);
    await recordOutbound(db, { phone: ctx.phone, body: msg, source: "system", tag: "complaint" });
    await patchConversation(db, ctx.phone, {
      unread: true,
      pending_action: { kind: "resolve_await_item", order_id: g.order.id, fault: g.fault, set_at: new Date().toISOString() },
    });
    return true;
  }

  if (outcome.next === "ask_photo") {
    if (!(await claimAnswer(db, ctx.phone, ctx.arrivedAt))) return true;
    const msg = askPhotoMessage(g.fault, itemName);
    await sendWhatsApp(ctx.phone, msg);
    await recordOutbound(db, { phone: ctx.phone, body: msg, source: "system", tag: "complaint" });
    await patchConversation(db, ctx.phone, {
      unread: true,
      pending_action: { kind: "resolve_await_photo", order_id: g.order.id, item_index: g.itemIndex, fault: g.fault, set_at: new Date().toISOString() },
    });
    return true;
  }

  return assistedPropose(db, ctx, g, itemName, assistedLineValue(items[g.itemIndex]));
}

async function assistedPropose(
  db: SupabaseClient, ctx: AssistedCtx, g: AssistedGate, itemName: string, value: number,
): Promise<boolean> {
  if (!(await claimAnswer(db, ctx.phone, ctx.arrivedAt))) return true;

  const hold = holdingMessage(g.fault, itemName);
  await sendWhatsApp(ctx.phone, hold);
  await recordOutbound(db, { phone: ctx.phone, body: hold, source: "system", tag: "complaint" });

  await patchConversation(db, ctx.phone, {
    unread: true,
    status: "escalated",
    escalated: true,
    escalate_reason: `assisted: ${g.fault} claim, awaiting founder`,
    pending_action: {
      kind: "resolve_proposal", order_id: g.order.id, item_index: g.itemIndex,
      fault: g.fault, set_at: new Date().toISOString(),
    },
  });

  try {
    const customerId = await resolveCustomer(db, { phone: ctx.phone });
    if (customerId) {
      await openOrReuseCase(db, {
        customerId, channel: "whatsapp", waPhone: ctx.phone,
        tag: "complaint", reason: `assisted: ${g.fault} claim`,
      });
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "support_case_write_failed", phone: ctx.phone, error: err instanceof Error ? err.message : String(err) }));
  }

  try {
    await db.from("policy_decisions").insert({
      policy: "assisted_resolution",
      order_id: g.order.id,
      input: { fault: g.fault, item: itemName, value, item_index: g.itemIndex },
      output: "proposed",
      reason: `${g.fault} claim within window, clean history, ₹${value} ≤ cap`,
    });
  } catch (err) {
    console.warn("[assisted] policy_decisions insert skipped:", err instanceof Error ? err.message : String(err));
  }

  const faultLabel = g.fault === "wrong_item" ? "wrong item" : g.fault === "missing_item" ? "missing item" : "damaged";
  const kb: InlineKeyboard = [
    [{ text: "✅ Replacement", callback_data: encodeCallback("arp", ctx.phone) }],
    [
      { text: "💸 Refund — I'll do it", callback_data: encodeCallback("rfm", ctx.phone) },
      { text: "❌ Reject", callback_data: encodeCallback("rjp", ctx.phone) },
    ],
    [{ text: "Open thread", url: `${ADMIN_INBOX}?phone=${ctx.phone}` }],
  ];
  const card =
    `🔧 <b>Resolve? — ${ctx.name}</b> · ${tgPhone(ctx.phone)}\n` +
    `#${g.order.id} · ${itemName} (₹${value})\n` +
    `Claim: <b>${faultLabel}</b>\n` +
    `Says: "${ctx.message.slice(0, 300)}"\n` +
    `History: clean\n\n` +
    `Approve → I create the replacement, send the template, close it.`;
  await sendWithButtons("LIVE", card, kb);
  return true;
}

/**
 * Tell a customer a person is coming, with a "Track my order" button under it.
 *
 * The holding message asks them to wait 3-5 working hours, and the commonest
 * thing anyone does inside that wait is ask where their parcel is — a question
 * that costs a reply and tells them nothing /track could not. The button lands
 * them there on their own number with nothing to type.
 *
 * Only when they actually have an order: a button that opens an empty tracking
 * page is worse than no button. Falls back to plain text inside sendWhatsAppCta
 * if Meta refuses the interactive send — the acknowledgement itself is the part
 * that matters.
 */
async function sendHoldingAck(
  db: SupabaseClient,
  phone: string,
  body: string,
  tag: string,
  hasOrders: boolean,
  aiMeta?: unknown,
): Promise<void> {
  if (hasOrders) {
    await sendWhatsAppCta(phone, body, {
      // Their own number, so /track resolves their parcels with nothing typed —
      // the same contract order_shipped_v2's Track button already uses.
      text: "Track my order",
      // Signed (lib/trackLink): /track is gated, and this skips the OTP only for
      // the number the message went to.
      url: `https://www.ajuki.in/track?phone=${signTrackLink(phone) ?? normalizePhone(phone)}`,
    });
  } else {
    await sendWhatsApp(phone, body);
  }
  await recordOutbound(db, { phone, body, source: "system", tag, aiMeta });
}

/** Recent thread, oldest-first, for the model's short-term memory. */
async function recentHistory(db: SupabaseClient, phone: string, limit = 10): Promise<ConversationTurn[]> {
  const { data } = await db
    .from("wa_messages")
    .select("direction, body, created_at")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data as { direction: "in" | "out"; body: string }[]) ?? [])
    .reverse()
    .map((r) => ({ direction: r.direction, body: r.body }));
}

export async function loadChunks(
  db: SupabaseClient,
  /**
   * Which channel is asking.
   *
   * A chunk marked 'both' answers either; one marked for a channel answers only
   * that one. It exists because the same fact needs different words: "just reply
   * here" is right in a chat and meaningless in an email, and a full policy
   * paragraph is unreadable in a WhatsApp bubble.
   *
   * The `channel` column may not exist yet — it arrives with
   * supabase-migration-email-persona.sql — so a failed filter falls back to
   * reading everything rather than leaving the bot with no knowledge at all.
   */
  channel: "whatsapp" | "email" = "whatsapp",
  /**
   * Whether to fetch each chunk's 3,072-float embedding.
   *
   * The one caller of this function, retrieveChunks()'s fallback, already knows
   * by the time it calls here whether a query embedding exists — and when it
   * doesn't, retrieve() never touches `.embedding` at all (it returns the first
   * `k` chunks unranked). Fetching the column anyway in that case is exactly the
   * ~1.46 MB-per-message cost this file's own retrieveChunks() was written to
   * kill, paid again on every fallback while Gemini's credits are down: seen
   * repeating in the Supabase logs on 30 Aug 2026, this select still carrying
   * `embedding` on a plain REST call, egress at 4.97 of the 5 GB free tier for
   * the period. Default true so a future caller that forgets to pass this still
   * gets a correct (if wasteful) result rather than a silently unranked one.
   */
  withEmbedding = true,
): Promise<KnowledgeChunk[]> {
  const cols = withEmbedding ? "id, kind, topic, content, embedding" : "id, kind, topic, content";
  const withNulledEmbedding = (rows: unknown[]): KnowledgeChunk[] =>
    withEmbedding
      ? (rows as KnowledgeChunk[])
      : (rows as Omit<KnowledgeChunk, "embedding">[]).map((c) => ({ ...c, embedding: null }));

  const scoped = await db
    .from("wa_knowledge_chunks")
    .select(cols)
    .eq("enabled", true)
    .in("channel", ["both", channel]);

  if (!scoped.error) return withNulledEmbedding(scoped.data ?? []);

  const { data } = await db
    .from("wa_knowledge_chunks")
    .select(cols)
    .eq("enabled", true);
  return withNulledEmbedding(data ?? []);
}

/**
 * The few chunks most relevant to this question, ranked by Postgres.
 *
 * Replaces `retrieve(question, await loadChunks(db))`, which pulled every
 * enabled chunk *including its 3,072-float embedding* — ~1.46 MB — on every
 * single inbound message, and then threw away all but five. Measured on
 * 27 Aug 2026 that was 3.63 GB/month of Supabase egress, three quarters of a
 * 5 GB allowance, and the real reason the backup cron was cut to weekly.
 * The RPC returns text only, so a reply now costs about 3 KB.
 *
 * Falls back to the old path when the function is missing, because migrations
 * here are run by hand and the code ships first — between the deploy and the
 * SQL editor, this is the only thing keeping the bot answering. It also falls
 * back when the question cannot be embedded, which preserves retrieve()'s own
 * "a degraded-but-complete context beats an empty one" behaviour.
 */
export async function retrieveChunks(
  db: SupabaseClient,
  question: string,
  channel: "whatsapp" | "email" = "whatsapp",
  k = 5,
): Promise<{ chunks: KnowledgeChunk[]; ranked: boolean }> {
  const queryEmbedding = await embed(question);

  if (queryEmbedding) {
    const { data, error } = await db.rpc("match_knowledge_chunks", {
      query_embedding: queryEmbedding,
      match_channel: channel,
      match_count: k,
    });

    // `embedding: null` is honest rather than lossy — the caller only ever
    // reads topic and content (see buildKnowledge in lib/gemini.ts), and the
    // whole point of this path is that the vectors never leave Postgres.
    if (!error && Array.isArray(data)) {
      return {
        chunks: (data as Omit<KnowledgeChunk, "embedding">[]).map((c) => ({ ...c, embedding: null })),
        ranked: true,
      };
    }
  }

  // withEmbedding mirrors what we already learned above: no query embedding
  // means retrieve() can never rank on embeddings either (embed() would just
  // fail again), so fetching the column here would cost the same ~1.46 MB and
  // buy nothing. A query embedding that exists but hit an RPC error is the one
  // case retrieve() can still use it, so that path keeps fetching it.
  const chunks = await retrieve(question, await loadChunks(db, channel, !!queryEmbedding), k, queryEmbedding);
  // `ranked` is false exactly when there was no query embedding to rank against:
  // embeddings are down, retrieve() has returned the first ~8 chunks in
  // insertion order, and systemInstruction() should warn the model they may not
  // be the most relevant. (A query embedding that exists but hit an RPC error
  // still lets retrieve() rank on the stored vectors, so that path stays
  // ranked — the rare all-null-embeddings corpus is treated as ranked too;
  // that only happens before the one-time re-embed and is not worth a flag.)
  return { chunks, ranked: !!queryEmbedding };
}

export function orderLinesForTelegram(orders: OrderRow[]): string {
  return orders.length
    ? orders.map((o) => `#${o.id} · ${o.status} · ₹${o.total ?? 0}`).join("\n")
    : "No orders on this number.";
}

/**
 * Whether this exact canned line already went to this phone recently.
 *
 * The out-of-hours notice and the "can't open attachments" media fallback both
 * fire from an early-return path that never reaches the escalation
 * quiet-period logic below — so a customer messaging outside hours three times
 * in a day, or sending three voice notes, got the identical sentence three
 * times. Same principle as the escalation quiet period, just body-matched
 * instead of tag-matched, since these two never carry a tag at all.
 */
export async function sentRecently(
  db: SupabaseClient,
  phone: string,
  body: string,
  withinHours: number,
): Promise<boolean> {
  const { data } = await db
    .from("wa_messages")
    .select("created_at")
    .eq("phone", phone)
    .eq("direction", "out")
    .eq("body", body)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return false;
  const hoursSince = (Date.now() - new Date(data.created_at).getTime()) / 3_600_000;
  return hoursSince < withinHours;
}

/**
 * Record the escalation as a durable support case — and make it LOUD if that cannot be done.
 *
 * support_cases exists because an escalation that is only a Telegram ping is not durable. But the four call sites used to
 * swallow a failed write with a console.error, and a customer with no resolvable identity wrote nothing at all, so the
 * very thing the table was built to guarantee could silently not happen. The customer is still acknowledged either way
 * (they must not be left hanging because our bookkeeping failed), but a missing case now pages OPS so a person creates it.
 * One retry first: the usual cause is a transient database error or a race on the unique (customer, tag) index.
 */
export async function recordCaseOrAlert(
  db: SupabaseClient,
  a: { phone: string; tag: string; reason: string; name?: string | null },
): Promise<boolean> {
  let lastError = "no customer record could be resolved for this number";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const customerId = await resolveCustomer(db, { phone: a.phone });
      if (!customerId) { lastError = "no customer record could be resolved for this number"; continue; }
      await openOrReuseCase(db, { customerId, channel: "whatsapp", waPhone: a.phone, tag: a.tag, reason: a.reason });
      return true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ event: "support_case_write_failed", phone: a.phone, attempt, error: lastError }));
    }
  }
  console.error(JSON.stringify({ event: "escalation_not_recorded", phone: a.phone, tag: a.tag, error: lastError }));
  await notify(
    "OPS",
    `🚨 <b>Escalation NOT recorded as a support case</b>
` +
    `${a.name ?? "Customer"} · ${tgPhone(a.phone)} · <b>${a.tag}</b>
` +
    `<i>Why it escalated:</i> ${a.reason}
<i>Why no case:</i> ${lastError}

` +
    `The customer was acknowledged and the thread is marked escalated, but it will not show in the case queue. Open it from the inbox and create the case by hand.
` +
    `<a href="${ADMIN_INBOX}?phone=${a.phone}">Open in support inbox</a>`,
  ).catch(() => {});
  return false;
}

/**
 * Handle one inbound support message end to end. Returns whether it was handled
 * here, so the webhook knows a duplicate/early-return needs nothing further.
 */
export async function handleSupportMessage(
  db: SupabaseClient,
  m: {
    phone: string;
    message: string;
    waMessageId?: string | null;
    profileName?: string | null;
    /** WhatsApp media ids on this message — return photos, almost always. */
    mediaIds?: string[];
    /** The raw WhatsApp type when something was attached, for the media filter. */
    mediaKind?: string | null;
    /**
     * A later message from this same customer is sitting in the same webhook
     * payload, waiting its turn.
     *
     * Meta batches messages, and the webhook awaits each one before starting the
     * next — so the later message is not written to wa_messages until this one
     * has already replied, and `overtaken` below cannot possibly see it. That is
     * how one customer got the same address read back twice nine seconds apart.
     * The caller can see the whole batch; we cannot. So it tells us.
     */
    supersededInBatch?: boolean;
    /**
     * Set by the wa-wake cron: this message already lives in wa_messages (it
     * arrived out of hours and only got the "we're closed" notice), and we are
     * now generating the real reply the bot owes it. Skips recordInbound and
     * the media fetch; `arrivedAt` is the original inbound's timestamp.
     */
    wake?: { body: string; arrivedAt: string };
  },
): Promise<void> {
  const startedAt = Date.now();

  // The media download + R2 upload used to run HERE, before recordInbound — so a
  // Meta webhook retry (Meta retries a slow webhook for days) re-downloaded the
  // same photo and left a fresh orphan R2 object on every retry, none of them
  // ever referenced by a row. Nothing between here and the dedup check needs the
  // bytes, so the fetch now happens after `if (duplicate) return;`.
  const hasMedia = !m.wake && (m.mediaIds ?? []).length > 0;

  // A wake reply is answering a message already stored — do not record it again.
  let duplicate = false;
  let arrivedAt: string | undefined;
  let inboundId: string | undefined;
  if (m.wake) {
    arrivedAt = m.wake.arrivedAt;
  } else {
    const rec = await recordInbound(db, {
      phone: m.phone,
      // A photo with no caption would otherwise store as an empty row, which
      // reads in the inbox as though nothing arrived. media_path is filled in
      // below once the download has actually succeeded.
      body: m.message || (hasMedia ? "[photo]" : ""),
      waMessageId: m.waMessageId,
      name: m.profileName,
      mediaKind: m.mediaKind ?? (hasMedia ? "image" : null),
    });
    duplicate = rec.duplicate;
    arrivedAt = rec.createdAt;
    inboundId = rec.id;
  }
  if (duplicate) return;

  // The decision trace (lib/decisionTrace.ts, default off): why each message was answered, held or left. The sent replies carry theirs
  // on their own row; a message that gets no outbound row has it written here, onto its inbound row. Never changes what is sent.
  const traceOn = decisionTraceEnabled();
  const traceInbound = (outcome: TraceOutcome, reason: string): Promise<void> =>
    traceOn ? writeInboundTrace(db, inboundId, silentTrace(outcome, reason, { v2: pipelineV2Enabled(), wake: Boolean(m.wake) })) : Promise.resolve();

  // Now safe: this message is new, so the photo is fetched once, not once per
  // retry. Both steps degrade independently — a download that fails leaves a
  // normal text message, an upload that fails still lets the bot answer about
  // what it saw.
  const images: { base64: string; mimeType: string }[] = [];
  let mediaPath: string | null = null;
  for (const id of (m.mediaIds ?? []).slice(0, 3)) {
    const media = await fetchWhatsAppMedia(id);
    if (!media) continue;
    images.push({ base64: media.base64, mimeType: media.mimeType });
    mediaPath ??= await storeMedia(db, m.phone, media.bytes, media.mimeType);
  }
  // Point the row just written at the stored file. Best-effort: the message is
  // already saved, and a failed update only costs the admin panel a thumbnail.
  if (mediaPath && inboundId) {
    await db.from("wa_messages").update({ media_path: mediaPath }).eq("id", inboundId);
  }

  // A later message from this customer is already in this payload. It is stored
  // now — that is the whole reason this runs at all — but answering it is the
  // job of the handler that has the complete burst in its history.
  if (m.supersededInBatch) {
    console.log(JSON.stringify({ event: "support_superseded", phone: m.phone, where: "batch" }));
    await traceInbound("superseded", "later message in the same batch");
    return;
  }

  const config = await getSupportConfig(db);
  const conv = await getConversation(db, m.phone);
  // The customer's own orders identify them and greet them by name. The name is
  // only ever taken from these — never from an order found by a typed id, or one
  // stranger could learn another customer's name by guessing an order number.
  const senderOrders = await ordersByPhone(db, m.phone);
  const name = m.profileName || conv?.name || senderOrders[0]?.address?.name || "Unknown";

  // Kill switch off, or a human is already on this thread → do not auto-reply.
  // Behave as the old code did: alert a person and let them handle it.
  const handOverToPerson = async (takenOver: boolean) => {
    await patchConversation(db, m.phone, { unread: true });
    await notify(
      "LIVE",
      `💬 <b>Customer message</b>${takenOver ? " (you're handling this thread)" : " (bot is off)"}\n` +
      `${name} · ${tgPhone(m.phone)}\n\n"${m.message.slice(0, 400)}"\n\n` +
      `<b>Their orders</b>\n${orderLinesForTelegram(senderOrders)}\n\n` +
      `<a href="${ADMIN_INBOX}?phone=${m.phone}">Open in support inbox</a>`,
    );
  };
  if (!config.enabled || conv?.taken_over) {
    await handOverToPerson(Boolean(conv?.taken_over));
    await traceInbound("taken_over", conv?.taken_over ? "a person has the thread" : "bot switched off");
    return;
  }

  // The deliberate quiet period (lib/replyDelay.ts), shared by every customer-facing reply this function sends. Customers write
  // in bursts; waiting for the burst to end means ONE answer, one quiet period after the LAST message, with the whole burst in
  // the history. A handler that finds a newer message from the same sender when it wakes stands down: the handler for that
  // newer message does the same wait from its own arrival and answers. Never on a wake replay (the cron already waited), and
  // skipped once the enclosing webhook batch has used its delay budget so a multi-sender batch still finishes under the ceiling.
  //
  // The wait is long enough for an operator to act, so the two switches that must hold at the moment of answering — the kill
  // switch and human takeover — are read again after it. This only DECIDES; callers keep every state write (case, ping, queued
  // wake reply) outside it, so a handler that stands down never drops something the team or the next cron depends on.
  const quietPeriod = async (): Promise<{ status: "go" | "superseded" | "held"; takenOver?: boolean; waitedMs?: number }> => {
    if (m.wake) return { status: "go" };
    const waitMs = delayToApply({ configured: configuredReplyDelayMs(), elapsedInBatchMs: elapsedInBatchMs() });
    if (waitMs <= 0) return { status: "go" };
    await new Promise((r) => setTimeout(r, waitMs));
    if (await overtaken(db, m.phone, arrivedAt)) {
      console.log(JSON.stringify({ event: "support_superseded", phone: m.phone, where: "quiet_period" }));
      return { status: "superseded" };
    }
    const [liveConfig, liveConv] = await Promise.all([getSupportConfig(db), getConversation(db, m.phone)]);
    if (!liveConfig.enabled || liveConv?.taken_over) {
      console.log(JSON.stringify({ event: "support_held_after_quiet_period", phone: m.phone, enabled: liveConfig.enabled, takenOver: Boolean(liveConv?.taken_over) }));
      return { status: "held", takenOver: Boolean(liveConv?.taken_over) };
    }
    return { status: "go", waitedMs: waitMs };
  };

  // Not a customer: another business's automatic greeting, or a scam menu (lib/autoReply.ts). Answering a greeting can set two
  // automatic replies talking to each other for good, and a scam menu is not ours to help. The message is already stored. A
  // greeting gets no reply, no ping and no state change, like a bare "Ok"; a scam menu gets no reply but is left unread so a
  // person can see it. Never when a photo came with it.
  if (images.length === 0) {
    const other = notACustomer(m.message);
    if (other) {
      console.log(JSON.stringify({ event: "support_not_a_customer", phone: m.phone, kind: other }));
      if (other === "spam") await patchConversation(db, m.phone, { unread: true });
      await traceInbound("silent", `not_a_customer:${other}`);
      return;
    }
  }

  // Abuse aimed at us: no reply, thread left unread, the team told on Telegram (founder, 13 Oct). Never when a photo came with it, and
  // only strong profanity counts (lib/abuse.ts), so plain anger, "fraud" and "worst service" still go the normal way.
  if (images.length === 0 && isAbusive(m.message)) {
    console.log(JSON.stringify({ event: "support_abuse_silent", phone: m.phone }));
    await patchConversation(db, m.phone, { unread: true });
    await notify(
      "LIVE",
      `🚫 <b>Abusive message — not answered</b> · ${tgPhone(m.phone)}\n${name}\n"${m.message.slice(0, 300)}"\n\n<i>The bot stays silent on abuse. Open the thread to decide.</i>\n<a href="${ADMIN_INBOX}?phone=${m.phone}">Open in support inbox</a>`,
    ).catch(() => {});
    await traceInbound("silent", "abusive_message");
    return;
  }

  // Escalation-keyword backstop, ahead of the out-of-hours early return.
  //
  // matchEscalateKeyword otherwise only runs inside generateSupportReply, which
  // the out-of-hours branch below never reaches — and route.ts's confirm/cancel
  // fast-path skips it too. So "I'm sending a legal notice" at 2 AM, or from
  // someone mid-COD-confirmation, would never trip the legal/chargeback guard.
  // Same keyword list the model path uses (config.escalate_keywords). Falls
  // into the standard escalate: conversation flagged, durable case opened
  // best-effort, team pinged, and the customer gets one canned line.
  const keywordHit = matchEscalateKeyword(m.message, config.escalate_keywords);
  if (keywordHit) {
    const outOfHours = !isWithinSupportHours();
    await patchConversation(db, m.phone, {
      status: "escalated", escalated: true,
      escalate_reason: `keyword: ${keywordHit}`, unread: true,
    });
    // Best-effort, exactly like the model-driven escalation block below — the
    // customer still gets acknowledged even if the identity/case write fails.
    await recordCaseOrAlert(db, { phone: m.phone, tag: "complaint", reason: `keyword: ${keywordHit}`, name });
    // One line to the customer: the canned hours notice out of hours, the
    // holding message within hours. Both deduped 6h so a customer sending
    // "fraud" three times overnight is not answered three times — the Telegram
    // ping below still fires every time so the team sees the impatience.
    // The team is told at once; only the customer's line waits out the quiet period.
    await notify(
      "LIVE",
      `⚠️ <b>Support escalation</b> · keyword <b>${keywordHit}</b>${outOfHours ? " · out of hours" : ""}\n` +
      `${name} · ${tgPhone(m.phone)}\n\n"${m.message.slice(0, 400)}"\n\n` +
      `<i>Why:</i> backstop keyword "${keywordHit}" — legal / chargeback / fraud language, never for a model to answer\n\n` +
      `<b>Their orders</b>\n${orderLinesForTelegram(senderOrders)}\n\n` +
      `<a href="${ADMIN_INBOX}?phone=${m.phone}">Open in support inbox</a>`,
    );
    const ack = outOfHours ? OUT_OF_HOURS_MESSAGE : FLAG_REPLY;
    let keywordAcked = false;
    if (!(await sentRecently(db, m.phone, ack, 6))) {
      if ((await quietPeriod()).status === "go") {
        // The out-of-hours line gets the Track button too — that customer is
        // waiting longer than the in-hours one, so self-service is worth more.
        keywordAcked = true;
        await sendHoldingAck(db, m.phone, ack, "complaint", senderOrders.length > 0);
      }
    }
    await traceInbound(keywordAcked ? "escalated_ack" : "escalated_quiet", `keyword: ${keywordHit}`);
    return;
  }

  // A bare "Ok" / "Thanks" / thumbs-up / WhatsApp reaction gets no reply at all, in or out of hours — see
  // lib/ackOnly.ts. Nothing is sent, no Telegram ping, no hours notice, and the model is never called. The
  // message is already stored, so a person still sees it in the inbox.
  // A bare "sure" after our own courtesy close ("You're welcome — … just message us here.") answers nothing either (21 Oct: it opened a case); after a question of ours it is an answer.
  const sureAfterClose = images.length === 0 && /\bsure\b/i.test(m.message) && m.message.length <= 30
    && isAckAfterClose(m.message, [...(await recentHistory(db, m.phone, 4))].reverse().find((t) => t.direction === "out")?.body);
  if (images.length === 0 && (isAckOnly(m.message) || sureAfterClose)) {
    console.log(JSON.stringify({ event: "support_ack_only_silent", phone: m.phone }));
    await traceInbound("silent", sureAfterClose ? "ack_only_after_courtesy_close" : "ack_only");
    return;
  }

  // The delivery number written in plain words ("9000100003 new mobile no.") is the Update phone button on a failed-delivery message: apply it the same way, through the NDR phone flow,
  // for a parcel that is undelivered with Delhivery or Shadowfax. On 21 Oct it was read as an address change and the customer was asked for an address. Anything else is left to the normal path.
  const phoneNumber = images.length === 0 ? phoneChangeNumber(m.message) : null;
  if (phoneNumber) {
    const target = senderOrders.find((o) => o.status === "undelivered" && !!o.awb_code && /delhivery|shadowfax/i.test(String(o.courier_name ?? "")));
    if (target) {
      try {
        const ndr = await import("@/lib/ndrButtonReply");
        await ndr.handleNdrPendingReply(db, {
          phone: m.phone, text: phoneNumber, waMessageId: m.waMessageId ?? null,
          pending: { kind: "ndr_phone", order_id: target.id, awb: String(target.awb_code), courier: ndr.ndrCourierOf(target.courier_name), set_at: new Date().toISOString() },
        });
        console.log(JSON.stringify({ event: "support_phone_change_in_words", phone: m.phone, orderId: target.id }));
        await traceInbound("sent", "phone change written in words, applied through the NDR phone flow");
        return;
      } catch (err) {
        console.warn("[support] phone change in words failed, using the normal path:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Guided flows (lib/menuHandler.ts, SUPPORT_MENU, default off): the first message after 24 hours of silence either gets the topic list
  // (a vague opener, once per chat) or goes straight into the flow it plainly names. At any hour: the answers are fixed and need no model.
  // Never for a photo, a wake replay or a thread with a button flow pending. Anything the menu does not own carries on exactly as before.
  if (menuMayApply(m.phone)) {
    try {
      const { maybeStartMenu } = await import("@/lib/menuHandler");
      const entry = await maybeStartMenu(db, {
        phone: m.phone, message: m.message, name, arrivedAt, hasPhoto: images.length > 0, wake: Boolean(m.wake),
        pendingKind: (conv?.pending_action as { kind?: string } | null | undefined)?.kind ?? null, quiet: quietPeriod,
      });
      if (entry.handled) {
        console.log(JSON.stringify({ event: "support_menu", phone: m.phone, outcome: entry.outcome, reason: entry.reason }));
        if (entry.outcome === "held") await handOverToPerson(Boolean(conv?.taken_over));
        await traceInbound(entry.outcome === "sent" ? "sent" : entry.outcome === "held" ? "taken_over" : entry.outcome === "superseded" ? "superseded" : "silent", entry.reason);
        return;
      }
    } catch (err) {
      console.error(JSON.stringify({ event: "menu_entry_failed", phone: m.phone, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  // Outside 11 AM–7 PM IST: send the fixed hours notice instead of generating a
  // reply, and stop — no Gemini/OpenAI call, no order lookup. Marked unread so
  // the thread still surfaces in the inbox for the morning, but not pinged to
  // Telegram: a canned "try again during our hours" line does not need a human
  // woken up for it the way an unanswered kill-switch thread does.
  //
  // Sent at most once per 6h: a customer messaging three times overnight used
  // to get the identical sentence three times, which is the fastest way to
  // sound like a machine that isn't listening.
  // A wake reply always generates — the cron already decided the desk is open,
  // and a minute of clock drift must not bounce it back into the queue it just
  // came out of.
  // The one exception: "Update phone" for a parcel that is with the courier, and the number given in answer to our ask for it, are fixed lines answered at any hour (lib/phoneAnyHour.ts).
  const phoneAnyHourNow = !isWithinSupportHours() && !m.wake && images.length === 0 && phoneAnyHour({
    message: m.message, ownOrders: senderOrders as never,
    lastBotReply: [...(await recentHistory(db, m.phone, 4))].reverse().find((t) => t.direction === "out")?.body ?? null,
  });
  if (!isWithinSupportHours() && !m.wake && !phoneAnyHourNow) {
    // Queue the real answer for when the bot opens (wa-wake cron). Not while
    // already mid-wake, not when an NDR button flow owns pending_action, and
    // not for an empty message. A later out-of-hours message overwrites this,
    // so the bot answers the newest thing they said.
    const paKind = (conv?.pending_action as { kind?: string } | null | undefined)?.kind;
    const patch: Record<string, unknown> = { unread: true };
    if (!m.wake && m.message.trim() && (!paKind || paKind === "wake_reply")) {
      patch.pending_action = { kind: "wake_reply", body: m.message.slice(0, 1000), set_at: new Date().toISOString() };
    }
    await patchConversation(db, m.phone, patch);
    // The notice itself waits out the quiet period (state above is already written, so a handler that stands down loses nothing).
    if (!(await sentRecently(db, m.phone, OUT_OF_HOURS_MESSAGE, 6)) && !(await sentRecently(db, m.phone, OUT_OF_HOURS_MESSAGE_LEGACY, 6))) {
      if ((await quietPeriod()).status === "go") {
        // With the guided flows on for this number, the topic list takes the place of this notice (founder, 13 Oct) the first time; after that
        // the notice is sent as before.
        let menuSent = false;
        if (menuMayApply(m.phone)) {
          try { menuSent = await (await import("@/lib/menuHandler")).menuInsteadOfNotice(db, m.phone, arrivedAt); } catch { menuSent = false; }
        }
        if (!menuSent) {
          await sendWhatsApp(m.phone, OUT_OF_HOURS_MESSAGE);
          await recordOutbound(db, { phone: m.phone, body: OUT_OF_HOURS_MESSAGE, source: "system" });
        }
      }
    }
    await traceInbound("silent", "out_of_hours: real answer queued for the wake cron");
    return;
  }

  // In hours and proceeding normally — any queued wake reply is now moot (they
  // are getting a live answer to this message instead).
  if (!m.wake && (conv?.pending_action as { kind?: string } | null | undefined)?.kind === "wake_reply") {
    await patchConversation(db, m.phone, { pending_action: null });
  }

  // Assisted resolution — a small product-fault claim (damaged / wrong / missing
  // item) the founder can clear with one Telegram tap. Runs before the model: if
  // this holds the customer and proposes, no AI reply is generated for the
  // message. Live-answer path only, never on a wake replay.
  // See docs/cx/assisted-resolution.md.
  if (ASSISTED_RESOLUTION_ENABLED && !m.wake && await tryAssistedResolution(db, {
    phone: m.phone, name, message: m.message, arrivedAt,
    senderOrders, conv, hasPhoto: images.length > 0,
  })) {
    await traceInbound("silent", "assisted_resolution: held for the founder");
    return;
  }

  // Wait out the quiet period (defined above) BEFORE the thread is read and the model is called, so the answer sees the whole burst.
  let quietWaitMs = 0;
  {
    const q = await quietPeriod();
    if (q.status === "superseded") { await traceInbound("superseded", "newer message arrived during the quiet period"); return; }
    if (q.status === "held") { await handOverToPerson(Boolean(q.takenOver)); await traceInbound("taken_over", "bot switched off or a person took the thread during the quiet period"); return; }
    quietWaitMs = q.waitedMs ?? 0;
  }

  const history = await recentHistory(db, m.phone);
  // Resolve orders across the whole recent thread, not just this line — the id or
  // number they gave a message ago still counts.
  const mentioned = [...history.filter((t) => t.direction === "in").map((t) => t.body), m.message].join(" ");
  // Anything already matched to their own number is dropped from the mentioned
  // set: the two are formatted separately, so an order in both would otherwise
  // print twice — once with its address and once without.
  const ownIds = new Set(senderOrders.map((o) => o.id));
  const mentionedOrders = (await ordersFromMentions(db, mentioned, m.phone)).filter((o) => !ownIds.has(o.id));
  // A dark, overdue parcel of their own → ask the courier now so the reply can
  // name a hub instead of "no scans yet". Mutates senderOrders in place.
  await hydrateDarkParcels(db, senderOrders);

  // Replacement parcels. An approved return settled as a "replacement" raised a
  // new free order (return_request.replacement_order_id) — it is one of the
  // customer's own orders, but it is not reliably matched to their phone, so
  // "where is my replacement" used to find nothing. Pull any not already in the
  // set and fold them in as normal own lines, tagged with their parent so the
  // model knows what they are. Best-effort: one extra `.in("id", …)` query, and
  // a failure just omits them.
  const replacementOf = new Map<string, string>();
  const wantReplacements = new Map<string, string>();
  for (const o of senderOrders) {
    const rid = o.return_request?.replacement_order_id;
    if (rid && !senderOrders.some((s) => s.id === rid)) wantReplacements.set(rid, o.id);
  }
  if (wantReplacements.size) {
    try {
      const { data } = await db.from("orders").select(ORDER_COLUMNS).in("id", [...wantReplacements.keys()]);
      for (const r of ((data as unknown as OrderRow[]) ?? [])) {
        if (wantReplacements.has(r.id) && !senderOrders.some((s) => s.id === r.id)) {
          senderOrders.push(r);
          replacementOf.set(r.id, wantReplacements.get(r.id)!);
        }
      }
    } catch (err) {
      console.warn("[support] replacement-parcel lookup failed:", err instanceof Error ? err.message : String(err));
    }
  }

  // Mentioned orders that turned out to be replacement parcels we just folded in
  // are dropped from the mentioned pass so they do not print twice.
  const finalMentioned = mentionedOrders.filter((o) => !senderOrders.some((s) => s.id === o.id));
  const orderRows = [...senderOrders, ...finalMentioned];
  // SUPPORT_PIPELINE_V2 (lib/pipelineV2.ts, default off). With it on, every fixed-wording override below is decided from the order
  // this message is about, not from all of the customer's orders (lib/orderScope.ts).
  const v2 = pipelineV2Enabled();
  const recentTurns = history.length && history[history.length - 1].direction === "in" && history[history.length - 1].body === m.message
    ? history.slice(0, -1) : history;
  const scope = v2 ? scopeOrders({ message: m.message, recent: recentTurns, own: senderOrders, mentioned: finalMentioned }) : null;
  const scopedOrders = scope ? scope.orders : senderOrders;
  // Whether this message or the recent thread even looks like a return, gating
  // the return-window fact on the order line below — see formatOrders.
  const returnIntent = hasReturnIntent(mentioned);
  // Refund / billing / cancellation intent — each gates one enrichment below,
  // and a false positive is only an extra DB read (see the matchers in
  // lib/supportGuardrails.ts).
  const billingIntent = hasBillingIntent(mentioned);
  const refundIntent = hasRefundIntent(mentioned);
  const cancellationIntent = hasCancellationIntent(mentioned);
  // The refund ledger, keyed by order id — only read when the message is about a
  // return, a refund, or a cancellation. Rendered on own lines only.
  const refunds = (returnIntent || refundIntent || cancellationIntent)
    ? await refundsByOrder(db, senderOrders.map((o) => o.id))
    : undefined;
  // Remember which order this turned out to be about. The bot resolves it to
  // answer with and then discards it, leaving the inbox unable to say which of
  // thirty threads concerns the order you are looking for.
  const subject = orderRows[0]?.id ?? null;
  if (subject && conv?.order_id !== subject) {
    await patchConversation(db, m.phone, { order_id: subject });
  }
  // ...and on the message itself, not just the thread. A conversation carries one
  // order_id, so a customer asking about two orders across a week leaves only the
  // most recent on the thread; the per-message stamp is what lets "which messages
  // were about AJUKI710013" be answered at all.
  await stampOrder(db, inboundId, subject);

  type Decision = Awaited<ReturnType<typeof generateSupportReply>>;
  // The fixed-reply decisions live in lib/replyOverrides.ts (pure, tested directly, replayed by the evaluation harness). WhatsApp
  // keyboards send curly apostrophes (don’t, won’t) and every rule pattern is written with the straight one: the rules read ruleMessage().
  const lastBotReply = lastBotReplyOf(history);
  // Skipped while an NDR button flow is waiting on the customer's next message (pending_action): a bare phone number
  // or address then belongs to that flow, which has its own policy.
  const noPending = !(conv?.pending_action as { kind?: string } | null | undefined)?.kind;
  const overrideInput: OverrideInput = {
    message: m.message, history, recentTurns, senderPhone: m.phone, senderOrders, finalMentioned, scopedOrders,
    scopeBasis: scope ? scope.basis : null, v2, lastBotReply, lastOutAt: conv?.last_out_at, noPending,
    imagesCount: images.length, wake: Boolean(m.wake), hasRefundRecord: !!refunds && refunds.size > 0,
  };
  // FAST PATH — fixed replies that do not need the model (a greeting, a bare order id, a plain topic question, a clarifying line, the
  // 11:00 bare reply): skip retrieval, the model and the verifier entirely. Anything it does not claim goes the long way round and
  // the same rules run after the model.
  const firstTouch = firstTouchDecision(overrideInput);
  let fastDecision: Decision | null = firstTouch ? firstTouch.decision : null;
  if (firstTouch) {
    console.log(JSON.stringify({ event: firstTouch.via === "fast" ? "support_fast_path" : "support_queued_bare_reply", phone: m.phone, kind: firstTouch.kind }));
  }
  // The order-context text the model was given, kept only for the decision trace (the open-case fact the situation reads).
  let orderContextText = "";
  // The product facts the model was given, kept for the general-path shadow (lib/generalShadow.ts).
  let productContextText = "";
  const runModel = async (): Promise<Decision> => {
    // The === CUSTOMER === header — identity, order tally, and any open case.
    const customerBlock = await customerContextBlock(db, { phone: m.phone }, name, senderOrders);
    // Formatted in two passes so the address only ever rides along with orders
    // proven to be the sender's own — see formatOrders.
    //
    // Each pass is labelled with where it came from, which is not decoration. The
    // orders used to arrive as one unlabelled list, so when a customer typed their
    // phone number the model had no way to tell that the order already in front of
    // it had been found by that very number — and answered "I can't find an order
    // associated with that phone number" three times in ninety seconds with the
    // order sitting in its context. Reproduced exactly, then fixed by saying which
    // number the orders came from.
    // Without the courier's scan text on any path (founder, 12 Oct): the old path's model was told to quote it, the general path never sees it.
    const orders = withoutScanText([
      customerBlock,
      senderOrders.length
        ? `Found by this customer's own WhatsApp number, +91 ${m.phone}, these are certainly theirs:\n${formatOrders(senderOrders, true, returnIntent, billingIntent, refunds, replacementOf)}`
        : `No orders are registered against their WhatsApp number, +91 ${m.phone}.`,
      finalMentioned.length
        ? `Found from an order ID or another number mentioned in this chat:\n${formatOrders(finalMentioned, false, returnIntent)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"));
    orderContextText = orders;
    // The knowledge base is switched off (lib/businessTruths.ts USE_KNOWLEDGE_BASE): the prompt ignores what retrieval returns,
    // so do not pay for the embedding call and the chunk read just to throw them away.
    const { chunks, ranked: chunksRanked } = USE_KNOWLEDGE_BASE
      ? await retrieveChunks(db, m.message)
      : { chunks: [] as Awaited<ReturnType<typeof retrieveChunks>>["chunks"], ranked: true };
    // Catalogue details for any product the message names — price, stock, link —
    // so a product question gets a real answer and the reply can carry the link.
    let products = await productContext(m.message);
    // "First one", "yes that", "the gold" name nothing, so the line above finds nothing — and the answer, a price and a link, was then
    // blocked as unsupported although the bot itself had listed those two products a message earlier (9 Oct). When the latest message
    // matches nothing, look for the products the thread has been about instead: the last few turns, both sides.
    if (!products && history.length) products = await productContext(history.slice(-4).map((t) => t.body).join("\n"));
    productContextText = products;
    // A picture carries no words to match on, so the shortlist has to be the whole
    // catalogue — otherwise the model is asked to identify a bracelet with nothing
    // to identify it against, and invents. Costs ~₹0.10 in tokens, on the small
    // fraction of messages that are photos.
    const catalogue = images.length ? await catalogueIndex() : "";
    return generateSupportReply({
      message: m.message || (images.length ? "(the customer sent a photo with no message)" : ""),
      history, orderContext: orders, productContext: products, chunks, chunksRanked, images, catalogue,
      // Fetched here, not with the flags at the top: this is the only line that
      // reads the persona, and every kill-switch and burst check above it can
      // return without ever reaching the model.
      config: await getSupportConfigWithPersonas(db),
    });
  };
  let decision: Decision = fastDecision ?? await runModel();
  // What the model itself drafted, before any fixed override replaces it: the trace keeps it when it was not what was sent.
  const modelDraft = fastDecision ? null : {
    action: decision.action as string, tag: decision.tag as string, text: decision.text ?? null,
    provenance: (typeof decision.meta?.provenance === "string" ? decision.meta.provenance : null) as string | null,
  };

  // A pending or rejected return, a cancellation after dispatch, an order already cancelled, a topic line, a late parcel: fixed wording
  // written in code replaces the model's text (lib/replyOverrides.ts applyOverrides).
  if (!fastDecision) decision = applyOverrides(decision, overrideInput);

  // LIVE-LITE LATE-DELIVERY AGENT, decided HERE, before the general path (SUPPORT_DELIVERY_AGENT=live, default off): where it has an approved line that line is used below; where it
  // has none, what it read about the parcel goes into the record the general path writes from (withAgentFacts), so the reply is written and verified under the same grounding
  // gate but knows the phase and how long the parcel has been still. A late-parcel turn only: the existing late line, or a late / order-status tag.
  let agent: Awaited<ReturnType<typeof runDeliveryLive>> | null = null;
  if (!fastDecision && deliveryAgentMode() === "live" && senderOrders.length && deliverySampled(m.phone) && images.length === 0 && !decision.orderAction) {
    const fr = decision.meta?.fixedReply;
    // A question of the agent's still waiting for its answer ("which day?", "did the rider call?") makes the reply that follows a late turn too, whatever it looks like ("tomorrow", "no one called").
    const lateTurn = (fr === undefined ? (decision.tag === "late_delivery" || decision.tag === "order_status") : (fr === "late_first" || fr === "late_insist" || fr === "lookup_late")) || await hasAwaitingCase(db, m.phone);
    if (lateTurn) {
      const liveRef = { text: decision.text ?? null, action: decision.action as string, kind: String(decision.meta?.provenance ?? decision.meta?.fixedReply ?? "?") };
      agent = await runDeliveryLive({ db, phone: m.phone, message: m.message, history, orders: senderOrders as never, inboundId, live: liveRef });
    }
  }

  // LIVE (lib/generalLive.ts; on at 100% by default, SUPPORT_GENERAL_LIVE=0 / SUPPORT_GENERAL_LIVE_RATE / SUPPORT_GENERAL_LIVE_PAUSE turn it down): for each sampled customer the
  // model-written reply of THIS turn is replaced by the general conversational path's, after the fixed overrides have had their say and
  // before the final guard. Never a fixed reply, an order action or a photo; rated with the damage ruler first; any error, any
  // irreparable finding, or its own flag line leaves `decision` exactly as the existing path made it.
  if (!fastDecision && generalLiveEnabled() && liveSampled(m.phone) && orderContextText) {
    const skip = eligibleForLive(decision, images.length);
    if (skip) {
      decision = { ...decision, meta: { ...decision.meta, generalLiveSkipped: skip } };
    } else {
      try {
        const g = await generalLiveDecision({
          decision, message: m.message, history, orderContext: withAgentFacts(orderContextText, agent && !agent.line ? agent.rec : null), products: productContextText,
          scopedOrderIds: (scopedOrders.length ? scopedOrders : senderOrders).map((o) => o.id),
        });
        console.log(JSON.stringify({ event: "support_general_live", phone: m.phone, used: g.info.used, why: g.info.why, tier: g.info.tier ?? null, handoff: g.info.handoffSource ?? null }));
        decision = g.decision ?? { ...decision, meta: { ...decision.meta, generalLiveFallback: g.info } };
      } catch (err) {
        console.warn("[support] general live trial failed, using the existing reply:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  // LIVE-LITE LATE-DELIVERY AGENT (lib/deliveryShadow.ts runDeliveryLive, SUPPORT_DELIVERY_AGENT=live, default off; SUPPORT_DELIVERY_AGENT_RATE = the share of customers,
  // by a stable hash of the phone). For a message about a late or failed parcel, the state machine decides, and for a few approved lines (LIVE_LITE_IDS: first reply with
  // no lever, nothing newer, 48 hours, repeated chase, two failed attempts, movement update) its line replaces the reply and a person is prompted where its ledger says so.
  // No courier action is taken and no ticket is requested. Never a photo, an order action, or another topic's fixed line (return, cancel, address, discount ...); any error,
  // timeout or other decision leaves `decision` exactly as the existing path made it.
  // The agent was decided above, before the general path, so its parcel facts reached the writer (lib/deliveryFacts.ts).
  if (agent) {
    const r = agent;
    // B2 says the courier was asked for a delivery day: ask first (SUPPORT_DELIVERY_AGENT_ACTIONS), then say only what happened (lib/deliveryActionReply.ts).
    if (r.line && r.line.replyId === "B2" && r.rec?.order) {
      const res = await runCourierAction(db, { orderId: r.rec.order.id, ask: { act: "DEFER_DLV", date: dateFromMessage(m.message, Date.now()) }, why: "customer asked in chat" }).catch(() => null);
      r.line = deferLine(r.line, r.rec.order.id, res, { promiseLater: updatesMode() === "on" });
    }
    if (r.rec) void storeDeliveryShadow(db, inboundId, { ...r.rec, state: { ...r.rec.state, note: r.line ? r.rec.state.note : (r.rec.state.note ?? "the existing path answered") } }).catch(() => { /* a record; never affects the reply */ });
    if (r.line) {
      console.log(JSON.stringify({ event: "support_delivery_agent_live", phone: m.phone, replyId: r.line.replyId, escalate: r.line.escalate }));
      // The ticket this escalation calls for (SUPPORT_DELIVERY_AGENT_TICKETS = off | dry | on, default off): Delhivery is queued for the night run, Shadowfax is raised now.
      // No person prompted: tell the ops chat what the customer wrote and was told, so a suppressed escalation is visible live (lib/deliveryAlert.ts). Fire-and-forget.
      { const alert = suppressionAlert({ line: r.line, orderId: r.rec?.order?.id ?? "?", phone: m.phone, message: m.message ?? "" }); if (alert) void notify("OPS", alert).catch(() => { /* never affects the reply */ }); }
      if (r.line.person && r.rec?.order) void runTicketRequest(db, { phone: m.phone, orderId: r.rec.order.id, escalate: r.line.escalate }).catch(() => { /* never affects the reply */ });
      decision = {
        action: r.line.person ? "escalate" : "reply", text: r.line.text, tag: "late_delivery",
        ...(r.line.person ? { reason: `late-delivery agent: ${r.line.escalate}` } : {}),
        meta: { ...(decision.meta ?? {}), fixedReply: `delivery_agent_${r.line.replyId}`, deliveryAgentLive: { replyId: r.line.replyId, escalate: r.line.escalate }, replacedDraft: decision.text ?? null },
      };
    }
  }

  // An address change on a dispatched parcel that asked for the new address: park the proposal flow so the next typed message is taken as that address
  // (lib/bookedAddressEdit.ts). The order is the one booked parcel the ask was about; if it cannot be found the ask is replaced by the escalation line.
  if (decision.meta?.fixedReply === "address_ask") {
    const target = bookedOrderForAddressEdit(scopedOrders.length ? scopedOrders : senderOrders);
    // A fragment of an address we have JUST passed to the courier (21 Oct: "201301", sent a minute after the rest) is not a new request: asking for the address again opened a second one.
    // The team checks that what the courier holds is what the customer meant.
    if (!target || (await recentCourierAddressEdit(db, m.phone)) || !(await parkAddressEditPending(db, m.phone, target.id))) {
      decision = { action: "escalate", text: ADDRESS_FLAG_REPLY, tag: "address_change", reason: "address change on a dispatched parcel (could not take the address here)", meta: { ...(decision.meta ?? {}), fixedReply: "address_flag" } };
    }
  }

  // An unhappy customer whose parcel really is late or failed, answered with a model-written reply and no person asked: the reply still goes, and the escalation below opens a case.
  // (24 Oct: AJUKI710054, undelivered nine days, got "no need to worry" twice and nobody was told; lib/lateEscalate.ts.)
  if (decision.action === "reply" && !decision.meta?.fixedReply && !decision.orderAction && decision.text) {
    const why = lateEscalation({ message: m.message ?? "", orders: orderRows as never, now: Date.now() });
    if (why) decision = { ...decision, action: "escalate", tag: "late_delivery", reason: why, meta: { ...(decision.meta ?? {}), lateNet: why } };
  }

  // One last gate for every path (fast, fixed, model, repaired): text that is neither a fixed reply nor verified model text is not sent.
  decision = finalGuard(decision);
  // Record the deliberate wait on the reply itself, so the Bot tab's slow-reply counter can tell it apart from real delay.
  decision = { ...decision, meta: withQuietWait(decision.meta, quietWaitMs) };

  // SHADOW ONLY (lib/completenessShadow.ts, COMPLETENESS_SHADOW=1): record whether a second reader thinks the reply answers what was
  // asked, next to the reply in ai_meta. It never changes the text, the action or the escalation, and a failure here is swallowed.
  if (completenessShadowEnabled() && decision.text) {
    try {
      const record = formatOrders(senderOrders, true, returnIntent, billingIntent, refunds, replacementOf);
      const rec = await completenessShadow({ message: m.message, history, record, draft: decision.text });
      decision = { ...decision, meta: { ...decision.meta, shadow: { ...((decision.meta?.shadow as object) ?? {}), completeness: rec } } };
    } catch { /* never affects the reply */ }
  }

  // The record of why this reply is what it is (lib/decisionTrace.ts). It rides the decision's meta onto the outbound row.
  if (traceOn) {
    // The code's own reading of the turn (lib/situation.ts), from the message, the thread and the record, without the model's tag.
    // Recorded next to what was actually sent; it changes nothing, and a failure here never reaches the customer.
    let situation: Parameters<typeof buildTrace>[0]["situation"] = null;
    try {
      const s = classifySituation({
        message: m.message, recent: recentTurns, own: senderOrders, mentioned: finalMentioned, senderPhone: m.phone,
        lastBotReply, lastOutAt: conv?.last_out_at ?? null, hasRefundRecord: !!refunds && refunds.size > 0,
        refunds: refunds ? Object.fromEntries(refunds) : undefined,
        openCase: orderContextText ? teamHasItOpen([orderContextText]) : false,
        hasImages: images.length > 0, pendingFlow: !noPending, wake: Boolean(m.wake),
      });
      const fixed = typeof decision.meta?.fixedReply === "string" ? decision.meta.fixedReply : null;
      situation = { s, agree: compareToActual(s, fixed) };
    } catch (err) {
      console.warn("[support] situation classifier failed:", err instanceof Error ? err.message : String(err));
    }
    decision = { ...decision, meta: { ...decision.meta, trace: buildTrace({
      decision, modelDraft, v2, wake: Boolean(m.wake), quietWaitMs, situation,
      scope: { basis: scope?.basis ?? null, subject, orders: scopedOrders.length },
    }) } };
  }
  // SHADOW (lib/generalShadow.ts, SUPPORT_GENERAL_SHADOW=1, default off): what the general conversational path would have said, and the
  // code's decision about a person, recorded beside what is about to be sent. Started now and NOT awaited: it adds no latency, cannot
  // change the reply, and every error is swallowed. Only for turns the model answered and that have an inbound row to write to.
  if (generalShadowEnabled() && inboundId && !fastDecision && typeof decision.meta?.fixedReply !== "string" && !decision.meta?.generalLive && orderContextText && shadowSampled(m.phone)) {
    try {
      const ids = (scopedOrders.length ? scopedOrders : senderOrders).map((o) => o.id);
      const live = { text: decision.text ?? null, action: decision.action as string, kind: String(decision.meta?.provenance ?? decision.meta?.fixedReply ?? "?") };
      void runGeneralShadow({
        message: m.message, thread: history, record: recordFor(orderContextText, ids), fullRecord: orderContextText, products: productContextText,
        live, handoffRecord: orderContextText,
      }).then((rec) => storeGeneralShadow(db, inboundId, rec)).catch(() => { /* a diagnostic; never affects the reply */ });
    } catch { /* a diagnostic; never affects the reply */ }
  }
  // SHADOW (lib/deliveryShadow.ts, SUPPORT_DELIVERY_AGENT=shadow, default off): what the late-delivery agent would have said and done about a late or failed
  // parcel, with its own memory of the case, recorded beside what is about to be sent. Started now and NOT awaited; every error is swallowed; it sends
  // nothing and opens nothing. Unlike the general shadow it also covers turns a fixed rule answered, which is where most late-delivery replies come from.
  if (deliveryAgentMode() === "shadow" && inboundId && senderOrders.length && deliverySampled(m.phone)) {
    try {
      const live = { text: decision.text ?? null, action: decision.action as string, kind: String(decision.meta?.provenance ?? decision.meta?.fixedReply ?? "?") };
      void runDeliveryShadow({ db, phone: m.phone, message: m.message, history, orders: senderOrders as never, inboundId, live })
        .then(async (rec) => {
          await storeDeliveryShadow(db, inboundId, rec);
          // A shadow run only ever DRY-runs the ticket it would have requested (a dry_run row, no courier call), so the requests can be read before anything is switched on.
          if (rec?.decision && rec.order && rec.decision.escalate !== "none") await runTicketRequest(db, { phone: m.phone, orderId: rec.order.id, escalate: rec.decision.escalate, forceDry: true });
          // Likewise a Delhivery date or re-attempt the agent would have taken (SUPPORT_DELIVERY_AGENT_ACTIONS = off | dry | on, default off): planned and logged, never submitted from a shadow run.
          const act = rec?.decision?.action;
          if (rec?.order && act?.allowed && (act.name === "DEFER_DLV" || act.name === "RE-ATTEMPT")) await runCourierAction(db, { orderId: rec.order.id, ask: { act: act.name }, forceDry: true, why: "shadow" });
        }).catch(() => { /* a diagnostic; never affects the reply */ });
    } catch { /* a diagnostic; never affects the reply */ }
  }
  // For the outcomes that send nothing: the same record, written to the inbound row with the outcome that stopped it.
  const finishInbound = (outcome: TraceOutcome, reason: string): Promise<void> => {
    const t = decision.meta?.trace as DecisionTrace | undefined;
    return traceOn && t ? writeInboundTrace(db, inboundId, { ...t, outcome, reason }) : Promise.resolve();
  };

  await pace(startedAt);

  // Stand down if they have carried on typing — before any state is written, not
  // just before the send. The escalation below claims the acknowledgement ahead
  // of sending to win a race with itself, so a handler that bailed out after
  // claiming would leave the later one believing the customer had already been
  // answered, and nobody would speak at all.
  //
  // Checked after the pace so the whole thinking window counts: that is where
  // the next message in a burst almost always lands.
  if (await overtaken(db, m.phone, arrivedAt)) {
    console.log(JSON.stringify({ event: "support_superseded", phone: m.phone, where: "read" }));
    await finishInbound("superseded", "newer message arrived while this was being decided");
    return;
  }

  // The read above is the cheap early exit; this is the one that actually
  // decides. Two handlers can both pass `overtaken` — it is a read, and a read
  // cannot settle a race — so the right to answer is claimed with a conditional
  // update that Postgres serialises. Newest message wins; an older handler loses.
  if (!(await claimAnswer(db, m.phone, arrivedAt))) {
    console.log(JSON.stringify({ event: "support_superseded", phone: m.phone, where: "claim" }));
    await finishInbound("superseded", "another handler claimed the answer");
    return;
  }

  // Re-read the thread state one last time.
  //
  // `conv` was fetched before the model was called, and that call can take 28
  // seconds on a photo, plus the reply floor on top. A human who opened the
  // inbox and answered during that window was invisible to everything above,
  // which is how eight threads ended up with the bot talking over someone who
  // had already taken the conversation.
  const fresh = (await getConversation(db, m.phone)) ?? conv;
  if (fresh?.taken_over) {
    console.log(JSON.stringify({ event: "support_taken_over_midflight", phone: m.phone }));
    await patchConversation(db, m.phone, { unread: true });
    await finishInbound("taken_over", "a person took the thread while this was being decided");
    return;
  }

  // A fixed reply is sent once. If this exact text is what the customer was last told (lib/waBurst.ts repeatsLastReply), do not
  // send it again: the thread goes quiet, stays unread, and the team is pinged that the customer is chasing — the same rule as an
  // escalation. Only deterministic fixed replies are held back; a model-written reply is never identical, and an escalation has its
  // own quiet period below. Nothing was changed on an order here (fixed replies carry no action), so there is nothing to undo.
  let repeatsRecent = false;
  if (decision.text && !decision.orderAction && typeof decision.meta?.fixedReply === "string") {
    // Any of our last few lines, not just the very last one: two canned answers that alternate defeat a last-line-only check.
    const { data: outs } = await db.from("wa_messages").select("body, created_at").eq("phone", m.phone).eq("direction", "out")
      .order("created_at", { ascending: false }).limit(6);
    repeatsRecent = repeatsRecentReply(decision.text, ((outs as { body: string; created_at: string }[]) ?? []).map((r) => ({ body: r.body, at: r.created_at })));
  }
  if (decision.action === "reply" && decision.text && !decision.orderAction
      && typeof decision.meta?.fixedReply === "string"
      && (repeatsLastReply(decision.text, lastBotReply, fresh?.last_out_at) || repeatsRecent)) {
    console.log(JSON.stringify({ event: "support_fixed_reply_not_repeated", phone: m.phone, kind: decision.meta.fixedReply, window: repeatsRecent ? "recent" : "last" }));
    // A repeated line cannot help them, so the line itself is not sent again. But a message that adds something NEW is not a chase: on 16 Oct a
    // customer told their return was pending wrote "Product showing in the app is different than the order I have received" and got silence.
    // That gets one short acknowledgement (unless we just said exactly that), and the team is told either way.
    const addsNew = images.length > 0 || addsNewContent(m.message);
    const ackRecently = addsNew && await sentRecently(db, m.phone, HELD_NEW_INFO_ACK, 6);
    // With the fixes on, the hold is VISIBLE — the thread goes to the team's queue as escalated with a case, and the ping goes to the
    // unmuted chat — instead of an unread flag and a muted note.
    await patchConversation(db, m.phone, { unread: true, status: "escalated", escalated: true, escalate_reason: addsNew ? "new information after a fixed answer" : "customer chasing — same answer already sent" });
    await recordCaseOrAlert(db, { phone: m.phone, tag: decision.tag, reason: addsNew ? "new information after a fixed answer" : "customer chasing — same answer already sent", name });
    await notify(
      "LIVE",
      (addsNew ? `🆕 <b>New information after a fixed answer</b> · ${tgPhone(m.phone)}\n` : `🔁 <b>Customer chasing — same answer already sent</b> · ${tgPhone(m.phone)}\n`) +
      `${name}\n"${m.message.slice(0, 400)}"\n\n` +
      `<i>They were last told exactly this, so it was not sent again (${decision.meta.fixedReply})${addsNew ? " — but this message adds something, so they were told it was escalated" : ""}:</i>\n${decision.text.slice(0, 300)}\n\n` +
      `<a href="${ADMIN_INBOX}?phone=${m.phone}">Open in support inbox</a>`,
    ).catch(() => {});
    if (addsNew && !ackRecently) {
      await sendHoldingAck(db, m.phone, HELD_NEW_INFO_ACK, decision.tag, senderOrders.length > 0, withTraceOutcome(decision.meta, "escalated_ack", "a fixed answer would have repeated, but the message added something new"));
      return;
    }
    await finishInbound("held_repeat", `same fixed answer already sent (${decision.meta.fixedReply}, ${repeatsRecent ? "recent lines" : "last line"})`);
    return;
  }

  // An action the model asked for, carried out before the reply goes out — so a
  // customer is never told their order was cancelled and then finds it was not.
  // runAction re-checks everything: that the order is theirs, that nothing is
  // booked, that the value stands up. A refusal comes back as a sentence written
  // for the customer, which replaces the reply rather than being appended to it.
  let actionRefusal: string | null = null;
  if (decision.orderAction) {
    const { runAction, toActionRequest } = await import("@/lib/supportActionRun");
    const outcome = await runAction(db, toActionRequest(decision.orderAction), {
      phone: m.phone, customerName: name,
    });
    if (!outcome.ok) {
      actionRefusal = outcome.message;
      console.log(JSON.stringify({ event: "support_action_refused", phone: m.phone, kind: outcome.kind, reason: outcome.reason }));
    } else {
      console.log(JSON.stringify({ event: "support_action_applied", phone: m.phone, kind: outcome.kind, order: outcome.orderId }));
    }
  }

  if (decision.action === "reply" && decision.text) {
    // The model wrote its reply believing the change would go through. When it
    // did not, that reply is now untrue, so the refusal is sent instead.
    const body = actionRefusal ?? decision.text;
    await sendWhatsApp(m.phone, body);
    await recordOutbound(db, { phone: m.phone, body, source: "ai", tag: decision.tag, aiMeta: withTraceOutcome(decision.meta, actionRefusal ? "action_refused" : "sent", actionRefusal ? "order action refused; the refusal was sent instead" : undefined) });
    // A refused action leaves the customer wanting something we would not do, so
    // the thread stays open for a person rather than being marked handled.
    await patchConversation(db, m.phone, actionRefusal
      ? { status: "escalated", escalated: true, escalate_reason: "action refused", unread: true }
      : { status: "ai_handled", escalated: false, unread: false });
    if (actionRefusal) {
      await recordCaseOrAlert(db, { phone: m.phone, tag: decision.tag, reason: "action refused", name });
    }
    return;
  }

  // Escalation. An escalation is a *state*, not an event: the customer has been
  // told a person is coming, and that stays true for every message they send
  // afterwards. Saying it again on each one is what makes the bot feel like a
  // machine — "I want to be called", "Urgent" drew three near-identical
  // apologies inside three minutes, which is worse than answering nothing.
  //
  // So the acknowledgement is sent once and then the thread goes quiet, while
  // the team still gets every follow-up. Silence here is not neglect: a human
  // is already on it, and the chasing messages are exactly what tells them how
  // impatient the customer is getting.
  // Quiet only while the customer is chasing the *same* thing. A thread
  // escalated over a wrong address then asked "can you cancel the order?" is not
  // repeating itself, it is asking something new — and staying silent left that
  // customer sending "??" into nothing for over an hour until a human noticed.
  // The tag is what tells the two apart: same subject is a chaser, a different
  // one is a new request and gets answered.
  // Read off `fresh`, not the `conv` fetched before the model call. The whole
  // point of this check is "has this customer already been told someone is
  // coming", and a state read half a minute ago cannot answer that — a human
  // replying mid-flight moves last_out_at, and the stale copy would not show it.
  const acknowledged = alreadyAcknowledged(fresh) && fresh?.last_tag === decision.tag;

  await patchConversation(db, m.phone, {
    status: "escalated", escalated: true, escalate_reason: decision.reason ?? "needs_human", unread: true,
    // Claim the acknowledgement here, before the send rather than after it.
    //
    // recordOutbound stamps last_out_at once the message is away, but the reply
    // floor holds it five seconds first — and a customer sending two lines in a
    // row has both webhooks running at once. The second would read an
    // `escalated` that was already true and a last_out_at that had not moved
    // yet, conclude nobody had answered, and send a near-identical apology a
    // second after the first. Which is precisely the repetition the quiet period
    // exists to prevent.
    //
    // If the send then fails the thread stays quiet for six hours having said
    // nothing — the worse of the two only in the rarer case, and the team is
    // pinged either way.
    ...(acknowledged ? {} : { last_out_at: new Date().toISOString() }),
  });

  // A durable case, not just the conversation flag above — this is what makes
  // the escalation survive past the one Telegram ping. Best-effort: a customer
  // must still get their acknowledgement even if identity/case writes fail,
  // so a failure here is logged, not thrown.
  await recordCaseOrAlert(db, { phone: m.phone, tag: decision.tag, reason: decision.reason ?? "needs_human", name });

  const lateInsist = decision.meta?.fixedReply === "late_insist" && !(await sentRecently(db, m.phone, decision.text ?? "", 1));
  const returnAndLate = decision.meta?.fixedReply === "return_and_late" || decision.meta?.fixedReply === "lookup_late";
  // The late-delivery agent's own lines, and the thank-you for a phone number we asked for, answer something NEW: they go even when this thread was acknowledged earlier. Before, the agent's
  // line was decided, the case opened, and the customer sent nothing (22-23 Oct: AJUKI710035's two_failed line and AJUKI710079's B1 question, whose answer then met silence too).
  const agentLine = String(decision.meta?.fixedReply ?? "").startsWith("delivery_agent_") || decision.meta?.fixedReply === "phone_given";
  if (!acknowledged || lateInsist || returnAndLate || agentLine) {
    // Preferably in the model's own words — on a return request that
    // acknowledgement carries the facts (delivered when, window open or closed,
    // what to send us) which a canned line cannot. The fixed holding message is
    // the fallback for escalations born of failure, where nothing model-written
    // exists to send.
    const ack = decision.text || FLAG_REPLY;
    await sendHoldingAck(db, m.phone, ack, decision.tag, senderOrders.length > 0, withTraceOutcome(decision.meta, "escalated_ack"));
  } else {
    // Already told, but the message adds something (an answer to our question, a number, an email address, a photo): one short acknowledgement instead of silence, not repeated within six hours.
    const addsNew = images.length > 0 || addsNewContent(m.message);
    if (addsNew && !(await sentRecently(db, m.phone, HELD_NEW_INFO_ACK, 6))) {
      await sendHoldingAck(db, m.phone, HELD_NEW_INFO_ACK, decision.tag, senderOrders.length > 0, withTraceOutcome(decision.meta, "escalated_ack", "already told someone is coming, but the message added something new"));
    } else {
      await finishInbound("escalated_quiet", "already told someone is coming; the team was pinged, the customer was sent nothing");
    }
  }

  // Telegram-only enrichment — never the model's context (founder decision):
  //  · the internal rejection note on any return this customer has raised, and
  //  · a bald RTO-history ratio.
  // Both computed from the sender's own real orders, excluding any replacement
  // parcel folded in above (a replacement is not part of their return history).
  const ownReal = senderOrders.filter((o) => !replacementOf.has(o.id));
  const rejectionNotes = ownReal
    .map((o) => o.return_request?.admin_note)
    .filter((n): n is string => Boolean(n));
  const rtoHistory = ownReal.filter((o) => o.status === "rto" || o.status === "returned").length;

  // OPS, not the unmuted LIVE chat: "the team will get back to you in a few
  // hours" is a today job, not a now one. The `acknowledged` (chasing) variant
  // is on borrowed time — it folds into the daily summary's chaser aggregate
  // once that ships (spec §6/§13), and comes out of here then.
  // The customer has just been told to wait 3-5 working hours. The number is
  // printed unspaced so Telegram turns it into a tappable phone_number entity —
  // one tap is the dialer, which is the fastest way to turn a 3-hour wait into
  // a two-minute call. A `tel:` button would be better still and Telegram
  // rejects it outright; see tgPhone() for the measurement.
  // A message on an already-acknowledged thread is normally just a chaser, and the thread stays quiet. When it asks for something
  // NEW (reschedule, change address, cancel, call me…) the team is told so in a separate alert to the unmuted chat. The customer is
  // sent nothing extra and nothing is acted on (lib/newRequest.ts).
  const newRequest = acknowledged ? newRequestKind(m.message) : null;
  await sendWithButtons(
    newRequest ? "LIVE" : "OPS",
    (newRequest
      ? `🆕 <b>New request on an escalated thread</b> · <b>${newRequest}</b> · ${decision.tag}\n`
      : acknowledged
        ? `🔁 <b>Customer chasing</b> · already escalated · <b>${decision.tag}</b>\n`
        : `⚠️ <b>Support escalation</b> · <b>${decision.tag}</b>\n`) +
    `${name} · ${tgPhone(m.phone)}\n\n"${m.message.slice(0, 400)}"\n\n` +
    `<i>Why:</i> ${decision.reason ?? "needs a human"}\n` +
    (newRequest ? `<i>Not replied to — they were already told someone is coming — but this asks for something: ${newRequest}. It needs a person to act, not just to read.</i>\n`
      : acknowledged ? `<i>Not replied to, they were already told someone is coming.</i>\n` : "") +
    (rejectionNotes.length ? `<i>Rejection note (internal):</i> ${rejectionNotes.join(" · ")}\n` : "") +
    (ownReal.length ? `<i>RTO history:</i> ${rtoHistory} of last ${ownReal.length} orders returned/rto\n` : "") +
    `\n<b>Their orders</b>\n${orderLinesForTelegram(orderRows)}\n\n` +
    `<i>Tap the number above to call.</i>`,
    [[
      { text: "💬 WhatsApp", url: waLink(m.phone) },
      { text: "Open inbox", url: `${ADMIN_INBOX}?phone=${m.phone}` },
    ]],
  );
}

