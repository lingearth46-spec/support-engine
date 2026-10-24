// Fixed wording for four everyday topics the founder has settled, so the same words go out every time:
//
//   1. Product quality / material, and "can I see photos"      -> a fixed line
//   2. An address change once the parcel is with the courier    -> "flagged to the team"
//   3. A size question from a customer whose order is in flight -> where to find it, then a team member
//   4. A discount / offer question                              -> flagged, because offers change
//
// Message-driven and conservative: each matcher needs the wording itself, and the order-state ones check the
// customer's actual orders. Anything not matched falls through to the model. Pure, so every branch is tested.

import { cancellationAllowed } from "@/lib/supportActions";
import type { ActionOrder } from "@/lib/supportActions";

export const QUALITY_REPLY = "Our products are made of stainless steel with premium plating.";

export const CARE_REPLY = "Our products are made of stainless steel with premium plating and come with a 1 month warranty. Care instructions are on our website and on the card in your parcel.";
/** What CARE_REPLY said before 14 Oct 2026; never sent now, recognised in history. */
export const LEGACY_CARE_REPLY = "You can find care instructions on our website, www.ajuki.in, and on the card included with your parcel.";

export const COMPLAINT_EMAIL_REPLY = "I'm sorry to hear that. Please email our Senior Support Team at ajukisupport@gmail.com with your order number and details of the problem.";

export const PHOTOS_REPLY = "You can find photos of our products on our website, www.ajuki.in, and on our Instagram page, @ajuki.in.";

export const WARRANTY_REPLY = "Our products are of premium quality and come with a 1 month warranty.";

/** An address change once the parcel is with the courier (founder, 14 Oct: the shared flag line is split by situation). */
/** What this line said until 18 Oct 2026, when the founder's decision that a booked parcel's address can still be changed through the courier replaced it. Never sent; recognised in history. */
export const LEGACY_ADDRESS_FLAG_REPLY = "This order is already with the courier, so the address cannot be changed now. I have escalated this to the team.";
/** An address change on a parcel the courier already holds, when it cannot be taken from the customer in this chat (several parcels, or the address is already in the message): a person decides. */
export const ADDRESS_FLAG_REPLY = "This order is already with the courier, and its address can sometimes still be changed there. I have escalated this to the team.";
/** One booked parcel and no address in the message yet: ask for it. The next message is taken as the proposed address (the confirm_addr_edit pending action), recorded on the order, and a person approves it on Telegram before anything reaches the courier. */
export const ADDRESS_ASK_REPLY = "I can pass a new delivery address to our team, and they will ask the courier to change it if that is still possible. Please send the full new address, including the 6-digit pincode.";

export const SIZE_REPLY = "You can find the sizes of your item on its product page at www.ajuki.in.";

export const SIZE_INSIST_REPLY = "I have asked a team member to get the exact size and get back to you.";

export const NO_STORE_REPLY = "We don't have a physical store or office. You can order on our website, www.ajuki.in.";

export const DISCOUNT_REPLY = "I will flag this to a team member to get you the exact details, as discounts may change over time.";

/** WhatsApp keyboards send curly apostrophes; every pattern below is written with the straight one. */
const n = (s: string | undefined) => (s ?? "").replace(/[‘’]/g, "'");

export type TopicResult = { text: string; tag: "product_info" | "address_change" | "sizing" | "offer_discount" | "complaint"; escalate: boolean; kind: string };

// ── 1. quality and photos ────────────────────────────────────────────────────────────────────────────────────────

/** Asking about quality, material or durability. Water-related questions are left to the model: the knowledge base
 *  carries the exact waterproof statement and a fixed quality line would not answer them. */
