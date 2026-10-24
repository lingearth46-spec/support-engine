export type OrderStatus =
  | "processing"
  | "call_1"
  | "call_2"
  | "on_hold"
  | "confirmed"
  | "packed"
  | "manifested"
  | "shipped"
  | "undelivered"
  | "delivered"
  | "rto"
  | "returned"
  | "cancelled"
  /**
   * The customer replied "no" to the WhatsApp confirmation.
   *
   * Kept apart from `cancelled` on purpose. Cancelled is our decision — a
   * refund, a duplicate, an order we could not fulfil. This is the customer's,
   * arrived at in one tap, and it deserves to be reviewed before it is treated
   * as final: a reply of "2" may be a change of mind, a wrong number, or a
   * misread. Filing it under cancelled would bury it among orders nobody needs
   * to look at again, and make the effect of the confirmation message
   * impossible to measure separately.
   */
  | "wa_cancelled";

/**
 * How an approved return is settled.
 *
 * - `pickup`:      we collect the item, then refund.
 * - `keep_item`:   reverse logistics on a low-value piece can cost more than the
 *                   piece, so we refund and let the customer keep it. No pickup must
 *                   ever then be promised or arranged.
 * - `replacement`: we send another of the same piece and do **not** collect the
 *                   original, which is the shape this actually takes in practice.
 *                   Same arithmetic as keep_item: recovering a ₹499 bracelet
 *                   costs more in reverse freight than the bracelet is worth, so
 *                   the faulty one stays with the customer. The one outcome that
 *                   ends in a parcel going out rather than money going back, so
 *                   nothing in this flow may promise a refund *or* a pickup for
 *                   it. A customer told to keep a parcel ready will wait in for
 *                   a courier who is never booked. It was being done anyway,
 *                   off-system, by telling people on WhatsApp to ask for one,
 *                   which left no record that a replacement was owed and no way
 *                   to count how many there were.
 *
 *                   The rare case where the original genuinely must come back is
 *                   a `pickup` plus a note; it is not worth a fifth option for
 *                   how seldom it happens.
 * - `silent`:      settled outside the system (already handled on WhatsApp or by
 *                   phone). Recorded here, but the customer is sent no email.
 *
 * Absent on older rows, which all predate the choice and were all pickups.
 */
export type ReturnResolution = "pickup" | "keep_item" | "replacement" | "silent";

/**
 * The collection leg of an approved return.
 *
 * `confirmed` is the only status that means a rider is coming. The other two
 * are both "a person still has to book this", kept apart so the panel can say
 * which kind of problem it is: `manual_required` is the integration being off,
 * `failed` is the courier refusing this particular parcel.
 */
export interface ReturnPickupShipment {
  status: "confirmed" | "manual_required" | "failed";
  courier?: string;
  /** Shadowfax's client_request_id. A reverse request has no AWB when it is
   *  created — the forward leg's awb_code has no counterpart here. */
  request_id?: string;
  /** Set only if one is assigned later. Never present at booking. */
  awb?: string;
  tracking_url?: string;
  booked_at?: string;
  attempted_at?: string;
  error?: string;
  /** What set it off: the ₹99 landing, the approval, or someone pressing the button. */
  trigger?: "pickup_paid" | "approval" | "manual";
  /** Where the collection has got to, kept current by the return-pickup-tracking
   *  cron. Absent until the first run after booking. */
  tracking?: import("@engine/returnTracking").PickupTracking;
}

