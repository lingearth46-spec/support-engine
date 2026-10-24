// Run with `npx tsx lib/clarifyReplies.test.ts`.
// The three guesses of 10 Oct that become a pointer or a clarifying question: the language question (E2), "Confirm" on a prepaid-only
// order (C), and a one-word fragment (F).
import { languageReply, payLinkConfirmReply, ambiguousFragmentReply, LANGUAGE_REPLY, PAY_LINK_REPLY, AMBIGUOUS_REPLY } from "./clarifyReplies";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

// ── language ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("E2: the real message", languageReply("You know bengali ?")?.text, LANGUAGE_REPLY);
eq("do you speak tamil", languageReply("Do you speak Tamil?")?.text, LANGUAGE_REPLY);
eq("Hinglish form", languageReply("bengali me baat kar sakte ho")?.text, LANGUAGE_REPLY);
eq("a long message that mentions a place is not a language question", languageReply("Please deliver to Bengali Market near the metro station, flat 12, second floor, ring the bell"), null);
eq("English / Hindi are languages we do reply in: not this", languageReply("do you know hindi"), null);
eq("nothing about language", languageReply("Where is my order?"), null);

// ── "Confirm" on a prepaid-only order ───────────────────────────────────────────────────────────────────────────────────────
const PROMPT = "Hi Asha, about your AJUKI order #AJUKI710021. Earlier orders to this number came back to us undelivered, so we can only send this one as a prepaid order. Tap below to pay ₹499 and we will pack it today.";
eq("C: 'Confirm' after our payment message", payLinkConfirmReply({ message: "Confirm", recentOut: [PROMPT], orderStatus: "on_hold" })?.text, PAY_LINK_REPLY);
eq("C: 'yes' too", payLinkConfirmReply({ message: "Yes", recentOut: [PROMPT], orderStatus: "on_hold" })?.text, PAY_LINK_REPLY);
eq("the reply offers no COD, no cancel/keep and no 'I'll do it'", /\bCOD\b|cancel|keep|I'll|I will/i.test(PAY_LINK_REPLY), false);
eq("no payment message before it: not this", payLinkConfirmReply({ message: "Confirm", recentOut: ["Your order has shipped."], orderStatus: "on_hold" }), null);
eq("the order is no longer waiting for payment: not this", payLinkConfirmReply({ message: "Confirm", recentOut: [PROMPT], orderStatus: "shipped" }), null);
eq("a sentence is not a bare confirmation", payLinkConfirmReply({ message: "Confirm but change the address", recentOut: [PROMPT], orderStatus: "on_hold" }), null);

// ── a fragment ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("F: 'Sunday'", ambiguousFragmentReply("Sunday")?.text, AMBIGUOUS_REPLY);
eq("'tomorrow'", ambiguousFragmentReply("Tomorrow")?.text, AMBIGUOUS_REPLY);
eq("'Sir ji'", ambiguousFragmentReply("Sir ji")?.text, AMBIGUOUS_REPLY);
eq("'Contact no' carries a known word: left to the model", ambiguousFragmentReply("Contact no"), null);
eq("'Gh'", ambiguousFragmentReply("Gh")?.text, AMBIGUOUS_REPLY);
eq("a greeting is not a fragment", ambiguousFragmentReply("Hello"), null);
eq("a thank-you is not a fragment", ambiguousFragmentReply("Thanks"), null);
eq("an order intent is not a fragment", ambiguousFragmentReply("Cancel"), null);
eq("a number is not a fragment", ambiguousFragmentReply("395009"), null);
eq("three words is a message", ambiguousFragmentReply("please help me"), null);
eq("the clarifying reply asks and promises nothing", /will|'ll|refund|replace|team/i.test(AMBIGUOUS_REPLY), false);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
