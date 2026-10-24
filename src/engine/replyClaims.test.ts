// Run with `npx tsx lib/replyClaims.test.ts`.
// Which sentences of a reply need evidence and which do not (10 Oct replay: the judge blocked requests for address details,
// "I don't have a reference number" and "please wait for their reply").
import { classifySentence, exemptSentences, splitReplySentences, teamHasItOpen, hasSubstance, unsupportedByKind } from "@engine/replyClaims";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const kind = classifySentence;

// ── requests for what the customer's own request needs: exempt ─────────────────────────────────────────────────────────────
eq("A1: a request for the new address", kind("Please send the new full address with pincode."), "request");
eq("A1: the Hinglish form from the replay", kind("Naya address bhej do please: house/line1, landmark/line2, city aur pincode."), "request");
eq("A1: another Hinglish form", kind("Please new full address bhej dijiye: house/flat no., area, city, state aur pincode"), "request");
eq("a request for the order number", kind("Could you share your order number?"), "question");
eq("a request for a photo", kind("Please send a photo of the item."), "request");

// ── …but a promise riding with it is NOT exempt ──────────────────────────────────────────────────────────────────────────────
eq("the promise half of the A1 draft", kind("I'll update it for your order."), "action_promise");
eq("the Hinglish promise half", kind("Main change kar dunga."), "action_promise");
eq("B1: the outcome claim that was wrong", kind("Understood — it will not be cancelled."), "action_promise");
eq("B1: the other wording", kind("The order will not be cancelled."), "action_promise");
eq("a request that names a refund is not a plain request", kind("Please send the details and we will refund it."), "action_promise");
const a1 = "Of course — please send the new full address with pincode, and I'll update it for your order.";
eq("A1 as one sentence: the promise rides with the request, so nothing is exempt and the judge sees all of it",
  exemptSentences(a1, { openCase: false }), []);
eq("A1 as two sentences: only the request is exempt, the promise still goes to the judge",
  exemptSentences("Please send the new full address with pincode. I'll update it for your order.", { openCase: false }),
  ["Please send the new full address with pincode."]);

// ── honest statements of what is not on record: judged against the evidence, not exempt ────────────────────────────────────
eq("missing reference number", kind("I don't have a transaction/reference number here."), "inability");
eq("missing reference, other wording", kind("I can't see any refund reference number on the order line."), "inability");
eq("a missing-reference sentence is NOT exempted (the judge checks it against the record)",
  exemptSentences("I don't have a transaction/reference number here.", { openCase: true }), []);

// ── waiting for the team ───────────────────────────────────────────────────────────────────────────────────────────────────
eq("pending-reply instruction", kind("Please wait for their reply."), "wait_instruction");
eq("exempt only when something is open", exemptSentences("Please wait for their reply.", { openCase: true }), ["Please wait for their reply."]);
eq("not exempt with nothing open", exemptSentences("Please wait for their reply.", { openCase: false }), []);
eq("open case is recognised from the order line", teamHasItOpen(["Already with the team: 1 open — late delivery raised 9 Oct"]), true);
eq("a refund in progress counts as open", teamHasItOpen(["refund: ₹634 in progress since 4 Oct"]), true);
eq("nothing open", teamHasItOpen(["#AJUKI710013 · shipped · ₹499 · expected around 12 Oct"]), false);

// ── empathy, questions: exempt; facts: not ─────────────────────────────────────────────────────────────────────────────────────
eq("apology", kind("I'm sorry this has been frustrating."), "empathy");
eq("question", kind("Do you want the same chain again?"), "question");
eq("a fact about the order", kind("Your refund of ₹634 is in progress since 4 Oct."), "factual");
eq("a policy statement", kind("Orders can only be cancelled within 24 hours."), "factual");
eq("a timing claim", kind("It will reach you by tomorrow."), "factual");
eq("a status claim", kind("Your order is out for delivery."), "factual");

// ── Bengali (E2): the persona's own rule, not a claim about the business ─────────────────────────────────────────────────────
eq("'I can help in English and Hinglish' is the persona's own rule: exempt", kind("I can help in English and Hinglish."), "persona_rule");
eq("…but a claim about another language is not", kind("I can help in Bengali."), "factual");
eq("…and is not exempted", exemptSentences("I can reply in Bengali too.", { openCase: true }), []);
eq("a route (an email address) is a policy statement, not a plain request",
  kind("For a damaged item, please email our Senior Support Team at ajukisupport@gmail.com with your order number and details."), "factual");
// (the Bengali question itself is answered by a fixed reply — lib/clarifyReplies.ts — so it never reaches the judge)

// ── absence of a payment reference is checked against the record, deterministically ───────────────────────────────────────────
const NOREF = ["#AJUKI710005 · cancelled · ₹634 · refund: ₹634 in progress since 4 Oct"];
const WITHREF = ["#AJUKI710005 · cancelled · refund: ₹634 completed 6 Oct · bank reference UTR 412345678901"];
eq("no reference in the record: 'I don't have one' needs no judge",
  exemptSentences("I don't have a transaction/reference number here.", { openCase: false, evidence: NOREF }), ["I don't have a transaction/reference number here."]);
eq("a reference IS in the record: the statement goes to the judge",
  exemptSentences("I don't have a reference number for this refund.", { openCase: false, evidence: WITHREF }), []);
eq("'can't see a reference number on the order line'",
  exemptSentences("I can't see a reference number on the order line.", { openCase: false, evidence: NOREF }).length, 1);

// ── promises and unfounded waits are unsupported by their KIND ────────────────────────────────────────────────────────────────
eq("an action promise with no action in progress", unsupportedByKind("Main change kar dunga.", { openCase: false, evidence: ["#AJUKI1 · processing"] }), ["Main change kar dunga."]);
eq("…is supported when the action is being performed",
  unsupportedByKind("I'll update the address.", { openCase: false, evidence: ["ACTION BEING PERFORMED: the system is carrying out \"change_address\""] }), []);
eq("a wait with nothing open", unsupportedByKind("Please wait for their reply.", { openCase: false, evidence: ["#AJUKI1 · shipped"] }), ["Please wait for their reply."]);
eq("a wait with a case open", unsupportedByKind("Please wait for their reply.", { openCase: true, evidence: ["case raised 9 Oct"] }), []);
eq("a plain request is never listed", unsupportedByKind("Please send the new full address with pincode.", { openCase: false, evidence: [] }), []);
eq("an offer to share a link is not a state-changing promise", kind("I can share the product link if you want."), "factual");

// ── a status in the past tense is a fact for the judge, not a promise ─────────────────────────────────────────────────────────
eq("'was delivered on 5 Oct' is a fact", kind("Your order was delivered on 5 Oct."), "factual");
eq("'has been cancelled' is a fact", kind("Your order has been cancelled."), "factual");
eq("'is already cancelled' is a fact", kind("Your order #AJUKI710073 is already cancelled."), "factual");
eq("…but 'will be cancelled' is a promise", kind("Your order will be cancelled."), "action_promise");

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("splits on sentence ends and newlines", splitReplySentences("One. Two!\nThree?"), ["One.", "Two!", "Three?"]);
eq("substance: an order number", hasSubstance("Your original order AJUKI710078 is with the team."), true);
eq("substance: an amount", hasSubstance("The refund of ₹634 is in progress."), true);
eq("substance: a date", hasSubstance("It was raised on 9 Oct."), true);
eq("substance: a link", hasSubstance("Track it at https://www.ajuki.in/track"), true);
eq("no substance: a generic line", hasSubstance("I understand — it is already with the team."), false);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
