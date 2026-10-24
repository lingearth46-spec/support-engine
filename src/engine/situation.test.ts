// Run with `npx tsx lib/situation.test.ts`.
// The situation classifier: what the code reads a turn as, with the model's tag out of it, and how that compares with what was sent.
import { classifySituation, compareToActual, lastBotKind, isSubtype, type SituationInput, type SituationOrder } from "@engine/situation";
import { PENDING_REPLY, CHASING_REPLY, RETURN_PAGE_REPLY } from "@engine/returnStateReply";
import { lateFirstText } from "@engine/lateDeliveryReply";
import { CANCEL_REPLY } from "@engine/cancelStateReply";
import { FLAG_REPLY } from "@policy/businessTruths";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

const NOW = Date.now(); // the return window is measured against the real clock, so a fixed date goes stale (fell over on 14 Oct 2026)
const day = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const order = (o: Partial<SituationOrder> & { id: string; status: string }): SituationOrder =>
  ({ total: 499, created_at: day(3), address: { phone: "9000000001" }, ...o }) as SituationOrder;
const rejectedReturn = { status: "rejected", reason: "x", submitted_at: day(5), resolved_at: day(2) } as never;
const pendingReturn = { status: "pending", reason: "x", submitted_at: day(1) } as never;
const sit = (message: string, own: SituationOrder[], o: Partial<SituationInput> = {}) =>
  classifySituation({ message, recent: [], own, now: NOW, senderPhone: "9000000001", ...o });

const shipped = order({ id: "AJUKI710009", status: "shipped", awb_code: "AWB1", estimated_delivery: day(-2).slice(0, 10) });
const processing = order({ id: "AJUKI710018", status: "processing", created_at: day(0.2) });
const cancelled = order({ id: "AJUKI710030", status: "cancelled" });
const overdue = order({ id: "AJUKI710041", status: "shipped", awb_code: "AWB4", estimated_delivery: day(5).slice(0, 10) });
const delivered = order({ id: "AJUKI710050", status: "delivered", delivered_at: day(3), awb_code: "AWB5" });

// ── the closed vocabulary ────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const subs = [
    sit("hi", [shipped], { lastOutAt: day(3) }).subtype, sit("AJUKI710009", [shipped]).subtype, sit("Cancel it", [cancelled]).subtype,
    sit("where is my order", [overdue]).subtype, sit("random words about nothing in particular here", [shipped]).subtype,
  ];
  eq("every subtype is family.detail", subs.every(isSubtype), true);
}

// ── first-touch lines ────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("a greeting", [sit("hi", [shipped], { lastOutAt: day(3) }).subtype, sit("hi", [shipped], { lastOutAt: day(3) }).rule], ["greeting.bare", "greeting"]);
eq("a bare order id they own", [sit("AJUKI710009", [shipped]).subtype, sit("AJUKI710009", [shipped]).rule], ["lookup.order", "lookup"]);
eq("a language we do not reply in", [sit("You know bengali ?", [shipped]).subtype, sit("You know bengali ?", [shipped]).rule], ["language.unsupported", "language"]);
{
  const pay = sit("Confirm", [order({ id: "AJUKI710021", status: "on_hold" })], {
    recent: [{ direction: "out", body: "Earlier orders came back undelivered, so we can only send this one as a prepaid order. Tap below to pay." }],
  });
  eq("'Confirm' after our prepaid message", [pay.subtype, pay.rule], ["payment.confirm_prepaid", "pay_link"]);
  eq("…but not with no payment message before it", sit("Confirm", [order({ id: "AJUKI710021", status: "on_hold" })]).subtype === "payment.confirm_prepaid", false);
}
eq("a one-word fragment", [sit("Sunday", [shipped]).subtype, sit("Sunday", [shipped]).rule], ["fragment.ambiguous", "clarify"]);

