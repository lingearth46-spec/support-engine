// Pure mappers from what a courier says to the values courier_tickets stores. No IO.
//
// The parcel state comes from the courier's live tracking, never from the ticket's text.
// Order matters in each function: a returned parcel must not read as "delivered" just because
// the courier's word for it contains "deliver", and a customer-side stop is not a courier delay.

export type ParcelState = "delivered" | "rto" | "cancelled" | "out_for_delivery" | "in_transit" | "customer_side" | "on_hold" | "unknown";
export type TicketState = "open" | "replied" | "resolved" | "closed" | "vanished";

export interface DelhiveryTrackIn { status?: string; statusType?: string; statusCode?: string; instructions?: string }
export interface ShadowfaxTrackIn { status?: string; statusDisplay?: string; remark?: string }

const lower = (s: unknown) => String(s ?? "").toLowerCase();

export function parcelStateFromDelhivery(t: DelhiveryTrackIn | null, ndrCodes: ReadonlySet<string> = new Set()): ParcelState {
  if (!t) return "unknown";
  const status = lower(t.status), type = lower(t.statusType), text = `${status} ${lower(t.instructions)}`;
  if (type === "rt" || /\brto\b|return(ed)? to (origin|shipper|seller)|returned/.test(text)) return "rto";
  if (type === "dl" || status === "delivered") return "delivered";
  if (/cancel/.test(status)) return "cancelled";
  if (/consignee to collect|collect from (branch|facility)/.test(text)) return "customer_side";
  if (t.statusCode && ndrCodes.has(t.statusCode)) return "customer_side";
  if (/out for delivery|dispatched/.test(status)) return "out_for_delivery";
  if (/hold/.test(status)) return "on_hold";
  return "in_transit";
}

export function parcelStateFromShadowfax(t: ShadowfaxTrackIn | null): ParcelState {
  if (!t) return "unknown";
  const s = lower(t.status);
  if (/^(rts|rto)|return/.test(s)) return "rto";
  if (s === "delivered" || /^delivered/.test(s)) return "delivered";
  if (/cancel/.test(s)) return "cancelled";
  if (/^(nc|na|cid)$|not_contactable|customer_not|refused|reschedule/.test(s)) return "customer_side";
  if (/out_for_delivery|ofd|picked_up_for_delivery/.test(s)) return "out_for_delivery";
  if (/hold/.test(s)) return "on_hold";
  return "in_transit";
}

/** The courier's own status word → our ticket state. `hasReply` is whether the courier wrote back. */
export function ticketStateFromStatus(status: string | null | undefined, hasReply: boolean): TicketState {
  const s = lower(status);
  if (/resolv/.test(s)) return "resolved";
  if (/clos|reject|cancel/.test(s)) return "closed";
  return hasReply ? "replied" : "open";
}

/** Whole days with nothing new → stall level: 0 none, 1 flag (3 d), 2 escalate (6 d), 3 hand to a person (9 d). */
export function stallLevelFor(daysQuiet: number, ticketState: TicketState): 0 | 1 | 2 | 3 {
  if (ticketState === "resolved" || ticketState === "closed" || ticketState === "vanished") return 0;
  return daysQuiet >= 9 ? 3 : daysQuiet >= 6 ? 2 : daysQuiet >= 3 ? 1 : 0;
}
