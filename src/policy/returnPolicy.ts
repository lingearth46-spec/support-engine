// Single source of truth for the return policy.
//
// The policy page, the account return form and the API all state or enforce this
// window. When they were separate the site drifted out of step with itself: the
// policy promised returns "for any reason", while the return form told customers
// returns were "only for defective or damaged items".

export const RETURN_WINDOW_DAYS = 7;
export const SUPPORT_EMAIL = "ajukisupport@gmail.com";

/**
 * What a customer may return for, and who pays to collect it.
 *
 * HISTORY, BECAUSE THIS LIST HAS MOVED TWICE AND BOTH MOVES WERE MEASURED
 *
 * "Changed my mind" and "Quality not as expected" were once offered and were
 * not eligible — a customer picked one, submitted, and had the request refused
 * after recording an unboxing video for nothing. A dropdown is a promise about
 * what will be accepted, so it should not list the answers that end in a no.
 *
 * "Wrong size received" and "Item not as described" were removed for the same
 * reason, one round later. Between them they were 8 of the first 22 requests and
 * 75% of each was refused, every refusal saying some version of the same thing:
 * *"the item matches the description"*, *"you ordered a free size item"*,
 * *"categorised as change of mind"*. Removing "Changed my mind" had not stopped
 * change-of-mind returns, it had renamed them, and it renamed them into the two
 * categories a photo cannot settle either way. A photo proves a dent. It cannot
 * prove that a free-size bracelet is the wrong size, or that an accurate listing
 * was inaccurate.
 *
 * WHAT CHANGED (2026-09-11, founder decision)
 *
 * Change of mind and fit are now ACCEPTED rather than refused — but the customer
 * pays the pickup. That is a better answer to the same evidence, not a reversal
 * of it. The old problem was never that these requests existed; it was that
 * people were made to photograph an undamaged item and then told no. Charging
 * for the collection prices the request honestly and ends the refusal loop.
 *
 * So the list now splits on FAULT, which is also what decides everything else:
 *
 *   ours     — damaged, defective, wrong item. Free pickup. Photos required,
 *              because a photo can actually decide these three, and they were
 *              already running at near-zero refusal.
 *   customer — it does not fit, or something else they describe themselves.
 *              Customer pays pickup. Photos split here rather than following
 *              fault: a sizing claim needs a POST-WEAR photo, because the item
 *              as it arrived proves nothing about fit but the piece worn settles
 *              it at a glance. "Something else" needs none at all — there is
 *              nothing for one to prove, and demanding one was the precise
 *              indignity described above. It requires WORDS instead.
 *
 * WHY THE CATCH-ALL IS "SOMETHING ELSE" AND NOT "CHANGED MY MIND"
 *
 * "Changed my mind" was a label written for the customer rather than one they
 * would ever choose for themselves. Almost nobody describes their own problem as
 * frivolity, so handing them a box that says so does one of two things: pushes
 * them into claiming a defect they do not have, or stops them asking at all.
 * Both destroy the data — the first poisons the defect rate, the second hides
 * demand entirely — and the 75% refusal figure above is partly the first one
 * happening.
 *
 * "Something else" plus a mandatory description costs the customer nothing to
 * admit, and gives a person something real to read. What keeps it from becoming
 * the old unbounded catch-all is the pickup charge: it is priced, not policed.
 *
 * Earrings are excluded for hygiene. That is stated on /returns and is not
 * enforced in code — a founder reviewing the request applies it, the same way
 * the unused-and-original-packaging condition is applied.
 */
export type ReturnFault = "ours" | "customer";

