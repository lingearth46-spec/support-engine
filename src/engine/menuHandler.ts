// The IO around lib/menuFlows.ts: load the customer's orders, send the step, write it down, tell the team when a step escalates, and run
// the one confirmed action (cancel). Off unless SUPPORT_MENU is on for this number (menuAllowed); with it off nothing in this file runs.
//
// Two entry points, both called from existing code behind small hooks:
//   handleMenuTap        the webhook, when a customer taps a list row or a reply button whose id starts with "m:"
//   maybeStartMenu       lib/waSupport.ts handleSupportMessage, for a customer's first message after 24 hours of silence
// Both leave everything they do not own to the existing code: a person's thread, the kill switch, photos, a pending flow, an unclear message.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsApp, sendWhatsAppButtons, sendWhatsAppList } from "@adapters/messaging/whatsapp";
import {
  ordersByPhone, recordInbound, recordOutbound, patchConversation, getConversation, getSupportConfig, refundsByOrder, recordCaseOrAlert,
} from "@engine/waSupport";
import { notify, tgPhone } from "@adapters/notifier/telegram";
import { isWithinSupportHours } from "@policy/supportHours";
import { runAction } from "@engine/supportActionRun";
import {
  menuAllowed, menuMayApply, menuMode, menuResendDays, parseMenuId, stepForTap, startTopic, topicList, isVagueOpener, detectTopic,
  type MenuContext, type MenuOrder, type MenuStep, type MenuTopic,
} from "@engine/menuFlows";

const inboxLink = (phone: string) => `https://www.ajuki.in/admin/support?phone=${phone}`;
const ORDER_IN_TEXT = /\bAJUKI\d{4,10}\b/i;

type Db = SupabaseClient;

/** The customer's recent orders in the shape the flows read. `offers` is not in the shared column list, so it is read separately (best effort). */
async function loadOrders(db: Db, phone: string): Promise<MenuOrder[]> {
  const rows = (await ordersByPhone(db, phone)) as unknown as (MenuOrder & { id: string })[];
  if (!rows.length) return [];
  try {
    const { data } = await db.from("orders").select("id, offers").in("id", rows.map((r) => r.id));
    const offers = new Map(((data as { id: string; offers?: MenuOrder["offers"] }[]) ?? []).map((r) => [r.id, r.offers ?? null]));
    return rows.map((r) => ({ ...r, offers: offers.get(r.id) ?? null }));
  } catch {
    return rows;
  }
}

async function loadContext(db: Db, phone: string, topic: MenuTopic | null, message?: string): Promise<MenuContext> {
  const orders = await loadOrders(db, phone);
  const ctx: MenuContext = { orders, now: Date.now() };
  if (topic === "refund" && orders.length) {
    const map = await refundsByOrder(db, orders.map((o) => o.id));
    ctx.refunds = new Map([...map].map(([k, v]) => [k, v]));
  }
  const typed = message ? ORDER_IN_TEXT.exec(message)?.[0] : null;
  if (typed) ctx.mentionedOrderId = typed;
  return ctx;
}

/** What the inbox shows for a step: the text, and the options in square brackets so a person can see what the customer was offered. */
function recordedBody(step: MenuStep): string {
  const options = step.buttons ? step.buttons.map((b) => b.title) : step.list ? step.list.rows.map((r) => r.title) : [];
  return options.length ? `${step.text}\n\n[${step.list ? "List" : "Buttons"}: ${options.join(" | ")}]` : step.text;
}

async function deliver(db: Db, phone: string, step: MenuStep, text: string, meta: Record<string, unknown>): Promise<boolean> {
  const sent = step.list
    ? await sendWhatsAppList(phone, text, step.list)
    : step.buttons ? await sendWhatsAppButtons(phone, text, step.buttons) : await sendWhatsApp(phone, text);
  if (!sent) return false;
  await recordOutbound(db, {
    phone, body: recordedBody({ ...step, text }), source: "system",
    // `escalated` is what the Bot tab reads to tell a guided reply that handed the customer to the team from one that did not.
    aiMeta: { fixedReply: step.fixed, menu: { ...meta, escalated: Boolean(step.escalate) } },
  });
  return true;
}

/**
 * Remember that this customer was promised an update (lib/followUps.ts). One open watch per customer, order and topic. Best effort and silent when
 * the table is not there yet: the flows work without it, they just do not follow up.
 */
export async function saveWatch(db: Db, phone: string, step: MenuStep, orders: MenuOrder[]): Promise<void> {
  if (!step.watch) return;
  try {
    const { data: open, error } = await db.from("support_watches").select("id").eq("phone", phone).eq("order_id", step.watch.orderId).eq("topic", step.watch.topic).eq("status", "open").limit(1);
    if (error || (open && open.length)) return;
    const eta = orders.find((o) => o.id === step.watch!.orderId)?.estimated_delivery ?? null;
    await db.from("support_watches").insert({ phone, order_id: step.watch.orderId, topic: step.watch.topic, baseline_eta: eta });
  } catch (err) {
    console.warn("[menu] could not save the watch:", err instanceof Error ? err.message : String(err));
  }
}

