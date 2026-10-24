// The fixed-reply decisions around the model call, as pure functions.
//
// These were inline in handleSupportMessage (lib/waSupport.ts) and could only be exercised by running the whole handler against a
// database. They are moved here VERBATIM — same rule modules, same order, same arguments — so they can be tested directly, replayed
// from a snapshot (evals/support/chain.ts) and called by one handler instead of mirrored by a harness. Moving them changed no
// behaviour: scripts/verify-override-extraction.mts runs the original inline text (sliced from the pre-extraction backup) and these
// functions side by side over a large corpus and requires identical output.
//
//   firstTouchDecision  BEFORE the model: a greeting, a bare order id, a plain topic question, a language / pay-link / fragment line,
//                       or the 11:00 bare reply — answered with no model call at all.
//   applyOverrides      AFTER the model: a return, cancel, topic or late-parcel rule may replace the model's text with fixed wording.
//
// Pure: no database, no clock beyond what the rule modules read, no network. Logging stays with the caller.

import type { SupportDecision } from "@/lib/gemini";
import type { ConversationTurn } from "@/lib/gemini";
import type { OrderRow } from "@/lib/orderLines";
import { returnStateReply, touchesReturnFlow } from "@/lib/returnStateReply";
import { cancelStateReply } from "@/lib/cancelStateReply";
import { lateDeliveryReply, lateLinesEnabled, combineReturnAndLate } from "@/lib/lateDeliveryReply";
import { queuedBareReply } from "@/lib/queuedReply";
import { greetingReply, orderLookupReply, barePhone } from "@/lib/lookupReply";
import { topicReply, PHONE_ASK_REPLY, PHONE_GOT_REPLY } from "@/lib/topicReplies";
import { hasCancellationIntent } from "@/lib/supportGuardrails";
import { isAckOnly } from "@/lib/ackOnly";
import { orderIdsIn, alreadyCancelledReply } from "@/lib/orderScope";
import { languageReply, payLinkConfirmReply, ambiguousFragmentReply } from "@/lib/clarifyReplies";

/** First-touch and topic replies share one shape whether they fire before the model (fast path) or after it. */
export type Special = { text: string; escalate: boolean; tag: string; reason?: string; kind: string };

export const pickSpecial = (
  g: string | null, lk: { text: string; escalate: boolean } | null, tp: { text: string; escalate: boolean; tag: string; kind: string } | null,
): Special | null =>
  g ? { text: g, escalate: false, tag: "other", kind: "greeting" }
  : lk ? { text: lk.text, escalate: lk.escalate, tag: lk.escalate ? "late_delivery" : "order_status", reason: lk.escalate ? "late delivery (order lookup)" : undefined, kind: lk.escalate ? "lookup_late" : "lookup" }
  : tp ? { text: tp.text, escalate: tp.escalate, tag: tp.tag, reason: tp.escalate ? `${tp.kind} (fixed reply)` : undefined, kind: tp.kind }
  : null;

/** An escalating one flags the team exactly as a late-delivery chaser does. */
export const specialDecision = (sp: Special, meta: Record<string, unknown>): SupportDecision => ({
  action: sp.escalate ? "escalate" : "reply", text: sp.text,
  tag: sp.tag as SupportDecision["tag"],
  ...(sp.escalate ? { reason: sp.reason ?? "needs a human" } : {}),
  meta: { ...meta, fixedReply: sp.kind },
});

/** What both passes read. Everything the handler already has in hand by the time it gets here. */
export interface OverrideInput {
  /** The inbound message exactly as received. Curly apostrophes are normalised inside. */
  message: string;
  history: ConversationTurn[];
  /** `history` without the message being answered (it is the last turn when the handler has already stored it). */
  recentTurns: ConversationTurn[];
  senderPhone: string;
  /** Orders matched to the sender's number, and orders named in the chat that are not theirs. */
  senderOrders: OrderRow[];
  finalMentioned: OrderRow[];
  /** What the fixed rules read: the one order this message is about (V2), or every order of theirs. */
  scopedOrders: OrderRow[];
  /** The scope basis, or null when the pipeline fixes are off. */
  scopeBasis: string | null;
  v2: boolean;
  lastBotReply: string | null;
  /** When we last sent them anything (the conversation's last_out_at). */
  lastOutAt: string | null | undefined;
  /** An NDR button flow owns the next message: the early pass is skipped. */
  noPending: boolean;
  imagesCount: number;
  /** Answering an overnight message at 11:00. */
  wake: boolean;
  /** A refund is on record for one of their orders. */
  hasRefundRecord: boolean;
}

