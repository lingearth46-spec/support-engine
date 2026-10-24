import assert from "node:assert/strict";
import { groundingViolations, stripPromiseSentences, removeUnsupportedSentences } from "@/lib/replyGrounding";
import { BUSINESS_TRUTHS } from "@/lib/businessTruths";

let passed = 0;
const rules = (reply: string, extra: string[] = []) => groundingViolations(reply, [BUSINESS_TRUTHS, ...extra]).map((v) => v.rule);
const ok = (name: string, reply: string, extra: string[] = []) => { assert.deepEqual(rules(reply, extra), [], `${name}: ${JSON.stringify(groundingViolations(reply, [BUSINESS_TRUTHS, ...extra]))}`); passed++; };
const bad = (name: string, reply: string, rule: string, extra: string[] = []) => { assert.ok(rules(reply, extra).includes(rule), `${name}: expected ${rule}, got ${JSON.stringify(rules(reply, extra))}`); passed++; };

const ORDER = "AJUKI710039 · SHIPPED · total ₹449 · COD ₹449 due on delivery · expected around 13 Oct · track: https://www.delhivery.com/track/package/60000000000006 · phone 9876543210";

// ── grounded replies pass ──
ok("order facts", "Your order AJUKI710039 is on its way, expected around 13 Oct. Track it here: https://www.delhivery.com/track/package/60000000000006", [ORDER]);
ok("amount from the order", "The COD amount due on delivery is ₹449.", [ORDER]);
ok("free shipping from the truths", "Orders above ₹99 get free shipping.");
ok("gift wrap from the truths", "Gift wrapping is ₹30, selectable at checkout.");
ok("support email from the truths", "Please email our Senior Support Team at ajukisupport@gmail.com.");
ok("website urls from the truths", "Photos are on www.ajuki.in and our Instagram page @ajuki.in.");
ok("returns link", "You can raise a return at www.ajuki.in/returns/start with your order number.");
ok("delivery times after dispatch", "Standard delivery takes 5-7 business days after dispatch.");
ok("negated promise", "I can't promise extra discounts, sorry.");
ok("their own phone number", "I can see this order is on 9876543210.", [ORDER]);

// ── invented facts are caught ──
bad("invented amount", "The cost is ₹799.", "amount", [ORDER]);
bad("invented order id", "Your order AJUKI710092 is on its way.", "order_id", [ORDER]);
bad("invented date", "It will arrive on 20 Oct.", "date", [ORDER]);
bad("invented link", "Track it at https://tracker.example.com/xyz", "url", [ORDER]);
bad("invented email", "Write to help@ajuki.com", "email");
bad("invented phone", "Call us on +91 90001 00006.", "phone");
bad("real phone not in the truths", "Call +91 90001 00012 for help.", "phone");

// ── things the model must never say ──
bad("reply time promise", "A team member will update you within 3-5 business working hours.", "reply_time");
bad("soon", "Our team will get back to you shortly.", "reply_time");
bad("by tomorrow", "We will reply by tomorrow.", "reply_time");
bad("delivery tomorrow", "Your parcel will be delivered tomorrow.", "delivery_promise");
bad("offer replacement", "I can arrange a replacement for you.", "offer");
bad("offer refund", "We will refund the amount.", "offer");
bad("offer discount", "I can offer you a discount on your next order.", "offer");
bad("happy to replace", "Happy to replace it for you!", "offer");
bad("callback", "Our team will call you tomorrow.", "callback");
bad("refuse advice", "You can refuse the parcel at the door.", "refusal_advice");
bad("guarantee", "We guarantee delivery by Friday.", "promise");
ok("refund status is not an offer", "Your refund of ₹449 is in progress.", [ORDER, "refund: ₹449 in progress since 7 Oct"]);
bad("a refund status the record does not show is blocked", "Your refund of ₹449 is in progress.", "refund_state", [ORDER]);
ok("warranty is fine", "Every product has a 1 month warranty.");

