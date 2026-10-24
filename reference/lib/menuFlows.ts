// Guided support flows: a topic list and button steps that lead a customer to a fixed, code-decided answer.
//
// Pure on purpose (no db, no network, no env reads except through the arguments), so every branch is unit-tested. lib/menuHandler.ts is the
// thin IO layer that sends these steps and records them. Design: the artifact "Guided support flows" (founder-approved 13 Oct 2026).
//
// STATELESS. A tap's id carries everything the next step needs, so nothing is parked in the conversation row:
//   m:menu                      send the topic list again
//   m:<topic>                   the topic was chosen; fix the order first
//   m:<topic>:*                 "another order": pick one from a list
//   m:<topic>:<ORDER>           the order is known; answer (or ask the next question)
//   m:<topic>:<ORDER>:<sub>     the answer to that question (reason, confirmation)
// Every wording below is either reused from the existing fixed replies or drafted in the approved artifact. No refund, replacement, discount,
// callback or reply time is ever promised here.

import { daysLeftToReturn, isRestrictedOfferOrder, RETURN_PICKUP_FEE } from "@/lib/returnPolicy";
import { isOverdue } from "@/lib/lateDeliveryReply";
import { orderStatusLine } from "@/lib/lookupReply";
import { cancellationAllowedInWindow } from "@/lib/supportActions";
import { PENDING_REPLY, EXCHANGE_EMAIL_REPLY, WINDOW_CLOSED_EMAIL_REPLY, rejectedReply, SENIOR_SUPPORT_EMAIL } from "@/lib/returnStateReply";
import { day } from "@/lib/orderLines";

export const MENU_TOPICS = ["late", "problem", "return", "exchange", "cancel", "phone", "address", "refund", "other"] as const;
export type MenuTopic = (typeof MENU_TOPICS)[number];

export interface MenuButton { id: string; title: string }
export interface MenuRow { id: string; title: string; description?: string }

/** One message to send, and what to do about it. */
export interface MenuStep {
  /** Message body (WhatsApp allows 1024 characters with buttons or a list). */
  text: string;
  /** Up to 3 reply buttons. */
  buttons?: MenuButton[];
  /** A list message: the button that opens it and its rows (up to 10). */
  list?: { button: string; rows: MenuRow[] };
  /** The team must hear about this one (case + Telegram), like any other escalation. */
  escalate?: { tag: string; reason: string };
  /** The customer confirmed: run the existing cancel action for this order, then send `text` only if it worked. */
  cancel?: { orderId: string; keptText: string };
  /** Recorded as ai_meta.fixedReply on the outbound message, so the final guard and the ratings treat it as a fixed line. */
  fixed: string;
  /** This answer leaves work open: save a watch so the follow-up job can tell the customer later (lib/followUps.ts). */
  watch?: { topic: "late" | "return" | "problem"; orderId: string };
}

export type MenuOrder = {
  id: string;
  status: string;
  awb_code?: string | null;
  created_at?: string | null;
  delivered_at?: string | null;
  estimated_delivery?: string | null;
  payment_id?: string | null;
  return_request?: { status?: string | null; resolved_at?: string | null } | null;
  items?: { name?: string | null }[] | null;
  offer_discount?: number | null;
  offers?: { kind?: string | null; label?: string | null }[] | null;
};

export type MenuRefund = { status: string; amount: number; since: string; processedAt: string | null } | null;

export interface MenuContext {
  orders: MenuOrder[];
  refunds?: Map<string, MenuRefund>;
  /** An order id the customer typed themselves, already matched to their own orders. */
  mentionedOrderId?: string | null;
  now?: number;
}

// ── Wording ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const TRACK = "www.ajuki.in/track";
export const NEED_OTHER_HELP: MenuButton = { id: "m:menu", title: "Need other help" };

export const MENU_BODY = "Hi, this is AJUKI support. Please choose what you need help with from the list below.";
export const MENU_TYPED_LINE = "Typed questions are answered 11:00 AM to 7:00 PM IST, Monday to Saturday.";
export const MENU_BUTTON = "Choose a topic";

