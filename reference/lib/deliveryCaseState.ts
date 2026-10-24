// The state-aware core of the late-delivery agent. PURE: no database, no clock beyond the `now` it is given, no network, no model.
//
// What it adds over the fixed late-parcel lines (lib/lateDeliveryReply.ts):
//   · a parcel TIMELINE rebuilt from the scans (attempts, last movement, hours since movement, the cause from the last failed attempt);
//   · a CASE STATE that outlives one message (what we last asked, chases since the parcel moved, the scan we last answered against);
//   · an ESCALATION LEDGER, so one stall, one repeat run and one failed-attempt count are each escalated ONCE, never again for the same reason;
//   · a CATCH-ALL: anything that is not plainly a status question goes to a person, never to a status line.
// The model (lib/deliveryIntent.ts, lib/deliveryAnalyst.ts) only READS: it names the intent and summarises the scans. Everything that happens
// next is decided here, from the founder's rules (16 Oct 2026): 48 h with no movement, three chases with no movement, two failed attempts,
// no courier action possible. The wording below is the DRAFT set in workflows/late-delivery-agent.md; nothing here is sent until it is approved.

import { reassurance, LATE_EFFORT } from "@/lib/lateReassurance";

import { courierPushesCancel } from "@/lib/courierPushCancel";

export type Courier = "delhivery" | "shadowfax" | "dtdc" | "other";
export type Cause = "courier_side" | "customer_side" | "ndr_pending" | "max_attempts" | "unknown";
export type Phase = "none" | "in_transit" | "out_for_delivery" | "failed_attempt" | "on_hold" | "rto" | "delivered";
export type Awaiting = null | "rider_answer" | "date" | "address";
export type Escalate = "none" | "no_lever" | "stall_48h" | "repeat_chase" | "dispute_manual" | "two_failed" | "not_received" | "needs_human";
export type DeliveryIntent =
  | "chase" | "dispute" | "rider_number" | "address_change" | "address_given" | "date_request" | "date_answer" | "rider_yes" | "number_changed"
  | "phone_given" | "call_me" | "contact_info" | "not_received" | "needs_human" | "other" | "ack";

export const STALL_HOURS = 48;
export const REPEAT_LIMIT = 3;
export const TWO_FAILED = 2;
const H = 3_600_000;

export interface DeliveryScan { event: string; raw_status: string | null; remark: string | null; location?: string | null; scanned_at: string }
export interface DeliveryOrder { id: string; courier: Courier; status?: string | null; estimated_delivery?: string | null; pincode?: string | null }

/** What the proactive movement updates (lib/deliveryMovement.ts) remember about a case: the stage last told, how many updates went, and when. Kept in the ledger so it survives the customer's next message. */
export interface MovementMeta { lastEvent: string | null; updatesSent: number; lastUpdateAt: number | null }
export interface Ledger { stall: boolean; repeat: boolean; twoFailedAt: number; dispute: boolean; noLever: boolean; movement?: MovementMeta; /** The customer-unavailable question has been put for this failed attempt. */ asked?: boolean }
export interface CaseState {
  awaiting: Awaiting; chases: number; failedAttempts: number; lastScanAt: number | null; lastReplyAt: number | null; ledger: Ledger;
}
export const emptyLedger = (): Ledger => ({ stall: false, repeat: false, twoFailedAt: 0, dispute: false, noLever: false });
export const emptyState = (): CaseState => ({ awaiting: null, chases: 0, failedAttempts: 0, lastScanAt: null, lastReplyAt: null, ledger: emptyLedger() });

export interface Timeline {
  attempts: number; lastEvent: string | null; lastAt: number | null; hoursSinceMovement: number | null; phase: Phase; cause: Cause;
  /** The delivery person's remarks, verbatim, newest last. */
  remarks: string[]; lastFailureRemark: string | null; movedSinceFailure: boolean;
  /** The courier has not yet taken the parcel: every scan is a manifest, a pickup booking or a pickup that did not happen. To the customer it is "being packed" (founder 19 Oct), never "not picked up". */
  prePickup: boolean;
  /** The last real movement was a failed attempt the courier blames on the customer, and since then only admin scans (NDR updated, deferred date set, which carry no movement) have arrived: the parcel waits for the customer's answer. */
  awaitingRetry: boolean;
}

const COURIER_SIDE = /vehicle|breakdown|rain|weather|not attempted|capacity|strike|holiday|backlog|shortage|hub/i;
const CUSTOMER_SIDE = /not contactable|unavailable|refused|shifted|wrong address|address|wants delivery on another date|closed|cid/i;
const NDR_PENDING = /require delivery|as per ndr|reattempt delivery/i;
const MAX_ATTEMPTS = /max attempt|maximum attempt|st-?108/i;

