// Run with `npx tsx lib/strategyCatalogue.test.ts`.
// The strategy catalogue and the selector's validation. The model is stubbed: no network.
import {
  STRATEGIES, STRATEGY_IDS, RULES, candidatesFor, decidedByCode, failedPrecondition, fallbackFor,
} from "./strategyCatalogue";
import { buildSelectorPrompt, selectStrategy, selectorSchema, validateSelection } from "./strategySelector";
import { classifySituation, type Situation, type SituationInput, type SituationOrder } from "./situation";
import { LATE_REPLY } from "./lateDeliveryReply";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

const S = (subtype: string, o: Partial<Situation> = {}): Situation => ({
  v: 1, subtype, family: subtype.split(".")[0] as Situation["family"], rule: null, also: [], handler: "model",
  subject: { order: "AJUKI1", basis: "single", orders: 1 }, facts: ["scope=single", "order=AJUKI1", "order.status=shipped"], signals: [], ...o,
});

(async () => {
// ── the catalogue is well-formed ──────────────────────────────────────────────────────────────────────────────────────────────
eq("every strategy keys to its own id", STRATEGY_IDS.every((id) => STRATEGIES[id].id === id), true);
eq("every rule named exists", STRATEGY_IDS.every((id) => STRATEGIES[id].rules.every((r) => r in RULES)), true);
eq("every strategy says when it applies", STRATEGY_IDS.every((id) => STRATEGIES[id].when.length > 10), true);
eq("every `for` pattern is exact, a family wildcard or *", STRATEGY_IDS.every((id) => STRATEGIES[id].for.every((p) => p === "*" || /^[a-z_]+(\.[a-z_]+)*(\.\*)?$/.test(p))), true);
eq("every strategy's wording is approved (the founder approved the three drafts on 11 Oct)",
  STRATEGY_IDS.filter((id) => !STRATEGIES[id].approved), []);
eq("only the hand-off and the late line flag the team among the fixed ones",
  STRATEGY_IDS.filter((id) => STRATEGIES[id].escalates).sort(), ["flag_address_change", "hand_off_team", "late_reassure"]);

// ── candidates ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const all: string[] = [
  "greeting.bare", "lookup.order", "language.unsupported", "payment.confirm_prepaid", "fragment.ambiguous", "cancel.already_cancelled",
  "cancel.dispatched", "cancel.possible", "return.pending", "return.rejected.chasing", "return.none.window_open", "topic.size", "delivery.late.first",
  "delivery.late.followup", "delivery.status", "refund.chase.record", "refund.chase.no_record", "address.change.possible", "address.change.dispatched",
  "other.ack", "other.fragment", "other.unclassified", "return.fault_report", "return.fault_report.not_delivered",
];
eq("the hand-off is the last candidate for every situation", all.every((st) => { const c = candidatesFor(S(st, { signals: ["intent.cancel", "intent.refund", "address_change"], facts: ["order.status=cancelled", "order.cancellable=yes", "order.overdue=yes"] })); return c.at(-1) === "hand_off_team"; }), true);
eq("a fragment may be answered by a question", candidatesFor(S("fragment.ambiguous")), ["ask_clarify", "hand_off_team"]);
eq("a follow-up on an overdue parcel: reassure, state the status, or ask", candidatesFor(S("delivery.late.followup", { facts: ["order.status=undelivered", "order.overdue=yes", "order=AJUKI1"] })), ["late_reassure", "status_update", "hand_off_team"]);
eq("a refund question: the refund line or the hand-off", candidatesFor(S("refund.chase.no_record", { signals: ["intent.refund"] })), ["refund_status", "hand_off_team"]);
eq("a refund strategy needs the customer to have asked about a refund", candidatesFor(S("refund.chase.no_record", { signals: [] })), ["hand_off_team"]);
eq("an address change before dispatch", candidatesFor(S("address.change.possible", { signals: ["address_change"], facts: ["order.status=processing", "order.cancellable=yes"] })), ["collect_address", "hand_off_team"]);
eq("…but not once it is booked with the courier", candidatesFor(S("address.change.possible", { signals: ["address_change"], facts: ["order.status=shipped", "order.cancellable=no:booked"] })), ["hand_off_team"]);
eq("a cancelled-order strategy needs the order to be cancelled", candidatesFor(S("cancel.already_cancelled", { facts: ["order.status=delivered"] })), ["hand_off_team"]);
eq("an unclassified turn with a known order may be a status question", candidatesFor(S("other.unclassified")), ["ask_clarify", "status_update", "hand_off_team"]);
eq("an unclassified turn with no order can only be asked about", candidatesFor(S("other.unclassified", { facts: ["scope=none"], subject: { order: null, basis: "none", orders: 0 } })), ["ask_clarify", "hand_off_team"]);
eq("a fault claim on a parcel that has not arrived is a status matter, not a return", candidatesFor(S("return.fault_report.not_delivered")), ["status_update", "hand_off_team"]);
eq("a fault claim on a delivered order is a return matter", candidatesFor(S("return.fault_report", { facts: ["order.status=delivered"] })), ["return_state", "hand_off_team"]);

// ── a clear signal is a second reading the selector may choose ──────────────────────────────────────────────────────────────────
{
  // 10 Oct variant: "where is my money" — the late-parcel rule fired on "where is my", the message is about a refund.
  const v = S("delivery.late.first", { handler: "code", rule: "late_first", facts: ["order.status=shipped", "order.overdue=yes", "order=AJUKI1"], signals: ["late_words", "intent.refund"] });
  eq("a money word next to a late-parcel rule offers the refund strategy too", candidatesFor(v), ["late_reassure", "refund_status", "hand_off_team"]);
  eq("…so it is no longer decided by code alone", decidedByCode(v), null);
  const plain = S("delivery.late.first", { handler: "code", rule: "late_first", facts: ["order.status=shipped", "order.overdue=yes"], signals: ["late_words"] });
  eq("without the money word it still is", decidedByCode(plain), "late_reassure");
  const both = S("cancel.dispatched", { handler: "code", rule: "return_state", facts: ["order.cancellable=no:booked", "order.status=shipped"], signals: ["intent.cancel", "address_change"] });
  eq("an address word on a booked parcel does not offer the collect strategy", candidatesFor(both).includes("collect_address"), false);
}

// ── what the code decides on its own ──────────────────────────────────────────────────────────────────────────────────────────
eq("a rule-covered cancellation is decided by code", decidedByCode(S("cancel.already_cancelled", { handler: "code", rule: "already_cancelled", facts: ["order.status=cancelled"] })), "state_cancelled");
eq("a rule-covered greeting is decided by code", decidedByCode(S("greeting.bare", { handler: "code", rule: "greeting" })), "greet");
eq("an acknowledgement is decided by code: say nothing", decidedByCode(S("other.ack", { handler: "none" })), "stay_quiet");
eq("a model-handled follow-up is NOT decided by code", decidedByCode(S("delivery.late.followup", { facts: ["order.status=undelivered", "order.overdue=yes", "order=AJUKI1"] })), null);
eq("a model-handled refund chase is not either", decidedByCode(S("refund.chase.no_record", { signals: ["intent.refund"] })), null);
eq("the fallback for an unclear turn is a question", fallbackFor(S("other.unclassified")), "ask_clarify");
eq("the fallback for anything else is the hand-off", fallbackFor(S("refund.chase.no_record", { signals: ["intent.refund"] })), "hand_off_team");
eq("a precondition that fails is named", failedPrecondition("state_cancelled", S("cancel.already_cancelled", { facts: ["order.status=shipped"] })), "order_is_cancelled");

// ── validating a model's answer ───────────────────────────────────────────────────────────────────────────────────────────────
const late = S("delivery.late.followup", { facts: ["scope=thread", "order=AJUKI1", "order.status=undelivered", "order.overdue=yes", "case.open=yes"], signals: ["thread.late_words"] });
{
  const ok = validateSelection({ strategy: "late_reassure", fact_ids: ["order.overdue=yes", "case.open=yes"], confidence: "high", reason: "overdue, case open" }, late);
  eq("a good selection is used", [ok.strategy, ok.source, ok.fact_ids, ok.rejected], ["late_reassure", "selector", ["order.overdue=yes", "case.open=yes"], undefined]);
  eq("its rules come from the catalogue, not the model", ok.rule_ids, ["NO_TIME_PROMISE", "ONE_ESCALATION", "RECORD_ONLY"]);
  const inv = validateSelection({ strategy: "late_reassure", fact_ids: ["order.overdue=yes", "refund.record=yes"], confidence: "medium", reason: "x" }, late);
  eq("a fact that was never offered is dropped and recorded", [inv.fact_ids, inv.invalid_fact_ids], [["order.overdue=yes"], ["refund.record=yes"]]);
  eq("a signal may be cited as a fact", validateSelection({ strategy: "late_reassure", fact_ids: ["thread.late_words"], confidence: "high", reason: "" }, late).fact_ids, ["thread.late_words"]);
  eq("a copied list bullet is the same id", validateSelection({ strategy: "late_reassure", fact_ids: ["- order.overdue=yes", "• case.open=yes"], confidence: "high", reason: "" }, late).fact_ids, ["order.overdue=yes", "case.open=yes"]);
  eq("a copied prompt heading is the same id", validateSelection({ strategy: "late_reassure", fact_ids: ["SIGNALS IN THE MESSAGE: thread.late_words", "SITUATION (computed by the system): delivery.late.followup"], confidence: "high", reason: "" }, late).fact_ids, ["thread.late_words", "delivery.late.followup"]);
  eq("the situation's own subtype may be cited", validateSelection({ strategy: "late_reassure", fact_ids: ["delivery.late.followup"], confidence: "high", reason: "" }, late).fact_ids, ["delivery.late.followup"]);
  const bad = validateSelection({ strategy: "cancel_order", fact_ids: [], confidence: "high", reason: "x" }, late);
  eq("a strategy outside the candidates becomes the fallback", [bad.strategy, bad.source, bad.rejected], ["hand_off_team", "fallback", "strategy_not_allowed:cancel_order"]);
  const lowc = validateSelection({ strategy: "late_reassure", fact_ids: [], confidence: "low", reason: "unsure" }, late);
  eq("a low-confidence pick is not acted on", [lowc.strategy, lowc.source, lowc.rejected], ["hand_off_team", "fallback", "low_confidence"]);
  eq("…but a low-confidence hand-off is fine", validateSelection({ strategy: "hand_off_team", fact_ids: [], confidence: "low", reason: "unsure" }, late).source, "selector");
  eq("garbage is a fallback", validateSelection("nope", late).source, "fallback");
  eq("a missing confidence is a fallback", validateSelection({ strategy: "late_reassure", fact_ids: [], reason: "" }, late).rejected, "no_confidence");
  eq("an unclear turn falls back to a question", validateSelection({ strategy: "hand_off_team_x" }, S("other.unclassified")).strategy, "ask_clarify");
}

// ── the prompt is narrow ──────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const p = buildSelectorPrompt({ situation: late, message: "I want oder my", recent: [{ direction: "in", body: "When will come my order tell me" }, { direction: "out", body: "Your order is with the team." }] });
  eq("it lists only the allowed strategies", p.candidates, ["late_reassure", "status_update", "hand_off_team"]);
  eq("it carries the facts and the message", [p.user.includes("order.overdue=yes"), p.user.includes("I want oder my"), p.user.includes("When will come my order")], [true, true, true]);
  eq("it does not offer a strategy that is not allowed", p.user.includes("cancel_order"), false);
  eq("the schema's enum is exactly the candidates", (selectorSchema(p.candidates).schema.properties.strategy as { enum: string[] }).enum, p.candidates);
  eq("the schema is strict", [selectorSchema(p.candidates).strict, selectorSchema(p.candidates).schema.additionalProperties], [true, false]);
}