async function escalate(db: Db, phone: string, name: string, step: MenuStep): Promise<void> {
  if (!step.escalate) return;
  await patchConversation(db, phone, { status: "escalated", escalated: true, escalate_reason: step.escalate.reason, unread: true });
  await recordCaseOrAlert(db, { phone, tag: step.escalate.tag, reason: step.escalate.reason, name });
  await notify(
    "LIVE",
    `⚠️ <b>Support escalation</b> · from the topic menu\n${name} · ${tgPhone(phone)}\n\n<i>Why:</i> ${step.escalate.reason.replace(/[<>&]/g, " ")}\n\n<a href="${inboxLink(phone)}">Open in support inbox</a>`,
  ).catch(() => {});
}

/**
 * A tap on one of our list rows or buttons. Returns true when it was answered here, false when the caller should carry on as it would for
 * any message (not ours, the menu is off for this number, a person has the thread, the bot is switched off).
 */
export async function handleMenuTap(
  db: Db,
  t: { phone: string; id: string; title: string; waMessageId?: string | null; name?: string | null },
): Promise<boolean> {
  const parsed = parseMenuId(t.id);
  if (!parsed || !(await menuEligible(db, t.phone, { tap: true }))) return false;
  const [config, conv] = await Promise.all([getSupportConfig(db), getConversation(db, t.phone)]);
  if (!config.enabled || conv?.taken_over) return false;

  // The tap is a message like any other: stored once (a retried webhook is a no-op), shown in the inbox under the row's title.
  const rec = await recordInbound(db, { phone: t.phone, body: t.title || t.id, waMessageId: t.waMessageId, name: t.name });
  if (rec.duplicate) return true;
  const name = t.name || conv?.name || "Unknown";

  try {
    const topic = parsed.kind === "step" ? parsed.topic : null;
    const ctx = await loadContext(db, t.phone, topic);
    const step = stepForTap(t.id, ctx, { outOfHours: !isWithinSupportHours() });
    if (!step) return true;
    const meta = { entry: "tap", id: t.id, topic };

    if (step.cancel) {
      // The one action a tap can run. runAction re-checks everything (ownership, dispatch, the 24-hour window) and returns a sentence for the
      // customer either way: the "is cancelled" text is only sent when it really happened.
      const outcome = await runAction(db, { kind: "cancel_order", orderId: step.cancel.orderId }, { phone: t.phone, customerName: name });
      const text = outcome.ok ? step.text : outcome.message;
      await deliver(db, t.phone, { ...step, buttons: step.buttons }, text, { ...meta, cancel: outcome.ok ? "done" : "refused" });
      return true;
    }

    const sent = await deliver(db, t.phone, step, step.text, meta);
    if (sent) await saveWatch(db, t.phone, step, ctx.orders);
    if (!sent) {
      await notify("OPS", `⚠️ <b>Menu reply could not be sent</b> · ${tgPhone(t.phone)} · tap <code>${t.id.replace(/[<>&]/g, "")}</code>\n<a href="${inboxLink(t.phone)}">Open in support inbox</a>`).catch(() => {});
      await patchConversation(db, t.phone, { unread: true });
      return true;
    }
    await escalate(db, t.phone, name, step);
    return true;
  } catch (err) {
    console.error(JSON.stringify({ event: "menu_tap_failed", phone: t.phone, id: t.id, error: err instanceof Error ? err.message : String(err) }));
    await patchConversation(db, t.phone, { unread: true }).catch(() => {});
    await notify("OPS", `⚠️ <b>Menu tap failed</b> · ${tgPhone(t.phone)} · <code>${t.id.replace(/[<>&]/g, "")}</code>\nThe customer was not answered.\n<a href="${inboxLink(t.phone)}">Open in support inbox</a>`).catch(() => {});
    return true;
  }
}

const DAY_MS = 24 * 3_600_000;

/** Has this number never written to us before the given moment (default: now)? Inbound only: an order notification we sent them is not a conversation. */
async function neverWroteBefore(db: Db, phone: string, beforeIso?: string): Promise<boolean> {
  const { data, error } = await db.from("wa_messages").select("id").eq("phone", phone).eq("direction", "in").lt("created_at", beforeIso ?? new Date().toISOString()).limit(1);
  if (error) return false; // unsure: leave a customer on the normal path rather than guess they are new
  return !(data && data.length);
}

/** Did we ever send this number a guided-flow message? Then a tap from them is a tap on our menu, whatever the mode says about newness. */
async function inMenuThread(db: Db, phone: string): Promise<boolean> {
  const { data, error } = await db.from("wa_messages").select("id").eq("phone", phone).eq("direction", "out").like("ai_meta->>fixedReply", "menu:%").limit(1);
  return !error && Boolean(data && data.length);
}

