// Telegram alerts to the shop owner.
//
// One sender, four named destinations. See docs/cx/telegram-notifications-spec.md
// for which message belongs where and why.
//
//   notify("LIVE",     …)  unmuted — acts-in-the-hour: customer with no bot
//                          safety net, money about to be wrong, a booked parcel
//                          about to ship against a cancellation.
//   notify("OPS",      …)  muted — a parcel / payment / return to handle today.
//   notify("HEALTH",   …)  muted — something broken or expiring.
//   notify("BRIEFING", …)  muted — the daily summaries only.
//
// Env — no-op without the token+chat for a destination, like the other optional
// integrations:
//   TELEGRAM_SUPPORT_BOT_TOKEN / TELEGRAM_SUPPORT_CHAT_ID   → LIVE
//   TELEGRAM_OPS_BOT_TOKEN     / TELEGRAM_OPS_CHAT_ID        → OPS  (one bot,
//   TELEGRAM_OPS_BOT_TOKEN     / TELEGRAM_HEALTH_CHAT_ID     → HEALTH   three
//   TELEGRAM_OPS_BOT_TOKEN     / TELEGRAM_BRIEFING_CHAT_ID   → BRIEFING chats)
//
// Two bots on purpose. LIVE is the one channel that is never muted — one person
// waiting for an answer must not be buried under the day's operational traffic.
// Everything else shares the OPS bot across three chats so a single mute setting
// per topic does the sorting.
//
// Migration note: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are the pre-refactor
// names for the OPS bot and are still read as a fallback until the env is
// renamed (spec §10). HEALTH and BRIEFING fall back to the OPS chat until their
// own chats exist, so nothing is lost while the callers are migrated.

type Bot = { token?: string; chatId?: string };

export type Destination = "LIVE" | "OPS" | "HEALTH" | "BRIEFING";

const OPS_TOKEN = () => process.env.TELEGRAM_OPS_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
const OPS_CHAT = () => process.env.TELEGRAM_OPS_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;

const DESTINATIONS: Record<Destination, () => Bot> = {
  // Falls back to the OPS bot rather than going silent. A customer question
  // landing in the wrong chat is recoverable; one landing nowhere is not.
  LIVE: () => ({
    token: process.env.TELEGRAM_SUPPORT_BOT_TOKEN ?? OPS_TOKEN(),
    chatId: process.env.TELEGRAM_SUPPORT_CHAT_ID ?? OPS_CHAT(),
  }),
  OPS: () => ({ token: OPS_TOKEN(), chatId: OPS_CHAT() }),
  HEALTH: () => ({
    token: OPS_TOKEN(),
    chatId: process.env.TELEGRAM_HEALTH_CHAT_ID ?? OPS_CHAT(),
  }),
  BRIEFING: () => ({
    token: OPS_TOKEN(),
    chatId: process.env.TELEGRAM_BRIEFING_CHAT_ID ?? OPS_CHAT(),
  }),
};

/** One inline-keyboard button. `callback_data` is ≤64 bytes and comes from
 *  lib/telegramActions.ts's codec; `url` opens a link. */
export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export type InlineKeyboard = InlineButton[][];

export interface SentMessage {
  ok: boolean;
  /** Present on a successful send — needed to edit the message later. */
  chatId?: number | string;
  messageId?: number;
}

async function post(bot: Bot, message: string, buttons?: InlineKeyboard): Promise<SentMessage> {
  if (!bot.token || !bot.chatId) return { ok: false };
  try {
    const res = await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: bot.chatId,
        text: message,
        parse_mode: "HTML",
        // Link previews turn a wa.me link into a large WhatsApp card that pushes
        // the actual question off the screen.
        link_preview_options: { is_disabled: true },
        ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
      }),
    });
    if (!res.ok) return { ok: false };
    const body = await res.json().catch(() => null);
    return { ok: true, chatId: body?.result?.chat?.id, messageId: body?.result?.message_id };
  } catch {
    // An alert failing must never take down whatever was trying to alert.
    return { ok: false };
  }
}

/** Send one alert to one destination. Returns false (no-op) when that
 *  destination's token or chat id is unset. */
export async function notify(to: Destination, message: string): Promise<boolean> {
  return (await post(DESTINATIONS[to](), message)).ok;
}