/** The message as the rules read it. WhatsApp keyboards send curly apostrophes; every rule pattern is written with the straight one. */
export const ruleMessage = (message: string): string => message.replace(/[‘’]/g, "'");

/** The last thing we said, from the thread. */
export const lastBotReplyOf = (history: ConversationTurn[]): string | null =>
  [...history].reverse().find((t) => t.direction === "out")?.body ?? null;

/**
 * FAST PATH — fixed replies that do not need the model. When the message is a greeting, a bare order ID or number, or a plain topic
 * question (size, address, discount, quality, care, warranty, photos, skin reaction) and nothing about it touches returns, exchanges
 * or cancellation, the answer is already known: skip retrieval, the model and the verifier entirely. Anything the early pass does
 * not claim goes the long way round and the same rules run after the model.
 * Return, cancel and late-parcel rules are NOT in this pass: they read the model's tag.
 *
 * `via` says which pass produced it, for the caller's log line.
 */
/** "I have already emailed you": acknowledge it, ask which address they wrote from, and hand it to the team (founder, 13 Oct). */
const EMAILED = /\b(?:e-?mail|mail) done\b|\b(?:no|not|never|haven'?t|hasn'?t|didn'?t)\b[^.?!\n]{0,20}\b(?:response|reply|revert|answer)\b[^.?!\n]{0,15}\b(?:e-?mail|mail)\b|\b(?:e-?mail|mail)\b[^.?!\n]{0,20}\b(?:no (?:response|reply|revert)|not (?:replied|responded|answered|reverted)|yet to (?:reply|respond))\b|\bchecked? (?:your |the |my )?(?:e-?mails?|mails?|inbox)\b|\bcheck (?:your |the |my )?(?:e-?mails?|mails?|inbox)\b|\b(?:i|we)(?:'ve| have| had)?\s+(?:already \s*)?(?:e-?mailed|mailed|sent (?:you |an? |the |one )?(?:e-?mail|mail))\b|\balready (?:e-?mailed|mailed|sent (?:an? |the )?(?:e-?mail|mail))\b|\b(?:e-?mail|mail) (?:kar diya|kiya|bhej diya|bheja)\b/i;
export const EMAILED_REPLY = "Thanks for letting us know. I have escalated this to the team. Please share the email address you wrote from, so they can find your email.";
/** "Why 7 days?" / "why does it take so long?": the answer is not a policy lecture, it is the team (founder, 13 Oct). */
const WHY_SLOW = /\bwhy\b[^.?!\n]{0,30}\b(?:7|seven|so many|these many|so much|this much)\b[^.?!\n]{0,15}\b(?:days?|time)\b|\bwhy (?:take|taking|takes|so long|so late)\b[^.?!\n]{0,20}/i;
export const SLOW_REPLY = "I have escalated this to the team, and they will try to deliver it as soon as possible.";
const IN_FLIGHT = new Set(["confirmed", "shipped", "dispatched", "in_transit", "out_for_delivery", "manifested", "processing"]);

