// Run with `npx tsx lib/replyRating.test.ts`.
// The damage ruler: each irreparable class fires on its own wording, an approved line is never rated, a verified action clears an
// action claim, and ordinary helpful replies are ok.
import { rateReply } from "@engine/replyRating";
import { FLAG_REPLY } from "@policy/businessTruths";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const RECORD = "=== CUSTOMER ===\n+91 9000000001 · 1 order(s)\n\n#AJUKI710009 · shipped · ₹499 · expected around 14 Oct · track: https://track.example/AWB1";
const R = (reply: string, extra: Partial<Parameters<typeof rateReply>[0]> = {}) => rateReply({ reply, message: "where is my order", sources: [RECORD], ...extra });
const rules = (reply: string, extra: Partial<Parameters<typeof rateReply>[0]> = {}) => R(reply, extra).findings.map((f) => f.rule).sort();

eq("a true status reply is ok", R("Your order AJUKI710009 is shipped and expected around 14 Oct.").tier, "ok");
eq("a request for details is ok", R("Could you please share your order ID?").tier, "ok");

eq("a refund offer is irreparable", R("We will refund you right away.").tier, "irreparable");
eq("a replacement offer is irreparable", R("I can arrange a replacement for you.").tier, "irreparable");
eq("a call-back promise is irreparable", R("Our team will call you back.").tier, "irreparable");
eq("a reply-time promise is irreparable", R("A team member will update you within 2 hours.").tier, "irreparable");
eq("an invented amount is irreparable", R("The charge is ₹777.").tier, "irreparable");
eq("an order number on no record is irreparable (another customer's order)", R("Your order AJUKI710092 is out for delivery.").tier, "irreparable");
eq("out for delivery not on the record is irreparable", R("Your parcel is out for delivery.").tier, "irreparable");
eq("advice to refuse the parcel is irreparable", R("You can refuse the parcel at the door.").tier, "irreparable");

eq("cancel claimed with nothing behind it is irreparable", rules("I have cancelled your order."), ["action_claim"]);
eq("cancel claimed after a verified cancel is fine", R("I have cancelled your order.", { verifiedActions: ["cancel"] }).tier, "ok");
eq("cancel stated when the record shows it is fine", R("Your order has been cancelled.", { sources: [RECORD + "\n#AJUKI710009 · cancelled"] }).tier, "ok");
eq("address change claimed with nothing behind it", rules("We have updated your address."), ["action_claim"]);

eq("waterproof to a pre-purchase question is fine", R("Yes, it is waterproof.", { message: "is it waterproof?" }).tier, "ok");
eq("waterproof repeated to a fading complaint is watched", R("It is waterproof, so this should not happen.", { message: "the colour is fading after a week" }).tier, "watch");
eq("an express fee of 35 is the settled figure", R("Express delivery costs ₹35 extra.", { sources: [RECORD, "Express delivery costs ₹35 extra"] }).tier, "ok");
eq("a different express figure is caught as invented", R("Express delivery costs ₹60 extra.", { sources: [RECORD, "Express delivery costs ₹35 extra"] }).tier, "irreparable");
eq("no COD charge, with none on the order, is fine", R("There is no extra charge for COD.").tier, "ok");
eq("no COD charge, when the order carries a COD fee, is damage", R("There is no extra charge for COD.", { sources: [RECORD + " + COD fee ₹49"] }).tier, "irreparable");
eq("the 24 hour cancellation window is fine", R("An order can be cancelled within 24 hours of placing it.").tier, "ok");
eq("another cancellation window is damage", R("You can cancel within 48 hours of ordering.").tier, "irreparable");

eq("an approved line is never rated", R(FLAG_REPLY).tier, "ok");
eq("a fault with no hand-off is recoverable", R("Thanks for letting us know.", { message: "the bracelet arrived damaged" }).tier, "recoverable");
eq("a fault that was handed off is ok", R("Thanks for letting us know.", { message: "the bracelet arrived damaged", handedOff: true }).tier, "ok");
eq("an internal tag leaking is recoverable", R("Your late_delivery ticket is open.").tier, "recoverable");
eq("declining to call is not a call-back promise", R("We cannot call you; please keep messaging here.").tier, "ok");
eq("declining to confirm a date is not a time promise", R("Your order is delayed. I cannot confirm delivery for tomorrow.").tier, "ok");
eq("a refusal with a curly apostrophe is still a refusal", R("Your order is overdue. I can’t confirm delivery for tomorrow.").tier, "ok");
eq("a real promise next to a refusal is still caught", R("I cannot confirm a date, but our team will call you back.").tier, "irreparable");
eq("our own tracking page is fine", R("You can track it at www.ajuki.in/track.", { sources: [RECORD, "www.ajuki.in/track"] }).tier, "ok");
eq("a courier tracking page is flagged", rules("Track it here: https://tracker.shadowfax.in/#/track/SF1", { sources: [RECORD, "https://tracker.shadowfax.in/#/track/SF1"] }), ["courier_tracking_link"]);
eq("irreparable beats watch", R("We will refund you. It is waterproof.", { message: "colour is fading" }).tier, "irreparable");

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