export interface ReturnReasonSpec {
  /** Who caused it — decides pickup cost, photos, and refund shape. */
  fault: ReturnFault;
  /** A photo is only demanded where a photo can settle the question. */
  requiresPhoto: boolean;
  /**
   * What, specifically, to photograph.
   *
   * Not every claim is settled by the same picture, and asking for the wrong one
   * is how the old policy produced useless evidence. A dent is proved by the
   * item as it arrived. Fit is not provable that way at all — it is proved by
   * the piece ON, which is why a sizing claim asks for a post-wear photo
   * instead. Same requirement, different evidence.
   */
  photoPrompt: string | null;
  /**
   * An unboxing video, from sealed tamper-proof bag to fully opened contents.
   *
   * Required only where the claim is that the WRONG THING CAME OUT OF THE BAG —
   * damaged on arrival, or not the item ordered. For those, the video is the
   * only evidence that settles the two disputes that actually arise: whether the
   * damage happened before or after opening, and whether the parcel really
   * contained what we say we packed.
   *
   * Deliberately NOT required for "Item is defective". A clasp that jams on day
   * five is a real defect and no unboxing video can show it, so demanding one
   * would refuse exactly the claims this category exists to accept. Damage
   * visible on opening is what "Item arrived damaged" is for, and that one does
   * require the video.
   */
  requiresVideo: boolean;
  /**
   * Whether the customer must say, in their own words, what is actually wrong.
   *
   * Only the catch-all needs this, and it is the entire reason the catch-all is
   * safe to offer. A dropdown option that means "none of the above" tells us
   * nothing on its own — it was removed once before for exactly that. What makes
   * it workable now is the pair: the customer has to describe the problem, and
   * the collection is charged for. One gives us something to read, the other
   * prices the request honestly.
   *
   * The named reasons do not require it. Someone who has chosen "Item arrived
   * damaged" and attached a photo of the damage has already said what is wrong,
   * and making them write it out again is friction with nothing behind it.
   */
  requiresDetails: boolean;
}

/**
 * What the customer is asked to record, stated once so the form, the policy
 * page and the WhatsApp reply cannot describe it three different ways.
 *
 * HOW IT REACHES US — deliberately not an upload.
 *
 * The video is emailed to SUPPORT_EMAIL, and only if the team asks for it. That
 * is a founder decision and a good one for two reasons. Practically, phone
 * unboxing videos are tens or hundreds of megabytes; putting one in front of the
 * submit button would fail on the patchy mobile connections most of these
 * customers are on, and would gate a return behind an upload that times out.
 * Commercially, most requests never need it — the photos settle them — so
 * demanding the heaviest evidence from everyone to catch the few would cost far
 * more good requests than it saves bad ones.
 *
 * So the form asks the customer to KEEP the video and says we may ask for it.
 * The requirement is real — a request can be refused for not producing one — but
 * it is enforced at review, by a person, not at submission by a progress bar.
 */
export const UNBOXING_VIDEO_PROMPT =
  "A single unbroken video showing the parcel from the sealed tamper-proof bag through to the fully opened contents.";

/** Where the video goes when we ask for it. Same address as every other return
 *  query, so a customer is never given a second one to remember. */
export const VIDEO_EMAIL = SUPPORT_EMAIL;

/** The one sentence shown wherever a video-backed reason is chosen. */
export function videoNoticeFor(reason: string | null | undefined): string | null {
  if (!videoRequiredFor(reason)) return null;
  return `Please keep your unboxing video. ${UNBOXING_VIDEO_PROMPT} We may ask you to email it to ${VIDEO_EMAIL} before approving this request.`;
}

export const RETURN_REASON_SPECS: Record<string, ReturnReasonSpec> = {
  "Item arrived damaged": {
    fault: "ours",
    requiresPhoto: true,
    photoPrompt: "Clear photos of the item as it arrived, showing the damage.",
    requiresVideo: true,
    requiresDetails: false,
  },
  "Item is defective": {
    fault: "ours",
    requiresPhoto: true,
    photoPrompt: "Clear photos showing the fault — the clasp, the link, or whatever isn't working.",
    // No video: a fault that appears on day five cannot have an unboxing video.
    requiresVideo: false,
    requiresDetails: false,
  },
  "Wrong item received": {
    fault: "ours",
    requiresPhoto: true,
    photoPrompt: "A clear photo of the item you received.",
    requiresVideo: true,
    requiresDetails: false,
  },
  // Photo required, but a different one: worn, not boxed. A sizing claim is the
  // one case where the item as it arrived proves nothing, and where seeing it on
  // settles the question immediately.
  "Size doesn't fit": {
    fault: "customer",
    requiresPhoto: true,
    photoPrompt: "A photo of the piece being worn, so we can see how it sits.",
    requiresVideo: false,
    requiresDetails: false,
  },
  // The catch-all, and the only reason that demands words.
  //
  // It replaced "Changed my mind", which was a label we wrote for the customer
  // rather than one they would choose for themselves. Almost nobody describes
  // their own problem that way — they have a reason, and being handed a box
  // labelled with an admission of frivolity either pushes them into claiming a
  // defect instead, or stops them asking at all. Neither outcome tells us
  // anything true.
  //
  // "Something else" plus a mandatory description does. Nothing for a photo to
  // prove here, so none is asked for; what we want is the sentence, and over
  // time a list of what actually keeps appearing in it.
  "Something else": {
    fault: "customer",
    requiresPhoto: false,
    photoPrompt: null,
    requiresVideo: false,
    requiresDetails: true,
  },
};

