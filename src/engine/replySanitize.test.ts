// Run with `npx tsx lib/replySanitize.test.ts`.
// The text tidy that runs before the checks, and the straight-apostrophe fix in the grounding rules (both from the 9 Oct review).
import { sanitiseModelText } from "@engine/replySanitize";
import { groundingViolations } from "@engine/replyGrounding";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const rules = (t: string, src: string[] = ["Order AJUKI710013 is shipped. Expected around 11 Oct."]) => groundingViolations(t, src, []).map((v) => v.rule);

// Internal tag names → plain words (real replies from 9 Oct).
eq("a late_delivery case becomes a late delivery case",
  sanitiseModelText("This issue is already with the team — a late_delivery case was raised on 7 Oct. They are handling it.").text,
  "This issue is already with the team — a late delivery case was raised on 7 Oct. They are handling it.");
eq("ticket form", sanitiseModelText("a late_delivery ticket was raised on 6 Oct").text, "a late delivery ticket was raised on 6 Oct");
eq("the change is reported", sanitiseModelText("a late_delivery case").changes, ["internal_term:late_delivery"]);
eq("even when the order line quotes the tag", sanitiseModelText("a late_delivery case", ['Already with the team: 1 open — "late_delivery" raised 7 Oct']).text, "a late delivery case");
eq("case-insensitive", sanitiseModelText("A LATE_DELIVERY case").text, "A late delivery case");
eq("wa_cancelled is a status, not words to space out", sanitiseModelText("status is wa_cancelled").text, "status is cancelled");
eq("text with nothing to do is untouched", sanitiseModelText("Your order is on its way.").text, "Your order is on its way.");
eq("an unknown internal term is NOT hidden: it is still blocked by the gate", sanitiseModelText("see ndr_pending_flag").text, "see ndr_pending_flag");
eq("…and the gate still blocks it", rules(sanitiseModelText("see ndr_pending_flag").text).includes("internal_term"), true);
eq("after the tidy the gate has nothing to say about a tag name", rules(sanitiseModelText("a late_delivery case was raised on 7 Oct").text, ["Case raised 7 Oct."]), []);

// Sample order numbers.
eq("the sample ID in 'looks like AJUKI12345' is rewritten",
  sanitiseModelText("Please send your AJUKI order ID (looks like AJUKI12345) or the phone number you used.").text,
  "Please send your AJUKI order ID (looks like AJUKI followed by numbers) or the phone number you used.");
eq("…and is then not an invented order id", rules(sanitiseModelText("send your order ID (looks like AJUKI12345)").text), []);
eq("a sample that the customer actually typed is left alone", sanitiseModelText("I couldn't find AJUKI12345.", ["my order is AJUKI12345"]).text, "I couldn't find AJUKI12345.");
eq("a sample in the order record is left alone", sanitiseModelText("Order AJUKI710013 is shipped.", ["Order AJUKI710013 is shipped."]).text, "Order AJUKI710013 is shipped.");
eq("an invented order number is NOT hidden", sanitiseModelText("Your order AJUKI710049 is shipped.").text, "Your order AJUKI710049 is shipped.");
eq("…and is still blocked", rules("Your order AJUKI710049 is shipped.").includes("order_id"), true);

// Curly apostrophes in the grounding rules.
eq("can’t promise (curly) is not a promise", rules("I can’t promise a delivery today. Your order is expected around 11 Oct."), []);
eq("can't promise (straight) is not a promise", rules("I can't promise a delivery today. Your order is expected around 11 Oct."), []);
eq("a real promise is still caught", rules("We guarantee delivery today.").includes("promise"), true);
eq("we’ll refund (curly) is now an offer", rules("We’ll refund you right away.").includes("offer"), true);
eq("we'll refund (straight) is an offer", rules("We'll refund you right away.").includes("offer"), true);
eq("don’t is not mistaken for anything", rules("We don’t share phone numbers."), []);


// States the record does not show (real replies from 9 Oct, and the true answers that must still go out).
{
  const noRefund = ["Order AJUKI710046 is shipped via DTDC. Last scan: Pickup Completed. refund: no refund on record. Already with the team: 1 open support case, raised 9 Oct."];
  const withRefund = ["Order AJUKI710029 · refund: ₹449 in progress since 7 Oct — a COD order, so it settles as AJUKI Wallet credit"];
  const done = ["Order AJUKI710022 · refund: ₹349 completed 8 Oct"];
  const picked = ["Order AJUKI710024 is shipped. Last courier scan: Picked Successfully. Expected around 14 Oct."];
  const ofd = ["Order AJUKI710034 is shipped. Last courier scan: Out for delivery at Mumbai_ShastriNagar_D."];
  eq("a refund said to be raised when the record has none is blocked", rules("Thanks — I see this is already with the team. The refund was raised on 9 Oct.", noRefund).includes("refund_state"), true);
  eq("…also in other forms", rules("Your refund has been initiated.", noRefund).includes("refund_state"), true);
  eq("a refund in progress that the record shows passes", rules("Your refund of ₹449 is in progress since 7 Oct and settles as AJUKI Wallet credit.", withRefund), []);
  eq("a completed refund that the record shows passes", rules("Your refund of ₹349 was completed on 8 Oct.", done), []);
  eq("saying there is no refund is not a claim", rules("There is no refund on record for this order.", noRefund), []);
  eq("the general wallet rule is not a claim about this order", rules("Refunds for COD orders are credited to your AJUKI Wallet.", noRefund), []);
  eq("out for delivery with a 'Picked Successfully' scan is blocked", rules("Your order has been shipped and is out for delivery. Last courier scan: Picked Successfully.", picked).includes("status_claim"), true);
  eq("out for delivery that the scan shows passes", rules("Your parcel is out for delivery today. Last courier scan: Out for delivery at Mumbai_ShastriNagar_D.", ofd), []);
  eq("OFD in the scan counts", rules("Your parcel is out for delivery.", ["Last scan: Item OFD at CBE_Velandipalayam_N"]), []);
}


// The order line's marker words and an empty attempt counter (real replies from 9 Oct).
{
  const san = (t: string) => sanitiseModelText(t).text;
  eq("marked OVERDUE and STUCK reads as plain words",
    san("Your order #AJUKI710046 (ordered 27 Sept) is still marked OVERDUE and STUCK — last courier scan was 9 days ago."),
    "Your order #AJUKI710046 (ordered 27 Sept) is overdue and stuck — last courier scan was 9 days ago.");
  eq("a bare marker is lower-cased", san("This parcel is OVERDUE."), "This parcel is overdue.");
  eq("NEEDS ATTENTION / STILL MOVING", san("It is STILL MOVING. It NEEDS ATTENTION."), "It is still moving. It needs attention.");
  eq("ordinary lower-case words are untouched", san("The parcel is overdue and stuck at the hub."), "The parcel is overdue and stuck at the hub.");
  eq("', delivery attempt 0.' is dropped, the sentence kept", san("Courier note: Consignee Unavailable, delivery attempt 0."), "Courier note: Consignee Unavailable.");
  eq("'and delivery attempts so far: 0.' is dropped",
    san("Courier note says: “Customer not contactable” and delivery attempts so far: 0."), "Courier note says: “Customer not contactable”.");
  eq("a real attempt count is kept", san("The courier has made delivery attempt 2."), "The courier has made delivery attempt 2.");
  eq("attempts so far: 3 is kept", san("Delivery attempts so far: 3."), "Delivery attempts so far: 3.");
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
