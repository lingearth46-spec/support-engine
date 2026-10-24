// hasReturnIntent gates whether formatOrders (lib/waSupport.ts) shows the
// return-window fact on an order line — see its own doc comment for why.
//
// Run with `npx tsx lib/supportGuardrails.test.ts`.

import {
  hasReturnIntent, hasRefundIntent, hasBillingIntent, hasCancellationIntent,
  matchEscalateKeyword, DEFAULT_ESCALATE_KEYWORDS,
} from "@engine/supportGuardrails";

let passed = 0, failed = 0;
const eq = (name: string, got: boolean, want: boolean) => {
  got === want ? passed++ : (failed++, console.log(`FAIL ${name}\n  got  ${got}\n  want ${want}`));
};

// Real messages from the 22 Aug-1 Sept corpus that must NOT show the window —
// none of these are about a return, and one triggered the leak this exists to
// stop ("Amazing 🤌🏻❤️" got "the return window ... is OPEN, 7 days left" back).
eq("pure delight", hasReturnIntent("Amazing 🤌🏻❤️"), false);
eq("delivery date question", hasReturnIntent("Delivery date?"), false);
eq("simple greeting", hasReturnIntent("Hi"), false);
eq("thanks", hasReturnIntent("Thank you"), false);
eq("cancellation question", hasReturnIntent("Can you cancel my order?"), false);
eq("address change", hasReturnIntent("Please change the delivery address"), false);
eq("product question", hasReturnIntent("Is this available in silver?"), false);
eq("courier chase", hasReturnIntent("Where is my order, it's late"), false);

// Real return-shaped messages from the same corpus — must show the window.
eq("explicit return", hasReturnIntent("I want to return this order"), true);
eq("refund ask", hasReturnIntent("Can u process the refund for this"), true);
eq("damaged item", hasReturnIntent("One piece came broken"), true);
eq("defect report", hasReturnIntent("received damaged product"), true);
eq("wrong item", hasReturnIntent("you have sent the black onyx instead of gold stone"), true);
eq("missing piece", hasReturnIntent("Missing item in order"), true);
eq("exchange", hasReturnIntent("Can i exchange the order?"), true);
eq("size problem", hasReturnIntent("the size is too big for me, so I want to return it"), true);
eq("quality complaint", hasReturnIntent("it's totally fake compare to order 1"), false); // no keyword hit — expected miss, human still catches it via needs_human
eq("faulty clasp", hasReturnIntent("the hook is not closing properly"), false); // "faulty" not literally said — documents the gate's limit, not a requirement
eq("tarnish", hasReturnIntent("the colour has started to tarnish"), true);
eq("case-insensitive", hasReturnIntent("REFUND please"), true);
eq("mid-sentence", hasReturnIntent("hey so the bracelet i got is DEFECTIVE, help"), true);

// ── hasRefundIntent — gates the per-order refund-status fact.
eq("refund plain", hasRefundIntent("Where is my refund?"), true);
eq("refund verb", hasRefundIntent("please refund me"), true);
eq("money back", hasRefundIntent("I want my money back"), true);
eq("paisa wapas", hasRefundIntent("mera paisa wapas chahiye"), true);
eq("didn't get my refund", hasRefundIntent("I still didn't get my refund"), true);
eq("refund not received", hasRefundIntent("refund not received yet"), true);
eq("refund case-insensitive", hasRefundIntent("REFUND STATUS?"), true);
eq("not a refund — order status", hasRefundIntent("where is my order"), false);
eq("not a refund — greeting", hasRefundIntent("hello there"), false);

// ── hasBillingIntent — gates the per-line money breakdown (showMoney).
eq("why charged", hasBillingIntent("why was I charged twice?"), true);
eq("overcharged", hasBillingIntent("I think I was overcharged"), true);
eq("invoice", hasBillingIntent("can you send me the invoice"), true);
eq("coupon not applied", hasBillingIntent("my coupon code was not applied"), true);
eq("discount didn't apply", hasBillingIntent("the discount didn't apply at checkout"), true);
eq("why so much", hasBillingIntent("why so much for one bracelet"), true);
eq("order total", hasBillingIntent("what is my order total"), true);
eq("not billing — delivery", hasBillingIntent("when will it arrive"), false);
eq("not billing — thanks", hasBillingIntent("thank you so much"), false);

// ── hasCancellationIntent — a third trigger for the refund lookup.
eq("cancel plain", hasCancellationIntent("cancel my order please"), true);
eq("cancelled", hasCancellationIntent("I already cancelled this"), true);
eq("don't want it", hasCancellationIntent("I don't want it anymore"), true);
eq("changed my mind", hasCancellationIntent("changed my mind, please stop it"), true);
eq("not cancellation — status", hasCancellationIntent("has my order shipped"), false);
eq("not cancellation — product", hasCancellationIntent("is this available in gold"), false);

// matchEscalateKeyword — untouched, sanity check it still imports correctly
// alongside the new export.
eq("legal keyword still matches", matchEscalateKeyword("I will go to consumer court", DEFAULT_ESCALATE_KEYWORDS) !== null, true);
eq("ordinary text does not match", matchEscalateKeyword("what is your return policy", DEFAULT_ESCALATE_KEYWORDS) !== null, false);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