// ── cancellation ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("asking to stop an order that is already cancelled", [sit("I don't want", [cancelled]).subtype, sit("I don't want", [cancelled]).rule], ["cancel.already_cancelled", "already_cancelled"]);
eq("…but not when they ask about the money", sit("I cancelled it, where is my refund", [cancelled]).subtype === "cancel.already_cancelled", false);
eq("cancel on a dispatched order", [sit("cancel my order", [shipped]).subtype, sit("cancel my order", [shipped]).rule], ["cancel.dispatched", "return_state"]);
eq("cancel again after we refused", sit("please cancel it", [shipped], { lastBotReply: CANCEL_REPLY }).subtype, "cancel.insist");
eq("cancel on an order that can still be stopped is the model's (it can act)", [sit("cancel my order", [processing]).subtype, sit("cancel my order", [processing]).handler], ["cancel.possible", "model"]);

// ── returns and refunds ───────────────────────────────────────────────────────────────────────────────────────────────────────
const withRej = order({ id: "AJUKI710052", status: "delivered", delivered_at: day(6), return_request: rejectedReturn });
const withPend = order({ id: "AJUKI710061", status: "delivered", delivered_at: day(3), return_request: pendingReturn });
eq("a rejected return, they ask about it", sit("what about my return", [withRej]).subtype, "return.rejected");
eq("a rejected return, they chase the email", sit("I have emailed, no reply", [withRej]).subtype, "return.rejected.chasing");
eq("a rejected return, how long to wait (the shared chase wording misses this)", sit("How much should I wait?", [withRej], { lastBotReply: PENDING_REPLY }).subtype, "return.rejected.chasing");
eq("a pending return", sit("any update on my return", [withPend]).subtype, "return.pending");
eq("a damaged item inside the window, nothing filed", sit("the bracelet arrived damaged", [delivered]).subtype, "return.none.window_open");
eq("…and the window is a fact", sit("the bracelet arrived damaged", [delivered]).facts.includes("return.window_open=4d"), true);
eq("a refund chase with the record", sit("still no refund", [cancelled], { refunds: { AJUKI710030: { status: "REFUND_ELIGIBLE", amount: 634 } }, hasRefundRecord: true }).subtype, "refund.chase.record");
eq("a refund chase with nothing on record", sit("where is my refund, you promised it", [delivered], { refunds: {}, hasRefundRecord: false }).subtype, "refund.chase.no_record");

// ── acknowledgements inside a canned thread ────────────────────────────────────────────────────────────────────────────────────
{
  const ack = sit("Sure!", [withRej], { lastBotReply: PENDING_REPLY });
  eq("a bare 'Sure!' after our canned line asks for nothing", [ack.subtype, ack.handler, ack.rule], ["other.ack", "none", null]);
  eq("…and the return rule it would otherwise trigger is kept as 'also'", ack.also.includes("return_state"), true);
  eq("a relayed 'they said 1-2 days' asks for nothing", sit("They said it will take 1 2 working days for them to resolve my issue", [withRej], { lastBotReply: PENDING_REPLY }).subtype, "other.ack");
  eq("an acknowledgement with a question is not one", sit("Sure, but where is my refund?", [withRej], { lastBotReply: PENDING_REPLY }).subtype === "other.ack", false);
  eq("'Sure' outside a canned thread is not an ack here", sit("Sure", [withRej], { lastBotReply: "Thanks for the details." }).subtype === "other.ack", false);
  eq("a held repeat is the right outcome for an ack", compareToActual(ack, "return_state", true), "same");
  eq("a reply to an ack is flagged", compareToActual(ack, "return_state", false), "reply_to_ack");
}

