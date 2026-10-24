// A deliberate quiet period before the bot answers.
//
// People write in bursts: a photo, then "I want this", then the order number, each a few seconds apart. The bot used to start
// answering the first line the moment it landed, and the only protection against talking over the rest was a five-second floor
// plus the "was I overtaken?" check after the model call. Of the 616 pairs of consecutive customer messages less than two
// minutes apart in the ten days to 2026-10-10, 41% followed within 10 s, 57% within 15 s and 67% within 20 s — mostly after the
// reply floor had already lapsed, so the bot answered the first line and then again, or answered without the second.
//
// The fix is to wait for the customer to finish. Before the bot reads the thread or calls the model it sleeps for a fixed quiet
// period; if a newer message from the same sender has arrived by then it stands down and leaves the answer to the handler for
// that newer message, which does the same wait from ITS arrival. The reply therefore goes out one quiet period after the LAST
// message of a burst, with the whole burst in the history.
//
// Applies to every customer-facing reply sent from lib/waSupport.ts handleSupportMessage: the normal answer, the legal/fraud keyword
// hold and the out-of-hours notice. It does NOT apply to wake replays, to the fixed COD-confirmation / NDR-button / opt-out /
// media-notice replies in the webhook, or to templates and automatic notifications.
//
// Pure, with no database or network, so every rule here is unit-tested. The sleep itself and the overtaken check live in
// lib/waSupport.ts.
//
// This is NOT the Phase 1 Response Guard. It changes when the bot answers, not what it says.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * How long to wait after a message before answering, in milliseconds. 60 s — the founder's decision (2026-10-10), replacing the
 * 12 s first chosen from the gaps above.
 *
 * Consequences worth knowing: every bot reply now arrives about a minute after the customer's LAST message plus the model's own
 * 3–15 s. The Bot tab's "slow reply" counter (lib/botMetrics.ts SLOW_REPLY_MS = 30 s) will therefore count nearly every reply as
 * slow — a consequence of the deliberate wait, not a fault; its definition is unchanged. A message that lands in the last minute
 * of support hours is answered just after closing, because hours are judged on arrival, not on sending.
 */
export const DEFAULT_REPLY_DELAY_MS = 60_000;

/** A configured value above this is treated as a typo, not a wish. */
export const MAX_REPLY_DELAY_MS = 60_000;

/**
 * Once a webhook batch has been running this long, stop adding delay to the messages still queued behind it. A batch from
 * several senders is handled one after another and the whole thing must finish inside the platform's 300 s ceiling
 * (app/api/webhooks/whatsapp/route.ts); the model calls alone were measured at ~250 s for five senders. With a 60 s delay this means the first one or two senders in a batch wait the full minute and any later ones are answered without the extra wait.
 */
export const BATCH_DELAY_BUDGET_MS = 90_000;

/**
 * The configured delay from SUPPORT_REPLY_DELAY_MS (milliseconds): unset or unreadable ⇒ the default; "0" ⇒ off; a negative
 * number ⇒ off; anything above the cap ⇒ the cap.
 */
export function configuredReplyDelayMs(raw: string | undefined = process.env.SUPPORT_REPLY_DELAY_MS): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REPLY_DELAY_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_REPLY_DELAY_MS;
  if (n <= 0) return 0;
  return Math.min(Math.round(n), MAX_REPLY_DELAY_MS);
}

/** The delay actually applied: the configured one, or none once this webhook batch has used up its delay budget. */
export function delayToApply(o: { configured: number; elapsedInBatchMs: number }): number {
  if (o.configured <= 0) return 0;
  if (o.elapsedInBatchMs >= BATCH_DELAY_BUDGET_MS) return 0;
  return o.configured;
}

/**
 * Stamp how long the reply deliberately waited into the decision's meta, which is stored as wa_messages.ai_meta. The Bot tab
 * subtracts it when it asks whether a reply was slow (lib/botMetrics.ts), so a deliberate minute is not counted as a slow answer.
 * Nothing is stamped when no wait happened, so every reply from before this existed reads as it always did.
 */
export function withQuietWait<M extends Record<string, unknown>>(meta: M | undefined, waitedMs: number): M & { quietWaitMs?: number } {
  const base = (meta ?? {}) as M;
  return waitedMs > 0 ? { ...base, quietWaitMs: Math.round(waitedMs) } : base;
}

// ── The batch clock ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A webhook payload's messages are processed sequentially inside one after() callback, so "how long has this batch been running"
// is a property of the call chain, not of a module variable (the server handles several webhooks concurrently).

const batchClock = new AsyncLocalStorage<{ startedAt: number }>();

/** Run `fn` with a batch clock started now. */
export function runInBatchClock<T>(fn: () => Promise<T>): Promise<T> {
  return batchClock.run({ startedAt: Date.now() }, fn);
}

/** Milliseconds since the enclosing batch started; 0 outside any batch. */
export function elapsedInBatchMs(now: number = Date.now()): number {
  const s = batchClock.getStore();
  return s ? Math.max(0, now - s.startedAt) : 0;
}
