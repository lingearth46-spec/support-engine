// Messages that are not from a customer: another business's automatic greeting, or spam written to look like one.
//
// A WhatsApp Business account that has an away/greeting message answers the first message it receives, and ours is sent
// messages like "Thank you for contacting Karthik! Please let us know how we can help you." — by people who typed our number
// into a chat, or by a customer's own business account. The bot answered it ("Thanks for reaching out, Vishal! How can I help
// you today?"), which can set two automatic replies talking to each other for good. On 9 Oct it also answered a scam menu
// ("Use Another Card / Limit Increase") as if it were a customer and opened a case for it.
//
// Both are recognised by the message itself, conservatively: a greeting must open the way a business greeting opens AND
// offer help the way one does, so a customer writing "thank you for contacting me" is never mistaken for one. Pure, so every
// rule is unit-tested; the decision of what to do lives in lib/waSupport.ts.

export type NotACustomer = "auto_reply" | "spam";

const norm = (s: string) => (s ?? "").replace(/[*_~`]/g, " ").replace(/\s+/g, " ").trim();

/** How a business greeting opens: "Thank you for contacting …", "Welcome to …", "Hello, thanks for reaching out to …". */
const OPENS = /^(?:hi+|hello+|hey+|dear [a-z ]{1,30})?[\s,!.-]*(?:thank(?:s| you)(?: so much)?(?: very much)? for (?:contacting|reaching out(?: to)?|messaging|writing(?: to)?|getting in touch(?: with)?|your (?:message|enquiry|inquiry|interest))|welcome to)\b/i;

/** A real customer talking TO us: "thank you for contacting me / back". ("…contacting us" is what a business greeting says, so it is not listed.) */
const ADDRESSED_TO_US = /\bthank(?:s| you) for (?:contacting|reaching out|messaging|writing|getting in touch)(?: to)? (?:me|back)\b/i;

/** What a greeting then says: it offers help or says when it will answer. */
const OFFERS_HELP =
  /\b(?:how (?:can|may|could) (?:i|we) (?:help|assist)|let (?:us|me) know how (?:we|i) can (?:help|assist)|tell me how can i help|how can i be of (?:help|assistance)|we(?:'| wi)?ll (?:get back|respond|reply|be in touch)|will (?:get back|respond|reply) (?:to you )?(?:shortly|soon|as soon)|our (?:business|working|office) hours|currently (?:closed|unavailable|away|out of office)|this is an automated|auto[- ]?reply|automated (?:message|response|reply))\b/i;

/** Promotional wording: an app to download, an instant cashback, a coupon or referral code. */
const PROMO = /(?:(?:download|install)\b.{0,60}\bapp\b)|(?:₹\s?\d+\s*(?:instant|cashback|off\b))|(?:\bcash ?back\b.{0,40}\b(?:app|upi)\b)|(?:\b(?:use|apply) (?:code|coupon)\b)|(?:\brefer(?:ral)? (?:code|and earn)\b)/i;
/** Anything that says the message is about us or an order. */
const ABOUT_US = /\b(?:ajuki|order|parcel|bracelet|chain|pendant|delivery|courier|refund|return|tracking|awb)\b/i;

/** A menu of numbered options — what a scam or an IVR-style bot sends. */
const NUMBERED_MENU = /(?:^|\s)1[.)]\s*\S.*(?:^|\s)2[.)]\s*\S/i;

/** Topics scam menus are about. None of them is something AJUKI sells or supports. */
const SPAM_TOPICS = /\b(?:credit card|debit card|use another card|limit increase|card limit|loan|insurance|lottery|prize|crypto|forex|invest(?:ment)?|trading|kyc|apply (?:now|for)|earn (?:₹|rs\.?)? ?\d)/i;

/**
 * Is this message from something that is not a customer talking to us? Null means: treat it as a customer.
 *
 * `auto_reply` — another business's greeting; no answer, no alert. `spam` — a scam or promotional menu; no answer, but left
 * unread so a person can see it.
 */
export function notACustomer(message: string | null | undefined): NotACustomer | null {
  const t = norm(message ?? "");
  if (t.length < 20 || t.length > 600) return null;
  if (ADDRESSED_TO_US.test(t)) return null;

  const greeting = OPENS.test(t) && OFFERS_HELP.test(t);
  if (greeting && (SPAM_TOPICS.test(t) || NUMBERED_MENU.test(t))) return "spam";
  if (greeting) return "auto_reply";
  // A forwarded advert (an app's cashback offer, a coupon chain): promotional wording AND no word about an order, a parcel or AJUKI. Left
  // unread for a person, no answer ("Thanks for sharing!" was sent to one on 12 Oct).
  if (t.length >= 120 && PROMO.test(t) && !ABOUT_US.test(t)) return "spam";
  // A scam menu that does not bother with a greeting: a numbered menu about cards/loans/limits.
  if (NUMBERED_MENU.test(t) && SPAM_TOPICS.test(t)) return "spam";
  return null;
}
