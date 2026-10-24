// What kind of statement is each sentence of a reply — so the verifier asks for evidence where evidence belongs.
//
// The judge (lib/groundingJudge.ts) was told to list every sentence that "gives advice or instructions" and is not supported. On
// 10 Oct that made it reject "please send the new full address with pincode", "I don't have a reference number here" and "Please
// wait for their reply" — requests and honest statements of what is NOT on record, which need no evidence — and the customer got
// "I have flagged this to the team" instead of a useful answer (19 of 122 model replies that day, 17 of them for this reason).
//
// The kinds, and what each needs:
//
//   request          Asks the customer for what is needed to handle THEIR own request (address details, order number, a photo).
//                    No evidence needed. Exempt — but only when the sentence promises nothing: "send it and I'll update it" is
//                    two sentences, and the second is a commitment.
//   question         Ends in "?". No evidence needed. (An offer phrased as a question is still caught by the mechanical gate.)
//   empathy          Greeting, apology, thanks, acknowledgement. No evidence needed.
//   wait_instruction "Please wait for their reply." Exempt ONLY when the evidence shows something is actually open with the team
//                    (a support case, a return or refund in progress). Otherwise it is a claim that someone will reply.
//   action_promise   "I'll update it", "it will not be cancelled", "main change kar dunga". NEVER exempt: it needs the action to be
//                    in progress (openaiSupport adds an ACTION BEING PERFORMED line) or it is a promise nobody can keep.
//   persona_rule     "I can help in English and Hinglish" — what the persona itself says about language. Exempt; any other language is not.
//   inability        "I don't have / can't see X". Exempt for a payment reference when the record has none; otherwise judged against the evidence.
//   factual          Everything else: a fact about an order, parcel, payment, refund, return, case, product or policy. Needs evidence.
//
// Deliberately conservative: when a sentence is not clearly one of the exempt kinds it is `factual` and the judge decides. This
// module only ever REMOVES work from the judge for the kinds that cannot be evidenced; it never approves a claim. Pure, so every
// rule is unit-tested.

export type ClaimKind = "request" | "question" | "empathy" | "persona_rule" | "wait_instruction" | "action_promise" | "inability" | "factual";