/**
 * May the guided flows act for this number right now? The allow list and the pilot percentage answer by number alone (menuAllowed). "new" mode answers by
 * the thread: a first message is eligible when the number has never written before; a tap is eligible when we sent them a guided message.
 */
export async function menuEligible(db: Db, phone: string, o: { arrivedAt?: string; tap?: boolean } = {}): Promise<boolean> {
  if (menuAllowed(phone)) return true;
  if (menuMode() !== "new") return false;
  return o.tap ? inMenuThread(db, phone) : neverWroteBefore(db, phone, o.arrivedAt);
}

/** Has this number been sent the automatic topic list within the resend window (0 days = ever)? */
export async function menuListSentRecently(db: Db, phone: string): Promise<boolean> {
  const days = menuResendDays();
  let q = db.from("wa_messages").select("id").eq("phone", phone).eq("direction", "out").eq("ai_meta->>fixedReply", "menu:list").limit(1);
  if (days > 0) q = q.gte("created_at", new Date(Date.now() - days * DAY_MS).toISOString());
  const { data, error } = await q;
  if (error) return true; // unsure: do not send a second list
  return Boolean(data && data.length);
}

/**
 * Was there a real conversation in the 24 hours before this message? Only the customer's own messages, a person's replies, the bot's replies and our
 * guided messages count. The automatic notifications we send on an order (confirmed, out for delivery, delivered, a pay link) are not a conversation:
 * counting them hid the menu from most new customers on its first day (14 Oct: 4 of 6 openers were blocked this way).
 */
async function hadRecentActivity(db: Db, phone: string, arrivedAt: string | undefined): Promise<boolean> {
  const before = arrivedAt ?? new Date().toISOString();
  const { data, error } = await db.from("wa_messages").select("created_at, direction, source, ai_meta").eq("phone", phone)
    .gte("created_at", new Date(Date.parse(before) - DAY_MS).toISOString()).lt("created_at", before).order("created_at", { ascending: false }).limit(25);
  if (error) return true;
  return (data ?? []).some((r: { direction?: string; source?: string; ai_meta?: Record<string, unknown> | null }) =>
    r.direction === "in" || r.source === "admin" || r.source === "ai" || Boolean(r.ai_meta?.menu) || typeof r.ai_meta?.fixedReply === "string" || typeof r.ai_meta?.provenance === "string");
}

export type MenuEntryOutcome = { handled: false } | { handled: true; outcome: "sent" | "superseded" | "held" | "failed"; reason: string };

/**
 * The first message of a conversation (nothing either way for 24 hours): a vague one gets the topic list, once per chat; one that plainly names a
 * topic goes straight into that topic's flow. Anything else is not ours. `quiet` is the handler's own quiet-period wait.
 */
export async function maybeStartMenu(
  db: Db,
  o: {
    phone: string; message: string; name: string; arrivedAt?: string; hasPhoto: boolean; wake: boolean; pendingKind?: string | null;
    quiet: () => Promise<{ status: "go" | "superseded" | "held" }>;
  },
): Promise<MenuEntryOutcome> {
  if (o.wake || o.hasPhoto || o.pendingKind || !menuMayApply(o.phone)) return { handled: false };
  const vague = isVagueOpener(o.message);
  const topic = vague ? null : detectTopic(o.message);
  if (!vague && !topic) return { handled: false };
  if (!(await menuEligible(db, o.phone, { arrivedAt: o.arrivedAt }))) return { handled: false };
  if (await hadRecentActivity(db, o.phone, o.arrivedAt)) return { handled: false };
  if (vague && await menuListSentRecently(db, o.phone)) return { handled: false };

  const q = await o.quiet();
  if (q.status !== "go") return { handled: true, outcome: q.status, reason: "menu: stood down during the quiet period" };

  const ctx = await loadContext(db, o.phone, topic, o.message);
  const step = vague ? topicList({ outOfHours: !isWithinSupportHours() }) : startTopic(topic as MenuTopic, ctx);
  const sent = await deliver(db, o.phone, step, step.text, { entry: vague ? "A" : "B", topic });
  if (!sent) return { handled: false };
  await saveWatch(db, o.phone, step, ctx.orders);
  await escalate(db, o.phone, o.name, step);
  return { handled: true, outcome: "sent", reason: vague ? "menu: topic list sent to a vague opener" : `menu: ${topic} flow started` };
}

/**
 * Out of hours the topic list takes the place of the "we are closed" notice, when this number has not had the list yet. True when it was sent.
 * The real answer is still queued for 11:00 by the caller, exactly as before.
 */
export async function menuInsteadOfNotice(db: Db, phone: string, arrivedAt?: string): Promise<boolean> {
  if (!menuMayApply(phone) || !(await menuEligible(db, phone, { arrivedAt })) || await menuListSentRecently(db, phone)) return false;
  const step = topicList({ outOfHours: true });
  return deliver(db, phone, step, step.text, { entry: "ooh" });
}
