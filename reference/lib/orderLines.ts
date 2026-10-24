// The per-order text the support model reads, and the shape/columns it is built
// from.
//
// Extracted verbatim from lib/waSupport.ts. That module builds a Sanity client
// at import time (productContext.ts, no projectId) and throws, so nothing that
// imports it can be unit-tested — which is why the Batch 2 P0 changes to
// formatOrders (the typed-id ₹total/items leak, and the day-2 OVERDUE
// threshold) shipped with no test covering them. Everything formatOrders needs
// is pure (returnPolicy, supportActions, parcelScan, orders — none reach
// Supabase or Sanity), so the function moves here where a test can reach it.
// lib/waSupport.ts re-exports formatOrders / ORDER_COLUMNS / OrderRow unchanged.
//
// Pure module: import nothing that touches the network at import time.

import { daysLeftToReturn, RETURN_WINDOW_DAYS } from "@/lib/returnPolicy";
import { cancellationAllowedInWindow } from "@/lib/supportActions";
import { scanContextLine, lateParcelVerdict } from "@/lib/parcelScan";
import type { OrderStatus, ReturnRequest } from "@/lib/orders";
// Type-only: lib/refunds.ts imports the Razorpay SDK at module load, so a value
// import would break this module's "import nothing that touches the network"
// rule. `import type` is fully elided (isolatedModules), so the enum name comes
// across with no runtime dependency.
import type { RefundStatus } from "@/lib/refunds";

export type OrderRow = {
  id: string; status: string; total: number | null; created_at: string;
  delivered_at?: string | null; estimated_delivery?: string | null;
  awb_code?: string | null; courier_name?: string | null; tracking_url?: string | null;
  shipping_method?: string | null;
  /**
   * Payment shape. `payment_id === "COD"` is the COD marker (not a separate
   * column — CLAUDE.md invariant); a real Razorpay id means prepaid;
   * amount_paid_online AND cod_due both > 0 is partial COD. Surfaced because the
   * bot could not otherwise pick the right refuse-at-door refund line — the KB
   * carries both (COD refuse: nothing lost; prepaid refuse: refunded minus
   * shipping) and the bot had no way to tell which order it was looking at.
   */
  payment_id?: string | null;
  amount_paid_online?: number | null;
  cod_due?: number | null;
  cod_fee?: number | null;
  /** Money breakdown, shown only on a billing-shaped message (showMoney). */
  subtotal?: number | null;
  discount?: number | null;
  /** What the automatic offers took off; `subtotal` is already net of it (lib/orderOffers.ts). */
  offer_discount?: number | null;
  shipping?: number | null;
  /** A boolean, not a rupee column — gift wrap adds ~₹30 to `total` but to no
   *  other column (supabase-migration-gift-wrap.sql), so it renders as a note
   *  without a figure. */
  gift_wrap?: boolean | null;
  coupon?: string | null;
  /** RTO-risk signals (supabase-migration-rto-risk.sql). Read-only here — the
   *  delivery-failure line just reads them back, never writes. */
  attempt_count?: number | null;
  ndr_reason?: string | null;
  rto_reason?: string | null;
  items?: Array<{ name?: string; quantity?: number; size?: string; color?: string }> | null;
  address?: {
    phone?: string; altPhone?: string; name?: string;
    line1?: string; line2?: string; city?: string; state?: string; pincode?: string;
  } | null;
  /**
   * Whether a return has already been asked for on this order, and what was
   * decided. The window alone was not enough: the bot could see that a return
   * was still allowed and had no idea one had already been raised and refused,
   * so a customer arguing a rejection read as a brand-new request every time
   * and was escalated again on each message. The decision itself is announced
   * to the customer by template the moment it is made, so the bot never breaks
   * this news — it only needs to know not to reopen it.
   */
  return_request?: ReturnRequest | null;
  /** Latest granular courier scan, denormalised onto the order by
   *  lib/parcelScan.ts recordScan — the hub, the wording, the time. Absent
   *  until supabase-migration-parcel-scans.sql is run; ordersByPhone falls back
   *  to the base column set if the select rejects them. */
  courier_status?: string | null;
  courier_status_detail?: string | null;
  courier_status_location?: string | null;
  courier_status_at?: string | null;
};

