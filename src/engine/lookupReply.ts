// Two fixed first-touch replies, written in code so the wording never drifts:
//
//  1. The greeting. Most chats open with the prefilled "Hi, I have a question about AJUKI" (the website's
//     click-to-chat text), or a bare "Hi". Every customer gets the same welcome.
//  2. A bare order ID or phone number — the whole message is just that. The reply is a template filled from the
//     order row, not composed by the model.
//
// Privacy is unchanged from the model path: full detail (dates, tracking link) only for orders found under the
// SENDER'S OWN number; an order reached by a typed ID alone gets its status and nothing else; another person's
// phone number reveals nothing. Pure, so every branch is unit-tested.

import { day } from "@engine/orderLines";
import { isOverdue, LATE_REPLY } from "@engine/lateDeliveryReply";

export const GREETING_REPLY =
  "Hi! Welcome to AJUKI 😊 How can we help you today? You can ask about your order, a product, sizing or payment.";

/** The website's prefilled click-to-chat text — always greeted, whenever it arrives. */
const PREFILLED = /^(?:(?:hi+|hello+|hey+)\s+)?i have a question about ajuki$/;
/** A bare greeting — only greeted as a first touch, never as a chaser mid-thread ("Hello??"). */
const BARE_GREETING = /^(?:hi+|hello+|hey+|hlo|helo|namaste|good (?:morning|afternoon|evening))(?: there| team| ajuki| sir| mam| madam)?$/;

const QUIET_HOURS = 6;

