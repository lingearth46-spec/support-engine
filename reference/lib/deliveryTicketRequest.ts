// How the late-delivery agent asks for a courier ticket: a pure builder, workflows/late-delivery-ticket-contract.md sections 2 to 4.
//
// The agent never talks to a courier portal. This module turns one decision (a trigger, an order, what the courier says right now) into either a request row for
// the existing machinery (courier_requests: the Courier Desk raises Delhivery tickets at night, the Shadowfax Escalation API is one call) or a refusal that says why
// and who takes it instead. It does no IO, so every guard is tested. Nothing here is wired to a courier yet.
//
// What the 18 Oct checks showed, and what is built on it:
//   · Delhivery's dispute category ("Shipment not delivered (need POD) / Fake remark") is refused unless Delhivery's own status is a failed delivery ("Shipment not
//     eligible for category", In Transit), so a dispute is requested only then; otherwise it falls back to the delay ticket, or goes to a person.
//   · A delay ticket is judged by Delhivery's live state and promised date, not by OUR order status: a parcel we call `undelivered` that Delhivery shows In Transit with
//     no scan for days is exactly the one nothing else acts on (AJUKI710036).
//   · Shadowfax carries a claim by its CATEGORY only (no text): status_mismatch is filed as "Fake status", delayed_delivery as "My shipment is delayed". One issue per
//     parcel, ever (the [sfx-escalated] marker), so a parcel already escalated goes to a person.
//   · Ticket text is built here from fixed templates, within the portal's 300 characters, from the AWB, a scan code and dates only. Never a phone number, an address, or
//     anything the customer or the model wrote.

import { evaluateDelhiveryCandidate, promisedDay, istDate, type TrackFacts } from "@/lib/courierDesk/candidates";
import { parcelStateFromDelhivery, parcelStateFromShadowfax, type ParcelState } from "@/lib/courierDesk/ticketMap";

export type TicketTrigger = "delay" | "stalled" | "disputed_attempt";
export type Claim = "no_call" | "no_attempt" | null;
export const TICKET_SOURCE = "delivery_agent";
/** Lower number first when the nightly cap is shared: a disputed attempt, then a stalled parcel, then a plain delay. */
export const PRIORITY: Record<TicketTrigger, 0 | 1 | 2> = { disputed_attempt: 0, stalled: 1, delay: 2 };
/** One request per case and kind inside this window (the contract, section 7). */
export const REQUEST_WINDOW_DAYS = 14;
/** Shadowfax `delivery_dispute` (category 5, only once a parcel is marked Delivered) has never been tried: until a supervised raise verifies it, that case goes to a person. */
export const SFX_DELIVERY_DISPUTE_VERIFIED = false;

/** The portal's strings, read from the 12 hand-raised tickets (18 Oct). */
export const DLV_DISPUTE = {
  category: "Shipment not delivered (need POD) / Fake remark",
  subCategory: "Delivery or consignee pickup failed due to incorrect / fake remark",
} as const;
export const DLV_DELAY = {
  category: "Reattempt or Delay in delivery / consignee pickup / return",
  subCategory: "Reattempt or Delay in delivery / consignee pickup",
} as const;
export const DESCRIPTION_MAX = 300;

export interface TicketOrder {
  id: string;
  awb: string | null;
  courierName: string | null;
  shiprocketOrderId: string | null;
  status: string | null;
  adminNotes: string | null;
  pendingCourierEdit?: boolean | null;
}
export interface TicketCtx {
  now: number;
  /** AWBs with an open ticket (our table or the portal list), and with a queued / raising / raised / deflected / unknown request. */
  openTicketAwbs: ReadonlySet<string>;
  activeRequestAwbs: ReadonlySet<string>;
  /** `${awb}|${kind}` for every request of the last REQUEST_WINDOW_DAYS. */
  recentRequests: ReadonlySet<string>;
  /** delhivery.ts NDR_ELIGIBLE_CODES and MAXED_OUT_CODES. */
  ndrCodes: ReadonlySet<string>;
  maxedCodes: ReadonlySet<string>;
}
export interface TicketLive {
  /** Delhivery's live tracking for the AWB, null when it could not be read. */
  delhivery: (TrackFacts & { statusCode?: string }) | null;
  /** Shadowfax's live status word (tracking), null when it could not be read. */
  shadowfaxStatus: string | null;
}
export interface TicketAsk { trigger: TicketTrigger; caseId?: string | null; claim?: Claim }

