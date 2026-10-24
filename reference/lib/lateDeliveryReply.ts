// Fixed wording for a customer chasing a parcel that is running late.
//
// First message: we have flagged it and are working on it. If they keep pushing: we are already on it, no
// need to worry. Same reason as lib/returnStateReply.ts — the founder wants the same words every time.
//
// "Late" follows the rule orderLines.ts already uses for the customer-facing OVERDUE framing: two or more
// days past the estimate, or a failed delivery attempt. A parcel that is merely on its way, or a customer
// asking an ordinary "where is my order", stays with the model (tracking link and all). Pure, unit-tested.

import { day } from "@/lib/orderLines";
import { LATE_REASSURE } from "@/lib/lateReassurance";

// 14 Oct 2026 (founder, from the audit of what was actually sent): the old first line, "I have flagged this to the team and we are working on it.",
// said nothing about the parcel and went to 59 customers in a week; the old second line, "We are already on it, there is no need to worry.",
// read as a brush-off. The first reply now says where the parcel stands, that it was escalated, and where to follow it; the second apologises
// and escalates again. Both old lines are kept below ONLY so an earlier line in a thread is still recognised as what we last said.

/** The escalation sentence both late-parcel replies carry. */
export const LATE_ESCALATED = "I have escalated this to the team.";
export const LATE_TRACK = "You can track it at www.ajuki.in/track.";

/** What this module used to send, word for word. Never sent now; recognised in history. */
export const LEGACY_LATE_REPLY = "I have flagged this to the team and we are working on it.";
export const LEGACY_LATE_INSIST_REPLY = "We are already on it, there is no need to worry.";

/** The approved escalation sentence (kept under its old export name: lookups append it to a status line). The full first reply is lateFirstText(). */
export const LATE_REPLY = LATE_ESCALATED;

// 18 Oct (founder): every late-parcel reply carries the reassurance (lib/lateReassurance.ts), which reverses the 14 Oct removal of "no need to worry": it is now a sentence AFTER the facts, not the reply.
/** What the second line said until 18 Oct. Never sent; recognised in history. */
export const PREVIOUS_LATE_INSIST_REPLY = "I am sorry you are still waiting. I have escalated this to the team again. You can follow the parcel at www.ajuki.in/track.";
export const LATE_INSIST_REPLY = `I am sorry you are still waiting. I have escalated this to the team again. ${LATE_REASSURE} You can follow the parcel at www.ajuki.in/track.`;

/** The same line: it carries the tracking page now, with or without the pipeline switch. Kept as an export for the modules that name it. */
export const LATE_INSIST_TRACK_REPLY = LATE_INSIST_REPLY;

const SETTLED = new Set(["delivered", "cancelled", "wa_cancelled", "returned", "rto"]);

export const LATE_WORDS =
  /(not (yet )?(received|delivered|arrived|come)|still not|haven'?t (got|received)|didn'?t (get|receive)|where is my|when will|\bdelay(ed)?\b|\blate\b|no (update|response|reply)|agent|courier|call(ed)? (him|them|the))/i;

export const PUSHING = /\b(please|plz|pls|reply|again|still|why|but|urgent|kindly|asap|hello|worry)\b|\?\?|!!/i;

// Only a chase gets the second line. "other" and "complaint" are what the model tags almost anything with (15 Oct: a request to open the box,
// "Call me"), so they no longer count on their own: the message must push, or use a late word, or be tagged as a delivery question.
const FOLLOWUP_TAGS = new Set(["late_delivery", "order_status"]);

/** Asking where things stand: "any update", "status", "when", "kab", "today/tomorrow". With a late-parcel line just above, that is a chase. */
const CHASE_WORDS = /\b(?:updates?|status|when|kab|kb|abhi tak|today|tomorrow|kal|aaj|time)\b/i;