// Batch 3b — order-lifecycle visibility. payment_id/amount_paid_online/cod_due
// drive the payment fact; subtotal/discount/shipping/gift_wrap/cod_fee/coupon the
// money breakdown; attempt_count/ndr_reason/rto_reason the delivery-failure line.
// All verified present on prod orders (introspected 2026-09-03). Kept a single
// string literal, not a concatenation: Supabase's .select() types off the literal
// and widening it to `string` breaks every `data as OrderRow[]` cast downstream.
/**
 * What the customer can be told about the collection on an approved return.
 *
 * Facts only, and only the ones that are theirs to know: which courier is
 * coming and its reference, or that a charge is still owed. A failed booking is
 * deliberately NOT described — "Shadowfax rejected this pickup" is an internal
 * problem, and a customer told that would reasonably ask us to fix something
 * they cannot act on. It reads as "not booked yet", which is true, and the
 * panel alerts a person separately.
 */
function pickupFacts(rr: NonNullable<OrderRow["return_request"]>): string {
  if (rr.resolution && rr.resolution !== "pickup") return "";
  const parts: string[] = [];

  const pay = rr.pickup_payment;
  const fee = typeof rr.pickup_fee === "number" ? rr.pickup_fee : 0;
  // Say FREE out loud. Stating only a non-zero charge left "do I have to pay
  // for the pickup?" unanswerable on a free return — the bot could see a fee
  // rule it could not apply, so it escalated a question it had the answer to.
  if (fee === 0) {
    parts.push("this pickup is FREE, there is nothing for them to pay");
  }
  if (fee > 0) {
    parts.push(
      pay?.status === "paid"
        ? `the ₹${fee} pickup charge is PAID`
        : `the ₹${fee} pickup charge is NOT yet paid — the collection is only booked once it is, and they can pay it at` +
          ` www.ajuki.in/returns/start with their order number and phone number${pay?.url ? ` or the link already sent` : ""}`,
    );
  }

  const ship = rr.pickup_shipment;
  if (ship?.status === "confirmed" && ship.request_id) {
    // The COLLECTION's own link, and only when there is a real one.
    //
    // A Delhivery reverse returns a genuine waybill that their public tracker
    // serves. Shadowfax reverse has no AWB at creation, so it gets no link
    // rather than a fabricated one.
    //
    // The warning is load-bearing: the first live run had the bot answer with
    // the order's FORWARD tracking_url — the original delivery, which reads
    // "Delivered" — while quoting the reverse reference beside it. Two numbers
    // exist on this order now and only one of them is the pickup.
    const url = ship.courier === "Delhivery" && /^\d{10,}$/.test(ship.request_id)
      ? `https://www.delhivery.com/track/package/${ship.request_id}`
      : null;
    parts.push(
      `pickup BOOKED with ${ship.courier ?? "our courier"}, reference ${ship.request_id}` +
        `${ship.booked_at ? ` on ${day(ship.booked_at)}` : ""} — tell them it is scheduled and to keep the item in its` +
        ` original packaging; the courier contacts them to collect` +
        `${url ? `. Track the COLLECTION at ${url}` : ""}` +
        `. The order's own delivery tracking link is a DIFFERENT parcel (the one already delivered) — never give that one` +
        ` for the pickup`,
    );
  } else if (fee === 0 || pay?.status === "paid") {
    parts.push("pickup not booked yet — say it is being arranged, give no date");
  }
  // Where the returned parcel is, so a refund question can be answered from it (12 Oct review: "has the returned parcel reached our warehouse?").
  // A refund for a returned item starts only once it is back, so "not received yet" is the honest answer until the stage says delivered.
  const stage = ship?.tracking?.stage;
  if (stage || rr.received) {
    parts.push(rr.received || stage === "delivered"
      ? "the RETURNED PARCEL HAS REACHED our warehouse"
      : stage === "cancelled" || stage === "exception"
        ? "the return pickup has a problem (the team is on it) — say the returned parcel has not reached us"
        : "the RETURNED PARCEL HAS NOT REACHED our warehouse yet (the courier has it or has not collected it) — a refund for the return starts only after it arrives; give no date");
  }

  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

export const ORDER_COLUMNS = "id, status, total, created_at, delivered_at, estimated_delivery, awb_code, courier_name, tracking_url, shipping_method, items, address, return_request, payment_id, amount_paid_online, cod_due, cod_fee, subtotal, discount, offer_discount, shipping, gift_wrap, coupon, attempt_count, ndr_reason, rto_reason";
export const ORDER_COLUMNS_WITH_SCAN =
  `${ORDER_COLUMNS}, courier_status, courier_status_detail, courier_status_location, courier_status_at`;

/**
 * One order's refund state, as refundsByOrder (lib/waSupport.ts) resolves it
 * from the `refunds` table. Passed into formatOrders only when the message looks
 * like a return / refund / cancellation, and rendered on own-phone lines only —
 * a refund figure is as sensitive as the order's value.
 */
export type RefundLine = { status: RefundStatus; amount: number; since: string; processedAt: string | null };

export const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

/**
 * One compact line per order for the model to answer from.
 *
 * `withAddress` is only ever true for orders matched to the sender's own phone
 * number. "Which address is this going to?" is one of the most common questions
 * asked during confirmation — one customer asked three times — and it cannot be
 * answered without the address. But an order found by a typed order id belongs
 * to whoever typed the id, which is not proof it is theirs, so those lines stay
 * address-free: a guessed order number must never reveal where someone lives.
 *
 * Delivery dates and the return window are computed here, not left to the model:
 * "was it delivered", "when did I order", and "am I still in the return window"
 * are the questions behind most return requests, and date arithmetic is exactly
 * what a language model gets confidently wrong. daysLeftToReturn is the same
 * function the returns form enforces, so the bot can never disagree with the
 * site about whether a window is open.
 *
 * `showReturnWindow` defaults to false on purpose: the return-window fact is
 * only worth the leak risk (see the comment at its call site below) when the
 * incoming message actually looks like a return, so every caller must decide
 * rather than getting it by accident.
 *
 * `showMoney` is its sibling: the per-line money breakdown (subtotal / discount
 * / shipping / total) is only shown on a billing-shaped message, for the same
 * reason — an itemised bill volunteered to someone who did not ask about money
 * is noise the model can trip over.
 *
 * `refunds` (own-phone lines only) carries the refund-ledger state per order,
 * and is passed only when the message is about a return / refund / cancellation.
 * `replacementOf` maps a replacement parcel's id to the id of the order whose
 * return it settles, so that line can be prefixed "REPLACEMENT for #… ·".
 */
export function formatOrders(
  orders: OrderRow[],
  withAddress = false,
  showReturnWindow = false,
  showMoney = false,
  refunds?: Map<string, RefundLine>,
  replacementOf?: Map<string, string>,
): string {
  const seen = new Set<string>();
  // Anyone with a return filed on ANY order never hears about the window, on any of their orders.
  const anyReturn = orders.some((o) => o.return_request);
  const rendered = orders
    .filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)))
    .slice(0, 6)
    .map((o) => {
      // Size and colour, because "you sent 3mm, I ordered 2mm" cannot be answered
      // without them. They sit on every order item and were simply never passed
      // on, so the bot told a customer their ordered size "is not specified in
      // the order details" while the row plainly read 2 mm.
      const items = (o.items ?? [])
        .map((i) => {
          const variant = [i.size, i.color].map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
          return `${i.name}${variant ? ` (${variant})` : ""}${(i.quantity ?? 1) > 1 ? ` x${i.quantity}` : ""}`;
        })
        .join(", ");
      // ₹total rides only on the own-phone path. Order ids are "AJUKI" + six
      // digits, guessable, and have twice been typed into WhatsApp by people who
      // were not that order's customer (AGENTS.md invariant) — so an order
      // matched by a typed id must not disclose its value any more than its
      // address. withAddress is already exactly "matched to the sender's own
      // number", so it doubles as the gate here.
      // A replacement parcel raised to settle an approved return. It is one of
      // the customer's own orders, folded into the own set by handleSupportMessage
      // — the prefix is what stops it reading as a mystery second order.
      const replacesParent = replacementOf?.get(o.id);
      let line = `${replacesParent ? `REPLACEMENT for #${replacesParent} · ` : ""}#${o.id} · ${o.status}${withAddress ? ` · ₹${o.total ?? 0}` : ""} · ordered ${day(o.created_at)} (${daysAgo(o.created_at)} days ago)`;
      // Whether they paid ₹99 for Express. Left out of this line until a customer
      // who had paid for it was told "I don't see any specific information about
      // an express delivery option" — the column was simply never selected, so
      // the bot denied something the order plainly said, to the one customer
      // guaranteed to know better.
      // No window quoted here on purpose — the expected date is already on this
      // line, and a second figure would only give the bot a chance to contradict
      // what the site told them.
      // No rupee figure: the upgrade costs ₹99 in the site's own checkout and
      // ₹35 in Magic Checkout, and this line cannot tell which one they used.
      // Naming a number here would state the wrong one to roughly half of them.
      if (o.shipping_method === "express") line += ` · EXPRESS delivery (they paid extra for it)`;
      // The same rule runAction actually enforces (lib/supportActions.ts's
      // cancellationAllowed), stated here as a fact rather than left for the
      // model to infer from a status word — "packed" and "confirmed" both
      // look ordinary in text but only one of them may already carry an AWB.
      // AI Integration stage: structural context in place of a guess, same
      // reasoning as the return-window line below.
      const cancellable = cancellationAllowedInWindow({ status: o.status as OrderStatus, awb_code: o.awb_code ?? undefined, created_at: o.created_at });
      line += cancellable.ok ? ` · can be cancelled by you directly` : ` · CANNOT be self-cancelled (${cancellable.reason === "booked" ? "already handed to the courier" : cancellable.reason === "too_old" ? "placed more than 24 hours ago, and orders can only be cancelled within 24 hours of placing them" : "already closed"})`;
      // Payment shape — always on an own-phone line, never gated on message
      // intent. Until this was surfaced the bot could not choose the right
      // refuse-at-door refund line: the KB says a COD refuse costs the customer
      // nothing while a prepaid refuse is refunded minus shipping, and nothing
      // in context told the model which one this order was. PARTIAL_COD is not
      // live and there is no COD fee today, but the partial branch is rendered
      // defensively (old rows, a future flip) and detected from the data —
      // amount_paid_online AND cod_due both positive — not from a flag.
      if (withAddress) {
        const paidOnline = o.amount_paid_online ?? 0;
        const codDue = o.cod_due ?? 0;
        if (paidOnline > 0 && codDue > 0) {
          line += ` · PARTIAL-COD, ₹${paidOnline} paid online + ₹${codDue} due on delivery`;
        } else if (o.payment_id === "COD") {
          line += ` · COD, ₹${o.cod_due ?? o.total ?? 0} due on delivery`;
        } else if (o.payment_id) {
          line += ` · PREPAID, ₹${o.amount_paid_online ?? o.total ?? 0} paid online`;
        }
      }
      // Money breakdown — only on a billing-shaped message (showMoney, the
      // sibling of showReturnWindow) and only on an own-phone line. gift_wrap is
      // a boolean, not a rupee column — it adds a flat ₹30 to `total` that
      // reconciles against no other column (supabase-migration-gift-wrap.sql),
      // so the ₹30 is written in here explicitly to keep the line adding up
      // (checkout's GIFT_WRAP_COST). cod_fee is 0 on every current order (no COD
      // fee live) — rendered only if a future flip makes it non-zero.
      if (withAddress && showMoney && o.subtotal != null) {
        const fee = o.cod_fee ? ` + COD fee ₹${o.cod_fee}` : "";
        const gw = o.gift_wrap ? " + gift wrap ₹30" : "";
        line += ` · subtotal ₹${o.subtotal}${Number(o.offer_discount) > 0 ? ` (after ₹${o.offer_discount} off from an automatic offer)` : ""} - discount ₹${o.discount ?? 0} + shipping ₹${o.shipping ?? 0}${fee}${gw} = ₹${o.total ?? 0}${o.coupon ? ` (coupon ${o.coupon})` : ""}`;
      }
      if (withAddress && o.address) {
        const a = o.address;
        const where = [a.line1, a.line2, a.city, a.state, a.pincode].map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
        if (where) line += ` · delivering to: ${where}`;
      }
      if (o.status === "delivered") {
        if (o.delivered_at) {
          line += ` · delivered ${day(o.delivered_at)} (${daysAgo(o.delivered_at)} days ago)`;
          // The window itself is still computed here unconditionally — see the
          // comment above this function — but whether the MODEL gets to see it
          // is gated on showReturnWindow. The persona already says never to
          // volunteer a return unasked, and mostly does not, but a corpus read
          // (22 Aug-1 Sept) found the fact leaking into replies to messages as
          // unrelated as "Amazing 🤌🏻❤️": once the line is in context, a small
          // model does not reliably withhold it just because it was told to.
          // Hiding it at the source when the message shows no sign of a
          // problem removes the temptation instead of relying on restraint.
          // Never once a return exists: the window is moot, and quoting "still open, 4 days"
          // to someone whose return was rejected reads as an invitation to re-file.
          if (showReturnWindow && !anyReturn) {
            const left = daysLeftToReturn(o.delivered_at);
            line += left !== null && left > 0
              ? ` · return window for defective/damaged items: OPEN, ${left} day${left === 1 ? "" : "s"} left`
              : ` · return window (${RETURN_WINDOW_DAYS} days from delivery): CLOSED`;
          }
        } else if (showReturnWindow && !anyReturn) {
          line += ` · delivered (date not on record, treat the return window as needing a human)`;
        }
      } else if (o.estimated_delivery && o.status !== "rto" && o.status !== "returned") {
        // Deliberately not for a parcel coming back. "OVERDUE by 5 days" on an
        // RTO reads as a late delivery still on its way, and the bot repeated it
        // to a customer whose parcel had already been refused and turned round.
        // A returned order is not late; it is finished.
        // A date that has already passed is not an estimate any more, and the
        // model will read one out as though it were: a parcel two days late was
        // answered with "expected around July 25th" on the 27th, which reads as
        // a bot that cannot see a calendar. Say it plainly instead — the model
        // is good at using a fact it is given and bad at deriving this one.
        const lateDays = Math.floor((Date.now() - Date.parse(o.estimated_delivery)) / 86_400_000);
        // Founder decision (Batch 2 P0): the customer-facing "OVERDUE / running
        // late" framing starts at day 2, not day 1. A parcel one day past the
        // estimate is within ordinary courier slippage, and "OVERDUE by 1 day"
        // trains customers to panic over what is usually noise — the estimate
        // was never a promise. Two days out, it is worth saying plainly.
        const overdue = lateDays >= 2;
        line += overdue
          ? ` · was due ${day(o.estimated_delivery)}, OVERDUE by ${lateDays} days`
          : lateDays >= 1
            ? ` · was expected around ${day(o.estimated_delivery)} and is running a little late (one day past; not overdue)`
            : ` · expected around ${day(o.estimated_delivery)}`;
        // Whether a late parcel still needs a person. Computed, not left to the
        // model: "is the last scan recent enough?" is date arithmetic, and
        // getting it wrong means either escalating every late parcel (what this
        // replaces) or reassuring someone whose parcel has stopped. The scan
        // wording itself is on the "last courier scan …" fragment below.
        //
        // The verdict runs from day 1 so a parcel that has genuinely stopped is
        // caught early — but on day 1 only a *concerning* verdict is surfaced.
        // A "moving" parcel one day out is just slow and the line stays a plain
        // estimate; a stuck / dark / failed-attempt one gets the hint even
        // before the OVERDUE wording kicks in.
        if (lateDays >= 1) {
          const verdict = lateParcelVerdict(o);
          if (overdue || verdict !== "moving") {
            line += verdict === "moving"
              ? " · STILL MOVING (courier scanned it recently) — answer from the scan below, do NOT escalate for lateness alone"
              : verdict === "attention"
                ? " · NEEDS ATTENTION (the recent scan below is a failed attempt / hold / address issue) — tell the customer what the courier said, then escalate"
                : verdict === "stuck"
                  ? " · STUCK (no courier scan in over 48h) — apologise and escalate"
                  : " · NO COURIER SCANS on record — apologise and escalate";
          }
        }
      }
      // The last thing the courier actually scanned — hub and wording — so the
      // bot can answer "where is it" with a fact instead of only a link. Null
      // for a delivered/returning parcel (handled elsewhere) or when no scan has
      // come in. It is a snapshot, not live GPS; scanContextLine says "3h ago"
      // so the model does not read a stale scan as the parcel's position now.
      const scanLine = scanContextLine(o);
      if (scanLine) line += ` · ${scanLine}`;
      // Delivery-failure detail — additive, and deliberately separate from the
      // RTO "ON ITS WAY BACK" block below (which is untouched). attempt_count
      // and ndr_reason are the courier's own record of a failed attempt; the
      // bot used to answer "a team member will look into it" when it could have
      // said what the courier actually noted. Own-phone only, same as the rest
      // of the Batch 3b facts.
      if (withAddress && (o.status === "undelivered" || o.status === "rto" || o.status === "returned" || (o.attempt_count ?? 0) > 0)) {
        // The count only when the courier actually recorded one. An empty attempt_count is "not known", and printing it as
        // "delivery attempt 0" next to "Customer not contactable" was repeated to customers as "delivery attempts so far: 0" (9 Oct).
        const attemptPart = (o.attempt_count ?? 0) > 0 ? `delivery attempt ${o.attempt_count}` : "";
        const notePart = o.ndr_reason ? `courier note: ${o.ndr_reason}` : "";
        const detail = [attemptPart, notePart].filter(Boolean).join(", ");
        if (detail) line += ` · ${detail}`;
        if (o.status === "rto" && o.rto_reason) line += ` · RTO reason: ${o.rto_reason}`;
      }
      // Whether a return has already been raised on this order, and what came of
      // it. Stated as a fact for the same reason the cancellable line above is:
      // the model cannot infer it, and without it a rejection has no terminal
      // state. The customer is told the outcome by template the moment it is
      // decided, so this is not news to break — it is the difference between
      // answering someone who is arguing a decision and escalating them again as
      // though they had just asked for the first time. Real threads read
      // "Customer asked for the reason for the return denial" and "Why no one is
      // contacting?" — both are this line missing.
      const rr = o.return_request;
      if (rr?.status === "pending") {
        line += ` · RETURN REQUEST ALREADY RAISED${rr.submitted_at ? ` on ${day(rr.submitted_at)}` : ""} and is with the team.` +
          // Reason and photo COUNT (never a path) — own-phone only. Lets the bot
          // answer "why is this taking so long / did my photos go through"
          // without re-escalating; real threads read "Customer asked for the
          // reason for the return denial" with the bot unable to see any of it.
          (withAddress && rr.reason ? ` · reason filed: "${rr.reason}"` : "") +
          (withAddress ? ` · ${rr.photo_paths?.length ?? 0} photo(s) attached` : "") +
          ` For ANY message about this return — status, how long, chasing, asking to cancel it or keep the item — reply with this` +
          ` wording and nothing else about the return: "Your return request is with our returns team. Please wait until they` +
          ` decide on it — they will update you here." Do not rephrase it, do not add promises (no \"prioritise\", no \"remind the` +
          ` team\"), do not give a timeline, and do NOT set needs_human or say you have forwarded anything to the team. Do NOT` +
          ` raise it again, and do NOT tell the customer to open Request Return or file a new one — the website removes that` +
          ` option once a return exists, so it is a dead end.`;
      } else if (rr?.status === "rejected") {
        // Deliberately no admin_note: the internal rejection note goes only to
        // the escalation Telegram ping, never the model.
        //
        // "please raise it again from Request Return" — a real reply the bot sent
        // a change-of-mind rejection (Vishnu, AJUKI710057, 3 Sept). It cannot be
        // followed: app/account/orders/[id] hides the Request Return button the
        // moment any return_request exists, so the customer hits a page with
        // nothing on it and comes back more confused. The reopen path is the
        // BOT escalating, never the customer re-filing.
        line += ` · RETURN REQUEST ALREADY REJECTED${rr.resolved_at ? ` on ${day(rr.resolved_at)}` : ""}, and the customer` +
          ` was told at the time by template. For ANY message about this return — why it was rejected, asking to reconsider,` +
          ` asking for an exchange instead, arguing, or saying they will send the item back — reply with this wording: "Your` +
          ` return request was reviewed and rejected${rr.resolved_at ? ` on ${day(rr.resolved_at)}` : ""}. If you would like to appeal, please email our Senior Support Team at` +
          ` ajukisupport@gmail.com with your order number and any photos or video showing the issue." Every reply in this state` +
          ` includes that email. An exchange request on a rejected return goes to the same email. Do not restate the reason it was` +
          ` rejected, do not argue it, do not say the return window is open, do not say the team will reconsider or that an appeal` +
          ` exists, and do NOT set needs_human or say you have forwarded anything to the team. NEVER tell the customer to open` +
          ` Request Return or raise a new return — the website removes that option once a return exists and they will come back` +
          ` confused. If the customer says they already emailed, or that the team has not replied to their email, or asks where` +
          ` the reply is, say exactly: "Our Senior Support Team is already working on your issue. Please wait for their reply." and do not tell them to email again.` +
          ` The only option you may mention is the appeal email; never mention a refund, replacement or exchange as something they can ask for.`;
      } else if (rr?.status === "approved") {
        line += ` · RETURN REQUEST ALREADY APPROVED${rr.resolved_at ? ` on ${day(rr.resolved_at)}` : ""}` +
          `${rr.resolution ? ` · resolution: ${rr.resolution}` : ""}` +
          // A replacement approval raised a free parcel — point the model at its
          // own line (folded into the own set by handleSupportMessage) so
          // "where is my replacement" is answerable.
          `${withAddress && rr.resolution === "replacement" && rr.replacement_order_id
            ? ` · replacement parcel #${rr.replacement_order_id} (see its own line)` : ""}` +
          // THE COLLECTION ITSELF — own-phone lines only.
          //
          // Without these the bot could only say "pickup has been arranged",
          // while the order already knew the courier, the tracking number and
          // whether a ₹99 link was sitting unpaid. "When is someone coming?" is
          // the single commonest follow-up to an approved return, and answering
          // it with a booked AWB is the difference between a closed question and
          // an escalation.
          `${withAddress && pickupFacts(rr) ? pickupFacts(rr) : ""}` +
          // An exchange is collected like a return but is NOT refunded. Without
          // this the bot sees an approved pickup on a COD order and can tell the
          // customer credit is coming — for an item they are swapping, not
          // returning.
          `${withAddress && rr.exchange_for
            ? ` · this is an EXCHANGE, not a refund: once the returned item reaches us we send ${rr.exchange_for} in its place.` +
              ` NEVER mention a refund or wallet credit for it`
            : ""}` +
          `. Tell them to track their return at www.ajuki.in/returns/start (order number and phone number) and confirm what happens next; do not raise it again.` +
          ` NEVER explain return or pickup-fee policy (who pays, ₹99, when it is free): you may state only this order's own pickup fact above; for any other question about charges or conditions say "You can find the details at www.ajuki.in/returns".` +
          ` For pickup timing give NO timing and do not say the team will confirm or handle it — only send them to www.ajuki.in/returns/start. For a refund question state only what the refund line for this order says (if none: there is no refund on record); never describe how refunds would work hypothetically and never offer, suggest or note down a refund or replacement as an alternative. Do NOT set needs_human or say you have forwarded anything to the team.` +
          ` THE PICKUP PAYMENT: the ₹99 link and the booked-pickup message are sent to the customer automatically — respect them, never contradict them. Talk about the pickup payment ONLY from the pickup facts above; do not invent how or when payment links are sent. You CANNOT resend a link, so never offer to: if they did not get it, send them to www.ajuki.in/returns/start. If they say they have already paid but the facts say unpaid, or they ask to waive or reduce the charge, reply: "Please email our Senior Support Team at ajukisupport@gmail.com with your order number and, if you have paid, a screenshot of the payment." Never forward these to the team.`;
      }
      // Once a return exists in any state the window is never discussed.
      if (rr) line += ` · NEVER mention the return window (open, closed, days left) for this order — a return has already been filed.`;
      // Refund status — own-phone lines only, and only present when the message
      // looked like a return / refund / cancellation (see refundsByOrder). This
      // is what lets "where's my refund" be answered with a status and a
      // timeline instead of an escalation every time — real threads read "Why no
      // one is contacting?" which is this fact missing.
      if (withAddress && refunds) {
        const rf = refunds.get(o.id);
        if (!rf) {
          line += ` · no refund on record`;
        } else if (rf.status === "REFUND_COMPLETED") {
          line += ` · refund: ₹${rf.amount} completed${rf.processedAt ? ` ${day(rf.processedAt)}` : ""}`;
        } else if (rf.status === "REFUND_MANUAL_REVIEW" || rf.status === "REFUND_FAILED") {
          line += ` · refund: ₹${rf.amount} needs the team — escalate`;
        } else {
          // A COD order has no original method to go back to; its refund settles
          // as AJUKI Wallet credit. Telling a COD customer "to the original
          // method" sends them checking a bank account nothing will arrive in.
          line += ` · refund: ₹${rf.amount} in progress since ${day(rf.since)} — ` +
            (typeof o.payment_id === "string" && o.payment_id.startsWith("pay_")
              ? "3-5 business working days to the original method"
              : "a COD order, so it settles as AJUKI Wallet credit, not to a bank account");
        }
      }
      // A parcel coming back needs saying out loud, because the courier's page
      // does not say it. An RTO leg is delivered *to us*, and it raises the same
      // scans a forward delivery does — including "out for delivery". A customer
      // reading that page sees their refused parcel apparently on its way to
      // them again, and asks why.
      //
      // AJUKI710012 is exactly that: refused at the door, and the bot answered
      // by handing over the courier link, which showed the return leg and made
      // the confusion worse. So the fact is stated and the link withheld — on a
      // returning parcel it means the opposite of what it looks like.
      const comingBack = o.status === "rto" || o.status === "returned";
      if (comingBack) {
        line += ` · ON ITS WAY BACK TO US — the delivery did not complete and the parcel is returning to our warehouse.` +
          ` The courier's tracking page will still show movement, and may even say "out for delivery": that is this parcel` +
          ` travelling back to us, NOT another attempt to deliver it. Do not give them the courier tracking link for this order,` +
          ` and do not tell them it is arriving.`;
      } else if (withAddress && (o.tracking_url || o.awb_code)) {
        // The tracking link, for their own orders only — same rule as the
        // address. It is the most useful thing we can hand someone asking where
        // a parcel is: our estimate is a date, the courier's page is the live
        // answer, and when the two disagree the customer can see for themselves
        // rather than being told a number that turns out to be wrong.
        // Founder's rule, 2026-10-11: the only tracking link ever given is www.ajuki.in/track. The courier's own page is not put in
        // the record at all, so a model that is shown this line cannot copy it. The courier name and AWB stay as facts.
        line += ` · track: www.ajuki.in/track${o.courier_name ? ` (${o.courier_name}` : ""}${o.awb_code ? `, AWB ${o.awb_code})` : o.courier_name ? ")" : ""}`;
      }
      // Item names/sizes withheld on the typed-id path for the same reason as
      // the ₹total above — a guessed order number must reveal nothing about
      // what someone bought. Own-phone orders still carry it, since "you sent
      // 3mm, I ordered 2mm" cannot be answered without it.
      return line + (withAddress && items ? ` · ${items}` : "");
    })
    .join("\n");
  // A customer with several orders asking about "my return" / "my pickup" / "my refund": when exactly one
  // of them has a return filed, that is the one they mean. Without this the bot asked "which order?" while
  // the answer was sitting in its own context.
  const withReturn = orders.filter((o) => o.return_request);
  const pointer = withAddress && orders.length > 1 && withReturn.length === 1
    ? `Only order ${withReturn[0].id} has a return filed. Any question about "my return", pickup, exchange or refund is about THAT order — assume it and NEVER ask which order they mean.\n`
    : "";
  return pointer + rendered;
}