const TOP_ROWS: { topic: MenuTopic; title: string; description: string }[] = [
  { topic: "late", title: "Late delivery", description: "Where is my parcel" },
  { topic: "problem", title: "Product problem", description: "Damaged, wrong or missing item" },
  { topic: "return", title: "Return", description: "Send an item back" },
  { topic: "exchange", title: "Exchange", description: "Swap for another size or item" },
  { topic: "cancel", title: "Cancel order", description: "Possible before it ships" },
  { topic: "phone", title: "Change phone number", description: "Update the delivery phone" },
  { topic: "address", title: "Change address", description: "Update the delivery address" },
  { topic: "refund", title: "Refund status", description: "Where is my money" },
  { topic: "other", title: "Something else", description: "Type your question" },
];

export const NO_ORDER_REPLY = "I could not find an order on this number. Please type your order ID (it looks like AJUKI710013).";
export const OTHER_REPLY = "Please type your question and we will help.";
export const RTO_REPLY = "Your parcel is on its way back to us, so it cannot be delivered again or changed now. You can place a new order at www.ajuki.in.";
export const EXPIRED_REPLY = "That option has expired. Please choose again.";

const PRE_DISPATCH = new Set(["processing", "call_1", "call_2", "on_hold", "confirmed", "packed"]);
const SETTLED = new Set(["delivered", "cancelled", "wa_cancelled", "returned", "rto"]);
const COMING_BACK = new Set(["rto", "returned"]);

const withHelp = (text: string, extra: MenuButton[] = []): Pick<MenuStep, "text" | "buttons"> => ({ text, buttons: [...extra, NEED_OTHER_HELP].slice(0, 3) });

// ── Ids ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ParsedMenuId =
  | { kind: "menu" }
  | { kind: "step"; topic: MenuTopic; orderId: string | null; another: boolean; sub: string | null };

const ORDER_ID = /^[A-Za-z0-9_-]{4,24}$/;

/** The id of a tapped list row or reply button, from a WhatsApp interactive payload (empty when nothing was tapped). */
export const tapIdOf = (i: { list_reply?: { id?: string }; button_reply?: { id?: string } } | null | undefined): string => i?.list_reply?.id ?? i?.button_reply?.id ?? "";

/**
 * The menu id of a tap on ANY message: a list row or reply button (by id), or the quick-reply button on our follow-up templates, which arrives as a
 * 'button' message. Its payload is "m:menu" when the template send sets one; if not, the button's own label is enough. Empty when it is not ours.
 */
export function menuTapIdOf(m: { interactive?: Parameters<typeof tapIdOf>[0]; button?: { text?: string; payload?: string } | null }): string {
  const id = tapIdOf(m.interactive);
  if (id) return id;
  const payload = m.button?.payload ?? "";
  if (/^m:/.test(payload)) return payload;
  return (m.button?.text ?? "").trim().toLowerCase() === NEED_OTHER_HELP.title.toLowerCase() ? "m:menu" : "";
}

export const isMenuId = (id: string | null | undefined): boolean => typeof id === "string" && /^m:/.test(id);

export function parseMenuId(raw: string | null | undefined): ParsedMenuId | null {
  if (!raw || !/^m:/.test(raw) || raw.length > 120) return null;
  const parts = raw.split(":");
  if (parts[1] === "menu" && parts.length === 2) return { kind: "menu" };
  const topic = parts[1] as MenuTopic;
  if (!(MENU_TOPICS as readonly string[]).includes(topic)) return null;
  const third = parts[2];
  if (third === undefined) return { kind: "step", topic, orderId: null, another: false, sub: null };
  if (third === "*") return { kind: "step", topic, orderId: null, another: true, sub: null };
  if (!ORDER_ID.test(third)) return null;
  const sub = parts[3];
  if (sub !== undefined && !/^[a-z]{1,12}$/.test(sub)) return null;
  return { kind: "step", topic, orderId: third, another: false, sub: sub ?? null };
}

const id = (topic: MenuTopic, order?: string, sub?: string) => `m:${topic}${order ? `:${order}` : ""}${sub ? `:${sub}` : ""}`;