bad("internal tag leaks", "A late_delivery ticket was raised on 5 Oct.", "internal_term");
ok("plain words with no underscore", "Your order is delayed.");
// repair: cut the promise sentence, keep the useful rest
assert.equal(stripPromiseSentences("Your order is on its way. Track it here: www.ajuki.in/track. A team member will update you within 3-5 business working hours."), "Your order is on its way. Track it here: www.ajuki.in/track."); passed++;
assert.equal(stripPromiseSentences("Sorry for the trouble. Our team will get back to you shortly."), "Sorry for the trouble."); passed++;
assert.equal(stripPromiseSentences("Your parcel will be delivered tomorrow."), ""); passed++;
assert.deepEqual(groundingViolations(stripPromiseSentences("Your order is on its way. A team member will update you within 3-5 business working hours."), [BUSINESS_TRUTHS]), []); passed++;
bad("internal status name", "This one is already closed (wa_cancelled).", "internal_term");
bad("soft share promise", "If you would like the live courier link I can share it as soon as it is available.", "reply_time");
ok("sharing a link now is fine", "Here is your tracking link: https://www.delhivery.com/track/package/60000000000006", [ORDER]);
// repair after the verifier: cut only the sentences it quoted
assert.equal(removeUnsupportedSentences("We deliver only within India. If you like I can tell you about future delivery areas.", ["I can tell you about future delivery areas"]), "We deliver only within India."); passed++;
assert.equal(removeUnsupportedSentences("Nice question! Wipe it with a soft cloth.", ["Wipe it with a soft cloth"]), null); passed++; // nothing worth sending is left
assert.equal(removeUnsupportedSentences("We deliver only within India.", ["a claim that is not in the reply at all"]), null); passed++; // cannot match -> flag the whole thing
assert.equal(removeUnsupportedSentences("Express costs extra. The fee varies by checkout path and is shown at checkout. We deliver within India only.", ["The fee varies by checkout path and is shown at checkout."]), "Express costs extra. We deliver within India only."); passed++;
assert.equal(removeUnsupportedSentences("Many customers with sensitive skin are fine with it. It is also waterproof and has a 1 month warranty.", ["Many customers with sensitive skin are fine with it."]), null); passed++; // orphaned fragment
assert.equal(removeUnsupportedSentences("Nice question! Quick care tips to keep the plating fresh:\nWipe it gently with a soft cloth after every wear.\nStore it in a dry pouch away from perfume.", ["Wipe it gently with a soft cloth after every wear.", "Store it in a dry pouch away from perfume."]), null); passed++; // dangling intro
assert.equal(removeUnsupportedSentences("We deliver only within India, and standard delivery takes 5-7 business days after dispatch. We may add new areas later.", ["We may add new areas later."]), "We deliver only within India, and standard delivery takes 5-7 business days after dispatch."); passed++;
// 24 Oct: replies that offered a replacement nobody asked for, and told a customer who got the wrong item to buy again
{
  const withCtx = (reply: string, ctx: string[]) => groundingViolations(reply, [BUSINESS_TRUTHS], ctx).map((v) => v.rule);
  assert.ok(withCtx("Atlas Bracelet - Silver is in stock. To have this as your replacement (small), email ajukisupport@gmail.com.", ["I need the Atlas Bracelet - silver, not Dorian", "Length: small"]).includes("replacement_offer")); passed++;
  assert.ok(!withCtx("A replacement is for the team to decide.", ["can you replace this bracelet"]).includes("replacement_offer")); passed++;
  assert.ok(!withCtx("Atlas Bracelet - Silver is in stock.", ["I need the Atlas Bracelet - silver"]).includes("replacement_offer")); passed++;
  assert.ok(withCtx("If you need the bracelet urgently, please place a new order at www.ajuki.in.", ["I got the wrong order", "I paid the amount also"]).includes("reorder_on_fault")); passed++;
  assert.ok(!withCtx("You can place a new order at www.ajuki.in.", ["where is my parcel"]).includes("reorder_on_fault")); passed++;
  assert.ok(!groundingViolations("You can place a new order at www.ajuki.in.", [BUSINESS_TRUTHS]).some((v) => v.rule === "reorder_on_fault")); passed++; // no context: unchanged
}
// 23 Oct (..2108): "on its way" about an order whose record says delivered
{
  const DELIVERED = "#AJUKI710033 · delivered · ordered 13 Oct (11 days ago) · delivered 22 Oct (2 days ago)";
  const OTHER = "#AJUKI710009 · shipped · ordered 13 Oct";
  const r = (reply: string, src: string[]) => groundingViolations(reply, [BUSINESS_TRUTHS, ...src]).map((v) => v.rule);
  assert.ok(r("Aapka order AJUKI710033 abhi on its way hai; record mein delivery confirm nahi dikh rahi.", [DELIVERED]).includes("status_contradiction")); passed++;
  assert.ok(r("Your order AJUKI710033 has not been delivered yet.", [DELIVERED]).includes("status_contradiction")); passed++;
  assert.ok(!r("Your order AJUKI710033 was delivered on 22 Oct.", [DELIVERED]).includes("status_contradiction")); passed++;
  assert.ok(!r("Your order AJUKI710009 is on its way.", [DELIVERED, OTHER]).includes("status_contradiction")); passed++;
  assert.ok(!r("Your order AJUKI710033 is on its way.", [OTHER]).includes("status_contradiction")); passed++;
}
console.log(`${passed} passed, 0 failed`);