/** Like notify(), but carries inline buttons and returns the message id so the
 *  callback handler can edit it after a tap. Used by the daily summaries and
 *  the action-bearing alerts (spec §14). */
export async function sendWithButtons(
  to: Destination,
  message: string,
  buttons: InlineKeyboard,
): Promise<SentMessage> {
  return post(DESTINATIONS[to](), message, buttons);
}

// ── Callback replies (spec §14) ──────────────────────────────────────────────
// The webhook route knows which bot the update came from; these take that key
// rather than a Destination, since a tap can land on any of the OPS chats.

export type BotKey = "ops" | "support";

const botToken = (bot: BotKey): string | undefined =>
  bot === "support" ? (process.env.TELEGRAM_SUPPORT_BOT_TOKEN ?? OPS_TOKEN()) : OPS_TOKEN();

/** Clear the spinner on a tapped button. Must be called within ~30s or the
 *  founder sees a loading state. `showAlert` turns the toast into a modal. */
export async function answerCallback(
  bot: BotKey,
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  const token = botToken(bot);
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text?.slice(0, 200), show_alert: showAlert }),
  }).catch(() => {});
}

/** Rewrite a message after its button was acted on — new text, and usually no
 *  buttons (so it can't be pressed twice). */
export async function editMessage(
  bot: BotKey,
  chatId: number | string,
  messageId: number,
  text: string,
  buttons?: InlineKeyboard,
): Promise<void> {
  const token = botToken(bot);
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: buttons?.length ? { inline_keyboard: buttons } : { inline_keyboard: [] },
    }),
  }).catch(() => {});
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "6 Sep, 14:30" — a date in IST, for message bodies.
 *
 * A fixed table, not `toLocaleString`: Node and the browser ship different ICU
 * data and disagree on the short month ("Sep" vs "Sept"), and every message
 * body should read the same wherever it is built. IST is a fixed UTC+5:30 with
 * no DST, so shifting and reading the UTC fields is exact.
 */
export function fmtIST(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d);
  const ist = new Date(date.getTime() + 5.5 * 3_600_000);
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const mm = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]}, ${hh}:${mm}`;
}

// ── Deprecated shims ─────────────────────────────────────────────────────────
// Kept so the ~20 existing callers keep working while they are migrated onto
// notify() one file at a time (spec §11). Delete once no caller remains.

/** @deprecated → notify("OPS", …) */
export async function sendTelegram(message: string): Promise<boolean> {
  return notify("OPS", message);
}

/** @deprecated → notify("LIVE", …) */
export async function sendSupportTelegram(message: string): Promise<boolean> {
  return notify("LIVE", message);
}

/**
 * @deprecated Split each caller into notify("LIVE", …) OR notify("OPS", …) per
 * the spec — nothing goes to both from here on.
 *
 * Until then, keeps its old behaviour: post to OPS, and to LIVE as well unless
 * LIVE resolves to the same bot+chat (in which case the single post is enough).
 */
export async function sendBothTelegram(message: string): Promise<boolean> {
  const ops = DESTINATIONS.OPS();
  const live = DESTINATIONS.LIVE();
  const sentToOps = (await post(ops, message)).ok;
  if (live.token === ops.token && live.chatId === ops.chatId) return sentToOps;
  const sentToLive = (await post(live, message)).ok;
  return sentToOps || sentToLive;
}

/**
 * A customer's number, formatted so Telegram makes it callable.
 *
 * Telegram linkifies a phone number into a `phone_number` entity — one tap on
 * mobile opens the dialer — but only when the digits are unbroken. Measured
 * 2026-09-09 against the live API: "+91 9000100017" returns no entities at all,
 * "+919000100017" returns `phone_number`. Every escalation ping had carried the
 * spaced form, so the number sitting right there was never tappable.
 *
 * A `tel:` inline-keyboard button is not an option — Telegram rejects it
 * outright ("Wrong port number specified in the URL"), because it parses the
 * colon as a port separator. The linkified number is the only native call path.
 */
export const tgPhone = (phone: string): string => `+91${String(phone).replace(/\D/g, "").slice(-10)}`;

/** One-tap route to the customer's WhatsApp thread from a Telegram card. */
export const waLink = (phone: string): string => `https://wa.me/91${String(phone).replace(/\D/g, "").slice(-10)}`;