// ── The topic list ───────────────────────────────────────────────────────────────────────────────────────────────

export function topicList(opts: { outOfHours?: boolean } = {}): MenuStep {
  return {
    text: opts.outOfHours ? `${MENU_BODY}\n\n${MENU_TYPED_LINE}` : MENU_BODY,
    list: { button: MENU_BUTTON, rows: TOP_ROWS.map((r) => ({ id: `m:${r.topic}`, title: r.title, description: r.description })) },
    fixed: "menu:list",
  };
}

// ── Entry detection ──────────────────────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => (s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

// A message that says nothing about what is wrong: a greeting, "help", "issue", "i have a question about ajuki" (the site's prefilled text).
const VAGUE = new RegExp(
  "^(?:(?:hi+|hello+|hey+|hii+|hlo|helo|namaste|good (?:morning|afternoon|evening))(?: there| team| ajuki| sir| mam| madam)?" +
  "|(?:hi+|hello+|hey+)? ?i have a question about ajuki" +
  "|(?:hi |hello |hey )?(?:need |please |plz |pls )?(?:help|support|assistance)(?: me| please| plz| pls)?" +
  "|(?:hi |hello |hey )?(?:i )?(?:have|got) (?:a |an |some )?(?:issue|problem|query|question|doubt)s?(?: with (?:my |the )?(?:order|parcel))?" +
  "|(?:shipping|delivery|order|payment|product|some|an?) (?:issue|problem|query|question)" +
  "|(?:issue|problem|query|question|doubt)s?" +
  "|(?:customer )?care|(?:are you|anyone) (?:there|available))$",
  "i",
);

/** The titles of the delivery-failure and pickup buttons (lib/ndrButtonReply.ts, lib/returnPickupRetry.ts, the COD confirmation). They have their own flows. */
const BUTTON_TITLES = /^(?:deliver tomorrow|update phone|update address|contact support|try again tomorrow|edit address)$/;

/** A first message that gives no topic: it gets the topic list. */
export function isVagueOpener(message: string): boolean {
  const t = norm(message);
  return t.length > 0 && t.length <= 60 && !BUTTON_TITLES.test(t) && VAGUE.test(t);
}

const T = {
  exchange: /\b(?:exchange|exchanged|swap)\b|\bchange\b.{0,15}\b(?:size|colou?r|item|piece)\b/,
  cancel: /\bcancel(?:l?ed|ling|lation)?\b|\border\b.{0,12}\bcancel/,
  returnIt: /\breturn(?:ed|ing)?\b|\bwapas\b|\bvapas\b|\bsend (?:it )?back\b/,
  refund: /\brefund\w*\b|\bmoney back\b/,
  phone: /\b(?:change|update|edit|correct|wrong|new)\b.{0,18}\b(?:phone|mobile|number|contact)\b|\b(?:phone|mobile|contact) number\b.{0,18}\b(?:change|wrong|update)\b/,
  address: /\b(?:change|update|edit|correct|wrong|new)\b.{0,18}\b(?:address|adress|pincode|pin code)\b|\baddress\b.{0,15}\b(?:change|wrong|incorrect)\b/,
  problem: /\b(?:damaged?|broken|defective|faulty|not working|wrong (?:item|product|piece)|missing item|item (?:is )?missing)\b/,
  late: /\bwhere (?:is|s) my (?:order|parcel|package)\b|\bnot (?:yet )?(?:received|delivered|arrived)\b|\b(?:order|parcel|delivery) (?:is |has )?(?:been )?(?:late|delayed)\b|\bdelay(?:ed)?\b|\bwhen will (?:it|my order|i get)\b|\bkab (?:tak )?(?:aayega|milega|ayega)\b|\babhi tak (?:nahi|nhi|nahin)\b|\bhaven'?t (?:received|got)\b|\bstill (?:waiting|not)\b|\bdidn'?t (?:get|receive)\b/,
};

/**
 * The one topic a first message is plainly about, or null. Deliberately strict: a long message, a message that names two topics, or one
 * that fits none goes to the normal bot, which reads it properly. A wrong guess here is worse than no guess.
 */
