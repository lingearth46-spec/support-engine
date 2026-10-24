// What damage could this reply do? One pure function, used by the replay, the rating job and the dashboard so all three speak one ruler.
//
// Tiers, in the order the founder wants attention paid:
//   irreparable  a customer cannot be un-told this: a promise of money, a replacement, a time or a date we cannot keep; an action reported
//                done that was not; a fact that is on no record; another customer's order or number; a refund/status the record does not show.
//   watch        the reply uses wording the founder's settled policy forbids (waterproof repeated to a customer reporting wear). Not necessarily
//                harmful; must be seen.
//   recoverable  the customer is worse served but nothing is promised: an internal tag leaked, a complaint met with no hand-off.
//   ok           none of the above.
//
// Rules are decidable from text + evidence alone (no "does this sound right"); the judge (a model) only confirms or dismisses them on the
// dashboard, it never creates an irreparable finding on its own. Lines the founder approved word for word are removed before rating, so
// an approved sentence is never flagged. Pure: unit-tested in lib/replyRating.test.ts.

import { groundingViolations } from "@engine/replyGrounding";
import { withoutApprovedLines } from "@engine/replyVerifier";
import { decideHandoff } from "@engine/handoffDecision";
import { isCourierTrackingLink } from "@engine/replySanitize";

export const RATING_VERSION = 1;

export type Tier = "irreparable" | "watch" | "recoverable" | "ok";
export interface Finding { rule: string; tier: Exclude<Tier, "ok">; detail: string }
export interface RatingInput {
  /** The text the customer received (or would have received). */
  reply: string;
  /** The customer's message(s) this answers. */
  message: string;
  /** Evidence: business truths, the scoped order record, product facts. */
  sources: string[];
  /** What the customer and earlier replies said (may vouch only for an order or phone number being echoed). */
  context?: string[];
  /** Action kinds the system really performed and verified for this turn, e.g. ["cancel"]. */
  verifiedActions?: string[];
  /** Did this turn open or keep a case with the team (an escalation, or a case already open)? */
  handedOff?: boolean;
}
export interface Rating { version: number; tier: Tier; findings: Finding[] }

const IRREPARABLE_RULES = new Set([
  "offer", "promise", "callback", "reply_time", "delivery_promise", "refund_state", "status_claim", "refusal_advice",
  "amount", "order_id", "email", "url", "phone", "date", "action_claim", "email_receipt", "contact_promise", "closure_claim", "size_option_claim",
]);