export function greetingReply(opts: { message: string; lastOutAt?: string | null; now?: number }): string | null {
  const t = (opts.message ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (PREFILLED.test(t)) return GREETING_REPLY;
  if (!BARE_GREETING.test(t)) return null;
  // A bare "Hi" straight after we spoke is part of that conversation, not a new one.
  const last = opts.lastOutAt ? Date.parse(opts.lastOutAt) : NaN;
  const now = opts.now ?? Date.now();
  if (Number.isFinite(last) && now - last < QUIET_HOURS * 3_600_000) return null;
  return GREETING_REPLY;
}

export type LookupOrder = {
  id: string;
  status: string;
  created_at?: string | null;
  delivered_at?: string | null;
  estimated_delivery?: string | null;
  tracking_url?: string | null;
};

const ORDER_ID = /^(?:my |the )?(?:order\s*)?(?:id|no\.?|number|#)?\s*[:#-]?\s*(ajuki\d{4,10})\W*$/i;

/** The order ID if the whole message is one, else null. */
export function bareOrderId(message: string): string | null {
  const m = ORDER_ID.exec((message ?? "").trim());
  return m ? m[1].toUpperCase() : null;
}

/** A 10-digit Indian mobile if the whole message is one (+91, spaces and dashes allowed), else null. */
export function barePhone(message: string): string | null {
  const t = (message ?? "").trim();
  if (!/^[+\d][\d\s\-]{8,16}$/.test(t)) return null;
  const digits = t.replace(/\D/g, "");
  const ten = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  return ten.length === 10 ? ten : null;
}

const PREP = new Set(["processing", "call_1", "call_2", "on_hold", "confirmed", "packed"]);
const ACTIVE = new Set([...PREP, "manifested", "shipped", "undelivered"]);

function phrase(o: LookupOrder): string {
  if (PREP.has(o.status)) return "is being prepared for dispatch";
  switch (o.status) {
    case "manifested": return "has been handed to the courier";
    case "shipped": return "is on its way";
    case "undelivered": return "had a delivery attempt that did not complete";
    case "delivered": return o.delivered_at ? `was delivered on ${day(o.delivered_at)}` : "has been delivered";
    case "cancelled": case "wa_cancelled": return "has been cancelled";
    case "rto": case "returned": return "is on its way back to us";
    default: return "is being processed";
  }
}

/** One day past the date: not "overdue" yet (founder, Batch 2), but the date is no longer an expectation. Founder-approved wording, 25 Oct (the 18 Oct late-parcel rule). */
export const RUNNING_LATE_TAIL = "We are working to get it delivered as soon as possible, so there is no need to worry.";

function eta(o: LookupOrder, now: number): string {
  if (!(ACTIVE.has(o.status) && o.estimated_delivery && !isOverdue(o, now))) return "";
  const passed = Math.floor((now - Date.parse(o.estimated_delivery)) / 86_400_000) >= 1;
  return passed ? ` It was expected around ${day(o.estimated_delivery)} and is running a little late. ${RUNNING_LATE_TAIL}` : ` Expected around ${day(o.estimated_delivery)}.`;
}

function track(o: LookupOrder): string {
  if (!ACTIVE.has(o.status) || PREP.has(o.status)) return "";
  // Always our own page (founder's rule, 2026-10-11), never the courier's.
  return " Track it at www.ajuki.in/track.";
}

/** One order's status as a sentence, from the record: what it is doing, when it is expected, where to track it. No lateness flag. */
export function orderStatusLine(o: LookupOrder, now: number = Date.now()): string {
  return `Order ${o.id} ${phrase(o)}.${eta(o, now)}${track(o)}`;
}

export type LookupResult = { text: string; escalate: boolean };

const TYPO_ID = /^(?:my |the )?(?:order\s*)?(?:id|no\.?|number|#)?\s*[:#-]?\s*([A-Za-z]{5})(\d{4,10})\W*$/i;

/** "AJUKO710076" for "AJUKI710076": the same digits as one of their orders and a different letter in the prefix. Null unless exactly that. */
export function typoOrderIdReply(message: string, candidateIds: string[]): string | null {
  const m = TYPO_ID.exec((message ?? "").trim());
  if (!m || /^ajuki$/i.test(m[1])) return null;
  const typed = `${m[1]}${m[2]}`.toUpperCase();
  const prefixDiffers = (a: string) => [...a.slice(0, 5)].filter((c, i) => c !== "AJUKI"[i]).length;
  const hit = candidateIds.find((id) => id.toUpperCase().endsWith(m[2]) && /^AJUKI/i.test(id) && prefixDiffers(typed) <= 2);
  return hit ? `I could not find ${typed}. Did you mean ${hit.toUpperCase()}?` : null;
}

const NOT_FOUND =
  "I couldn't find that order. Please check the order ID, or message us from the number you ordered with.";

const OTHER_NUMBER =
  "For privacy I can only share order details with the number the order was placed from. Please message us from that number, or send the order ID.";

/**
 * `ownOrders` are the ones matched to the sender's WhatsApp number; `mentionedOrders` are whatever a typed ID
 * resolved to that is NOT theirs. Returns null when the message is not a bare ID or number.
 */
export function orderLookupReply(opts: {
  message: string;
  senderPhone: string;
  ownOrders: LookupOrder[];
  mentionedOrders: LookupOrder[];
  now?: number;
}): LookupResult | null {
  const now = opts.now ?? Date.now();
  const late = (list: LookupOrder[]) => list.some((o) => isOverdue(o, now));
  const withLate = (text: string, list: LookupOrder[]): LookupResult =>
    late(list) ? { text: `${text}\n\n${LATE_REPLY}`, escalate: true } : { text, escalate: false };

  const typo = typoOrderIdReply(opts.message, [...opts.ownOrders, ...opts.mentionedOrders].map((o) => o.id));
  if (typo) return { text: typo, escalate: false };
  const id = bareOrderId(opts.message);
  if (id) {
    const own = opts.ownOrders.find((o) => o.id.toUpperCase() === id);
    if (own) return withLate(`Order ${own.id} ${phrase(own)}.${eta(own, now)}${track(own)}`, [own]);
    const other = opts.mentionedOrders.find((o) => o.id.toUpperCase() === id);
    if (other) return { text: `Order ${other.id} ${phrase(other)}. For live tracking, use www.ajuki.in/track with your order ID and phone number.`, escalate: false };
    // The ID a customer quotes is sometimes not the one on our side (a webhook hiccup can leave them with a
    // different number). So rather than stopping at "not found", check what IS on their number and ask which they mean.
    if (opts.ownOrders.length) {
      const shown = opts.ownOrders.slice(0, 3);
      const lines = shown.map((o) => `• ${o.id} ${phrase(o)}.${eta(o, now)}`);
      return { text: `I couldn't find an order with that ID, but I can see these on your number:\n${lines.join("\n")}\n\nWhich of these are you asking about?`, escalate: false };
    }
    return { text: NOT_FOUND, escalate: false };
  }

  const phone = barePhone(opts.message);
  if (phone) {
    if (phone !== opts.senderPhone) return { text: OTHER_NUMBER, escalate: false };
    if (!opts.ownOrders.length) return { text: "I couldn't find an order on this number. Please send your order ID.", escalate: false };
    const shown = opts.ownOrders.slice(0, 3);
    const lines = shown.map((o) => `• ${o.id} ${phrase(o)}.${eta(o, now)}`);
    return withLate(`Your recent orders:\n${lines.join("\n")}\n\nSend an order ID for tracking details.`, shown);
  }
  return null;
}