/** Asks for something the second line does not answer (open the box, a call, the courier's number): the model answers it, with the thread in view. */
const NOT_A_CHASE = /\b(?:open[- ]?box|call me|call karo|phone me|ring me|(?:his|the|delivery (?:boy|guy|person)'?s?) (?:phone )?number)\b/i;

export type LateOrder = { id: string; status: string; estimated_delivery?: string | null };

/** The first late-parcel reply for one order: its state, the escalation, and where to follow it. No cause is given: a courier's reason is not for the customer. */
export function lateFirstText(o: LateOrder): string {
  const state = o.status === "undelivered"
    ? `Your order ${o.id} had a delivery attempt that did not complete.`
    : o.estimated_delivery ? `Your order ${o.id} was expected around ${day(o.estimated_delivery)} and is delayed.` : `Your order ${o.id} is delayed.`;
  return `${state} ${LATE_ESCALATED} ${LATE_REASSURE} ${LATE_TRACK}`;
}

const LATE_FIRST_SHAPE = /^Your order \S+ (?:had a delivery attempt that did not complete|was expected around [^.]+ and is delayed|is delayed)\. I have escalated this to the team\. (?:We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry\. )?You can track it at www\.ajuki\.in\/track\.$/;
/** Is this text one of our first late-parcel replies (today's or the old one)? */
export const isLateFirstText = (t: string): boolean => LATE_FIRST_SHAPE.test(t.trim()) || t.startsWith(LEGACY_LATE_REPLY.slice(0, 30));
/** Is this text one of our second late-parcel replies (today's or the old one)? */
export const isLateInsistText = (t: string): boolean => t.startsWith(LATE_INSIST_REPLY.slice(0, 30)) || t.startsWith(LEGACY_LATE_INSIST_REPLY.slice(0, 30));

export function isOverdue(o: LateOrder, now = Date.now()): boolean {
  if (SETTLED.has(o.status)) return false;
  if (o.status === "undelivered") return true;
  if (!o.estimated_delivery) return false;
  return Math.floor((now - Date.parse(o.estimated_delivery)) / 86_400_000) >= 2;
}

/**
 * The old fixed late-parcel lines (late_first, late_insist) on or off. ON by default. SUPPORT_LATE_LINES=0|off|false stops the REPLY from using them, so a late-parcel turn
 * goes to the late-delivery agent (SUPPORT_DELIVERY_AGENT=live) or, where it has no line, the general path writing from the parcel facts. This is how the old lines are
 * RETIRED without a deploy and brought back as fast; it is meant to be flipped only after the canary has shown the agent covers late chats (workflows/late-lines-retirement.md).
 * The situation reader (lib/situation.ts) still reads what the rule WOULD say, so the Bot tab's comparison keeps working.
 */
export const lateLinesEnabled = (env: Record<string, string | undefined> = process.env): boolean => !["0", "off", "false"].includes((env.SUPPORT_LATE_LINES ?? "").trim().toLowerCase());

/** `kind: "first"` is a new flag to the team; `"insist"` is the answer to a customer who keeps pushing. */
export function lateDeliveryReply(opts: {
  ownOrders: LateOrder[];
  message: string;
  tag: string;
  lastBotReply?: string | null;
  now?: number;
  /** SUPPORT_PIPELINE_V2: the "already on it" line carries the tracking link. Off = unchanged. */
  v2?: boolean;
}): { text: string; kind: "first" | "insist" } | null {
  const overdue = opts.ownOrders.filter((o) => isOverdue(o, opts.now));
  if (!overdue.length) return null;

  const last = opts.lastBotReply ?? "";
  const afterUs = isLateFirstText(last) || isLateInsistText(last);
  if (afterUs && NOT_A_CHASE.test(opts.message)) return null;
  if (afterUs && (FOLLOWUP_TAGS.has(opts.tag) || PUSHING.test(opts.message) || CHASE_WORDS.test(opts.message) || LATE_WORDS.test(opts.message))) {
    return { text: LATE_INSIST_REPLY, kind: "insist" };
  }
  if (opts.tag === "late_delivery" || LATE_WORDS.test(opts.message)) return { text: lateFirstText(overdue[0]), kind: "first" };
  return null;
}

/**
 * One message asking about a return AND a late parcel: the return line first, then the late-parcel line, as a single
 * reply. Only a first-time late flag is appended — an "insist" line belongs to a customer already told we are on it,
 * and bolting it onto a return answer would read as a non sequitur.
 */
export function combineReturnAndLate(returnText: string, late: { text: string; kind: "first" | "insist" } | null): string {
  return late && late.kind === "first" ? `${returnText}\n\n${late.text}` : returnText;
}