export const RETURN_REASONS = [
  ...Object.keys(RETURN_REASON_SPECS),
  // Admin-only: for recategorising a request after reading the free text.
  // Deliberately not offered to the customer — see CUSTOMER_RETURN_REASONS.
  "Other",
] as const;

/** The customer-facing subset — every real reason, minus the admin catch-all. */
export const CUSTOMER_RETURN_REASONS = Object.keys(RETURN_REASON_SPECS);

/**
 * What it costs the customer to have an item collected, in rupees.
 *
 * Charged only where the return is not our fault. Zero for damaged, defective
 * and wrong-item returns, which stay a free pickup exactly as before.
 *
 * ₹99 confirmed by the founder on 2026-09-11, and a published price rather than
 * an internal estimate: it is printed on /returns and /returns/start.
 *
 * COLLECTED, NOT DEDUCTED. Paying up front is a commitment: someone unwilling to
 * spend ₹99 on the collection was not sure they wanted to return at all. (It was
 * also first designed while exchanges ran through this flow, where there was no
 * refund to deduct from; exchanges have since moved to email.) So once a
 * customer-fault return is approved, the customer is sent a
 * link to pay it (lib/returnPickupPayment.ts), and the pickup — and the refund —
 * only follow once it is paid.
 */
export const RETURN_PICKUP_FEE = 99;

export function reasonSpec(reason: string | null | undefined): ReturnReasonSpec | null {
  return RETURN_REASON_SPECS[String(reason ?? "")] ?? null;
}

/** What the customer pays to have it collected. Unknown reasons are treated as
 *  our fault, because wrongly charging someone is worse than wrongly absorbing
 *  a pickup — the same asymmetry isWithinReturnWindow already applies. */
export function pickupFeeFor(reason: string | null | undefined, order?: OfferOrderFacts | null): number {
  // Buy 1 Get 1 orders pay the pickup on EVERY return, ours or theirs (founder, 2026-10-09). See the section below.
  if (isRestrictedOfferOrder(order)) return RETURN_PICKUP_FEE;
  return reasonSpec(reason)?.fault === "customer" ? RETURN_PICKUP_FEE : 0;
}

// ── Buy 1 Get 1 orders ────────────────────────────────────────────────────────
//
// FOUNDER DECISION, 2026-10-09. For an order that used a Buy-1-Get-1 offer (the site-wide offer or a product's B1G1 / B2G1 / B2G2 tag):
//
//   1. A return is accepted ONLY for damaged, defective or wrong item. "Size doesn't fit" and "Something else" are not offered.
//   2. The pickup costs ₹99 on EVERY return, including those three. Everywhere else it is still free when the fault is ours.
//
// Why it exists: the free item makes a change-of-mind return cheap to ask for and expensive to grant (return the paid piece, keep the free
// one). Refund proration (lib/returnSettlement.ts) already fixes the money; this rule is about the volume of returns on these orders, which
// run at 11.5% of delivered against 9.1% elsewhere.
//
// WHAT THE FOUNDER WAS TOLD AND ACCEPTED, so it is not rediscovered later as a bug:
//   · Rule 2 reverses the 2026-09-11 principle that a fault of ours is a free pickup. On these orders we will charge for our own mistakes:
//     22 of the 91 return requests on offer orders since 10 Aug were "wrong item", which looks like a packing error.
//   · Consumer law (the Consumer Protection Act and the e-commerce rules) gives a customer a remedy for wrong, defective or damaged goods,
//     and a pickup charge on those can be challenged. A chargeback or a complaint is the likely route. Have this checked by someone qualified.
//   · A rule is far easier to defend if the customer was told BEFORE they bought. It applies only to orders placed after OFFER_RETURN_RULES_FROM,
//     and it is stated on /returns, the Terms and the FAQ and again on the return form. The founder chose (2026-10-09) NOT to put it on the
//     cart, the product page or the offer collection, so a customer can buy without having seen it; that weakens it if it is ever challenged.
//     An order placed earlier keeps the old rules whatever it contains.