export function detectTopic(message: string): MenuTopic | null {
  const t = norm(message);
  if (!t || t.length > 140 || BUTTON_TITLES.test(t)) return null;
  // Withdrawing a return or a pickup is a person's job (the existing fixed line sends it to email), never a topic of ours.
  if (/\b(?:cancel|withdraw|stop|drop)\b.{0,15}\b(?:the |my |this )?(?:return|pick ?up)\b/.test(t)) return null;
  const hits: MenuTopic[] = [];
  const exchange = T.exchange.test(t);
  if (exchange) hits.push("exchange");
  if (T.cancel.test(t) && !/\bcancel(?:l?ed|ling)?\b.{0,12}\b(?:return|pickup|pick up)\b/.test(t)) hits.push("cancel");
  if (T.returnIt.test(t) && !exchange) hits.push("return");
  if (T.refund.test(t)) hits.push("refund");
  if (T.phone.test(t)) hits.push("phone");
  if (T.address.test(t)) hits.push("address");
  if (T.problem.test(t)) hits.push("problem");
  if (T.late.test(t)) hits.push("late");
  // A refund question inside a return sentence is still one topic: the customer's goal is the return.
  const uniq = [...new Set(hits)];
  if (uniq.length === 2 && uniq.includes("return") && uniq.includes("refund")) return "return";
  if (uniq.length === 2 && uniq.includes("problem") && uniq.includes("return")) return "problem";
  return uniq.length === 1 ? uniq[0] : null;
}

// ── Orders ───────────────────────────────────────────────────────────────────────────────────────────────────────

const NEEDS_ORDER: Record<MenuTopic, boolean> = { late: true, problem: true, return: true, exchange: false, cancel: true, phone: true, address: true, refund: true, other: false };

const itemNames = (o: MenuOrder): string => (o.items ?? []).map((i) => (i?.name ?? "").trim()).filter(Boolean).slice(0, 2).join(", ");

const orderLabel = (o: MenuOrder): string => { const n = itemNames(o); return n ? `${o.id} (${n})` : o.id; };

const STATUS_WORDS: Record<string, string> = {
  processing: "being prepared", call_1: "being prepared", call_2: "being prepared", on_hold: "being prepared", confirmed: "being prepared", packed: "being prepared",
  manifested: "with the courier", shipped: "on its way", undelivered: "delivery attempted", delivered: "delivered",
  cancelled: "cancelled", wa_cancelled: "cancelled", rto: "returning to us", returned: "returning to us",
};

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function orderPicker(topic: MenuTopic, orders: MenuOrder[]): MenuStep {
  const rows = orders.slice(0, 10).map((o) => ({
    id: id(topic, o.id),
    title: clip(o.id, 24),
    description: clip([itemNames(o), STATUS_WORDS[o.status] ?? ""].filter(Boolean).join(" · "), 72) || undefined,
  }));
  return { text: "Which order is this about?", list: { button: "Pick an order", rows }, fixed: `menu:${topic}:pick` };
}

/** The first step of a topic, before an order is known. */
export function startTopic(topic: MenuTopic, ctx: MenuContext): MenuStep {
  if (topic === "exchange") return { ...withHelp(EXCHANGE_EMAIL_REPLY), fixed: "menu:exchange" };
  if (topic === "other") return { text: OTHER_REPLY, fixed: "menu:other" };
  if (!NEEDS_ORDER[topic]) return { text: OTHER_REPLY, fixed: "menu:other" };
  const orders = ctx.orders;
  if (!orders.length) return { text: NO_ORDER_REPLY, fixed: `menu:${topic}:no_order` };
  if (ctx.mentionedOrderId) {
    const hit = orders.find((o) => o.id.toUpperCase() === ctx.mentionedOrderId!.toUpperCase());
    if (hit) return answerTopic(topic, hit, null, ctx);
  }
  if (orders.length === 1) {
    const o = orders[0];
    return {
      text: `Is this about order ${orderLabel(o)}?`,
      buttons: [{ id: id(topic, o.id), title: "Yes" }, { id: id(topic, "*"), title: "Another order" }],
      fixed: `menu:${topic}:confirm`,
    };
  }
  return orderPicker(topic, orders);
}