export interface ReturnRequest {
  status: "pending" | "approved" | "rejected";
  /** Only meaningful once approved. */
  resolution?: ReturnResolution;
  reason: string;
  details?: string;
  /** Which of the order's items are coming back. Absent on requests raised
   *  before /returns/start, which meant the whole order. */
  item_indexes?: number[];
  /** The pickup charge the customer was quoted at submission, frozen. */
  pickup_fee?: number;
  /** Whether the reason calls for the unboxing video (damaged, wrong item). */
  video_required?: boolean;
  /** Which door it came in by: "web_returns" for /returns/start. */
  source?: string;
  /** Set once a pickup-charge link is issued, and updated when it is paid. */
  pickup_payment?: { status: "pending" | "paid"; url?: string; token?: string; paid_at?: string | null; last_sent_at?: string };
  /** The reverse parcel, once booking has been ATTEMPTED. A `failed` or
   *  `manual_required` status is recorded rather than left absent, because an
   *  absent field reads identically to "not tried yet" — and the difference
   *  between those two is a customer waiting at home for a rider who was never
   *  sent. See lib/returnPickup.ts. */
  pickup_shipment?: ReturnPickupShipment;
  /** Object paths into the private return-photos bucket, not URLs — sign one
   *  to view it (see app/api/admin/returns/photo-urls). At least one is
   *  required at submission (supabase-migration-return-photos.sql); absent
   *  only on requests raised before that requirement existed. */
  photo_paths?: string[];
  submitted_at: string;
  resolved_at?: string;
  admin_note?: string;
  /**
   * The free order raised to settle a `replacement`, set when the approval
   * created one. Absent on every other resolution, and on replacements approved
   * before the panel started creating the parcel itself.
   */
  replacement_order_id?: string;
  /**
   * Set when this is an EXCHANGE: the item is collected and something else is
   * sent in its place, with no refund.
   *
   * The resolutions cannot say this on their own. `pickup` collects but opens a
   * refund and messages the customer that money is coming; `replacement` sends a
   * parcel but books no collection. An exchange needs the collection of the
   * first and the no-refund of the second, so it is recorded as a pickup with
   * this marker, written directly rather than through the approve action — which
   * would open the refund and send that message. Money on an exchange (a
   * shipping fee, a price difference) is collected by support staff, not here.
   */
  exchange_for?: string;
  /**
   * The exact lines the replacement is built from, checked against the
   * catalogue when the exchange was created (lib/exchange.ts). Absent on
   * exchanges recorded before the panel could create them — those pick the
   * item at the QC step instead.
   */
  exchange_items?: OrderItem[];
  /**
   * The item physically reached us and was inspected. A pass on an exchange is
   * what creates the replacement order; a fail stops it for a person to decide.
   * Set by app/api/admin/returns/exchange, never by a courier scan — "Returned
   * To Client" means the parcel arrived, not that what is inside is fine.
   */
  received?: { at: string; qc: "pass" | "fail"; note?: string };
  /** Customer WhatsApp messages already sent for this return, by key — so the
   *  poll and the courier webhooks never send the same one twice. lib/returnNotify.ts */
  notified?: string[];
  /** The customer tapped "Try again tomorrow" on a missed-pickup message. */
  pickup_retry_requested_at?: string;
}

/**
 * Statuses that mean no parcel exists yet. An AWB proves one does, so an order in
 * any of these must move to "manifested" the moment it gets one — otherwise a
 * booked parcel sits in the Confirmed queue and gets booked a second time.
 *
 * Anything past manifested (shipped, delivered, rto, returned) is further along
 * and must never be dragged backwards; cancelled orders stay cancelled.
 */
const PRE_MANIFEST: OrderStatus[] = [
  "processing", "call_1", "call_2", "on_hold", "confirmed", "packed",
];

/**
 * Either kind of cancellation — ours, or the customer's own on WhatsApp.
 *
 * The two are separate statuses so the admin can tell them apart and review the
 * customer's, but to everyone outside the panel they are the same thing: the
 * order is not coming. Anywhere that asks "is this order dead" should ask here
 * rather than compare against "cancelled" alone.
 */
export function isCancelled(status: OrderStatus | string | null | undefined): boolean {
  return status === "cancelled" || status === "wa_cancelled";
}

/**
 * How long a customer gets to answer the confirmation message before we act on
 * their order without them. Matches the cron that moves silent orders into the
 * call queue.
 */
export const CONFIRM_WINDOW_HOURS = 12;

/** Hours since the confirmation message went out, or null if it never did. */
export function hoursSinceAsk(o: { confirm_wa_sent_at?: string | null }): number | null {
  if (!o.confirm_wa_sent_at) return null;
  const at = Date.parse(o.confirm_wa_sent_at);
  return Number.isFinite(at) ? (Date.now() - at) / 3_600_000 : null;
}

/** Hours still owed to the customer, or 0 once the window has run out. */
export function hoursLeftInWindow(o: { confirm_wa_sent_at?: string | null }): number {
  const since = hoursSinceAsk(o);
  return since === null ? 0 : Math.max(0, CONFIRM_WINDOW_HOURS - since);
}