const QUALITY =
  /\b(quality|good product|hypo-?allergenic|allerg\w*|sensitive skin|skin (irritation|reaction|safe|friendly|problem)|nickel|(how|ways?) (do i|to|can i|should i)?\s*(clean|care|maintain|polish|keep)\b.{0,30}|clean(ing)?|care (for|of|tips|instructions)|maintenance|maintain|polish(ing)?|plating (last|wear|come|peel|fade)\w*|peel(ing|s)?|scratch(es|ed)?|is (it|this) good|durab\w*|last(s|ing)? long|how long (will|does|do) (it|they) last|tarnish\w*|fad(e|es|ed|ing)|rust\w*|material|made (of|from|out of)|genuine|original|will (it|they) (get )?(damage\w*|break|spoil)|get damage\w*)\b/i;
/** A quality COMPLAINT is not a question about the material — it goes to the return routing, never to this line. */
const QUALITY_COMPLAINT = /\b(customer (?:support|service|care|experience)|prompt delivery|delay(?:ed)?|late|frustrat\w*|unhappy|upset|angry|promotion\w*|poor|bad|cheap|worst|pathetic|fake|disappointed|not satisfied|dissatisfied|don'?t like|do not like|not good|not up to|does not match|doesn'?t match|price only|waste|useless|rubbish|so bad|very bad|return|refund|exchange|replace|received|delivered|looking|looked|turned|became|already|bought|again|i ordered|not in (my|the)|spent|spend money|(got|have|had|having|developed|getting)\b.{0,14}(rash|allerg\w*|itch\w*|irritation))\b/i;
/** Warranty / guarantee, including the spellings customers actually type (gerenty, gurantee, warrenty). */
const WARRANTY = /\b(warr?an?t(y|ies)|warrenty|guarant(ee|y|ies)|gurant(ee|y)|garant(ee|y)|gerent(y|ee)|garanty)\b/i;
/** A fault report that mentions a warranty is a claim, not a question: the return routing owns it. */
const FAULT_REPORT = /\b(damag\w*|broke\w*|broken|defect\w*|not working|stopped working|wrong|missing|faulty|came off|rust(ed|y)?)\b/i;
const WATER = /\b(water|waterproof|sweat|shower|bath|swim|rain)\b/i;

/** Asking to SEE photos — not offering to send some (that is a return or a fault claim). */
const WANTS_PHOTOS =
  /(^|[,;.!]\s*)(please |pls |plz )?(send|show|share)\s+(photos?|pics?|pictures?|images?|videos?)\b|\b(send|show|share|give|upload)\s+(me|us)\s+(some\s+|more\s+|real\s+|actual\s+|the\s+|a\s+)?(photos?|pics?|pictures?|images?|videos?)\b|\b(can|could|will) (u|you|uh)\s+(pls |please )?(send|show|share)\s+(me\s+)?((some|more|real|actual|the|a)\s+)*(photos?|pics?|pictures?|images?|videos?)\b|\b(want|need|get|have|see|give|show)\b.{0,12}\b(any|more|real|actual)\s+(photos?|pics?|pictures?|images?|videos?)\b|\bdo you have\b.{0,15}\b(photos?|pics?|pictures?|images?)\b|\bcan i see (the )?(photos?|pics?|pictures?|product|actual|real)\b/i;
