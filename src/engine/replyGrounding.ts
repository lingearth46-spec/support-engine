// The gate between the model and the customer for FACTS.
//
// lib/replyCheck.ts catches strings that are visibly broken (placeholders, Devanagari, empty). This catches
// strings that read fine and are wrong: an amount, order number, date, link, email or phone number that appears
// nowhere in what the model was given, a time promise, an offer of a refund or replacement, a call-back, or advice
// to refuse a parcel. The founder's instruction: the model states only the business truths, the customer's order
// record and the catalogue — so a reply carrying anything else is not sent.
//
// Every rule here is decidable from the text and the sources alone; nothing asks "does this sound right". A
// violation means the reply is replaced by the fixed flag line and the team is pinged (see openaiSupport.ts) — the
// customer gets a true statement instead of a plausible one. That costs a few escalations where the model was
// merely loose; the founder chose that trade. Pure, so every rule is unit-tested.

import { pipelineV2Enabled } from "@engine/pipelineV2";

export type Violation = { rule: string; detail: string };

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
const digits = (s: string) => s.replace(/[^\d.]/g, "").replace(/\.0+$/, "");

/** "I can't promise…" and "we cannot guarantee…" say the opposite of a promise. */
const NEGATED_PROMISE = /\b(can'?t|cannot|can not|won'?t|unable to|not able to|don'?t)\s+(promise|guarantee|assure)\b/gi;

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";

const FIRST_PERSON_OFFER =
  /\b(i|we)\s*(can|could|will|'ll|would|shall|may|am happy to|are happy to)\s+(also\s+)?(arrange|offer|issue|process|approve|organi[sz]e|send you|give you|provide|get you)\b[^.!?\n]{0,60}\b(refund|replacement|replace|exchange|discount|compensation|credit|coupon|voucher|goodwill)\b/i;
const HAPPY_TO = /\b(happy|glad|ready) to (replace|refund|exchange|compensate)\b/i;
const WILL_REFUND = /\b(we|i)\s*(will|'ll)\s+(refund|replace|exchange|reship|resend)\b/i;
const CALLBACK = /\b(call you|call back|callback|give you a call|ring you|phone you)\b/i;
const REFUSAL_ADVICE = /\b(you can|you may|can|may|please|just|simply|should|could|try to|better to|option to)\b[^.!?\n]{0,15}\brefus(e|ing)\b/i;
const RESPONSE_VERB = /\b(update|reply|respond|get back|contact you|review|revert|resolve|sort(ed)? (it|this|that) out|look(ing)? into|follow up|reach out|assist|share|send you|provide|let you know|inform|notify|confirm)\b/i;
const DELIVERY_VERB = /\b(deliver(ed)?|arrive|reach|come|dispatch(ed)?|ship(ped)?)\b/i;
const TIME_EXPR =
  /\b(within\s+(\d|a |an |one|two|three|four|five|few|couple|the next|24|48)|in\s+(\d|a few|a couple|the next)[^.!?\n]{0,12}\b(hour|hr|day|minute|min|week)s?\b|\d+\s*(-|to)\s*\d+\s*(business |working )*(hour|hr|day)s?|shortly|soon|right away|straight away|immediately|as soon as possible|asap|by (tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|evening|morning)|tomorrow|tonight|today)\b/i;

/** Pulls a `sentence` out of the reply at each match so a rule can look at it in isolation. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * `sources` is EVIDENCE: the founder's truths, the customer's own order record and the catalogue. `context` is what the
 * customer and earlier replies said — it may only vouch for an order number or phone number being ECHOED ("I couldn't find
 * AJUKI999"); it never makes an amount, date, link or email supported, because a customer's claim is not AJUKI's fact.
 */
export function groundingViolations(reply: string, sources: string[], context: string[] = []): Violation[] {
  const out: Violation[] = [];
  // Straight apostrophes only: WhatsApp keyboards and the model both write "can’t" / "we’ll", and every rule below is written with
  // the straight one — "I can’t promise a delivery today" was blocked as a promise while "can't" passed, and "we’ll refund you"
  // slipped past the offer rule.
  const text = (reply ?? "").replace(/[‘’]/g, "'");
  const hay = norm(sources.join("\n"));
  const ctx = norm(context.join("\n"));
  const hayDigits = hay.replace(/[^\d.\n ]/g, " ");
  const add = (rule: string, detail: string) => { if (!out.some((v) => v.rule === rule && v.detail === detail)) out.push({ rule, detail }); };

  // ── things that must exist in the sources ──
  for (const m of text.matchAll(/₹\s?([\d,]+(?:\.\d+)?)/g)) {
    const d = digits(m[1]);
    if (d && !hay.includes(`₹${m[1]}`.toLowerCase()) && !hay.includes(`₹ ${m[1]}`.toLowerCase()) && !new RegExp(`(^|[^\\d.])${d.replace(/\./g, "\\.")}([^\\d]|$)`).test(hayDigits.replace(/,/g, ""))) {
      add("amount", `₹${m[1]}`);
    }
  }
  for (const m of text.matchAll(/\bajuki\d{4,10}\b/gi)) if (!hay.includes(m[0].toLowerCase()) && !ctx.includes(m[0].toLowerCase())) add("order_id", m[0].toUpperCase());
  for (const m of text.matchAll(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g)) if (!hay.includes(m[0].toLowerCase())) add("email", m[0]);
  for (const m of text.matchAll(/(?:https?:\/\/|www\.)[^\s)<>"']+/gi)) {
    const url = m[0].replace(/[.,;:!?)]+$/, "").toLowerCase();
    if (!hay.includes(url) && !hay.includes(url.replace(/^https?:\/\//, "").replace(/^www\./, ""))) add("url", url);
  }
  for (const m of text.matchAll(/(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g)) {
    const d = m[0].replace(/\D/g, "").slice(-10);
    if (!hay.replace(/\D/g, " ").replace(/\s+/g, "").includes(d) && !ctx.replace(/\D/g, " ").replace(/\s+/g, "").includes(d)) add("phone", m[0]);
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})[a-z]*\\b`, "gi"))) {
    const day = String(Number(m[1]));
    const mon = m[2].toLowerCase().slice(0, 3);
    if (!new RegExp(`\\b0?${day}(?:st|nd|rd|th)?\\s+${mon}`, "i").test(hay)) add("date", m[0]);
  }

  // ── things the model must never say ──
  // An internal tag or status name leaking into customer text ("a late_delivery ticket was raised").
  // A link is judged by the url rule above and is the record's own text: the DTDC tracking page is ".../tracking_results.asp?...",
  // and that path segment is not an internal term. (10 Oct: three correct drafts became the flag line because of it.)
  const prose = pipelineV2Enabled() ? text.replace(/(?:https?:\/\/|www\.)[^\s)<>"']+/gi, " ") : text;
  for (const m of prose.matchAll(/\b[a-z]{2,}(?:_[a-z0-9]+)+\b/g)) add("internal_term", m[0]);
  // A STATE the record does not show. Two claims the verifier waved through on 9 Oct:
  //  · "The refund was raised on 9 Oct" — said to a customer whose order line read "no refund on record"; the date was a support
  //    case's, not a refund's. A refund may be called raised, started, processed or completed only when an order line carries a
  //    refund fact ("refund: ₹… in progress / completed").
  //  · "shipped and is out for delivery" beside a last scan of "Picked Successfully". "Out for delivery" must appear in the order
  //    record (a scan or status line) before the bot may say it.
  const REFUND_STATE = /\brefunds?\b[^.!?\n]{0,60}\b(was|has been|have been|is|got|will be)\s+(now\s+)?(raised|initiated|processed|issued|created|started|completed|credited|in progress|on (its|the) way)\b/i;
  if (REFUND_STATE.test(text) && !/refund:\s*₹/.test(hay)) add("refund_state", "states a refund's status that the order record does not show");
  if (/\bout for delivery\b|\bofd\b/i.test(text) && !/out for delivery|\bofd\b/.test(hay)) add("status_claim", "says out for delivery; the order record does not");
  // A reply that says an order is on its way, in transit or not delivered when its own record line says delivered (23 Oct, ..2108: AJUKI710033 was delivered the evening before and the
  // reply said "on its way ... delivery confirm nahi dikh rahi", repeating the earlier bot lines in the thread).
  const NOT_DELIVERED_CLAIM = /\b(?:on its way|in transit|is shipped|not (?:been )?delivered|hasn'?t been delivered|has not been delivered|delivery confirm nahi|deliver nahi hua)\b/i;
  if (NOT_DELIVERED_CLAIM.test(text)) {
    const lines = sources.join("\n").split("\n").map((l) => l.toLowerCase());
    for (const m of text.matchAll(/\bajuki\d{4,10}\b/gi)) {
      const id = m[0].toLowerCase();
      if (lines.some((l) => l.includes(`#${id}`) && /·\s*delivered\s*·/.test(l))) add("status_contradiction", `says ${m[0].toUpperCase()} is not delivered; the order record says delivered`);
    }
  }
  const cleaned = text.replace(NEGATED_PROMISE, " ");
  if (/\b(guarantee[ds]?|promise[ds]?|assure[ds]?)\b/i.test(cleaned) && !/\bwarranty\b/i.test(cleaned)) add("promise", "guarantee/promise wording");
  if (FIRST_PERSON_OFFER.test(text) || HAPPY_TO.test(text) || WILL_REFUND.test(text)) add("offer", "offers a refund, replacement, exchange or discount");
  if (CALLBACK.test(text)) add("callback", "promises a call");
  // A reply that brings up a replacement the customer never mentioned is offering one (24 Oct: "To have this as your replacement (small), email ...").
  if (ctx && /\b(replacement|replaces?|replaced|replacing)\b/i.test(text) && !/\b(replac|exchang|swap)/.test(ctx)) add("replacement_offer", "mentions a replacement the customer did not raise");
  // A customer who got the wrong, damaged or missing item is not told to buy again (24 Oct: "If you need the bracelet urgently, please place a new order").
  if (ctx && /\b(place a new order|order again|new order at|re-?order)\b/i.test(text) && /\b(wrong (?:item|order|product|piece)|got the wrong|damag\w+|defect\w*|broken|faulty|missing (?:item|piece)|received only|not what i ordered)\b/.test(ctx)) add("reorder_on_fault", "tells a customer with a fault complaint to place a new order");
  // Nobody here can see the mailbox, so "we see you have emailed" / "we have received your email" states something nobody knows (13 Oct, #58).
  if (EMAIL_RECEIPT.test(text.replace(/[‘’]/g, "'"))) add("email_receipt", "says an email was seen or received; nobody here can see the mailbox");
  // "We won't disturb you" is a promise about future contact the team may not be able to keep (13 Oct, #28).
  if (NO_CONTACT.test(text.replace(/[‘’]/g, "'"))) add("contact_promise", "promises not to contact or disturb the customer");
  // Nothing here is ever "closed in our record": a conversation or case is closed only by a person (14 Oct, #77).
  if (CLOSURE_CLAIM.test(text)) add("closure_claim", "says the conversation or case is closed");
  // Choosing a size the product does not offer (15 Oct, #70-72: "choose 18cm there" on a bracelet with no size option). A measurement can be
  // picked only when a product line lists it ("sizes: 17cm, 18cm"); a generic "choose your size" is refused when the product line says there is none.
  for (const m of text.matchAll(SIZE_PICK)) {
    const measure = (m[1] ?? m[2] ?? "").replace(/\s+/g, "").toLowerCase();
    if (measure) {
      const listed = hay.split("\n").some((l) => /\bsizes:/.test(l) && l.replace(/\s+/g, "").includes(measure));
      if (!listed) { add("size_option_claim", `offers ${measure} as a size to choose; no product line lists it`); break; }
    } else if (/\bno size option\b/.test(hay)) { add("size_option_claim", "tells the customer to choose a size; the product has no size option"); break; }
  }
  // "Cancel this order and place a new one in 18cm": the same mistake from the other side (15 Oct, #70-71). Sizes are never fixed by cancelling and reordering.
  if (CANCEL_TO_REORDER.test(text)) add("size_option_claim", "suggests cancelling and reordering to get a different size or length");
  if (REFUSAL_ADVICE.test(text)) add("refusal_advice", "suggests refusing the parcel");
  for (const s of sentences(text)) {
    if (TIME_EXPR.test(s) && RESPONSE_VERB.test(s) && !/\b(day|hour)s?\b.{0,20}\bafter dispatch\b/i.test(s)) add("reply_time", s.slice(0, 80));
    // A question is not a promise ("…or do you want your current order delivered today?", 10 Oct E3). With SUPPORT_PIPELINE_V2 on, a sentence
    // that ends in a question mark is not read as a delivery promise; a statement is still caught, and so is a promise with a
    // tag question ("it will arrive tomorrow, okay?").
    const isQuestion = pipelineV2Enabled() && /\?["')\]]*$/.test(s) && !/\b(will|shall|going to)\b|'ll\b/i.test(s);
    if (!isQuestion && DELIVERY_VERB.test(s) && /\b(tomorrow|tonight|today|by (monday|tuesday|wednesday|thursday|friday|saturday))\b/i.test(s) && !hay.includes(norm(s))) add("delivery_promise", s.slice(0, 80));
  }
  return out;
}

/** "We see you've emailed", "we have received your email", "I can see your mail", "your email has been received". */
export const EMAIL_RECEIPT =
  /\b(?:we|i)(?:'ve| have)?\s+(?:can\s+)?(?:see|saw|seen|received|got|noticed|read)\s+(?:that\s+)?(?:your|the|an?)\s+(?:e-?mails?|mails?)\b|\bwe (?:can )?see (?:that )?you(?:'ve| have)\s+(?:e-?mailed|mailed|written|sent (?:us )?an? e-?mail)\b|\b(?:your|the) e-?mails?\b[^.!?\n]{0,10}\b(?:has been|was|have been|is)\s+(?:received|seen|noted|read)\b/i;

/** "This conversation is closed in our record", "your case has been closed". */
export const CLOSURE_CLAIM = /\b(?:this |your |the )?(?:conversation|chat|case|ticket|issue)\b[^.!?\n]{0,30}\b(?:is|has been|was)\s+(?:now\s+)?closed\b/i;

/** "choose 18cm", "pick the 18 cm option", "select your size": group 1 or 2 is a measurement when there is one. */
export const SIZE_PICK = /\b(?:choose|select|pick|opt for|go for)\b[^.!?\n]{0,25}?\b(\d{1,2}(?:\.\d)?\s?(?:cm|mm|inch(?:es)?))\b|\b(\d{1,2}(?:\.\d)?\s?(?:cm|mm|inch(?:es)?))\s+(?:option|size)\b|\b(?:choose|select|pick)\b[^.!?\n]{0,15}\b(?:your |a |the )?size\b/gi;

/** "cancel this order and place a new order for the 18cm", "cancel it so you can reorder in a different size". */
export const CANCEL_TO_REORDER = /\bcancel(?:l?ed|l?ing)?\b[^.!?\n]{0,80}\b(?:place|make|put in|reorder|re-order)\b[^.!?\n]{0,40}\b(?:new order|again|order)?[^.!?\n]{0,40}\b(?:\d{1,2}\s?(?:cm|mm)|size|length)\b/i;

/** "We won't disturb you", "I will not bother you", "no more messages". */
export const NO_CONTACT =
  /\b(?:we|i)\s*(?:won't|will not|shall not|promise not to|will never)\s+(?:disturb|bother|contact|message|text|ping|call|trouble)\b|\b(?:won't|will not) (?:disturb|bother|trouble) you\b|\bno (?:more|further) (?:messages|texts|calls)\b|\bstop (?:messaging|contacting|texting|disturbing) you\b/i;

/**
 * Remove the sentences that make a reply-time or delivery-date promise, keeping everything else. The persona still
 * tells the model to close every hand-off with "a team member will update you within 3-5 business working hours";
 * rather than discard a reply that is otherwise a correct tracking link or order status, that one sentence is cut.
 */
export function stripPromiseSentences(text: string): string {
  return sentences(text)
    .filter((s) => !(TIME_EXPR.test(s) && RESPONSE_VERB.test(s)) && !(DELIVERY_VERB.test(s) && /\b(tomorrow|tonight|today|by (monday|tuesday|wednesday|thursday|friday|saturday))\b/i.test(s)))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const nz = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Cut the sentences that contain what the verifier quoted as unsupported, and keep the rest. Returns null (so the
 * caller flags the whole reply) when a quote cannot be matched to a sentence, or too little is left to be worth sending.
 */
export function removeUnsupportedSentences(text: string, claims: string[]): string | null {
  const all = sentences(text);
  const drop = new Set<number>();
  for (const c of claims) {
    const cn = nz(c);
    if (cn.length < 6) continue;
    let hit = false;
    all.forEach((snt, i) => {
      const sn = nz(snt);
      if (sn.length >= 6 && (sn.includes(cn) || cn.includes(sn))) { drop.add(i); hit = true; }
    });
    if (!hit) return null;
  }
  const kept = all.filter((_, i) => !drop.has(i)).join(" ").replace(/\s{2,}/g, " ").trim();
  // Too little left to be worth sending, or what is left is a fragment of the answer that was cut: flag the whole reply.
  if (nz(kept).length < 15) return null;
  if (/[:;,]$/.test(kept)) return null;
  if (/^(it|they|that|this)('s|s|'re| is| are)? ?(also|too)?\b|^(also|and|but|plus|so)\b/i.test(kept)) return null;
  return kept;
}