// ── Answers ──────────────────────────────────────────────────────────────────────────────────────────────────────

const lateAnswer = (o: MenuOrder, now: number): MenuStep => {
  if (o.status === "delivered") {
    return {
      ...withHelp(`Our record shows this order as delivered. I have escalated this to the team. Please email ${SENIOR_SUPPORT_EMAIL} with your order number so Senior Support can look into it.`),
      escalate: { tag: "late_delivery", reason: `menu: late delivery, but ${o.id} shows delivered` }, fixed: "menu:late",
    };
  }
  if (o.status === "cancelled" || o.status === "wa_cancelled") return { ...withHelp(`Order ${o.id} has been cancelled.`), fixed: "menu:late" };
  if (COMING_BACK.has(o.status)) return { ...withHelp(RTO_REPLY), fixed: "menu:late" };
  if (isOverdue({ id: o.id, status: o.status, estimated_delivery: o.estimated_delivery }, now)) {
    return {
      ...withHelp(`Your order ${o.id} is running late. I have escalated this to the team, and they will try to deliver it as soon as possible. You can track it at ${TRACK}.`),
      escalate: { tag: "late_delivery", reason: `menu: late delivery, ${o.id} is overdue` }, fixed: "menu:late", watch: { topic: "late", orderId: o.id },
    };
  }
  return { ...withHelp(orderStatusLine({ id: o.id, status: o.status, delivered_at: o.delivered_at, estimated_delivery: o.estimated_delivery }, now)), fixed: "menu:late", watch: { topic: "late", orderId: o.id } };
};

/** A return or a damage claim cannot be raised yet / any more, or must wait; null when the return form is the next step. */
function returnBlocked(o: MenuOrder, topic: "return" | "problem", now: number): MenuStep | null {
  const rr = o.return_request;
  if (rr?.status === "pending") return { ...withHelp(PENDING_REPLY), fixed: `menu:${topic}`, ...(topic === "return" ? { watch: { topic: "return" as const, orderId: o.id } } : {}) };
  if (rr?.status === "rejected") return { ...withHelp(rejectedReply(rr.resolved_at)), fixed: `menu:${topic}` };
  if (rr?.status === "approved") return { ...withHelp("Your return request is approved. You can follow it at www.ajuki.in/returns/start."), fixed: `menu:${topic}` };
  if (o.status === "cancelled" || o.status === "wa_cancelled") return { ...withHelp(`Order ${o.id} has been cancelled, so there is nothing to return.`), fixed: `menu:${topic}` };
  if (COMING_BACK.has(o.status)) return { ...withHelp(RTO_REPLY), fixed: `menu:${topic}` };
  if (o.status !== "delivered") {
    if (cancellationAllowedInWindow({ status: o.status as never, awb_code: o.awb_code ?? undefined, created_at: o.created_at }, now).ok) {
      return {
        ...withHelp("Your order has not been delivered yet, so a return cannot be raised. It has not shipped, so you can still cancel it.", [{ id: id("cancel", o.id), title: "Cancel this order" }]),
        fixed: `menu:${topic}`,
      };
    }
    return {
      ...withHelp("Your order is with the courier and has not been delivered yet, so a return cannot be raised now. Once it is delivered, you can raise a return at www.ajuki.in/returns/start."),
      fixed: `menu:${topic}`,
    };
  }
  const left = daysLeftToReturn(o.delivered_at, new Date(now));
  if (left === null || left <= 0) return { ...withHelp(WINDOW_CLOSED_EMAIL_REPLY), fixed: `menu:${topic}` };
  return null;
}

const FAULT_REPLY =
  "Sorry about that. Please raise the return at www.ajuki.in/returns/start. Pickup is free for a damaged, defective or wrong item. " +
  `An unboxing video helps; if you do not have one, email ${SENIOR_SUPPORT_EMAIL} with your order number and photos of the item.`;