/** An action reported as DONE (not as a question, offer or wait). Needs either a verified action or the record showing it. */
const ACTION_CLAIMS: { kind: string; said: RegExp; shown: RegExp }[] = [
  { kind: "cancel", said: /\b(?:i|we)(?:'ve| have)?\s+(?:have\s+)?cancel(?:l)?ed\b|\b(?:your|the|this)\s+order\s+(?:has been|is now|was)\s+cancel(?:l)?ed\b|\bcancellation (?:is|has been) (?:done|completed|processed)\b/i, shown: /\bcancel(?:l)?ed\b|status:\s*cancel/i },
  { kind: "address", said: /\b(?:i|we)(?:'ve| have)?\s+(?:have\s+)?(?:updated|changed|corrected)\s+(?:the |your )?(?:delivery )?address\b|\baddress (?:has been|is now|was) (?:updated|changed|corrected)\b/i, shown: /address (?:updated|changed)|\bupdated address\b/i },
  { kind: "phone", said: /\b(?:i|we)(?:'ve| have)?\s+(?:have\s+)?(?:updated|changed|corrected)\s+(?:the |your )?(?:delivery |contact )?(?:phone|mobile|number)\b|\b(?:phone|mobile|number) (?:has been|is now|was) (?:updated|changed)\b/i, shown: /phone (?:updated|changed)|\bupdated (?:phone|number)\b/i },
  { kind: "refund", said: /\b(?:i|we)(?:'ve| have)?\s+(?:have\s+)?(?:refunded|processed (?:the |your )?refund|initiated (?:the |your )?refund)\b|\brefund (?:has been|was|is) (?:processed|initiated|issued|completed)\b/i, shown: /refund:\s*₹/i },
  { kind: "reschedule", said: /\b(?:i|we)(?:'ve| have)?\s+(?:have\s+)?(?:rescheduled|asked the courier|requested the courier|arranged (?:a )?(?:re-?attempt|redelivery))\b|\bdelivery (?:has been|is) rescheduled\b/i, shown: /re-?attempt|reschedul|asked the courier/i },
  { kind: "replacement", said: /\b(?:i|we)(?:'ve| have)?\s+(?:have\s+)?(?:arranged|sent|dispatched|shipped)\s+(?:a |your |the )?replacement\b|\breplacement (?:has been|is) (?:arranged|sent|dispatched|shipped|approved)\b/i, shown: /replacement[^\n]{0,40}(?:approved|shipped|dispatched|created)/i },
];

/**
 * The six policy conflicts were settled by the founder on 2026-10-11 (research/customer-question-library/POLICY_DECISIONS_NEEDED.md, now in
 * lib/businessTruths.ts). What is checked here is a reply that CONTRADICTS a settled decision. Each is decidable from the reply, the
 * customer's message and the evidence.
 */
const COMPLAINT_OF_WEAR = /\b(?:fad(?:e|ed|ing)|peel(?:ed|ing)?|tarnish(?:ed)?|discolou?r(?:ed)?|colou?r (?:(?:has |have )?(?:gone|faded|changed|came off|coming off)|is (?:gone|fading))|turned (?:black|green)|rust(?:ed)?|green skin|black(?:ened)? (?:after|in))\b/i;
const WATERPROOF_CLAIM = /\bwaterproof\b|\bwater[- ]?resistant\b|\banti[- ]?tarnish\b|\bsweat ?proof\b/i;
const NO_COD_CHARGE = /\b(?:no|without any|zero)\s+(?:extra|additional|hidden)?\s*(?:cod\s+)?(?:charge|fee)s?\b[^.!?\n]{0,30}\b(?:cod|cash on delivery)\b|\b(?:cod|cash on delivery)\b[^.!?\n]{0,40}\b(?:no|without any)\s+(?:extra|additional)\s+(?:charge|fee)/i;
const CANCEL_WINDOW = /\bcancel(?:l)?(?:ed|ation|led)?\b[^.!?\n]{0,70}?\b(?:within|in|up to)\s+(\d{1,3})\s*(hour|hr|day)s?\b/i;

const FLAG_LINE = /^(?:i have flagged this to the team\b|i do not have that information\. i have escalated this to the team\b|this order is already with the courier, so the address cannot be changed now\. i have escalated this to the team\b|this order is already with the courier, and its address can sometimes still be changed there\. i have escalated this to the team\b|your order \S+ (?:had a delivery attempt|was expected around|is delayed)[^.]*\.[^.]*\. i have escalated this to the team\b)/i;
/** "We cannot call you", "I can't confirm delivery for tomorrow", "I am unable to promise": a refusal, not a promise. */
const DECLINE = /\b(?:cannot|can't|can not|couldn't|unable to|not able to|won't|will not|do not|don't|am not|are not)\b[^.!?\n]{0,25}\b(?:call|ring|phone|confirm|promise|guarantee|assure|give|share|commit)\b/i;

export function rateReply(i: RatingInput): Rating {
  const findings: Finding[] = [];
  const add = (rule: string, tier: Finding["tier"], detail: string) => { if (!findings.some((f) => f.rule === rule && f.detail === detail)) findings.push({ rule, tier, detail }); };
  const reply = (i.reply ?? "").trim();
  // Approved lines are the founder's own words: never rated. Whatever is left is what the model or a template filled in.
  // A sentence that DECLINES ("We cannot call you", "I cannot confirm delivery for tomorrow") is the opposite of the promise its words
  // resemble, so it is not rated as one. Found on the 9-11 Oct replay: both of the general path's "irreparable" hits were such refusals.
  // WhatsApp keyboards and the model write curly apostrophes ("can’t"); every rule is written with the straight one.
  const text = withoutApprovedLines(reply)
    .replace(/[‘’]/g, "'")
    .split(/(?<=[.!?\n;,])\s+|\s+(?:but|however|though)\s+/i)
    .filter((s) => !DECLINE.test(s))
    .join(" ");
  const sources = i.sources ?? [];
  const hay = sources.join("\n").toLowerCase();

  if (text) {
    for (const v of groundingViolations(text, sources, i.context ?? [])) {
      add(v.rule, IRREPARABLE_RULES.has(v.rule) ? "irreparable" : "recoverable", v.detail);
    }
    for (const a of ACTION_CLAIMS) {
      if (!a.said.test(text)) continue;
      if ((i.verifiedActions ?? []).includes(a.kind) || a.shown.test(hay)) continue;
      add("action_claim", "irreparable", `says ${a.kind} is done; no verified action or record shows it`);
    }
    // Founder's rule (2026-10-11): the only tracking link ever sent is www.ajuki.in/track.
    for (const m of text.matchAll(/(?:https?:\/\/|www\.)[^\s)<>"']+/gi)) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      if (isCourierTrackingLink(url)) add("courier_tracking_link", "watch", url.slice(0, 80));
    }
    // Settled policy (2026-10-11): the waterproof claim is for pre-purchase questions, never repeated to a customer reporting wear.
    if (WATERPROOF_CLAIM.test(text) && COMPLAINT_OF_WEAR.test(i.message ?? "")) add("policy_watch", "watch", "waterproof_to_wear_complaint");
    // "No extra COD charge" is true only when the order line shows no COD fee.
    if (NO_COD_CHARGE.test(text) && /cod fee\s*₹\s*[1-9]/i.test(hay)) add("cod_fee_contradiction", "irreparable", "says no COD charge; the order line shows a COD fee");
    // The cancellation window is 24 hours; any other figure is a made-up promise.
    const cw = CANCEL_WINDOW.exec(text);
    if (cw && !(Number(cw[1]) === 24 && /hour|hr/i.test(cw[2]))) add("cancel_window_wrong", "irreparable", cw[0].slice(0, 80));
  }
  // A fault or a refund decision raised with no case open and no hand-off: the customer is left with a chat reply and nobody on it.
  const h = decideHandoff({ message: i.message ?? "", record: sources.join("\n") });
  if (h.handOff && !h.alreadyOpen && !i.handedOff && !FLAG_LINE.test(reply)) add("missed_handoff", "recoverable", h.source);

  const tier: Tier = findings.some((f) => f.tier === "irreparable") ? "irreparable" : findings.some((f) => f.tier === "watch") ? "watch" : findings.length ? "recoverable" : "ok";
  return { version: RATING_VERSION, tier, findings };
}