const OFFERING_PHOTOS = /\b(send(ing)? you|i (will|'ll|have|had|already) (send|sent)|already (send|sent)|attach(ed|ing)?|damag\w*|broken|defect\w*|wrong|upload|exchange|worn|record|option|not available|can'?t|cant|before packing|my (order|stuff|parcel)|with mail|by mail)\b/i;

/** Plating care: how to clean it, keep it, whether it peels or scratches. The answer is where the instructions are, not instructions. */
const CARE = /\b(clean(ing)?|care (for|of|tips|instructions)|take care of|care instructions|maintenance|maintain|polish(ing)?|plating (last|wear|come|peel|fade)\w*|peel(ing|s)?( off)?|scratch(es|ed)?|how (do i|to|can i) keep)\b/i;

/** A customer REPORTING a skin reaction, or a defect that has come back: a complaint, so it goes to email. */
const REACTION_REPORT = /(got|have|had|having|developed|getting|gets|get)\b.{0,14}(rash|allerg\w*|itch\w*|irritation)|(turn(ed|s|ing)?|went|gone|become|became)\b.{0,15}\bgreen\b|(skin|finger|hand|wrist|neck)\b.{0,20}\b(green|black|rash|red|itch\w*|irritat\w*|allerg\w*)\b/i;
const REPEAT_COMPLAINT = /\bagain\b.{0,40}\b(peel\w*|fad\w*|rust\w*|tarnish\w*|colou?r|scratch\w*|broke\w*|stopped)\b|\b(peel\w*|fad\w*|rust\w*|tarnish\w*|broke\w*|stopped)\b.{0,40}\bagain\b/i;

/** A skin reaction or a repeat defect is a complaint, not a product question: it goes to the Senior Support Team by email. */
export function complaintEmailReply(opts: { message: string }): TopicResult | null {
  const m = n(opts.message);
  if (REACTION_REPORT.test(m) || REPEAT_COMPLAINT.test(m)) return { text: COMPLAINT_EMAIL_REPLY, tag: "complaint", escalate: false, kind: "complaint_email" };
  return null;
}

/** "Is it original?" / "100% original product" ask about authenticity. "my original undelivered order" does not: the word is how a
 *  customer separates the order they placed from a replacement. */
const ASKS_AUTHENTIC = /\b(?:is|are|it'?s|its|100 ?%|really|truly|pure|genuine|totally)\b[^.?!]{0,15}\boriginal\b|\boriginal\b[^.?!]{0,12}\b(?:product|quality|or fake|hai kya|hai ya|material|jewell?ery)\b/i;

export function productInfoReply(opts: { message: string; v2?: boolean }): TopicResult | null {
  const m = n(opts.v2 && !ASKS_AUTHENTIC.test(n(opts.message)) ? opts.message.replace(/\boriginal\b/gi, " ") : opts.message);
  if (WARRANTY.test(m) && !FAULT_REPORT.test(m)) return { text: WARRANTY_REPLY, tag: "product_info", escalate: false, kind: "warranty" };
  if (WANTS_PHOTOS.test(m) && !OFFERING_PHOTOS.test(m)) return { text: PHOTOS_REPLY, tag: "product_info", escalate: false, kind: "photos" };
  if (CARE.test(m) && !WATER.test(m) && !QUALITY_COMPLAINT.test(m)) return { text: CARE_REPLY, tag: "product_info", escalate: false, kind: "care" };
  if (QUALITY.test(m) && !WATER.test(m) && !QUALITY_COMPLAINT.test(m)) return { text: QUALITY_REPLY, tag: "product_info", escalate: false, kind: "quality" };
  return null;
}

// ── 2. address change ────────────────────────────────────────────────────────────────────────────────────────────

export const NEGATED_ADDRESS = /\b(don'?t|do not|no need|not)\b.{0,12}\b(change|update|edit)\b/i;

export const ADDRESS_CHANGE =
  /\b(change|changing|update|edit|correct|fix|new|wrong)\b.{0,25}\b(address|adress|pincode|pin code|landmark)\b|\baddress\b.{0,15}\b(change|changed|wrong|incorrect|needs? to)\b|\bi (do not|don'?t) live (there|here)\b/i;

type FlightOrder = { id: string; status: string; awb_code?: string | null; items?: { name?: string; slug?: string }[] | null };

/** Once nothing of theirs can still be edited and at least one parcel is with the courier, an address change
 *  is a flag to the team. Before dispatch it stays with the model, which can make the change itself. */
/** The thank-you for a phone number the customer sends after we asked for one (the "Update phone" tap): the number goes to the team with the case. */
export const PHONE_GIVEN_REPLY = "Thanks, I have passed that number to the team to update with the courier.";
const MOBILE_G = /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/g;
/** A message that is only phone number(s): "9000100018", "9000100005 & 9000100022". */
export function isPhoneOnly(message: string | null | undefined): boolean {
  const m = String(message ?? "");
  const nums = m.match(MOBILE_G) ?? [];
  if (!nums.length || nums.length > 3) return false;
  const rest = m.replace(MOBILE_G, " ").replace(/\b(?:and|or|aur|number|no|mobile|phone|contact|my|is|new)\b/gi, " ").replace(/[^\p{L}\p{N}]/gu, "");
  return rest.length === 0;
}

export function addressChangeReply(opts: { message: string; tag: string; ownOrders: FlightOrder[] }): TopicResult | null {
  // 23 Oct: "9000100005 & 9000100022", sent because we had just asked for the new phone number, was answered by asking for a delivery ADDRESS.
  if (opts.tag === "address_change" && isPhoneOnly(opts.message)) return { text: PHONE_GIVEN_REPLY, tag: "address_change", escalate: true, kind: "phone_given" };
  if (NEGATED_ADDRESS.test(n(opts.message))) return null;
  // 24 Oct: "Update phone" on a thread already tagged address_change was answered by asking for a delivery ADDRESS. A phone request is phoneChangeReply's.
  if (PHONE_CHANGE.test(n(opts.message)) && !ADDRESS_CHANGE.test(n(opts.message))) return null;
  if (opts.tag !== "address_change" && !ADDRESS_CHANGE.test(n(opts.message))) return null;
  const verdicts = opts.ownOrders.map((o) => cancellationAllowed({ status: o.status as ActionOrder["status"], awb_code: o.awb_code ?? undefined }));
  if (verdicts.some((v) => v.ok)) return null;
  if (!verdicts.some((v) => !v.ok && v.reason === "booked")) return null;
  // Exactly one parcel is booked and the message carries no address yet: ask for it (the proposal flow takes the answer). Otherwise a person decides.
  const only = bookedOrderForAddressEdit(opts.ownOrders);
  const carriesAddress = /\b\d{6}\b/.test(opts.message) && opts.message.replace(/\s+/g, " ").trim().length >= 25;
  if (only && !carriesAddress) return { text: ADDRESS_ASK_REPLY, tag: "address_change", escalate: false, kind: "address_ask" };
  return { text: ADDRESS_FLAG_REPLY, tag: "address_change", escalate: true, kind: "address_flag" };
}

const ADDRESS_EDIT_CLOSED = new Set(["delivered", "cancelled", "wa_cancelled", "rto", "returned"]);
/** The one booked, still-open parcel an address proposal would be about; null when there is none or more than one (then a person decides which). */
export function bookedOrderForAddressEdit<T extends { id: string; status: string; awb_code?: string | null }>(orders: T[]): T | null {
  const c = orders.filter((o) => !!o.awb_code && !ADDRESS_EDIT_CLOSED.has(String(o.status)));
  return c.length === 1 ? c[0] : null;
}

// ── 3. size questions on an order in flight ──────────────────────────────────────────────────────────────────────

const IN_FLIGHT = new Set(["processing", "call_1", "call_2", "on_hold", "confirmed", "packed", "manifested", "shipped", "undelivered"]);

/** Not a question about the size: a statement, a return-policy question, or a return/exchange. */
const NOT_A_SIZE_QUESTION = /\b(let you know|return|exchange|refund|policy|didn'?t like|did not like|too (big|small|loose|tight|long|short)|is (small|big|loose|tight))\b/i;

const SIZE_QUESTION =
  /\b(what|which|whats|what's)\b.{0,12}\bsize\b|\bsize\s+of\b|\bsize\s*(mm|cm|inch|inches)\b|\bsizes?\s*\?|\b(ideal|exact|right|correct)\s+size\b|\b(tell|know|share|give)\b.{0,15}\bsize\b|\bhow (big|large|small)\b|\bhow long (is|are)\b/i;

/** Where the sizes are: the item's own product page when the order names it (one link per distinct item, at most 3), else the site. */
function sizeLine(orders: FlightOrder[]): string {
  const seen = new Set<string>();
  const items: { name: string; slug: string }[] = [];
  for (const o of orders) {
    if (!IN_FLIGHT.has(o.status)) continue;
    for (const it of o.items ?? []) {
      if (it?.slug && !seen.has(it.slug)) { seen.add(it.slug); items.push({ name: it.name || "your item", slug: it.slug }); }
    }
  }
  if (!items.length || items.length > 3) return SIZE_REPLY;
  if (items.length === 1) return `You can find the sizes of your item on its product page: https://www.ajuki.in/products/${items[0].slug}`;
  return "You can find the sizes of your items on their product pages:" + items.map((i) => `\n• ${i.name}: https://www.ajuki.in/products/${i.slug}`).join("");
}

export function sizeQuestionReply(opts: { message: string; ownOrders: FlightOrder[]; lastBotReply?: string | null }): TopicResult | null {
  if (!opts.ownOrders.some((o) => IN_FLIGHT.has(o.status))) return null;
  const last = opts.lastBotReply ?? "";
  const asks = SIZE_QUESTION.test(n(opts.message)) && !NOT_A_SIZE_QUESTION.test(n(opts.message));
  const afterFirst = last.startsWith(SIZE_REPLY.slice(0, 30));
  const afterInsist = last.startsWith(SIZE_INSIST_REPLY.slice(0, 30));
  // They were told where to look and are still asking: a team member is asked to find the exact size.
  if ((afterFirst || afterInsist) && (asks || /\b(please|plz|pls|but|still|exact|tell me|reply|again)\b|\?/i.test(n(opts.message)))) {
    return { text: SIZE_INSIST_REPLY, tag: "sizing", escalate: true, kind: "size_insist" };
  }
  return asks ? { text: sizeLine(opts.ownOrders), tag: "sizing", escalate: false, kind: "size" } : null;
}

// ── 4. discounts ─────────────────────────────────────────────────────────────────────────────────────────────────

const DISCOUNT = /\b(discounts?|coupons?|promo(code)?|offers?|bogo|sale|student (id|discount)|cashback|deal)\b/i;

/** A refund chase, a damage report or a cancellation that happens to use the word "offer" or "deal" is not a discount question. */
const NOT_A_DISCOUNT_QUESTION = /\b(?:refund\w*|return\w*|damag\w*|broken|defect\w*|complain\w*|disappoint\w*|cancel\w*|not (?:yet )?(?:received|delivered)|wrong (?:item|product))\b/i;

export function discountReply(opts: { message: string; tag: string; v2?: boolean }): TopicResult | null {
  if (opts.v2 && NOT_A_DISCOUNT_QUESTION.test(n(opts.message))) return null;
  if (!DISCOUNT.test(n(opts.message)) && opts.tag !== "offer_discount") return null;
  // A bare tag with no discount wording ("Please check", "More") is a reply to a campaign, which is left alone.
  if (!DISCOUNT.test(n(opts.message))) return null;
  return { text: DISCOUNT_REPLY, tag: "offer_discount", escalate: true, kind: "discount" };
}

// ── 5. a physical store or office ─────────────────────────────────────────────────────────────────────────────────────────
//
// AJUKI sells only online. "Where is the office?" / "can I visit your shop?" used to reach the model, which asked what they wanted
// from the office and flagged it to the team; a person then replied "we don't have a physical store".

const STORE_QUESTION =
  /\bwhere\s+(?:is|are)\s+(?:the|your|ur)\s+(?:office|shop|store|showroom|outlet|branch)\b|\b(?:your|ur|the)\s+(?:office|shop|store|showroom|outlet|branch)\s+(?:address|location|timings?)\b|\b(?:do\s+you|do\s+u|u|you)\s+have\s+(?:a|any)\s+(?:physical\s+|offline\s+)?(?:store|shop|showroom|outlet|office|branch)\b|\b(?:visit|come\s+to|walk[- ]?in)\b.{0,20}\b(?:store|shop|office|showroom|outlet)\b|\b(?:physical|offline)\s+(?:store|shop|outlet)\b/i;

export function noStoreReply(opts: { message: string }): TopicResult | null {
  if (!STORE_QUESTION.test(n(opts.message))) return null;
  return { text: NO_STORE_REPLY, tag: "product_info", escalate: false, kind: "no_store" };
}

// ── 2b. a phone number change once the parcel is with the courier ────────────────────────────────────────────────────

export const PHONE_ASK_REPLY = "Please type the new phone number you would like used. I have escalated this to the team.";

export const PHONE_GOT_REPLY = "Thank you. I have passed the new number to the team.";

/** The parcel the customer wants changed is coming back to us (RTO): no phone or address can change on it (the settled returning line). */
export const PHONE_RTO_REPLY = "Your parcel is on its way back to us, so it cannot be delivered again or changed now. You can place a new order at www.ajuki.in.";

/** They have an order that can still be changed and one that cannot: ask which, so the number is never put on the wrong parcel (14 Oct, #14 and #15). */
export const phoneWhichReply = (changeable: string[]): string =>
  `I can change the phone number on ${changeable.length === 1 ? "order" : "orders"} ${changeable.join(" or ")}, which ${changeable.length === 1 ? "has" : "have"} not been dispatched. Is that the one you mean?`;

const PHONE_CHANGE =
  /\b(?:change|changing|update|edit|correct|replace|wrong|galat)\b[^.?!]{0,18}\b(?:phone|mobile|contact|number)\b|\b(?:phone|mobile|contact)(?: number)?\b[^.?!]{0,18}\b(?:change|update|wrong|galat|badal)/i;

/** Same condition as the address rule: nothing of theirs can still be edited here and a parcel is with the courier. Before dispatch the model can do it. */
export function phoneChangeReply(opts: { message: string; ownOrders: FlightOrder[] }): TopicResult | null {
  const m = n(opts.message);
  if (NEGATED_ADDRESS.test(m) || !PHONE_CHANGE.test(m) || ADDRESS_CHANGE.test(m)) return null;
  const verdicts = opts.ownOrders.map((o) => cancellationAllowed({ status: o.status as ActionOrder["status"], awb_code: o.awb_code ?? undefined }));
  const changeable = opts.ownOrders.filter((_, i) => verdicts[i].ok).map((o) => o.id);
  const booked = verdicts.some((v) => !v.ok && v.reason === "booked");
  const coming = opts.ownOrders.some((o) => o.status === "rto" || o.status === "returned");
  // Something can still be changed AND something else cannot: which one? (If nothing else is in the way, the model does it, as before.)
  if (changeable.length && (booked || coming)) return { text: phoneWhichReply(changeable.slice(0, 3)), tag: "address_change", escalate: false, kind: "phone_which" };
  if (changeable.length) return null;
  if (booked) return { text: PHONE_ASK_REPLY, tag: "address_change", escalate: true, kind: "phone_flag" };
  if (coming) return { text: PHONE_RTO_REPLY, tag: "address_change", escalate: false, kind: "phone_rto" };
  return null;
}

/** First match wins, in the order a customer's message is most likely to be about. */
export function topicReply(opts: {
  message: string; tag: string; ownOrders: FlightOrder[]; lastBotReply?: string | null;
  /** SUPPORT_PIPELINE_V2: the matcher corrections from the 10 Oct replay (lib/pipelineV2.ts). Off = unchanged behaviour. */
  v2?: boolean;
}): TopicResult | null {
  return (
    sizeQuestionReply(opts) ??
    addressChangeReply(opts) ??
    phoneChangeReply(opts) ??
    discountReply(opts) ??
    complaintEmailReply(opts) ??
    noStoreReply(opts) ??
    productInfoReply(opts)
  );
}