const REAL_MOVEMENT: ReadonlySet<string> = new Set(["picked_up", "in_transit", "at_facility", "out_for_delivery", "delivered"]);
/** A scan from before the courier has the parcel: Delhivery "Manifested", Shadowfax "New / Assigned For Pickup / Out For Pickup", DTDC "pickup scheduled / not picked up". */
const PRE_PICKUP_RAW = /^\s*(?:new|assigned for pickup|out for pickup|manifest\w*|pickup[ _]scheduled|not[ _]picked[ _]up)\s*$/i;
/** Shadowfax "Cid / Seller Initiated Delay": the pickup was put off on our side, so the courier still does not have the parcel. */
const PRE_PICKUP_REMARK = /seller initiated delay/i;
export const isPrePickupScan = (s: Pick<DeliveryScan, "event" | "raw_status"> & { remark?: string | null }): boolean => s.event === "manifested" || PRE_PICKUP_RAW.test(s.raw_status ?? "") || PRE_PICKUP_REMARK.test(s.remark ?? "");

export function causeOfRemark(text: string): Cause {
  if (MAX_ATTEMPTS.test(text)) return "max_attempts";
  if (NDR_PENDING.test(text) && !CUSTOMER_SIDE.test(text.replace(NDR_PENDING, ""))) return "ndr_pending";
  if (COURIER_SIDE.test(text)) return "courier_side";
  if (CUSTOMER_SIDE.test(text)) return "customer_side";
  return "unknown";
}

/** Rebuild what is true about the parcel at `now` from its scans (oldest first or not: they are sorted here). `orderStatus` only adds rto/returned. */
export function buildTimeline(scansIn: DeliveryScan[], now: number, orderStatus?: string | null): Timeline {
  const scans = [...scansIn].filter((s) => s.scanned_at).sort((a, b) => Date.parse(a.scanned_at) - Date.parse(b.scanned_at));
  const last = scans[scans.length - 1] ?? null;
  const lastAt = last ? Date.parse(last.scanned_at) : null;
  const failures = scans.filter((s) => s.event === "failed_attempt");
  const lastFail = failures[failures.length - 1] ?? null;
  let phase: Phase = "none";
  if (last) {
    phase = last.event === "delivered" ? "delivered" : /^rto/.test(last.event) ? "rto" : last.event === "out_for_delivery" ? "out_for_delivery"
      : last.event === "failed_attempt" ? "failed_attempt" : last.event === "on_hold" ? "on_hold" : "in_transit";
  }
  if (orderStatus === "rto" || orderStatus === "returned") phase = "rto";
  const failText = lastFail ? `${lastFail.raw_status ?? ""} ${lastFail.remark ?? ""}` : "";
  // "Maximum attempts reached" arrives as its own scan AFTER the last failed attempt: it decides the cause, not the failed attempt's own remark.
  const afterFail = lastFail ? scans.filter((s) => Date.parse(s.scanned_at) >= Date.parse(lastFail.scanned_at)) : [];
  const maxed = afterFail.some((s) => MAX_ATTEMPTS.test(`${s.raw_status ?? ""} ${s.remark ?? ""}`));
  return {
    attempts: failures.length, lastEvent: last?.event ?? null, lastAt, hoursSinceMovement: lastAt === null ? null : Math.max(0, (now - lastAt) / H), phase,
    cause: lastFail ? (maxed ? "max_attempts" : causeOfRemark(failText)) : "unknown",
    prePickup: scans.length > 0 && phase !== "delivered" && phase !== "rto" && scans.every(isPrePickupScan),
    awaitingRetry: !!lastFail && phase !== "delivered" && phase !== "rto" && (maxed ? false : causeOfRemark(failText) === "customer_side" || causeOfRemark(failText) === "ndr_pending") && !afterFail.some((s) => REAL_MOVEMENT.has(s.event) && Date.parse(s.scanned_at) > Date.parse(lastFail.scanned_at)),
    remarks: scans.map((s) => (s.remark ?? "").trim()).filter(Boolean).filter((r, i, a) => a.indexOf(r) === i).slice(-6),
    lastFailureRemark: lastFail?.remark ?? lastFail?.raw_status ?? null,
    movedSinceFailure: !!(lastFail && last && last !== lastFail && Date.parse(last.scanned_at) > Date.parse(lastFail.scanned_at)),
  };
}