// ── selectStrategy with a stubbed model ──────────────────────────────────────────────────────────────────────────────────────
const reply = (content: unknown, status = 200) => async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 321 } }), { status });
process.env.OPENAI_API_KEY = "test";
{
  let calls = 0;
  const counting = async () => { calls++; return reply({ strategy: "state_cancelled", fact_ids: [], confidence: "high", reason: "x" })(); };
  const decided = S("cancel.already_cancelled", { handler: "code", rule: "already_cancelled", facts: ["order.status=cancelled"] });
  const a = await selectStrategy({ situation: decided, message: "I don't want", recent: [] }, { fetchImpl: counting as never });
  eq("a rule-decided situation asks no model", [a.source, a.strategy, calls], ["code", "state_cancelled", 0]);
  const b = await selectStrategy({ situation: decided, message: "I don't want", recent: [] }, { fetchImpl: counting as never, force: true });
  eq("…unless forced, for measurement", [b.source, calls], ["selector", 1]);
  eq("tokens and model are recorded", [b.tokens, typeof b.model], [321, "string"]);

  const m = await selectStrategy({ situation: late, message: "I want oder my", recent: [] }, { fetchImpl: reply({ strategy: "late_reassure", fact_ids: ["order.overdue=yes"], confidence: "high", reason: "overdue" }) as never });
  eq("a model-handled situation uses the model's choice", [m.source, m.strategy], ["selector", "late_reassure"]);
  const h = await selectStrategy({ situation: late, message: "x", recent: [] }, { fetchImpl: reply({}, 500) as never });
  eq("an HTTP error is a fallback, not a crash", [h.source, h.strategy, h.rejected], ["fallback", "hand_off_team", "http_500"]);
  const u = await selectStrategy({ situation: late, message: "x", recent: [] }, { fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 })) as never });
  eq("unparseable output is a fallback", [u.source, u.rejected], ["fallback", "unparseable"]);
  const t = await selectStrategy({ situation: late, message: "x", recent: [] }, { fetchImpl: (async () => { throw new Error("boom"); }) as never });
  eq("a thrown error is a fallback", [t.source, t.rejected], ["fallback", "error"]);
  delete process.env.OPENAI_API_KEY;
  const n = await selectStrategy({ situation: late, message: "x", recent: [] }, { fetchImpl: reply({}) as never });
  eq("no key is a fallback", [n.source, n.rejected], ["fallback", "no_key"]);
}

// ── against the real classifier: E3's turn offers the right strategies ─────────────────────────────────────────────────────────
{
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const o = { id: "AJUKI710045", status: "undelivered", total: 599, created_at: "2026-10-06T07:41:00Z", estimated_delivery: "2026-10-12", awb_code: "A", address: { phone: "9000100009" } } as SituationOrder;
  const input: SituationInput = {
    message: "I want oder my", recent: [{ direction: "in", body: "When will come my order tell me" }, { direction: "out", body: "I’m sorry this has been frustrating. Your order AJUKI710045 is already with the team — a support case was raised on 10 Oct." }],
    own: [o], now: NOW, openCase: true, lastBotReply: LATE_REPLY.replace("flagged", "flagged"),
  };
  const sit = classifySituation(input);
  eq("E3 is read as a late follow-up", sit.subtype, "delivery.late.followup");
  eq("…not decided by code, so the selector is asked", decidedByCode(sit), null);
  eq("…and reorder is not among the choices", candidatesFor(sit), ["late_reassure", "status_update", "hand_off_team"]);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
})();