const norm = (s: string) => (s ?? "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

export function splitReplySentences(text: string): string[] {
  return norm(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The customer is asked for something the reply's own subject needs. */
const DETAIL_NOUN =
  /\b(address|adress|pincode|pin code|pin|landmark|flat|house|street|area|city|state|order (?:id|number|no)|order|number|phone|mobile|contact|photos?|pictures?|videos?|screenshots?|details?|name|e-?mail|reference|invoice|utr|proof)\b/i;
const REQUEST_VERB =
  /\b(please|kindly|pls|plz)\b|^(?:can|could|would) you\b|^(?:send|share|reply|tell|write|type|mention|provide|give|confirm|attach|upload|email|forward)\b|\b(bhej|bhejo|bhej do|bhej dijiye|bhejiye|batao|bata do|bataiye|bata dijiye|likh|likhiye|share kar|send kar|de do|dijiye)\b/i;

/** Commitment or outcome: what we or the team WILL do, or what has happened to the order. */
const PROMISE =
  /\b(?:i|we)\s*(?:'ll|will|shall|can)\s+(?:also\s+|then\s+|just\s+)?(?:update|change|cancel|refund|replace|dispatch|ship|deliver|arrange|process|fix|correct|edit|reschedule|book|call|get back|let you know|check with|take care|raise|escalate|send you)\b|\b(?:it|this|the order|your order|that)\s+(?:will|is going to)\s+(?:not\s+)?(?:be\s+)?(?:cancel(?:l)?ed|updated|changed|refunded|replaced|dispatched|shipped|delivered|processed|fixed|corrected)\b|\bwill (?:not )?be (?:cancel(?:l)?ed|updated|changed|refunded|replaced)\b|\bkar (?:dunga|dungi|denge|dege)\b|\bmain\b[^.!?]{0,30}\bkar (?:dunga|dungi)\b/i;

const WAIT = /\b(?:please\s+)?wait\s+(?:for|until|till)\s+(?:their|the team'?s?|our|the|a)\b[^.!?]{0,25}\b(?:reply|response|update|decision|call)\b|\bplease\s+wait\b[^.!?]{0,10}$|\bplease wait for (?:their|the) reply\b/i;

const EMPATHY =
  /^(?:hi|hello|hey|namaste|namaskar|dear [a-z ]{1,25}|thanks?|thank you|ok(?:ay)?|sure|got it|noted|understood|no problem|of course|bilkul|theek hai|thik hai|samajh gaya|samajh gayi|sorry|i'?m (?:so |really |very )?sorry|we'?re (?:so |really |very )?sorry|apolog|i understand|i hear you|that must|i know)\b[^.!?]{0,60}[.!]?$/i;

/** What the persona itself says about language: replies are in English, or Hinglish in Latin letters. A statement of that is the
 *  persona's own rule, not a claim about the business; a claim about ANY OTHER language is not covered and goes to the judge. */
const LANGUAGE_RULE = /\b(?:i|we) can (?:help|reply|write|talk|chat|assist|respond)\b[^.!?]{0,40}\b(?:english|hinglish|hindi)\b(?![^.!?]{0,40}\b(?:bengali|bangla|tamil|telugu|kannada|malayalam|marathi|gujarati|punjabi|odia|urdu)\b)/i;

const INABILITY = /\bi (?:don'?t|do not|can'?t|cannot|couldn'?t|am not able to|'m not able to) (?:see|find|have|share|confirm|provide)\b|\b(?:not|isn'?t|aren'?t) (?:on|in) (?:the |our |your )?(?:record|order|system)\b|\b(?:no|isn'?t any) (?:reference|transaction|utr|arn|record)\b/i;

export function classifySentence(raw: string): ClaimKind {
  const s = norm(raw);
  if (!s) return "empathy";
  if (PROMISE.test(s)) return "action_promise";
  if (/\?\s*[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]*$/u.test(s)) return "question";
  if (WAIT.test(s)) return "wait_instruction";
  if (INABILITY.test(s)) return "inability";
  // A line that names an email address or a link is a ROUTE (where to go), which is a policy statement: not a plain request.
  if (REQUEST_VERB.test(s) && DETAIL_NOUN.test(s) && !/\b(refund|cancel|deliver|ship|dispatch)ed?\b/i.test(s) && !/@|https?:|www\./i.test(s)) return "request";
  if (LANGUAGE_RULE.test(s)) return "persona_rule";
  if (EMPATHY.test(s) && s.length < 90) return "empathy";
  return "factual";
}

/** A bank/payment reference present in the evidence (a UTR, ARN, RRN or a reference/transaction id with a value). */
const HAS_REFERENCE = /\b(?:utr|arn|rrn|reference(?: no| number| id)?|transaction(?: id| ref| no| number)?)\b[^\n]{0,20}[A-Z0-9]{6,}/i;
const ABSENCE_ABOUT_REFERENCE = /\b(?:reference|transaction|utr|arn|rrn)\b/i;

/**
 * Sentences of `reply` the verifier must NOT list as unsupported.
 *
 *  · request / question / empathy / persona_rule — never need evidence.
 *  · wait_instruction — only when the evidence shows something open with the team (`openCase`).
 *  · inability about a payment reference — only when the evidence really contains none. "I don't have a reference number" is a
 *    true statement exactly when the record has none; it is left to the judge when the record has one.
 */
export function exemptSentences(reply: string, o: { openCase: boolean; evidence?: string[] }): string[] {
  const out: string[] = [];
  const hay = (o.evidence ?? []).join("\n");
  for (const sent of splitReplySentences(reply)) {
    const k = classifySentence(sent);
    if (k === "request" || k === "question" || k === "empathy" || k === "persona_rule") out.push(sent);
    else if (k === "wait_instruction" && o.openCase) out.push(sent);
    else if (k === "inability" && o.evidence && ABSENCE_ABOUT_REFERENCE.test(sent) && !HAS_REFERENCE.test(hay)) out.push(sent);
  }
  return out;
}

/**
 * Statements that are unsupported by their KIND, decided without the judge:
 *  · an action promise or outcome claim ("I'll update it", "it will not be cancelled") when the evidence carries no
 *    "ACTION BEING PERFORMED" line — nothing is carrying the action out, so nobody can keep the promise;
 *  · "please wait for their reply" when nothing is open with the team.
 * The judge is not asked about these: a model reader is the wrong tool for a rule that has one right answer, and on the 10 Oct
 * labelled set it let 1 of 3 Hinglish promises and 2 of 3 unfounded waits through.
 */
export function unsupportedByKind(reply: string, o: { openCase: boolean; evidence: string[] }): string[] {
  const acting = o.evidence.some((e) => /ACTION BEING PERFORMED/.test(e ?? ""));
  const out: string[] = [];
  for (const sent of splitReplySentences(reply)) {
    const k = classifySentence(sent);
    if (k === "action_promise" && !acting) out.push(sent);
    else if (k === "wait_instruction" && !o.openCase) out.push(sent);
  }
  return out;
}

/**
 * Does `text` still say something specific to this customer — an order number, an amount, a date or a link? Used when a hand-off
 * loses an unsupported sentence: a remainder with this is worth sending (after it passes the checks again); a generic line is not.
 */
export function hasSubstance(text: string): boolean {
  return /\bAJUKI\d{4,10}\b|₹\s?\d|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|(?:https?:\/\/|www\.)\S+/i.test(text ?? "");
}

/** Does the evidence show something open with the team — a support case, or a return/refund in progress? */
export function teamHasItOpen(evidence: string[]): boolean {
  const hay = evidence.join("\n");
  return /support case|case (?:was )?raised|open case|already with the team|return request is|return (?:is )?(?:approved|pending)|refund:\s*₹[^\n]{0,40}in progress|senior support team is already|escalat/i.test(hay);
}