// ── reading the message with patterns: the veto and the fallback beside the model's reading ──
const DISPUTE = /(?:switched\s+off|phone\s+(?:is\s+|was\s+)?off|unreachable|not\s+reachable)|(?:did(?:n'?t| not)|never|nobody|no one|hasn'?t|haven'?t|not)\s+(?:\w+\s+){0,3}?(?:call(?:ed)?|contact(?:ed)?|attempt(?:ed)?|come|came|visit(?:ed)?)|(?:no|not)\s+(?:a\s+)?(?:call|contact|attempt)|attempt\s+(?:was\s+)?never|(?:rider|boy|guy|agent|courier)\s+(?:is\s+)?not\s+(?:contactable|picking|answering|reachable|calling)|not\s+(?:answering|picking)|call\s+(?:nhi|nahi)|never\s+called|wasn'?t\s+attempted|(?:no|not)\s+(?:an)?answer(?:ing)?|doesn'?t\s+(?:pick|answer)/i;
const RIDER_NUMBER = /(?:rider|delivery\s+(?:boy|guy|person)|courier\s+(?:boy|guy)|agent)'?s?\s+(?:phone\s+)?(?:number|contact|no\b|phone)|(?:give|send|share).{0,25}(?:his|rider|boy).{0,12}(?:number|no\b)|number\s+of\s+(?:the\s+)?(?:rider|delivery)/i;
const CONTACT_INFO = /\b(?:contact|phone|customer care|support)\s+(?:number|no\b|email|mail)\b|how\s+(?:can|do)\s+i\s+contact/i;
const CALL_ME = /\bcall\s+me\b|\bcall\s+karo\b|\bphone\s+me\b/i;
const ADDRESS_CHANGE = /(?:change|update|wrong|correct|new)\s+(?:my\s+|the\s+)?(?:delivery\s+)?(?:address|pincode)|address\s+(?:is\s+)?(?:wrong|galat|change)|deliver\s+(?:it\s+)?(?:on|to)\s+that\s+address|adress/i;
const DATE_WORDS = /\b(?:tomorrow|today|kal|aaj|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?:st|nd|rd|th)?\s*(?:oct|october)|\d{1,2}\/\d{1,2})\b/i;
const DATE_REQUEST = /(?:deliver|delivery|attempt|send)\b.{0,25}\b(?:tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?:st|nd|rd|th)?\s*(?:oct|october))|\b(?:tomorrow|kal)\s+(?:deliver|delivery|bhej)|\bdeliver\s+(?:it\s+)?(?:on|by)\b/i;
const IS_QUESTION = /\b(?:when|kab|kabh|kitne|kitna|ayega|aayega|aayegi|milega|will (?:it|i|the)|what time)\b/i;
const NOT_RECEIVED = /(?:not|didn'?t|never|haven'?t)\s+(?:receive[d]?|get|got)\s+(?:the |my )?(?:order|parcel|package)|marked\s+(?:as\s+)?delivered/i;
/** Words that always put a person on it, whatever the model says: refund, cancel, legal or abusive language, a photo, a request to change courier. */
export const HUMAN_VETO = /(?:don'?t|do not|never|stop)\s+(?:send|use|ship|give)\b.{0,40}(?:shadowfax|shadow\s?fax|delhivery|courier|dtdc|partner)|(?:change|another|other|different)\s+(?:the\s+)?(?:courier|delivery partner)|\b(?:fraud|scam|scamers?|cheat|legal|consumer court|police|complain(?:t)?|refund|cancel(?:l?ation)?)\b|\[(?:photo|video|customer sent)|declin|returned? to (?:you|us|sender)|returning my order/i;
const STATUS_Q = /\b(?:where|when|status|update|updates|track|tracking|kab|kahan|reach|arrive|ayega|aayega|aayegi|milega|delivered?|delivery|deliver|order|parcel|late|delay|still|waiting|any news)\b|\?/i;
const PHONE_ONLY = /^\s*(?:\+?91[\s-]?)?[6-9]\d{9}\s*$/;
const PHONE_IN = /(?:\+?91[\s-]?)?[6-9]\d{9}/;
const PHONE_CHANGE = /\b(?:change|update)\b.{0,25}\b(?:no|number|phone|mobile)\b/i;
const PIN = /\b[1-9]\d{5}\b/;
const YES = /^\s*(?:yes|yeah|yep|haan|han|he\s+called|called|they\s+called|rider\s+did)/i;
const NO = /^\s*(?:no|nope|nahi|nhi|never|didn'?t|not)\b/i;
const CHANGED = /(?:number\s+(?:changed|is\s+different|wrong)|wrong\s+number|new\s+number)/i;

/** Read the message with patterns, in the light of what we last asked. The fallback and the veto: the model's reading is merged in `mergeIntent`. */
export function intentFromText(message: string, awaiting: Awaiting): DeliveryIntent {
  const m = (message ?? "").replace(/[‘’]/g, "'").trim();
  if (!m) return "chase";
  if (awaiting === "date" && (DATE_WORDS.test(m) || /^\s*(?:any\s*day|whenever|next day)/i.test(m)) && !/\?\s*$/.test(m)) return "date_answer";
  if (awaiting === "address" && (PIN.test(m) || m.length > 25) && !HUMAN_VETO.test(m)) return "address_given";
  if (awaiting === "rider_answer") { if (CHANGED.test(m)) return "number_changed"; if (DISPUTE.test(m) || NO.test(m)) return "dispute"; if (YES.test(m)) return "rider_yes"; if (DATE_WORDS.test(m) || /^\s*(?:any\s*day|whenever|next day)/i.test(m)) return "date_answer"; }
  if (PHONE_ONLY.test(m)) return "phone_given";
  if (PHONE_CHANGE.test(m)) return PHONE_IN.test(m) ? "phone_given" : "number_changed";
  if (NOT_RECEIVED.test(m)) return "not_received";
  // The rider wants the customer to cancel, or the customer refuses to: a complaint about the courier (a person and a ticket), not a cancellation for the veto to catch.
  if (courierPushesCancel(m)) return "dispute";
  if (HUMAN_VETO.test(m)) return "needs_human";
  if (DISPUTE.test(m)) return "dispute";
  if (CONTACT_INFO.test(m)) return "contact_info";
  if (RIDER_NUMBER.test(m)) return "rider_number";
  if (ADDRESS_CHANGE.test(m)) return "address_change";
  if (DATE_REQUEST.test(m) && !IS_QUESTION.test(m.replace(/deliver tomorrow/i, ""))) return "date_request";
  if (CALL_ME.test(m)) return "call_me";
  if (STATUS_Q.test(m) && m.length <= 200) return "chase";
  return m.length <= 60 ? "chase" : "other";
}

/** What the model read (lib/deliveryIntent.ts), as the intents this module uses. */
export interface ModelRead { intent: string; confidence: "high" | "low" }
const FROM_MODEL: Record<string, DeliveryIntent> = {
  status_question: "chase", no_contact_complaint: "dispute", rider_number: "rider_number", address_change_request: "address_change", address_provided: "address_given",
  date_request: "date_request", date_answer: "date_answer", rider_called_yes: "rider_yes", number_changed: "number_changed", phone_provided: "phone_given",
  call_me: "call_me", contact_info: "contact_info", not_received_but_marked_delivered: "not_received", acknowledgement: "ack",
  courier_complaint: "needs_human", change_courier_request: "needs_human", refund_or_cancel: "needs_human", abusive_or_legal: "needs_human", photo_or_media_only: "needs_human", other: "needs_human",
};
/**
 * Merge the model's reading with the pattern veto. The model decides the intent; the patterns only ever ADD a person (refund, cancel, legal, photo, change
 * courier). No reading (the call failed) or a low-confidence one goes to a person, except a short message, which is a chase ("Confirm", "Help me with this").
 */
export function mergeIntent(message: string, awaiting: Awaiting, model: ModelRead | null): DeliveryIntent {
  const m = (message ?? "").trim();
  if (!m) return "chase";
  if (courierPushesCancel(m)) return "dispute";
  if (HUMAN_VETO.test(m.replace(/[‘’]/g, "'"))) return "needs_human";
  if (!model) return m.length <= 40 ? "chase" : "other";
  if (model.confidence === "low") return m.length <= 40 ? "chase" : "other";
  return FROM_MODEL[model.intent] ?? "needs_human";
}

// ── wording: the DRAFT set (workflows/late-delivery-agent.md). Never sent until approved. ──
const TRACK = "You can track it at www.ajuki.in/track.";
const ESCALATED = "I have escalated this to the team.";
const EXPLICIT_DAY = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?:st|nd|rd|th)?\s*(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\d{1,2}\/\d{1,2}|it'?s\s+\d{1,2})\b/i;
/** The customer named a day to deliver on. "Tomorrow" counts only when they are not asking for today: "deliver today, I will be busy tomorrow" asks for today (21 Oct). */
/** A day mentioned only to say when they are away ("my flight is on Saturday") is not a day to deliver on (23 Oct: it was answered "your request for that date"). */
const AWAY_CONTEXT = /\b(?:flight|travel(?:l?ing)?|trip|out of (?:town|station|the city|city|india)|not (?:at )?home|vacation|wedding)\b/i;
const ASKS_DELIVERY = /\b(?:deliver\w*|send|arrive|reach|come|attempt|dispatch|try)\b/i;
export const namedDay = (message: string): boolean => {
  if (AWAY_CONTEXT.test(message) && !ASKS_DELIVERY.test(message)) return false;
  return EXPLICIT_DAY.test(message) || (/\b(?:tomorrow|kal)\b/i.test(message) && !/\b(?:today|aaj)\b/i.test(message));
};
const UNAVAILABLE_OPTIONS = "Would you like it delivered at a later time? If so, please tell me which day. If nobody called or came, please tell me that instead and I will raise it with the courier.";
export const STATUS_WORDS: Record<string, string> = { in_transit: "in transit", picked_up: "in transit", at_facility: "in transit", out_for_delivery: "out for delivery", failed_attempt: "delivery attempted", on_hold: "on hold at a hub", rerouting: "in transit", manifested: "in transit", unknown: "in transit" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayOf = (ms: number): string => { const d = new Date(ms + 5.5 * H); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

export interface Action { name: "DEFER_DLV" | "RE-ATTEMPT" | "EDIT_DETAILS" | "SHADOWFAX_EDIT" | "SHADOWFAX_ISSUE" | "KAM_REQUEST" | "CALLBACK"; allowed: boolean; why: string }
export interface Decision {
  replyId: string; text: string; escalate: Escalate; intent: DeliveryIntent; moved: boolean; action: Action | null; state: CaseState; timeline: Timeline;
}

/** `priorChases`: how many times the customer already asked about this parcel in the chat before this case existed (the whole chat is read, 19 Oct); only used when there is no case yet. */
export interface DecideInput { order: DeliveryOrder; timeline: Timeline; message: string; intent: DeliveryIntent; state: CaseState | null; now: number; priorChases?: number }

/** One turn. Returns the reply (an approved draft line), whether a person is prompted and why, the courier action wanted, and the new case state. */
export function decideDelivery(i: DecideInput): Decision {
  const { order, timeline: t, now } = i;
  const id = order.id;
  const s0 = i.state;
  const moved = !!(s0 && s0.lastScanAt !== null && t.lastAt !== null && t.lastAt > s0.lastScanAt);
  const ledger: Ledger = moved ? { stall: false, repeat: false, twoFailedAt: s0?.ledger.twoFailedAt ?? 0, dispute: false, noLever: false, ...(s0?.ledger.movement ? { movement: s0.ledger.movement } : {}) } : { ...(s0?.ledger ?? emptyLedger()) };
  const state: CaseState = { awaiting: null, chases: moved ? 1 : (s0?.chases ?? Math.max(0, i.priorChases ?? 0)) + 1, failedAttempts: t.attempts, lastScanAt: t.lastAt, lastReplyAt: now, ledger };
  let intent = i.intent;
  if (intent === "not_received" && t.phase !== "delivered") intent = "chase"; // "I did not receive it" is about a parcel marked delivered only
  const out = (replyId: string, text: string, escalate: Escalate, action: Action | null = null, awaiting: Awaiting = null): Decision => { state.awaiting = awaiting; return { replyId, text, escalate, intent, moved, action, state, timeline: t }; };
  const status = STATUS_WORDS[t.lastEvent ?? "unknown"] ?? "in transit";
  const stalled = t.hoursSinceMovement !== null && t.hoursSinceMovement >= STALL_HOURS;
  // Delhivery accepts a defer or an edit only while the parcel sits in its failed-delivery window (otherwise "Package in incorrect status"); Shadowfax takes edits, never a date.
  const inNdrWindow = t.phase === "failed_attempt" || t.phase === "on_hold" || t.awaitingRetry;
  const canDefer = order.courier === "delhivery" && inNdrWindow && (t.cause === "customer_side" || t.cause === "ndr_pending");
  const editLever = (order.courier === "delhivery" && inNdrWindow) || order.courier === "shadowfax";
  const editAction = (why: string, allowed = true): Action => ({ name: order.courier === "delhivery" ? "EDIT_DETAILS" : "SHADOWFAX_EDIT", allowed, why });

  if (intent === "ack") return out("S0", "", "none"); // a bare thank-you or ok is answered with silence upstream
  if (t.phase === "delivered" && intent !== "not_received") return out("D3", `Your order ${id} shows as delivered. If you have not received it, please reply here.`, "none");
  if (intent === "not_received") return out("N1", `Our record shows order ${id} as delivered. ${ESCALATED} Please email ajukisupport@gmail.com with your order number so Senior Support can look into it.`, "not_received");
  if (t.phase === "rto") return out("D4", `Your order ${id} is on its way back to us and cannot be delivered again. You can place a new order at www.ajuki.in.`, "none");

  // ── state rules, whatever the customer writes ──
  if (intent === "needs_human" || intent === "other") return out("H1", `${ESCALATED} ${TRACK}`, "needs_human");
  // The courier has not taken the parcel yet. Founder 19 Oct: never say it has not been picked up; say it is being packed and will be shipped as soon as possible, politely and with assurance.
  if (t.prePickup && intent === "chase") {
    const PACKING = `Thank you for your patience. Your order ${id} is being packed and will be shipped as soon as possible. We are working to get it to you quickly, so there is no need to worry.`;
    if (stalled && !ledger.stall) { ledger.stall = true; return out("P2", `${PACKING} ${ESCALATED} ${TRACK}`, "no_lever"); }
    return out("P1", `${PACKING} ${TRACK}`, "none");
  }
  if (t.attempts >= TWO_FAILED && t.attempts > ledger.twoFailedAt && intent === "chase") {
    ledger.twoFailedAt = t.attempts;
    // Founder 19 Oct: when the courier says the customer was unavailable, say so, offer a later time, and ask whether anyone called or came.
    if (t.cause === "customer_side") return out("A5", `Your order ${id} has had ${t.attempts} delivery attempts that did not complete, and the courier reports that you were not available. ${ESCALATED} ${UNAVAILABLE_OPTIONS}`, "two_failed", null, "rider_answer");
    return out("A5", `Your order ${id} has had ${t.attempts} delivery attempts that did not complete. ${ESCALATED} ${TRACK}`, "two_failed");
  }

  // ── answers to what we last asked ──
  // F2: a delivery day no courier call can take. It says "that date" only when the customer named one; "Today delivery available?" is a status question with a person on it.
  const f2 = (): Decision => {
    const waiting = (t.phase === "failed_attempt" || t.awaitingRetry) && t.cause === "customer_side";
    // A customer-side failed attempt with no day named: ask the unavailable question first (21 Oct: F2 came before it, and A1 an hour and a half later).
    if (!namedDay(i.message) && waiting && !ledger.asked) { ledger.asked = true; return out("A1", `Your order ${id} had a delivery attempt that did not complete, and the courier reports that you were not available. ${UNAVAILABLE_OPTIONS}`, "none", null, "rider_answer"); }
    // A parcel already out for delivery with no day named ("when will it arrive?", "date?"): the rider is on it, there is nothing for a person to do (24 Oct, ..5282: escalated for it).
    if (!namedDay(i.message) && t.phase === "out_for_delivery" && !waiting) return out("F2", `Order ${id} is out for delivery. I cannot promise a delivery time here. The rider will contact you before delivery. ${TRACK}`, "none");
    const already = ledger.noLever; ledger.noLever = true;
    const action: Action = { name: "KAM_REQUEST", allowed: false, why: order.courier === "shadowfax" ? "Shadowfax has no scheduling call" : "no usable API" };
    // The team has already been told: say so once, do not escalate again (21 Oct: "I have escalated this to the team" twice in eight minutes).
    if (already) return out("F2", namedDay(i.message) ? `Your request for that date is already with the team. ${TRACK}` : `Your request is already with the team. ${TRACK}`, "none", action);
    if (namedDay(i.message)) return out("F2", `I have passed your request for that date to the team. ${ESCALATED}`, "no_lever", action);
    // "Order X is delivery attempted" reads wrongly: after a failed attempt say what happened.
    const head = t.phase === "failed_attempt" || t.awaitingRetry ? `Order ${id} had a delivery attempt that did not complete.` : `Order ${id} is ${status}.`;
    return out("F2", `${head} I cannot promise a delivery time here. ${ESCALATED} ${TRACK}`, "no_lever", { ...action, why: "a delivery-time question with no day named and no way to schedule" });
  };
  if (intent === "date_answer") {
    if (canDefer) return out("B2", `I have asked the courier to deliver order ${id} on the date you gave. I will message you here when it moves. ${TRACK}`, "none", { name: "DEFER_DLV", allowed: true, why: "Delhivery customer-side code; confirmed by the courier before the customer is told" });
    return f2();
  }
  if (intent === "rider_yes") return out("B6", `Thank you. Which day would you like the delivery for order ${id}?`, "none", null, "date");
  if (intent === "number_changed") return out("B5", `Thank you. Please send the correct number for order ${id}.`, "none", editAction("phone edit", order.courier === "delhivery" || order.courier === "shadowfax"));
  if (intent === "phone_given") return out("B5b", `I have asked the courier to use that number for order ${id}. I will message you here when it moves. ${TRACK}`, order.courier === "dtdc" || order.courier === "other" ? "no_lever" : "none", editAction("phone edit; Shadowfax masks the contact on read-back, so it stays unconfirmed unless a scan proves it", order.courier === "delhivery" || order.courier === "shadowfax"));
  if (intent === "address_given" || intent === "address_change") {
    const given = PIN.exec(i.message)?.[0] ?? null;
    const differentPin = !!(given && order.pincode && given !== order.pincode);
    if (intent === "address_change" && !given) return editLever ? out("F3a", `I can ask the courier to change the address for order ${id}. Please send the full new address, keeping the same pincode.`, "none", editAction("awaiting the address"), "address")
      : out("F3c", `I have passed the new address to the team to request the change from the courier. ${ESCALATED} A different pincode may not be possible.`, "no_lever", { name: "KAM_REQUEST", allowed: false, why: "no usable API for this parcel's state" });
    if (!editLever || differentPin) return out("F3c", `I have passed the new address to the team to request the change from the courier. ${ESCALATED} A different pincode may not be possible.`, "no_lever", { name: "KAM_REQUEST", allowed: false, why: differentPin ? "a different pincode: Delhivery cannot, Shadowfax is intra-city only" : "no usable API" });
    return out("F3b", `I have asked the courier to deliver order ${id} to the new address. I will message you here when it moves. ${TRACK}`, "none", editAction("same pincode"));
  }

  // ── requests ──
  if (intent === "contact_info") return out("F5", "You can message us here on this WhatsApp chat or email our Senior Support Team at ajukisupport@gmail.com.", "none");
  if (intent === "rider_number") return out("F1", "I cannot share the rider's number. The rider will contact you before delivery.", "none");
  if (intent === "dispute" || (intent === "call_me" && (t.cause === "customer_side" || t.cause === "ndr_pending") && t.phase !== "out_for_delivery")) {
    if (order.courier === "shadowfax") { const first = !ledger.dispute; ledger.dispute = true; return out("B3", `I am sorry about that. I have escalated this to the team so the courier can be asked what happened. I will message you here when it moves. ${TRACK}`, first ? "dispute_manual" : "none", { name: "SHADOWFAX_ISSUE", allowed: true, why: "raise an issue; Shadowfax has no scheduling" }, null); }
    if (order.courier === "delhivery") { const first = !ledger.dispute; ledger.dispute = true; return out("B1", "I am sorry about that. I have escalated this to the team so the courier can be asked what happened. Which day would you like the delivery, and is this the right number to call?", first ? "dispute_manual" : "none", { name: "DEFER_DLV", allowed: canDefer, why: "awaiting the date; the complaint is a prepared request while ticket automation is not live" }, "date"); }
    ledger.dispute = true; return out("B4", `I have reported to the courier that you were not contacted. ${ESCALATED} ${TRACK}`, "dispute_manual", { name: "KAM_REQUEST", allowed: false, why: "no API for this courier" });
  }
  if (intent === "date_request") {
    if (canDefer && namedDay(i.message)) return out("B2", `I have asked the courier to deliver order ${id} on the date you gave. I will message you here when it moves. ${TRACK}`, "none", { name: "DEFER_DLV", allowed: true, why: "Delhivery customer-side code" });
    return f2();
  }
  if (intent === "call_me") {
    if (t.phase === "out_for_delivery") return out("F1b", "I cannot arrange a call from here. The rider will contact you before delivery.", "none");
    return out("F4", `I cannot arrange a call from here. ${ESCALATED}`, "no_lever", { name: "CALLBACK", allowed: false, why: "the bot cannot place calls; a person must" });
  }

  // ── a status question: the case state decides ──
  if (s0) {
    if (t.awaitingRetry && t.cause === "customer_side" && !ledger.asked && !moved) { ledger.asked = true; return out("A1", `Your order ${id} had a delivery attempt that did not complete, and the courier reports that you were not available. ${UNAVAILABLE_OPTIONS}`, "none", null, "rider_answer"); }
    if (moved && t.lastEvent === "failed_attempt") return out("A1", t.cause === "customer_side" ? `Your order ${id} had another delivery attempt that did not complete, and the courier reports that you were not available. ${UNAVAILABLE_OPTIONS}` : `Your order ${id} had another delivery attempt that did not complete. Did the rider contact you?`, "none", null, "rider_answer");
    if (moved) return out(t.lastEvent === "out_for_delivery" ? "D2" : "D1", t.lastEvent === "out_for_delivery" ? `Your order ${id} is out for delivery today. ${TRACK}` : `Update on your order ${id}: the latest status is ${status}. You can follow it at www.ajuki.in/track.`, "none");
    if (stalled && !ledger.stall) { ledger.stall = true; return out("E1", `There has been no movement on order ${id} for 2 days. ${ESCALATED} ${TRACK}`, "stall_48h"); }
    if (state.chases >= REPEAT_LIMIT && !ledger.repeat) { ledger.repeat = true; return out("E2", `I am sorry you are still waiting. ${ESCALATED} ${TRACK}`, "repeat_chase"); }
    return out("C1", `Order ${id} is ${status}, and the courier has not added anything newer since ${t.lastAt !== null ? dayOf(t.lastAt) : "it shipped"}. I will message you here as soon as it moves. ${TRACK}`, "none");
  }
  // first contact about this parcel, but not the first time they asked: the chat before this case counts (priorChases)
  if (state.chases >= REPEAT_LIMIT && !ledger.repeat) { ledger.repeat = true; return out("E2", `I am sorry you are still waiting. ${ESCALATED} ${TRACK}`, "repeat_chase"); }
  if (t.cause === "max_attempts") return out("A2", `Your order ${id} had a delivery attempt that did not complete. ${ESCALATED} ${TRACK}`, "no_lever", { name: "KAM_REQUEST", allowed: false, why: "maximum attempts reached: no NDR action is accepted" });
  if (order.courier === "dtdc" || order.courier === "other") return out("A2", `Your order ${id} is delayed. ${ESCALATED} ${TRACK}`, "no_lever", { name: "KAM_REQUEST", allowed: false, why: "no NDR API for this courier" });
  if ((t.phase === "failed_attempt" || t.awaitingRetry) && (t.cause === "customer_side" || t.cause === "ndr_pending")) { ledger.asked = true; return out("A1", t.cause === "customer_side" ? `Your order ${id} had a delivery attempt that did not complete, and the courier reports that you were not available. ${UNAVAILABLE_OPTIONS}` : `Your order ${id} had a delivery attempt that did not complete. Did the rider contact you?`, "none", null, "rider_answer"); }
  if (t.cause === "courier_side" && t.phase === "failed_attempt" && order.courier === "delhivery" && /not attempted/i.test(t.lastFailureRemark ?? "")) return out("A3", `Your order ${id} is delayed with the courier, and I have asked them to attempt it again. I will message you here when it moves. ${TRACK}`, "none", { name: "RE-ATTEMPT", allowed: true, why: "EOD-86: a plain re-attempt is allowed" });
  if (stalled) { ledger.stall = true; return out("E1", `There has been no movement on order ${id} for 2 days. ${ESCALATED} ${TRACK}`, "stall_48h"); }
  return out("A2s", `Update on your order ${id}: the latest status is ${status}${t.lastAt !== null ? ` (last scan ${dayOf(t.lastAt)})` : ""}. I will message you here when it moves. ${TRACK}`, "none");
}

// ── LIVE-LITE: the few lines the agent may send before courier actions and movement updates exist ──
//
// Lines A (first reply, no lever), C (nothing newer), E (48 hours, repeat chase), the two-failed-attempts prompt and the movement-update lines. No line that
// asks the customer something the agent cannot then act on (A1, B1 to B6, F3a), no line that says the courier was asked to do something (A3, B2, B3, F3b), and
// no line that promises a later message, because proactive movement updates are not built: "I will message you here when it moves" would be a promise nobody
// keeps. C1 and A2s lose that sentence; E1 says "at least 2 days" because the stall rule fires at 48 hours or more.
// 19 Oct: with the courier actions and the ticket executor live, the customer-unavailable flow joins: A1 (ask), B6 (which day), B2 (defer, only after the action is submitted), B1 / B3 / B4 (nobody
// called or came: a person and a ticket), F2 (a date no courier call can take), and the two "being packed" lines P1 / P2.
export const LIVE_LITE_IDS: ReadonlySet<string> = new Set(["A1", "A2", "A2s", "A5", "B1", "B2", "B3", "B4", "B6", "C1", "D1", "D2", "E1", "E2", "F2", "P1", "P2"]);
const LATER_MESSAGE = /\s*I will message you here (?:as soon as it moves|when it moves)\.?/;

export interface LiveLiteLine { replyId: string; text: string; escalate: Escalate; person: boolean }
/** Lines that tell the customer about a late or stalled parcel and so carry the reassurance (lib/lateReassurance.ts); the movement updates carry the short effort sentence instead. */
const REASSURED = new Set(["A2", "A2s", "A5", "C1", "E1", "E2"]);
const EFFORT = new Set(["D1", "D2"]);
const BEFORE_TRACK = /\s+(You can (?:track|follow) (?:it|the parcel) at www\.ajuki\.in\/track\.)$/;

/** The approved line the agent may send now for this decision, or null when the existing path should answer. Pure. */
export function liveLiteLine(d: Pick<Decision, "replyId" | "text" | "escalate">, o: { blameCourier?: boolean } = {}): LiveLiteLine | null {
  if (!LIVE_LITE_IDS.has(d.replyId) || !d.text.trim()) return null;
  let text = d.text.replace(LATER_MESSAGE, "").replace("for 2 days", "for at least 2 days").replace(/\s+/g, " ").trim();
  // 18 Oct (founder): a late-parcel line always says we are working to get it delivered as soon as possible and that there is no need to worry, and may say the delay is on the courier's side.
  const extra = REASSURED.has(d.replyId) ? reassurance(o.blameCourier === true) : EFFORT.has(d.replyId) ? LATE_EFFORT : "";
  if (extra) text = BEFORE_TRACK.test(text) ? text.replace(BEFORE_TRACK, ` ${extra} $1`) : `${text} ${extra}`;
  return { replyId: d.replyId, text, escalate: d.escalate, person: d.escalate !== "none" };
}

// ── the code-only gate and the order choice ──
export const LATE_TALK = /where is my|when will|not (yet )?(received|delivered|arrived)|delay|late\b|still|update|deliver|delivery|courier|rider|attempt|call|address|adress|order nhi|kab|status|track|parcel|waiting/i;
export interface OrderView { order: DeliveryOrder; scans: DeliveryScan[]; createdAt: number }

/** Is this message worth the agent at all? Code only, so non-late traffic never costs a model call. */
export function deliveryGate(views: OrderView[], message: string, now: number): boolean {
  if (!views.length) return false;
  const open = views.some((v) => { const t = buildTimeline(v.scans, now, v.order.status); return t.phase !== "delivered" && t.phase !== "none" && (t.phase === "failed_attempt" || t.phase === "on_hold" || (t.hoursSinceMovement ?? 0) >= 24 || !!(v.order.estimated_delivery && (now - Date.parse(v.order.estimated_delivery)) / 86_400_000 >= 2)); });
  return open || (LATE_TALK.test(message) && views.some((v) => v.scans.length > 0 && buildTimeline(v.scans, now, v.order.status).phase !== "delivered"));
}

/** Which of the customer's orders the message is about: one they name, else one whose last scan was a failed attempt, else the one most overdue, else the newest shipped. */
export function pickDeliveryOrder(views: OrderView[], message: string, now: number): OrderView | null {
  const named = /AJUKI\d+/i.exec(message)?.[0]?.toUpperCase();
  const live = views.filter((v) => v.scans.length > 0);
  const tl = (v: OrderView) => buildTimeline(v.scans, now, v.order.status);
  return (named && live.find((v) => v.order.id === named))
    || live.find((v) => tl(v).phase !== "delivered" && tl(v).lastEvent === "failed_attempt")
    || live.find((v) => tl(v).phase !== "delivered" && v.order.estimated_delivery && (now - Date.parse(v.order.estimated_delivery)) / 86_400_000 >= 2)
    || [...live].sort((a, b) => b.createdAt - a.createdAt).find((v) => tl(v).phase !== "delivered")
    || null;
}
