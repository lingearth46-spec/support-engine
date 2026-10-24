// Run with `npx tsx lib/newRequest.test.ts`. Real messages from threads that were already escalated, and chasers that are not requests.
import { newRequestKind } from "./newRequest";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

// Requests (several are the exact messages that went unanswered on 9 Oct).
eq("please reschedule my order", newRequestKind("Please reschedule my order"), "reschedule delivery");
eq("deliver tomorrow", newRequestKind("Deliver tomorrow"), "reschedule delivery");
eq("reattempt", newRequestKind("please reattempt the delivery"), "reschedule delivery");
eq("I want the order I couldn't collect it", newRequestKind("I want the order ,I can’t collect it beacuse I wasn’t available"), "still wants the order");
eq("update my address", newRequestKind("Please update my address, it is wrong"), "change address");
eq("the address is wrong", newRequestKind("The adress is wrong"), "change address");
eq("change my number", newRequestKind("change my phone number to 9876543210"), "change phone number");
eq("cancel", newRequestKind("Cancel karo please"), "cancel");
eq("call me", newRequestKind("Call me once"), "call me");
eq("raise a phone call", newRequestKind("Raise a phone call for me"), "call me");
eq("refund", newRequestKind("I want my refund now"), "refund");

// Chasers and reactions are not requests.
eq("any update", newRequestKind("Any update?"), null);
eq("where is my order", newRequestKind("Where is my order, it is already late"), null);
eq("hello", newRequestKind("Hello"), null);
eq("thanks", newRequestKind("Thank you"), null);
eq("two question marks", newRequestKind("??"), null);
eq("a complaint", newRequestKind("This is really irritating, you are not doing your work"), null);
eq("empty", newRequestKind(""), null);
eq("null", newRequestKind(null), null);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