/**
 * Is this order safe to hand to a courier?
 *
 * The distinction the booking run turns on. A customer who tapped Yes has
 * answered, so their order is ready the moment they do — waiting the full twelve
 * hours would only delay the orders least likely to come back. Prepaid is
 * already paid for, and an order auto-confirmed at twenty-four hours has by
 * definition outlived the window.
 *
 * What is left is the case this exists for: an order an admin confirmed by hand
 * while the customer still had hours left to reply. That is the one that skips
 * the wait, and it is indistinguishable on screen from a real confirmation
 * unless something says so.
 */
export function isReadyToBook(o: {
  confirm_wa_sent_at?: string | null;
  confirm_source?: string | null;
}): boolean {
  // Never asked — an order placed before the confirmation flow existed, or a
  // channel that does not ask. Nothing to wait for.
  if (!o.confirm_wa_sent_at) return true;
  if (o.confirm_source === "whatsapp" || o.confirm_source === "auto_prepaid" || o.confirm_source === "auto_timeout") {
    return true;
  }
  return hoursLeftInWindow(o) === 0;
}

/**
 * An order the confirmation cron can never move on its own.
 *
 * Both of its steps — twelve hours to the call queue, twenty-four to
 * auto-confirmed — find orders by the timestamp of the confirmation message. An
 * order that never got one has no such timestamp, so it matches neither query
 * and waits in Awaiting Reply for a customer reply to a message that was never
 * sent. Nothing is wrong with the order; it is simply invisible to the only
 * thing that would advance it.
 *
 * Rare, and worth catching precisely because it is rare: the standing
 * instruction is not to touch this queue, which is exactly what leaves one of
 * these sitting there indefinitely.
 */
export function isStrandedWithoutAsk(o: {
  status?: OrderStatus | string | null;
  confirm_wa_sent_at?: string | null;
}): boolean {
  return (o.status === "processing" || o.status === "call_1") && !o.confirm_wa_sent_at;
}

/** The status an order should take when an AWB lands on it, or null to leave it alone. */
export function statusOnAwbAssigned(current: OrderStatus | null | undefined): OrderStatus | null {
  return current && PRE_MANIFEST.includes(current) ? "manifested" : null;
}

export interface OrderItem {
  id: string;
  name: string;
  category: string;
  color: string;
  size: string;
  quantity: number;
  price: number;
  image?: string;
  sku?: string;
}

export interface Order {
  id: string;
  date?: string;
  created_at?: string;
  updated_at?: string;
  admin_notes?: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotal: number;
  /** Codes and credits taken off after the automatic offers. Never an offer: see lib/orderOffers.ts. */
  discount: number;
  /** What the automatic offers (B1G1 and friends) took off. `subtotal` is already net of it. */
  offer_discount?: number;
  /** The offers, itemised: [{ kind, label, amount }]. */
  offers?: { kind: string; label: string; amount: number }[];
  shipping: number;
  /**
   * Razorpay's COD handling fee, in rupees. 0 on prepaid orders and on every COD
   * order placed before the fee existed. Kept apart from `shipping` because
   * `shipping_method` is derived from that field — a fee folded in there would
   * book a Standard parcel as Express.
   */
  cod_fee?: number;
  total: number;
  address: {
    name: string;
    email?: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    pincode: string;
    phone: string;
    /**
     * Razorpay holds two numbers: the one attached to the delivery address and
     * the OTP-verified one the customer logged in with. They disagree on roughly
     * one order in ten. We used to keep whichever the code path happened to pick
     * and silently drop the other, which left support calling a number the
     * customer never answers — the likeliest way an order turns into an RTO.
     * Both are kept now; `phone` is the delivery contact, this is the other one.
     */
    altPhone?: string;
  };
  coupon?: string;
  estimatedDelivery?: string;
  estimated_delivery?: string;
  payment_id?: string;
  /** When the order was marked delivered. The return window is measured from this. */
  delivered_at?: string | null;
  /**
   * When the parcel was handed to a courier.
   *
   * The start of transit, and the only fair place to measure a courier from:
   * between created_at and this sits our confirmation queue, and timing partners
   * from the order date ranks them on how long we took to phone the customer.
   * Set on about 69% of delivered orders, so anything computed from it is a
   * sample rather than a census.
   */
  manifested_at?: string | null;
  /** Customer paid for gift wrapping — the parcel must be wrapped before dispatch. */
  gift_wrap?: boolean;
  /** standard | express — chosen on the cart, since Magic Checkout renders only one delivery option. */
  shipping_method?: string;
  user_id?: string;
  awb_code?: string;
  courier_name?: string;
  tracking_url?: string;
  shiprocket_order_id?: string;
  shiprocket_shipment_id?: string;
  /** When the shipping label was last downloaded. Null means never printed. */
  label_printed_at?: string;
  /** Partial COD: captured online before dispatch. Null on ordinary orders. */
  amount_paid_online?: number;
  /** Partial COD: what the rider collects, including the COD fee. */
  cod_due?: number;
  return_request?: ReturnRequest;