const BOGO_FAULT_REPLY =
  "Sorry about that. Please raise the return at www.ajuki.in/returns/start. " +
  `On a Buy 1 Get 1 order the pickup costs ₹${RETURN_PICKUP_FEE}. An unboxing video helps; if you do not have one, email ${SENIOR_SUPPORT_EMAIL} with your order number and photos of the item.`;
const BOGO_RETURN_REPLY =
  `This is a Buy 1 Get 1 order. A return is accepted only if an item arrived damaged, is defective or is the wrong item, and the pickup costs ₹${RETURN_PICKUP_FEE}. ` +
  "If that applies, you can raise it at www.ajuki.in/returns/start.";

function returnAnswer(o: MenuOrder, sub: string | null, now: number): MenuStep {
  const blocked = returnBlocked(o, "return", now);
  if (blocked) return blocked;
  const restricted = isRestrictedOfferOrder(o);
  if (restricted) return { ...withHelp(BOGO_RETURN_REPLY), fixed: "menu:return" };
  if (sub === "fault") return { ...withHelp(FAULT_REPLY), fixed: "menu:return:fault" };
  if (sub === "size") {
    return { ...withHelp(`You can raise the return at www.ajuki.in/returns/start with a photo of the piece being worn. Pickup costs ₹${RETURN_PICKUP_FEE} for a size or fit return.`), fixed: "menu:return:size" };
  }
  if (sub === "other") {
    return { ...withHelp(`You can raise the return at www.ajuki.in/returns/start and describe what is wrong. Pickup costs ₹${RETURN_PICKUP_FEE} for any reason other than a damaged, defective or wrong item.`), fixed: "menu:return:other" };
  }
  return {
    text: "What is the reason for the return?",
    buttons: [{ id: id("return", o.id, "fault"), title: "Damaged or wrong" }, { id: id("return", o.id, "size"), title: "Size or fit" }, { id: id("return", o.id, "other"), title: "Something else" }],
    fixed: "menu:return:reason",
  };
}

function problemAnswer(o: MenuOrder, sub: string | null, now: number): MenuStep {
  // Nothing to report on a parcel that has not arrived: say where it stands instead of asking what is wrong with it.
  if (!sub && o.status !== "delivered") return returnBlocked(o, "problem", now) ?? { text: OTHER_REPLY, fixed: "menu:problem" };
  if (sub === "miss") {
    return {
      ...withHelp(`Sorry about that. I have escalated this to the team. Please email ${SENIOR_SUPPORT_EMAIL} with your order number and a photo of what you received.`),
      escalate: { tag: "complaint", reason: `menu: item missing on ${o.id}` }, fixed: "menu:problem:miss", watch: { topic: "problem", orderId: o.id },
    };
  }
  if (sub === "dmg" || sub === "wrong") {
    const blocked = returnBlocked(o, "problem", now);
    if (blocked) return blocked;
    return { ...withHelp(isRestrictedOfferOrder(o) ? BOGO_FAULT_REPLY : FAULT_REPLY), fixed: "menu:problem:fault" };
  }
  return {
    text: "What is wrong with the item?",
    buttons: [{ id: id("problem", o.id, "dmg"), title: "Damaged or faulty" }, { id: id("problem", o.id, "wrong"), title: "Wrong item" }, { id: id("problem", o.id, "miss"), title: "Item missing" }],
    fixed: "menu:problem:ask",
  };
}