// ── delivery ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("an overdue parcel, they ask where it is", [sit("where is my order", [overdue]).subtype, sit("where is my order", [overdue]).rule], ["delivery.late.first", "late_first"]);
eq("after our late line, they push", sit("please reply", [overdue], { lastBotReply: lateFirstText(overdue) }).subtype, "delivery.late.insist");
{
  const thread = [{ direction: "in" as const, body: "When will come my order tell me" }, { direction: "out" as const, body: "Your order AJUKI710041 is already with the team — a support case was raised on 10 Oct." }];
  const f = sit("I want oder my", [overdue], { recent: thread, lastBotReply: thread[1].body, openCase: true });
  eq("a fragment that continues a late-delivery thread is that thread (not a reorder)", [f.subtype, f.rule], ["delivery.late.followup", null]);
  eq("…its facts say so", f.facts.includes("order.overdue=yes") && f.facts.includes("case.open=yes"), true);
}
eq("an in-flight parcel, a status question", sit("what is the status of my order", [shipped]).subtype, "delivery.status");
eq("an address change before dispatch is the model's (it can make the change)", [sit("Address change h sir", [processing]).subtype, sit("Address change h sir", [processing]).handler], ["address.change.possible", "model"]);
eq("an address change once dispatched asks for the new address (one parcel, none in the message)", [sit("please change my address", [shipped]).subtype, sit("please change my address", [shipped]).rule], ["address.change.dispatched", "address_ask"]);

// ── what the rules read from the model's tag shows up as a disagreement ───────────────────────────────────────────────────────
{
  // E1, 10 Oct: our last line was the late line, the customer wrote a preference with no late wording. The live rule fires on the
  // model's tag alone ("other" is a follow-up tag). Without the tag no rule applies.
  const e1 = sit("Yeah fine If nothing available get me my original undelivered order", [overdue], { lastBotReply: lateFirstText(overdue), openCase: true });
  eq("no rule applies without the tag", e1.rule, null);
  eq("…so a late_insist that fired is flagged as needing the tag", compareToActual(e1, "late_insist"), "rule_needs_tag");
  eq("…and a model answer is not a disagreement", compareToActual(e1, null), "model_both");
}
eq("same rule", compareToActual({ rule: "already_cancelled", also: [] }, "already_cancelled"), "same");
eq("rule exists but the model's text went out", compareToActual({ rule: "late_first", also: [] }, null), "rule_suppressed");
eq("a different rule fired", compareToActual({ rule: "late_first", also: [] }, "size"), "conflict");
eq("return + late together", compareToActual({ rule: "return_state", also: ["late_first"] }, "return_and_late"), "same");
eq("an also-rule counts", compareToActual({ rule: "return_state", also: ["late_first"] }, "late_first"), "same");

// ── facts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const s = sit("where is my order", [overdue]);
  eq("scope, subject, status", [s.subject.order, s.subject.basis, s.facts.includes("order.status=shipped")], ["AJUKI710041", "single", true]);
  eq("overdue days are positive and counted", s.facts.includes("order.overdue_days=5"), true);
  const u = sit("when will it come", [order({ id: "AJUKI710082", status: "undelivered", awb_code: "A", estimated_delivery: day(-2).slice(0, 10) })]);
  eq("undelivered is overdue by status, with no negative day count", [u.facts.includes("order.overdue=yes"), u.facts.some((f) => f.startsWith("order.overdue_days=")), u.facts.includes("order.delivery_failed=yes")], [true, false, true]);
  eq("a repeated message is counted", sit("same words again", [shipped], { recent: [{ direction: "in", body: "Same words again" }, { direction: "in", body: "same words again!" }] }).facts.includes("msg.repeat=3"), true);
  eq("what we last said", [lastBotKind(FLAG_REPLY), lastBotKind(PENDING_REPLY), lastBotKind(RETURN_PAGE_REPLY), lastBotKind("Hello there"), lastBotKind(null)], ["flag", "return_canned", "return_canned", "model", "none"]);
  eq("several orders in different states: nothing is inferred", sit("what is my status", [shipped, cancelled]).subject.basis, "ambiguous");
}

// ── purity ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const own = [overdue, shipped];
  const before = JSON.stringify(own);
  const a = sit("where is my order AJUKI710041", own), b = sit("where is my order AJUKI710041", own);
  eq("deterministic", JSON.stringify(a), JSON.stringify(b));
  eq("inputs untouched", JSON.stringify(own), before);
  eq("curly apostrophes are normalised like the live path", sit("I don’t want", [cancelled]).subtype, "cancel.already_cancelled");
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