  // ── RTO risk and confirmation ──────────────────────────────────────────────
  // Written by the courier-report import and the admin panel. See
  // supabase-migration-rto-risk.sql for why each one is kept.

  /** Failed delivery attempts. 1 → 12% RTO, 2 → 30%, 3 → 67% in our own data. */
  attempt_count?: number;
  /** The courier's words for the last failed attempt. */
  ndr_reason?: string;
  /** The courier's words for why the parcel turned around. */
  rto_reason?: string;
  /**
   * The courier says the rider reached the customer and was refused. Null means
   * unknown, which is most parcels — never read it as false.
   */
  otp_refused?: boolean | null;
  /** Shiprocket's pre-dispatch grade: low / high / very-high. */
  courier_rto_risk?: string;

  /** Attempts to reach the customer, by any route. */
  confirm_attempts?: number;
  last_called_at?: string | null;
  last_wa_at?: string | null;
  confirmed_at?: string | null;
  /** When the confirm-or-cancel message went out — the clock the 12h window runs on. */
  confirm_wa_sent_at?: string | null;
  /** whatsapp | call | auto_prepaid | auto_timeout | admin */
  confirm_source?: string | null;
  /** The customer's most recent answer, verbatim. */
  confirm_reply?: string | null;
  /**
   * Every answer, oldest first. confirm_reply is overwritten each time, so a
   * customer who taps No and then Yes leaves no trace in it — this is where the
   * change of mind survives.
   */
  confirm_replies?: ConfirmReply[] | null;

  /** low | medium | high — as judged at checkout. */
  risk_tier?: string | null;
  /** Why that tier, in words an admin can act on. */
  risk_reasons?: string[] | null;

  // ── Ticket queue ─────────────────────────────────────────────────────────────
  // Read and written throughout the admin orders page (courier-overdue escalation,
  // /admin/tickets) but never declared here until this comment — every use before
  // it relied on Order structurally accepting extra properties rather than TS
  // actually knowing they exist. See lib/tickets.ts for the source of truth on
  // TicketState/TicketPriority.
  ticket_status?: "open" | "escalated" | "closed" | null;
  ticket_priority?: "high" | "medium" | "low" | null;
  /** What was last done about it, in the operator's words. */
  ticket_action?: string | null;
  /** When that was — the age of the action says whether it is being worked or
   *  has stalled, not the age of the ticket itself. */
  ticket_action_at?: string | null;
  ticket_closed_at?: string | null;
}

/** One inbound WhatsApp answer to the confirm-or-cancel message. */
export type ConfirmReply = {
  at: string;
  text: string;
  /** How the reply parser read it. */
  intent: "confirm" | "cancel" | "unclear";
  /** True when they tapped a quick-reply button rather than typing. */
  tapped: boolean;
};

/**
 * Did they say no and then yes, or yes and then no?
 *
 * Worth surfacing on its own: a COD customer who wavered before the parcel was
 * even packed is the same customer who refuses it at the door, which is the
 * cause behind 81% of our RTOs.
 */
export function changedTheirMind(replies?: ConfirmReply[] | null): boolean {
  const decisions = (replies ?? []).filter((r) => r.intent !== "unclear");
  return decisions.some((r, i) => i > 0 && r.intent !== decisions[i - 1].intent);
}