function cancelAnswer(o: MenuOrder, sub: string | null, now: number): MenuStep {
  if (sub === "no") return { ...withHelp(`Okay, order ${o.id} is kept as it is.`), fixed: "menu:cancel:kept" };
  const verdict = cancellationAllowedInWindow({ status: o.status as never, awb_code: o.awb_code ?? undefined, created_at: o.created_at }, now);
  if (!verdict.ok) {
    if (o.status === "cancelled" || o.status === "wa_cancelled") return { ...withHelp(`Order ${o.id} has already been cancelled.`), fixed: "menu:cancel" };
    if (o.status === "delivered") return { ...withHelp(`Order ${o.id} has already been delivered, so it cannot be cancelled.`), fixed: "menu:cancel" };
    if (COMING_BACK.has(o.status)) return { ...withHelp(RTO_REPLY), fixed: "menu:cancel" };
    if (verdict.reason === "too_old") return { ...withHelp("Orders can only be cancelled within 24 hours of placing them."), fixed: "menu:cancel" };
    return { ...withHelp(`Order ${o.id} is already with the courier, so it cannot be cancelled now.`), fixed: "menu:cancel" };
  }
  if (sub === "yes") {
    return { ...withHelp(`Your order ${o.id} is cancelled.`), cancel: { orderId: o.id, keptText: `Order ${o.id} could not be cancelled just now.` }, fixed: "menu:cancel:done" };
  }
  return {
    text: `Order ${o.id} has not shipped yet, so it can be cancelled. Cancel it now?`,
    buttons: [{ id: id("cancel", o.id, "yes"), title: "Yes, cancel" }, { id: id("cancel", o.id, "no"), title: "No, keep it" }],
    fixed: "menu:cancel:confirm",
  };
}

function editAnswer(topic: "phone" | "address", o: MenuOrder): MenuStep {
  const what = topic === "phone" ? "phone number" : "address";
  if (o.status === "cancelled" || o.status === "wa_cancelled") return { ...withHelp(`Order ${o.id} has been cancelled, so the ${what} cannot be changed.`), fixed: `menu:${topic}` };
  if (o.status === "delivered") return { ...withHelp(`Order ${o.id} has already been delivered, so the ${what} cannot be changed.`), fixed: `menu:${topic}` };
  if (COMING_BACK.has(o.status)) return { ...withHelp(RTO_REPLY), fixed: `menu:${topic}` };
  if (PRE_DISPATCH.has(o.status) && !o.awb_code) {
    return { text: topic === "phone" ? `Please type the new phone number for order ${o.id}.` : `Please type the full new address for order ${o.id}.`, fixed: `menu:${topic}:ask` };
  }
  if (topic === "phone") {
    return {
      ...withHelp(`This order is already with the courier, so the phone number cannot be changed here. I have escalated this to the team. Please type the new number you would like used.`),
      escalate: { tag: "address_change", reason: `menu: phone change on ${o.id}, already with the courier` }, fixed: "menu:phone",
    };
  }
  return { ...withHelp(`This order is already with the courier, so the address cannot be changed now.`), fixed: "menu:address" };
}

function refundAnswer(o: MenuOrder, ctx: MenuContext): MenuStep {
  const rf = ctx.refunds?.get(o.id) ?? null;
  const cod = !(typeof o.payment_id === "string" && o.payment_id.startsWith("pay_"));
  if (!rf) {
    const returning = o.return_request?.status === "pending" || o.return_request?.status === "approved";
    return {
      ...withHelp(returning
        ? `I cannot see a refund on order ${o.id} yet. A refund starts after the returned parcel reaches our warehouse.`
        : `I cannot see a refund on record for order ${o.id}. If you have a question about it, please type it and we will help.`),
      fixed: "menu:refund",
    };
  }
  if (rf.status === "REFUND_MANUAL_REVIEW" || rf.status === "REFUND_FAILED") {
    return { ...withHelp(`Your refund of ₹${rf.amount} for order ${o.id} needs a look from our team. I have escalated this to the team.`), escalate: { tag: "refund", reason: `menu: refund on ${o.id} needs review` }, fixed: "menu:refund" };
  }
  if (rf.status === "REFUND_COMPLETED") {
    return { ...withHelp(`Your refund of ₹${rf.amount} for order ${o.id} was completed${rf.processedAt ? ` on ${day(rf.processedAt)}` : ""}. ${cod ? "It was credited to your AJUKI Wallet." : "It was sent to your original payment method."}`), fixed: "menu:refund" };
  }
  return {
    ...withHelp(`Your refund of ₹${rf.amount} for order ${o.id} is in progress. ${cod ? "It will be credited to your AJUKI Wallet." : "It takes 3-5 business working days to reach your original payment method."}`),
    fixed: "menu:refund",
  };
}