export interface TicketRequest {
  courier: "delhivery" | "shadowfax";
  kind: TicketTrigger;
  source: typeof TICKET_SOURCE;
  orderId: string;
  awb: string;
  priority: 0 | 1 | 2;
  caseId: string | null;
  /** Delhivery: the portal category pair and the text. Shadowfax: the Escalation API category (the claim travels by that alone). */
  ticket: { category?: string; subCategory?: string; description?: string; shadowfaxCategory?: "delayed_delivery" | "status_mismatch" | "delivery_dispute" };
  evidence: { trigger: TicketTrigger; claim: Claim; parcel: ParcelState; promisedDate: string | null; daysLate: number | null; lastScanAt: string | null; lastScanText: string | null; fellBackFromDispute: boolean };
}
/** `to`: who takes it when no request is made. person = a human decides; wait = ask again later; none = nothing to do. */
export type Built = { ok: true; request: TicketRequest; notes: string[] } | { ok: false; reason: string; to: "person" | "wait" | "none" };

const no = (reason: string, to: "person" | "wait" | "none"): Built => ({ ok: false, reason, to });
const TERMINAL = new Set(["delivered", "rto", "returned", "cancelled", "wa_cancelled"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (iso: string | null | undefined): string | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : null;
};
/** Words from a scan, safe to put in a ticket: tags, long digit runs (phones) and quotes out, short. */
const safeWords = (s: unknown, n = 60): string => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\+?\d[\d\s-]{8,}\d/g, " ").replace(/["“”]/g, "'").replace(/\s+/g, " ").trim().slice(0, n);

export function delayDescription(o: { promised: string | null; lastCode: string | null; lastOn: string | null }): string {
  const p = dayLabel(o.promised);
  const scan = o.lastCode && o.lastOn ? ` Last scan ${safeWords(o.lastCode, 20)} on ${o.lastOn}, no movement since.` : "";
  const text = `Parcel is delayed beyond the promised delivery date${p ? ` (${p})` : ""}.${scan} Please locate it, arrange delivery with a call to the consignee first, and share an updated delivery date.`;
  return text.length <= DESCRIPTION_MAX ? text : "Parcel is delayed beyond the promised delivery date. Please locate it, expedite delivery and share an updated delivery date.";
}
export function disputeDescription(o: { awb: string; remark: string | null; scannedOn: string | null }): string {
  const rem = safeWords(o.remark, 50);
  const scanned = rem ? `was scanned '${rem}'${o.scannedOn ? ` on ${o.scannedOn}` : ""}` : "shows a failed delivery attempt";
  const text = `AWB ${o.awb} ${scanned}, but the consignee says no call or visit was made. Please share proof of attempt (call log, rider location) and arrange redelivery, with a call to the consignee first.`;
  return text.length <= DESCRIPTION_MAX ? text : `AWB ${o.awb} shows a failed delivery attempt, but the consignee says no call or visit was made. Please share proof of attempt and arrange redelivery, with a call to the consignee first.`;
}

const courierOf = (o: TicketOrder): "delhivery" | "shadowfax" | null => {
  const c = (o.courierName ?? "").trim().toLowerCase();
  if (o.shiprocketOrderId) return null; // a Shiprocket-assigned parcel is escalated through Shiprocket, not here
  return c === "delhivery" ? "delhivery" : c === "shadowfax" ? "shadowfax" : null;
};

/** One decision in, one request or one refusal out. Pure. */
export function buildTicketRequest(order: TicketOrder, ask: TicketAsk, live: TicketLive, ctx: TicketCtx): Built {
  const awb = String(order.awb ?? "").trim();
  if (!awb) return no("the parcel is not booked: there is no AWB to raise a ticket on", "none");
  const status = String(order.status ?? "").toLowerCase();
  if (TERMINAL.has(status)) return no(`the order is ${status}`, "none");
  const courier = courierOf(order);
  if (!courier) return no("this courier has no ticket route from here (DTDC, a Shiprocket-assigned parcel, or another): a person raises it by hand", "person");
  if (ctx.openTicketAwbs.has(awb)) return no("an open ticket already exists for this parcel", "wait");
  if (ctx.activeRequestAwbs.has(awb)) return no("a request for this parcel is already active", "wait");
  if (ctx.recentRequests.has(`${awb}|${ask.trigger}`)) return no(`a ${ask.trigger} request was made for this parcel in the last ${REQUEST_WINDOW_DAYS} days`, "wait");
  const claim: Claim = ask.claim ?? null;
  const caseId = ask.caseId ?? null;
  const base = { source: TICKET_SOURCE, orderId: order.id, awb, caseId } as const;

  if (courier === "shadowfax") {
    if ((order.adminNotes ?? "").includes("[sfx-escalated")) return no("Shadowfax allows one issue per parcel and one was already raised: a person decides", "person");
    if (live.shadowfaxStatus === null) return no("Shadowfax's live status could not be read", "wait");
    const parcel = parcelStateFromShadowfax({ status: live.shadowfaxStatus });
    if (parcel === "rto" || parcel === "cancelled") return no(`the parcel is ${parcel}`, "none");
    const evidence = { trigger: ask.trigger, claim, parcel, promisedDate: null, daysLate: null, lastScanAt: null, lastScanText: safeWords(live.shadowfaxStatus, 30), fellBackFromDispute: false };
    if (parcel === "delivered") {
      if (ask.trigger !== "disputed_attempt" || !SFX_DELIVERY_DISPUTE_VERIFIED) return no("the parcel shows as delivered at Shadowfax; the delivered-dispute category has not been verified yet: a person decides", "person");
    }
    if (ask.trigger === "disputed_attempt") {
      return { ok: true, notes: ["Shadowfax files this as 'Fake status': the claim travels by the category, there is no text"], request: { ...base, courier, kind: "disputed_attempt", priority: PRIORITY.disputed_attempt, ticket: { shadowfaxCategory: "status_mismatch" }, evidence } };
    }
    if (parcel === "customer_side" || parcel === "on_hold") return no(`Shadowfax shows ${parcel === "on_hold" ? "a hold" : "a failed attempt"}, which its delay issue does not cover (it is an NDR): a person decides`, "person");
    if (parcel === "out_for_delivery") return no("out for delivery today", "wait");
    return { ok: true, notes: ["Shadowfax files this as 'My shipment is delayed'"], request: { ...base, courier, kind: ask.trigger, priority: PRIORITY[ask.trigger], ticket: { shadowfaxCategory: "delayed_delivery" }, evidence } };
  }

  // ── Delhivery ──
  if (!/^\d{10,15}$/.test(awb)) return no(`not a Delhivery AWB: ${awb}`, "person");
  if (order.pendingCourierEdit) return no("a delivery-detail edit is pending", "wait");
  const track = live.delhivery;
  if (!track) return no("Delhivery's live tracking could not be read", "wait");
  const parcel = parcelStateFromDelhivery(track, ctx.ndrCodes);
  if (parcel === "delivered" || parcel === "rto" || parcel === "cancelled") return no(`Delhivery shows the parcel as ${parcel}`, "none");
  const failedAttempt = parcel === "customer_side" || (!!track.statusCode && ctx.maxedCodes.has(track.statusCode));
  const lastScanText = safeWords(track.instructions || track.status, 60) || null;
  const scanIso = track.statusDateTime ? new Date(`${track.statusDateTime.replace(" ", "T").slice(0, 19)}+05:30`).toISOString() : null;

  if (ask.trigger === "disputed_attempt") {
    if (failedAttempt) {
      const description = disputeDescription({ awb, remark: track.instructions || track.status || null, scannedOn: dayLabel(scanIso ? istDate(Date.parse(scanIso)) : null) });
      return { ok: true, notes: [], request: { ...base, courier, kind: "disputed_attempt", priority: PRIORITY.disputed_attempt, ticket: { ...DLV_DISPUTE, description },
        evidence: { trigger: "disputed_attempt", claim, parcel, promisedDate: promisedDay(track.promisedDate), daysLate: null, lastScanAt: scanIso, lastScanText, fellBackFromDispute: false } } };
    }
    // Delhivery would refuse the dispute category ("not eligible for category", 18 Oct): fall back to the delay ticket, or a person.
    const d = delay(order, track, ctx, scanIso);
    if (!d.ok) return no(`Delhivery's own status is not a failed delivery, so the dispute category would be refused; and for a delay ticket: ${d.reason}`, "person");
    return { ok: true, notes: ["a dispute cannot be filed while Delhivery shows the parcel in transit: filed as a delay ticket, the claim is not on it"], request: { ...base, courier, kind: "delay", priority: PRIORITY.delay, ticket: { ...DLV_DELAY, description: d.description },
      evidence: { trigger: "disputed_attempt", claim, parcel, promisedDate: d.promised, daysLate: d.daysLate, lastScanAt: scanIso, lastScanText, fellBackFromDispute: true } } };
  }

  if (failedAttempt) return no("Delhivery shows a failed delivery that waits on the customer, which is not a courier delay: the NDR flow or the customer's answer decides", "person");
  const d = delay(order, track, ctx, scanIso);
  if (!d.ok) return no(d.reason, d.to);
  return { ok: true, notes: [], request: { ...base, courier, kind: ask.trigger, priority: PRIORITY[ask.trigger], ticket: { ...DLV_DELAY, description: d.description },
    evidence: { trigger: ask.trigger, claim, parcel, promisedDate: d.promised, daysLate: d.daysLate, lastScanAt: scanIso, lastScanText, fellBackFromDispute: false } } };
}

/**
 * The delay ticket's own guards, judged by Delhivery's live state and promised date and NOT by our order status. Reuses the night job's verdict with our status and NDR
 * fields neutralised: the night job drops every `undelivered` order, which left a parcel Delhivery shows In Transit with nothing acting on it.
 */
function delay(order: TicketOrder, track: TrackFacts & { statusCode?: string }, ctx: TicketCtx, scanIso: string | null):
  { ok: true; description: string; promised: string | null; daysLate: number } | { ok: false; reason: string; to: "person" | "wait" | "none" } {
  const v = evaluateDelhiveryCandidate(
    { id: order.id, awb: String(order.awb), status: null, ndrReason: null, pendingCourierEdit: order.pendingCourierEdit ?? null },
    track,
    { openTicketAwbs: new Set(), activeRequestAwbs: new Set(), unverifiedNdrOrderIds: new Set(), ndrCodes: ctx.ndrCodes, maxedCodes: ctx.maxedCodes },
    ctx.now,
  );
  if (!v.ok) {
    const to = /not breached|has not passed|out for delivery|on hold/i.test(v.why) ? "wait" : /delivered|rto|cancelled/i.test(v.why) ? "none" : "person";
    return { ok: false, reason: v.why, to };
  }
  const description = delayDescription({ promised: v.promisedDate, lastCode: track.statusCode || null, lastOn: dayLabel(scanIso ? istDate(Date.parse(scanIso)) : null) });
  return { ok: true, description, promised: v.promisedDate, daysLate: v.daysLate };
}
