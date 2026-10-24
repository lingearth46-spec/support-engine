// What must never reach a customer.
//
// The two placeholder cases and all five Devanagari cases below are verbatim from
// wa_messages — they were sent to real people. Everything asserted as *safe* is
// also real, taken from the same table, because the cost of this module getting
// over-eager is a good reply replaced by "I've escalated it to my senior".

import { checkReply } from "./replyCheck";

let passed = 0;
let failed = 0;
const eq = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${e}, got ${a}`); }
};
const rule = (text: string | null | undefined) => checkReply(text)?.rule ?? null;

// ── The two that actually shipped ─────────────────────────────────────────────
eq("real leak 1", rule(
  "Your order #AJUKI710086 is expected to be delivered around August 3rd. " +
  "You can track its journey here: [no tracking link available in provided data]."), "placeholder");
eq("real leak 2", rule(
  "Your order #AJUKI710053 is expected to be delivered around August 11th. " +
  "You can track its journey here: [No tracking link available in context]."), "placeholder");

// ── Other placeholder syntaxes the model has been trained on ──────────────────
// {{1}} is what our own WhatsApp templates look like; <first name> is quoted in
// the email persona as the salutation to write, so copying it out is the exact
// failure to expect.
eq("mustache", rule("Hi {{name}}, your order is on its way."), "placeholder");
eq("angle slot", rule("Hi <first name>,\n\nThanks for writing in."), "placeholder");
eq("bracketed instruction", rule("Sure! [insert tracking link here]"), "placeholder");
eq("bracketed apology", rule("[No order details were provided]"), "placeholder");

// ── ...and the prose that must NOT trip it ────────────────────────────────────
// The whitespace requirement is doing the work here. A bracketed *phrase* is the
// model talking to itself; bracketed punctuation is just writing.
eq("footnote marker is fine", rule("Your bracelet [1] is on its way."), null);
eq("single mustache word is fine", rule("Use code {SAVE50} at checkout."), null);
eq("less-than in prose is fine", rule("Delivery is usually <7 days."), null);
eq("a real tracking link is fine", rule(
  "Your order AJUKI710074 is on its way! You can track it here: " +
  "https://tracker.shadowfax.in/#/track/SF3667650092JKE"), null);
eq("an address read back is fine", rule(
  "Your order #AJUKI710032 is delivering to: The Altruist Business Hotel Whitefield " +
  "12 Example Main Road, Room no 6, Bengaluru, Karnataka, 560001."), null);
eq("emoji are fine", rule("So glad you love it! 😊"), null);

// ── Script ────────────────────────────────────────────────────────────────────
// All five went out on 26-27 July, before the English-only rule existed.
for (const t of [
  "आपका ऑर्डर AJUKI710048 28 जुलाई तक पहुंचने की उम्मीद है!",
  "खुशी है कि मैं मदद कर पाई! 😊",
  "मुझे अफ़सोस है कि आपको अपना ऑर्डर वापस करना पड़ रहा है।",
]) eq(`devanagari: "${t.slice(0, 20)}…"`, rule(t), "script");

// The rule is about the script, not the language. 20 inbound messages are
// Hinglish in Latin letters and a reply in kind renders fine on every handset.
eq("hinglish in latin is fine", rule("Aapka order kal tak pahunch jayega!"), null);
eq("a Hindi word transliterated is fine", rule("Shukriya! Let us know if you need anything else."), null);

// ── Empty ─────────────────────────────────────────────────────────────────────
eq("empty", rule(""), "empty");
eq("whitespace only", rule("   \n  "), "empty");
eq("null", rule(null), "empty");
eq("undefined", rule(undefined), "empty");

// ── The detail is carried, so a rejection can be read in the logs ─────────────
eq("detail names the offending span",
  checkReply("Track it here: [no tracking link available]")?.detail,
  "[no tracking link available]");
eq("detail is truncated", (checkReply(`[${"x ".repeat(200)}]`)?.detail ?? "").length, 80);
eq("empty carries no detail", checkReply("")?.detail, "");

// ── Ordinary replies, straight from the table, all of which must pass ─────────
for (const t of [
  "Hi there! 👋 How can I help you today?",
  "Yes, your order #AJUKI710017 for the Micro Rope Chain Bracelet - Silver was delivered on July 14th. 😊",
  "We accept returns only if the product you received was defective or damaged.",
  "Your order AJUKI710010 is expected to arrive around August 2nd. ✨",
  "I'm really sorry for the trouble 🙏 I've escalated it to my senior, who will get back to you shortly.",
  "Yes, we have the Tulip Pendant - Gold! It's ₹899, in stock, and comes in Gold colour. " +
    "You can find it here: https://www.ajuki.in/products/tulip-pendant---gold",
]) eq(`safe: "${t.slice(0, 32)}…"`, rule(t), null);

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