export const statusConfig: Record<OrderStatus, { label: string; adminLabel: string; color: string; bg: string; step: number }> = {
  // ── Customer-visible statuses ────────────────────────────────────────────────
  // "Processing" read to the admin as a queue awaiting their action, so it got
  // cleared — which confirmed orders by hand while the customer still had hours
  // left to reply, defeating the whole point of asking. It is not a to-do list;
  // it is a waiting room, and the name now says so.
  processing:    { label: "Processing",  adminLabel: "Awaiting Reply", color: "text-amber-700",  bg: "bg-amber-50 border-amber-200",    step: 1 },
  confirmed:     { label: "Confirmed",   adminLabel: "Confirmed",     color: "text-blue-700",    bg: "bg-blue-50 border-blue-200",      step: 2 },
  shipped:       { label: "Shipped",     adminLabel: "Shipped",       color: "text-violet-700",  bg: "bg-violet-50 border-violet-200",  step: 3 },
  delivered:     { label: "Delivered",   adminLabel: "Delivered",     color: "text-green-700",   bg: "bg-green-50 border-green-200",    step: 4 },
  cancelled:     { label: "Cancelled",   adminLabel: "Cancelled",     color: "text-red-700",     bg: "bg-red-50 border-red-200",        step: 0 },
  // The customer sees "Cancelled" — from their side it is, they asked for it.
  // Only the admin label distinguishes where the decision came from.
  wa_cancelled:  { label: "Cancelled",   adminLabel: "WA Cancelled",  color: "text-pink-700",    bg: "bg-pink-50 border-pink-200",      step: 0 },
  rto:           { label: "Returning",   adminLabel: "RTO",           color: "text-orange-700",  bg: "bg-orange-50 border-orange-200",  step: 0 },
  returned:      { label: "Returned",    adminLabel: "Returned",      color: "text-rose-700",    bg: "bg-rose-50 border-rose-200",      step: 0 },
  // ── Internal ops statuses (customers see "Processing") ───────────────────────
  // Where an order lands once its window has run out with no answer. Its name
  // is the instruction: these are the ones to ring.
  call_1:        { label: "Processing",  adminLabel: "Call Queue",    color: "text-teal-700",    bg: "bg-teal-50 border-teal-200",      step: 1 },
  // call_2 and on_hold are retired — never used once between them, and a tab
  // that is always empty is a tab you learn to stop reading. Kept in the type so
  // any historical row still renders, but no longer offered as a queue.
  call_2:        { label: "Processing",  adminLabel: "Call #2",       color: "text-sky-700",     bg: "bg-sky-50 border-sky-200",        step: 1 },
  on_hold:       { label: "Processing",  adminLabel: "On Hold",       color: "text-yellow-700",  bg: "bg-yellow-50 border-yellow-200",  step: 1 },
  packed:        { label: "Confirmed",   adminLabel: "Packed",        color: "text-purple-700",  bg: "bg-purple-50 border-purple-200",  step: 2 },
  manifested:    { label: "Confirmed",   adminLabel: "Manifested",    color: "text-indigo-700",  bg: "bg-indigo-50 border-indigo-200",  step: 2 },
  // A courier tried to deliver and failed — almost always an unanswered phone.
  // It is a call queue, not a customer-facing state: the parcel is still out, so
  // the customer sees "Shipped" while we chase it before it turns into an RTO.
  undelivered:   { label: "Shipped",     adminLabel: "Undelivered",   color: "text-orange-700",  bg: "bg-orange-50 border-orange-200",  step: 3 },
};

/**
 * How far along an order is. A courier report may arrive late or out of order, so
 * an imported status is only applied when it moves the order *forward* — a stale
 * "in transit" row must never drag a delivered order backwards.
 *
 * `delivered` and `rto` share a rank: they are mutually exclusive endings, and
 * neither may overwrite the other. `cancelled` and `returned` are human decisions
 * and are never touched by an import at all.
 */
export const STATUS_RANK: Record<OrderStatus, number> = {
  processing: 0, call_1: 0, call_2: 0, on_hold: 0,
  confirmed: 1,
  packed: 2, manifested: 2,
  shipped: 3,
  undelivered: 4,
  delivered: 5, rto: 5,
  // Sharing the top rank with cancelled is what stops a courier report reviving
  // one: an import only moves an order forward, and nothing outranks 6.
  returned: 6, cancelled: 6, wa_cancelled: 6,
};

/**
 * A date as "5 Sep 2026" for the admin order read-outs — the courier line's
 * delivered/due/placed stamp, the ticket history list, the shared
 * CustomerOrderPanel.
 *
 * Client-only. `toLocaleDateString` ships different ICU data in Node and the
 * browser ("Sept" vs "Sep"), so a value formatted during SSR and hydrated in
 * the browser is a mismatch — the same trap deliveryEstimate.test.ts guards
 * against. Every caller renders this after a client-side fetch, never on the
 * server; keep it that way rather than reaching for a fixed month table.
 */
export function formatOrderDate(iso: string | null | undefined): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