/** "Stop sending the same message", "you keep repeating", "automated replies": they are telling us the bot is looping (13 Oct, #11, #55). */
const REPEAT_COMPLAINT =
  /\b(?:stop|don'?t|do not|why)\b[^.?!\n]{0,25}\b(?:send(?:ing)?|repeat(?:ing)?|giv(?:e|ing)|say(?:ing)?|reply(?:ing)?)\b[^.?!\n]{0,20}\b(?:same|again|repeat\w*)\b|\byou (?:keep|are|r) (?:repeating|sending (?:me )?the same)|\bsame (?:message|reply|answer|response|line|thing)\b[^.?!\n]{0,25}\b(?:again|repeat\w*|every time|always)\b|\b(?:repeat(?:ing)? (?:the )?same|same (?:automated|bot) (?:response|reply|message))\b|\bautomated (?:replies|reply|response|responses|messages?)\b/i;
export const REPEAT_COMPLAINT_REPLY = "I am sorry for the repeated message. I have escalated this to the team.";

/** After we ask which email address they wrote from (our own line, or the bot's earlier question), an address typed back is the cue to hand over. */
export const EMAIL_GIVEN_REPLY = "Thank you. I have passed the email address to the team.";
const EMAIL_ASKED = /which email address|email address you wrote from|share the email address|\bemail\b[^.?!\n]{0,25}\b(?:you )?used\b|phone\/email/i;
/** Our question when a customer with several orders sends an address: "Which order number should this address apply to?" */
const ADDRESS_ORDER_ASKED = /which order[^.?]{0,60}address|address[^.?]{0,60}which order/i;
const EMAIL_ADDRESS = /([A-Za-z0-9._%+-]+)\s*@\s*([A-Za-z0-9.-]+\.[A-Za-z]{2,})/;

/**
 * A real message of theirs that has not been answered yet, sent just before this one ("No the attempt was never made", then "Hi" a second
 * later). A bare greeting that arrives after it is the tail of the same burst: the welcome line must not be what they get back (17 Oct). The
 * trailing customer turns since our last word, ignoring greetings and acknowledgements.
 */
export function earlierUnansweredContent(recentTurns: ConversationTurn[]): boolean {
  for (let k = recentTurns.length - 1; k >= 0; k--) {
    const t = recentTurns[k];
    if (t.direction === "out") return false;
    const body = (t.body ?? "").trim();
    if (!body || body.startsWith("[")) continue;
    if (isAckOnly(body) || greetingReply({ message: body })) continue;
    return true;
  }
  return false;
}

type FirstTouch = { decision: SupportDecision; kind: string; via: "fast" | "queued" } | null;

/** The same fixed reply as before, unless it would be the third time we ask for an order we cannot find (see breakIdentityLoop). */
export function firstTouchDecision(i: OverrideInput): FirstTouch {
  const r = firstTouchCore(i);
  if (!r) return r;
  const d = breakIdentityLoop(r.decision, i);
  return d === r.decision ? r : { decision: d, kind: "identity_loop", via: r.via };
}

function firstTouchCore(i: OverrideInput): FirstTouch {
  const ruleMsg = ruleMessage(i.message);
  // The customer says we are repeating ourselves: not the same line again, an apology and a hand-off. Only when we have already answered.
  if (i.imagesCount === 0 && i.lastBotReply && REPEAT_COMPLAINT.test(ruleMsg)) {
    const sp: Special = { text: REPEAT_COMPLAINT_REPLY, escalate: true, tag: "complaint", reason: "customer says the bot keeps repeating itself", kind: "repeat_complaint" };
    return { decision: specialDecision(sp, { fastPath: true }), kind: sp.kind, via: "fast" };
  }
  // They were asked which email address they wrote from and have typed one: say it was passed on, with the address in the case.
  if (i.imagesCount === 0 && i.lastBotReply && EMAIL_ASKED.test(i.lastBotReply)) {
    const em = EMAIL_ADDRESS.exec(ruleMsg);
    if (em && ruleMsg.length <= 120) {
      const sp: Special = { text: EMAIL_GIVEN_REPLY, escalate: true, tag: "complaint", reason: `customer says they emailed from ${em[1]}@${em[2]}`, kind: "email_given" };
      return { decision: specialDecision(sp, { fastPath: true }), kind: sp.kind, via: "fast" };
    }
  }
  // They were asked for a new phone number (lib/topicReplies.ts phoneChangeReply) and have typed one: say it was passed on, with the number in the case.
  if (i.imagesCount === 0 && i.lastBotReply?.startsWith(PHONE_ASK_REPLY.slice(0, 40))) {
    const num = barePhone(ruleMsg);
    if (num) {
      const sp: Special = { text: PHONE_GOT_REPLY, escalate: true, tag: "address_change", reason: `customer sent a new phone number: ${num}`, kind: "phone_given" };
      return { decision: specialDecision(sp, { fastPath: true }), kind: sp.kind, via: "fast" };
    }
  }
  // They were asked which order an address is for and have typed an order number: that is the answer, not a status lookup. The address goes to the team with the order named
  // (24 Oct: AJUKI710020 was sent back as "being prepared for dispatch" and the address was never applied).
  if (i.imagesCount === 0 && i.lastBotReply && ADDRESS_ORDER_ASKED.test(i.lastBotReply) && ruleMsg.length <= 30) {
    const id = orderIdsIn(ruleMsg)[0];
    if (id && i.senderOrders.some((o) => o.id.toUpperCase() === id)) {
      const addr = [...i.recentTurns].reverse().find((t) => t.direction === "in" && /\b\d{6}\b/.test(t.body ?? ""))?.body ?? "";
      const sp: Special = { text: `Thanks, I have passed that address for order ${id} to the team to update.`, escalate: true, tag: "address_change", reason: `new address for ${id}: ${addr.replace(/\s+/g, " ").slice(0, 300)}`, kind: "address_for_order" };
      return { decision: specialDecision(sp, { fastPath: true }), kind: sp.kind, via: "fast" };
    }
  }
  if (i.imagesCount === 0 && EMAILED.test(ruleMsg) && !/\?\s*$/.test(ruleMsg.trim())) {
    const sp: Special = { text: EMAILED_REPLY, escalate: true, tag: "complaint", reason: "customer says they have already emailed", kind: "emailed" };
    return { decision: specialDecision(sp, { fastPath: true }), kind: sp.kind, via: "fast" };
  }
  if (i.imagesCount === 0 && WHY_SLOW.test(ruleMsg) && i.scopedOrders.some((o) => IN_FLIGHT.has(String(o.status)) || o.awb_code)) {
    const sp: Special = { text: SLOW_REPLY, escalate: true, tag: "late_delivery", reason: "customer asks why delivery takes so long", kind: "slow_delivery" };
    return { decision: specialDecision(sp, { fastPath: true }), kind: sp.kind, via: "fast" };
  }
  if (
    i.imagesCount === 0 && i.noPending
    && !i.senderOrders.some((o) => o.return_request)
    && !touchesReturnFlow(ruleMsg) && !hasCancellationIntent(ruleMsg)
  ) {
    const fg = earlierUnansweredContent(i.recentTurns) ? null : greetingReply({ message: ruleMsg, lastOutAt: i.lastOutAt });
    const fl = fg ? null : orderLookupReply({ message: ruleMsg, senderPhone: i.senderPhone, ownOrders: i.senderOrders, mentionedOrders: i.finalMentioned });
    const ft = fg || fl ? null : topicReply({ message: ruleMsg, tag: "unknown", ownOrders: i.scopedOrders, lastBotReply: i.lastBotReply, v2: i.v2 });
    let fs = pickSpecial(fg, fl, ft);
    // A language we do not reply in, "Confirm" in answer to our own payment message, a one-word fragment: a fixed pointer or a
    // clarifying question instead of a guess (lib/clarifyReplies.ts). Pipeline fixes only.
    if (!fs && i.v2) {
      const recentOut = i.history.filter((t) => t.direction === "out").map((t) => t.body);
      const extra = languageReply(ruleMsg)
        ?? payLinkConfirmReply({ message: ruleMsg, recentOut, orderStatus: i.scopeBasis === "none" ? null : i.scopedOrders[0]?.status })
        ?? (orderIdsIn(ruleMsg).length === 0 ? ambiguousFragmentReply(ruleMsg) : null);
      if (extra) fs = { text: extra.text, escalate: false, tag: extra.kind === "pay_link" ? "payment_cod" : "other", kind: extra.kind };
    }
    if (fs) return { decision: specialDecision(fs, { fastPath: true }), kind: fs.kind, via: "fast" };
  }
  // The 11:00 answer to an overnight message that is only a greeting or a tracking word: a short fixed line, not a model reply six
  // hours late (lib/queuedReply.ts). Only for the queued (wake) answer; a live "Track" is still answered by the bot at once.
  if (i.wake && i.imagesCount === 0 && i.noPending) {
    const q = queuedBareReply(ruleMsg, { ownOrderCount: i.senderOrders.length });
    if (q) return { decision: specialDecision({ text: q.text, escalate: false, tag: q.tag, kind: q.kind }, { fastPath: true }), kind: q.kind, via: "queued" };
  }
  return null;
}

/**
 * After the model: a pending or rejected return gets fixed wording, written in code: the model drifts around a prompted sentence,
 * and the founder wants the same words every time (lib/returnStateReply.ts). It replaces the model's text and any escalation it
 * asked for. Asking to cancel an order already dispatched gets fixed wording too (lib/cancelStateReply.ts); an order that is already
 * cancelled is told so (V2); every fixed override reads the scoped orders only.
 */
export function applyOverrides(decision: SupportDecision, i: OverrideInput): SupportDecision {
  return breakIdentityLoop(applyOverridesCore(decision, i), i);
}

/**
 * A customer whose order we cannot find on their number gets asked for the order id or the phone number. Some cannot give either (17 Oct: eight
 * asks in 18 minutes to a customer who had no order id, offered a different phone number and an email, and wanted a call). After two asks the
 * third is not another ask: the team is told, once, and a person can look the order up from what the customer has sent.
 */
const IDENTITY_ASK = /\b(?:share|send|provide|tell|confirm)\b[^.?!\n]{0,60}\b(?:order (?:id|number)|phone number|number you used|number used)\b|couldn'?t find an order|no orders (?:registered|against)|don'?t see any orders|record still shows no orders/i;
export const IDENTITY_LOOP_ASKS = 2;
export const IDENTITY_LOOP_REPLY = "I have escalated this to the team.";
export const asksForIdentity = (text: string | null | undefined): boolean => IDENTITY_ASK.test(text ?? "");

export function breakIdentityLoop(d: SupportDecision, i: OverrideInput): SupportDecision {
  if (d.action === "escalate" || d.orderAction || !asksForIdentity(d.text)) return d;
  const recentOut = i.history.filter((t) => t.direction === "out").slice(-8);
  // Only an unbroken run of asks counts: a real answer in between means the thread moved on.
  let asks = 0;
  for (let k = recentOut.length - 1; k >= 0; k--) { if (asksForIdentity(recentOut[k].body)) asks++; else break; }
  if (asks < IDENTITY_LOOP_ASKS) return d;
  return { action: "escalate", text: IDENTITY_LOOP_REPLY, tag: "order_status", reason: "no order found for this customer after two requests for an order id or phone number", meta: { ...d.meta, fixedReply: "identity_loop" } };
}

function applyOverridesCore(decision: SupportDecision, i: OverrideInput): SupportDecision {
  const ruleMsg = ruleMessage(i.message);
  const settled = i.v2
    ? alreadyCancelledReply({ scoped: i.scopedOrders, message: ruleMsg, recentCustomer: i.recentTurns.filter((t) => t.direction === "in").map((t) => t.body) })
    : null;
  const fixed = settled?.text ?? returnStateReply({
    ownOrders: i.scopedOrders, message: ruleMsg, tag: decision.tag,
    hasRefundRecord: i.hasRefundRecord,
    lastBotReply: i.lastBotReply, v2: i.v2,
  }) ?? cancelStateReply({ ownOrders: i.scopedOrders, message: ruleMsg, tag: decision.tag, lastBotReply: i.lastBotReply, recentCustomer: i.recentTurns.filter((t) => t.direction === "in").map((t) => t.body) });
  const greet = i.noPending && !earlierUnansweredContent(i.recentTurns) ? greetingReply({ message: ruleMsg, lastOutAt: i.lastOutAt }) : null;
  const lookup = i.noPending && !greet
    ? orderLookupReply({ message: ruleMsg, senderPhone: i.senderPhone, ownOrders: i.senderOrders, mentionedOrders: i.finalMentioned })
    : null;
  // Quality / photos, an address change once dispatched, a size question on an order in flight, a discount question —
  // each a fixed line (lib/topicReplies.ts). The escalating ones really do flag the team.
  const topic = i.noPending && !greet && !lookup
    ? topicReply({ message: ruleMsg, tag: decision.tag, ownOrders: i.scopedOrders, lastBotReply: i.lastBotReply, v2: i.v2 })
    : null;
  // Not when the model has asked for an order action (cancel, change address): the fixed reply would replace the decision and the
  // action would silently never run — "cancel my order, any discount?" must still cancel it.
  const special: Special | null = fixed || decision.orderAction ? null : pickSpecial(greet, lookup, topic);
  const lateToo = lateLinesEnabled() ? lateDeliveryReply({ ownOrders: i.scopedOrders, message: ruleMsg, tag: decision.tag, lastBotReply: i.lastBotReply, v2: i.v2 }) : null;
  if (fixed && lateToo?.kind === "first") {
    // One message asking about a return AND a late parcel: both answers in one reply, return first. The parcel part is a real
    // flag to the team, so this escalates (case + ping) rather than closing the thread as handled.
    return { action: "escalate", text: combineReturnAndLate(fixed, lateToo), tag: decision.tag, reason: "return + late delivery (fixed reply)", meta: { ...decision.meta, fixedReply: "return_and_late" } };
  }
  if (fixed) {
    return { action: "reply", text: fixed, tag: decision.tag, meta: { ...decision.meta, fixedReply: settled ? "already_cancelled" : "return_state", ...(i.scopeBasis !== null ? { scope: i.scopeBasis } : {}) } };
  }
  if (special) return specialDecision(special, decision.meta);
  // A parcel running late: flag it to the team once (a real escalation, so the case and the Telegram ping exist), then answer a
  // customer who keeps pushing with a fixed reassurance. See lib/lateDeliveryReply.ts.
  const late = lateLinesEnabled() ? lateDeliveryReply({ ownOrders: i.scopedOrders, message: ruleMsg, tag: decision.tag, lastBotReply: i.lastBotReply, v2: i.v2 }) : null;
  if (late) {
    return { action: "escalate", text: late.text, tag: "late_delivery", reason: "late delivery (fixed reply)", meta: { ...decision.meta, fixedReply: `late_${late.kind}` } };
  }
  return decision;
}
