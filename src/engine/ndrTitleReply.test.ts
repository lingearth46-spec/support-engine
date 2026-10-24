// Run with `npx tsx lib/ndrTitleReply.test.ts`.
import { ndrTitleReply, NDR_TITLE_LINES } from "@engine/ndrTitleReply";
import { rateReply } from "@engine/replyRating";
import { groundingViolations } from "@engine/replyGrounding";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const SHIPPED = "#AJUKI710009 · shipped · ₹499 · track: www.ajuki.in/track (Delhivery, AWB 6000)";
const RTO = "#AJUKI710018 · rto · ON ITS WAY BACK TO US — the delivery did not complete";

eq("update phone asks for the number, promises nothing", ndrTitleReply("Update phone", SHIPPED), NDR_TITLE_LINES.phone);
eq("update address asks for the address", ndrTitleReply("update address.", SHIPPED), NDR_TITLE_LINES.address);
eq("deliver tomorrow, parcel with the courier: no date promised", ndrTitleReply("Deliver tomorrow", SHIPPED), NDR_TITLE_LINES.tomorrow);
eq("deliver tomorrow, parcel returning: says it cannot be, no redelivery offer", ndrTitleReply("Deliver tomorrow", RTO), NDR_TITLE_LINES.returning);
eq("deliver tomorrow with no order on record asks for the number", ndrTitleReply("Deliver tomorrow", "No orders are registered"), NDR_TITLE_LINES.noOrder);
eq("contact support is left to the hand-off decision", ndrTitleReply("Contact support", SHIPPED), null);
eq("an ordinary sentence is not a title", ndrTitleReply("please update phone number to 9000000001", SHIPPED), null);
eq("a longer message containing the words is not a title", ndrTitleReply("Deliver tomorrow morning please", SHIPPED), null);

// None of the lines may trip the damage ruler or the grounding gate.
for (const [k, line] of Object.entries(NDR_TITLE_LINES)) {
  eq(`${k}: rated ok`, rateReply({ reply: line, message: "x", sources: [SHIPPED, "www.ajuki.in/track", "ajukisupport@gmail.com"] }).tier, "ok");
  eq(`${k}: no grounding violation`, groundingViolations(line, [SHIPPED, "www.ajuki.in/track ajukisupport@gmail.com"]).map((v) => v.rule), []);
}
// a parcel already returning cannot have its phone or address changed or be re-delivered: no request for a number, point to a new order
eq("update phone on a returning parcel: says so and points to a new order", ndrTitleReply("Update phone", RTO), NDR_TITLE_LINES.returning);
eq("update address on a returning parcel", ndrTitleReply("Update address", RTO), NDR_TITLE_LINES.returning);
eq("the returning line points to a new order, not an email", /place a new order at www\.ajuki\.in/.test(NDR_TITLE_LINES.returning) && !/@/.test(NDR_TITLE_LINES.returning), true);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