/**
 * CONFIRMED BY THE FOUNDER, 2026-10-09: the rules start on 10.10.2026 (10 October 2026, midnight IST).
 *
 * Orders placed at or after this instant are covered. It MUST be no earlier than the moment the notice is live on the site: set it to the
 * deploy time (or later) when this ships. Orders before it keep every old rule.
 */
export const OFFER_RETURN_RULES_FROM = "2026-10-10T00:00:00+05:30";

/** The only reasons offered on a Buy 1 Get 1 order: the three where the fault is ours. */
export const OFFER_RETURN_REASONS: readonly string[] = ["Item arrived damaged", "Item is defective", "Wrong item received"];

/** The notice shown on the return form, and the sentence /returns, the Terms and the FAQ say in full. */
export const OFFER_RETURN_NOTICE =
  `Buy 1 Get 1 orders can be returned only if an item arrives damaged, defective or is not what you ordered, and every return on these orders carries a ₹${RETURN_PICKUP_FEE} pickup charge.`;

/** What an order needs to say for the rule to be applied; `Order` and the returns-access row both satisfy it. */
export type OfferOrderFacts = {
  created_at?: string | null;
  offer_discount?: number | null;
  offers?: { kind?: string | null; label?: string | null }[] | null;
};

const BUY_GET_KINDS = new Set(["site_bogo", "tag_b1g1", "tag_b2g1", "tag_b2g2"]);
// "Buy 1 Get 1 Free — 1 item free", "B1G1", "B2G1"... for an offer whose amounts the items could not prove.
const BUY_GET_LABEL = /buy\s*\d\s*get\s*\d|\bb[12]g[12]\b/i;

/**
 * Does the Buy 1 Get 1 return rule apply to this order?
 *
 * Needs all of: placed on or after the start date, an automatic offer actually recorded on it, and that offer is a buy-get one (not the
 * chain bundle or a Build-a-Stack tier, which the notice does not cover). An order with no recorded offer is never restricted, which is the
 * safe side: wrongly applying a restriction to a customer who was never told of it is worse than wrongly not applying it.
 */
export function isRestrictedOfferOrder(order: OfferOrderFacts | null | undefined, from: string = OFFER_RETURN_RULES_FROM): boolean {
  if (!order) return false;
  const placed = Date.parse(String(order.created_at ?? ""));
  if (!Number.isFinite(placed) || placed < Date.parse(from)) return false;
  if (!(Number(order.offer_discount) > 0)) return false;
  return (order.offers ?? []).some((l) => BUY_GET_KINDS.has(String(l?.kind ?? "")) || BUY_GET_LABEL.test(String(l?.label ?? "")));
}

/** "10 October 2026": the start date as people read it, derived from the one constant so the Terms, FAQ and /returns can never name a different day. */
export function offerRulesFromLabel(from: string = OFFER_RETURN_RULES_FROM): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // The date part as written, in the offset it was written in: that IS the IST calendar day the rule starts on.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(from);
  return m ? `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}` : from;
}

/** The reasons this order's customer may choose from. */
export function customerReasonsFor(order: OfferOrderFacts | null | undefined): string[] {
  return isRestrictedOfferOrder(order) ? CUSTOMER_RETURN_REASONS.filter((r) => OFFER_RETURN_REASONS.includes(r)) : [...CUSTOMER_RETURN_REASONS];
}

export function photoRequiredFor(reason: string | null | undefined): boolean {
  return reasonSpec(reason)?.requiresPhoto ?? true;
}

/** What to ask the customer to photograph, or null when nothing is required. */
export function photoPromptFor(reason: string | null | undefined): string | null {
  return reasonSpec(reason)?.photoPrompt ?? null;
}

/** Days left to raise a return, or null when the order has no delivery date on record. */
export function daysLeftToReturn(deliveredAt?: string | null, now: Date = new Date()): number | null {
  if (!deliveredAt) return null;
  const elapsedMs = now.getTime() - new Date(deliveredAt).getTime();
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
  return Math.ceil(RETURN_WINDOW_DAYS - elapsedDays);
}

/**
 * Orders delivered before `delivered_at` existed have no date to measure from.
 * Allow those through for manual review rather than reject them: wrongly refusing
 * a genuine return is worse than looking at an old request by hand.
 */