/** The answer for a topic once the order is known. `sub` is the reason or confirmation, when the step has one. */
export function answerTopic(topic: MenuTopic, order: MenuOrder, sub: string | null, ctx: MenuContext): MenuStep {
  const now = ctx.now ?? Date.now();
  switch (topic) {
    case "late": return lateAnswer(order, now);
    case "return": return returnAnswer(order, sub, now);
    case "problem": return problemAnswer(order, sub, now);
    case "cancel": return cancelAnswer(order, sub, now);
    case "phone": return editAnswer("phone", order);
    case "address": return editAnswer("address", order);
    case "refund": return refundAnswer(order, ctx);
    default: return { text: OTHER_REPLY, fixed: "menu:other" };
  }
}

/** One tapped id to the next message, or null when the id is not ours (the caller then treats the tap as ordinary text). */
export function stepForTap(raw: string, ctx: MenuContext, o: { outOfHours?: boolean } = {}): MenuStep | null {
  const p = parseMenuId(raw);
  if (!p) return null;
  if (p.kind === "menu") return topicList(o);
  if (!p.orderId && !p.another) return startTopic(p.topic, ctx);
  if (p.another) {
    if (ctx.orders.length > 1) return orderPicker(p.topic, ctx.orders);
    return { text: NO_ORDER_REPLY, fixed: `menu:${p.topic}:no_order` };
  }
  const order = ctx.orders.find((x) => x.id.toUpperCase() === (p.orderId ?? "").toUpperCase());
  // The order id in a tap is only ever one we offered, but never trust it: an id that is not one of THEIR orders is a stale or forged tap.
  if (!order) return { text: EXPIRED_REPLY, fixed: "menu:expired" };
  return answerTopic(p.topic, order, p.sub, ctx);
}

// ── Switches ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * SUPPORT_MENU: unset/0/off = nothing changes. "new" = customers who have never written to us before (plus the allow list): see menuMayApply and
 * lib/menuHandler.ts menuEligible, which looks at the thread. "allow" = only the numbers in SUPPORT_MENU_ALLOW (a comma list of 10-digit phones, for testing).
 * "1"/"on" = the allow list plus SUPPORT_MENU_RATE percent of numbers, chosen by a stable hash of the phone (default 10: a pilot, not everyone).
 */
export function menuAllowed(phone: string, env: Record<string, string | undefined> = process.env): boolean {
  const mode = (env.SUPPORT_MENU ?? "").trim().toLowerCase();
  if (!mode || mode === "0" || mode === "off" || mode === "false") return false;
  const ten = phone.replace(/\D/g, "").slice(-10);
  const allow = (env.SUPPORT_MENU_ALLOW ?? "").split(",").map((s) => s.replace(/\D/g, "").slice(-10)).filter(Boolean);
  if (allow.includes(ten)) return true;
  if (mode === "allow") return false;
  if (!["1", "on", "true"].includes(mode)) return false;
  const rate = Number(env.SUPPORT_MENU_RATE ?? "10");
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 100) return true;
  let h = 2166136261;
  for (const c of ten) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 100) < rate;
}

/** The configured mode. "new" = the guided flows are for customers who have never written to us before (decided per message in lib/menuHandler.ts menuEligible). */
export function menuMode(env: Record<string, string | undefined> = process.env): "off" | "allow" | "on" | "new" {
  const m = (env.SUPPORT_MENU ?? "").trim().toLowerCase();
  return m === "allow" ? "allow" : m === "new" ? "new" : ["1", "on", "true"].includes(m) ? "on" : "off";
}

/**
 * A cheap, synchronous "could the guided flows apply to this number at all?": true for anyone menuAllowed admits, and for EVERY number in "new" mode
 * (whether they really are new needs the database, so menuEligible decides). Callers use this to skip all menu work when the switch is off.
 */
export function menuMayApply(phone: string, env: Record<string, string | undefined> = process.env): boolean {
  return menuAllowed(phone, env) || menuMode(env) === "new";
}

/** Days after which the automatic topic list may be sent again to the same number (0 = never again). */
export function menuResendDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SUPPORT_MENU_RESEND_DAYS ?? "30");
  return Number.isFinite(n) && n >= 0 ? n : 30;
}