export function isWithinReturnWindow(
  deliveredAt?: string | null,
  adminNotes?: string | null,
  // Injectable so a caller reasoning about a fixed instant gets an answer for
  // THAT instant. lib/returnDecision.ts takes a `now` and passes it down; while
  // this read Date.now() regardless, decideReturn(order, now) was only
  // deterministic in the parts that did not touch the window — its tests drifted
  // by a day the moment the date rolled over.
  now: Date = new Date(),
): boolean {
  const granted = returnWindowOverride(adminNotes);
  if (granted !== null && granted > now.getTime()) return true;

  const left = daysLeftToReturn(deliveredAt, now);
  return left === null || left > 0;
}

/**
 * A window a person deliberately reopened for one order.
 *
 * Goodwill exceptions are routine — a customer who complained inside the window
 * and got an answer outside it, a return rejected in error, a case that dragged
 * on past seven days through no fault of theirs. Without a way to record one,
 * the only lever is editing `delivered_at`, and that date is not free to move:
 * it feeds courier SLA stats (lib/courierSla.ts), the delivery-estimate model,
 * and the line the bot reads back to the customer about their own order. Buying
 * one return by making a parcel claim it arrived a week later than it did
 * corrupts three other things quietly.
 *
 * So the exception lives in `admin_notes` behind a marker, the same shape
 * lib/shadowfax.ts uses for SFX_ESCALATED_MARKER: visible to whoever opens the
 * order, greppable, and carrying its own expiry so a one-off favour does not
 * silently become a permanent one.
 *
 *   [return-window-until:2026-09-19]
 */
export const RETURN_WINDOW_MARKER = "return-window-until";

/** The instant an override expires, or null when there is none. */
export function returnWindowOverride(adminNotes?: string | null): number | null {
  if (!adminNotes) return null;
  const m = adminNotes.match(new RegExp(`\\[${RETURN_WINDOW_MARKER}:([0-9]{4}-[0-9]{2}-[0-9]{2})\\]`));
  if (!m) return null;
  // End of that day, so "until the 19th" includes the 19th.
  const until = Date.parse(`${m[1]}T23:59:59Z`);
  return Number.isFinite(until) ? until : null;
}

/** The note to append when granting one. */
export function returnWindowNote(days: number, now: Date = new Date()): string {
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return `[${RETURN_WINDOW_MARKER}:${until.toISOString().slice(0, 10)}]`;
}

/** One line of an approved replacement: an original item, at a possibly reduced quantity. */
export type ReplacementLine = { index: number; quantity: number };

/**
 * What an approved `replacement` actually puts in the parcel.
 *
 * Built from the order rather than from the request. The panel sends indices into
 * the original items and a quantity for each, and everything else — name, price,
 * colour, size — is read off the order here. A replacement whose contents came
 * from the browser would let a mistyped request post goods that were never
 * bought, on an order nobody is charged for.
 *
 * Quantities are clamped to what was ordered. Sending three of something a
 * customer bought one of is not a partial replacement, and choosing how much to
 * give away is the entire point of the screen this serves.
 *
 * No lines at all means the whole order goes again: that is what a full
 * replacement means, and what a bulk approve sends when there is nowhere to pick
 * items one order at a time.
 *
 * Returns null when nothing survives, which callers must treat as a refusal
 * rather than as an empty parcel.
 */
export function replacementItems<T extends { quantity: number }>(
  original: T[] | null | undefined,
  lines?: ReplacementLine[]
): T[] | null {
  if (!Array.isArray(original) || !original.length) return null;

  const chosen: ReplacementLine[] = lines?.length
    ? lines
    : original.map((item, index) => ({ index, quantity: item.quantity }));

  const items = chosen
    .map(({ index, quantity }) => {
      const item = original[index];
      if (!item) return null;
      const qty = Math.min(Math.floor(Number(quantity) || 0), item.quantity);
      return qty > 0 ? { ...item, quantity: qty } : null;
    })
    .filter((i): i is T => i !== null);

  return items.length ? items : null;
}


/** Whether this claim needs the unboxing video. Unknown reasons do not — the
 *  heaviest ask we make should never be triggered by a label we do not know. */
export function videoRequiredFor(reason: string | null | undefined): boolean {
  return reasonSpec(reason)?.requiresVideo ?? false;
}

/** Must this reason carry the customer's own description of the problem? */
export function detailsRequiredFor(reason: string | null | undefined): boolean {
  return reasonSpec(reason)?.requiresDetails ?? false;
}

/** What to ask for, where a description is mandatory. */
export const DETAILS_PROMPT =
  "Tell us what's wrong in your own words — a sentence or two is enough.";
