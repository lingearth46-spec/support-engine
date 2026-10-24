// Run with `npx tsx lib/replyBuilder.test.ts`.
// Building a reply from a strategy and the facts, and checking it mechanically. No model, no network.
import { buildReply, type BuildContext } from "./replyBuilder";
import { validateBuilt, FIXED_TEXTS } from "./replyValidate";
import { classifySituation, type SituationInput, type SituationOrder } from "./situation";
import { STRATEGY_IDS, STRATEGIES } from "./strategyCatalogue";
import {
  PENDING_REPLY, CHASING_REPLY, CHASING_AGAIN_REPLY, RETURN_PAGE_REPLY, WINDOW_CLOSED_EMAIL_REPLY, NO_RETURN_EMAIL_REPLY, rejectedReply,
} from "./returnStateReply";
import { CANCEL_REPLY, CANCEL_TOO_OLD_REPLY, CANCEL_INSIST_REPLY } from "./cancelStateReply";
import { LATE_REPLY, LATE_INSIST_TRACK_REPLY, lateFirstText } from "./lateDeliveryReply";
import { FLAG_REPLY } from "./businessTruths";
import type { OrderRow } from "./orderLines";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

const NOW = Date.now(); // the return window is measured against the real clock, so a fixed date goes stale (fell over on 14 Oct 2026)
const day = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const order = (o: Partial<SituationOrder> & { id: string; status: string }): SituationOrder =>
  ({ total: 499, created_at: day(3), address: { phone: "9000000001" }, ...o }) as SituationOrder;

const sit = (message: string, own: SituationOrder[], o: Partial<SituationInput> = {}) =>
  classifySituation({ message, recent: [], own, now: NOW, senderPhone: "9000000001", ...o });
const ctx = (message: string, own: SituationOrder[], o: Partial<BuildContext> = {}): BuildContext =>
  ({ message, recent: [], own, now: NOW, senderPhone: "9000000001", ...o });

const cancelled = order({ id: "AJUKI710030", status: "cancelled" });
const shipped = order({ id: "AJUKI710009", status: "shipped", awb_code: "AWB1", estimated_delivery: day(-2).slice(0, 10), tracking_url: "https://track.example/AWB1" });
const overdue = order({ id: "AJUKI710041", status: "undelivered", awb_code: "AWB4", estimated_delivery: day(5).slice(0, 10) });
const delivered = order({ id: "AJUKI710050", status: "delivered", delivered_at: day(3), awb_code: "AWB5" });
const rejected = order({ id: "AJUKI710052", status: "delivered", delivered_at: day(6), return_request: { status: "rejected", reason: "x", submitted_at: day(5), resolved_at: day(2) } as never });

(async () => {
// ── every strategy can be built, and says whether its wording is approved ────────────────────────────────────────────────────
{
  const any = sit("hi", [shipped]);
  const results = STRATEGY_IDS.map((id) => buildReply(id, any, ctx("hi", [shipped])));
  eq("every strategy returns a result for its own id", results.every((r, i) => r.strategy === STRATEGY_IDS[i]), true);
  eq("approval in the result is the catalogue's", results.every((r) => r.approved === STRATEGIES[r.strategy].approved), true);
}

// ── fixed lines ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("hand-off flags the team", (() => { const b = buildReply("hand_off_team", sit("x", [shipped]), ctx("x", [shipped])); return [b.text, b.action, b.escalates]; })(), [FLAG_REPLY, "escalate", true]);
eq("stay quiet sends nothing", (() => { const b = buildReply("stay_quiet", sit("Sure", [shipped]), ctx("Sure", [shipped])); return [b.ok, b.text, b.action]; })(), [true, null, "none"]);
eq("a cancel the system carries out is not built here", (() => { const b = buildReply("cancel_order", sit("cancel", [shipped]), ctx("cancel", [shipped])); return [b.text, b.action, b.source]; })(), [null, "model_action", "action"]);

// ── cancellation ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const s = sit("I don't want", [cancelled]);
  eq("already cancelled names the order and nothing else", buildReply("state_cancelled", s, ctx("I don't want", [cancelled])).text, "Your order #AJUKI710030 is already cancelled.");
  const bad = buildReply("state_cancelled", sit("I don't want", [shipped]), ctx("I don't want", [shipped]));
  eq("…and refuses when the order is not cancelled", [bad.ok, bad.reason], [false, "no_cancelled_order"]);
  eq("dispatched", buildReply("refuse_cancel", sit("cancel my order", [shipped]), ctx("cancel my order", [shipped])).text, CANCEL_REPLY);
  eq("after we refused", buildReply("refuse_cancel", sit("please cancel", [shipped], { lastBotReply: CANCEL_REPLY }), ctx("please cancel", [shipped], { lastBotReply: CANCEL_REPLY })).text, CANCEL_INSIST_REPLY);
  const old = order({ id: "AJUKI710061", status: "processing", created_at: day(3) });
  eq("past the 24-hour window", buildReply("refuse_cancel", sit("cancel my order", [old]), ctx("cancel my order", [old])).text, CANCEL_TOO_OLD_REPLY);
}

// ── returns ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const pend = order({ id: "AJUKI710082", status: "delivered", delivered_at: day(3), return_request: { status: "pending", reason: "x", submitted_at: day(1) } as never });
  eq("pending", buildReply("return_state", sit("any update on my return", [pend]), ctx("any update on my return", [pend])).text, PENDING_REPLY);
  const rj = buildReply("return_state", sit("what about my return", [rejected]), ctx("what about my return", [rejected]));
  eq("rejected carries the date from the record", rj.text, rejectedReply(day(2)));
  eq("rejected and chasing", buildReply("return_state", sit("I have emailed, no reply", [rejected]), ctx("I have emailed, no reply", [rejected])).text, CHASING_REPLY);
  const again = "I have emailed, still no reply";
  eq("chasing again after the first chase line: the second line", buildReply("return_state", sit(again, [rejected], { lastBotReply: CHASING_REPLY }), ctx(again, [rejected], { lastBotReply: CHASING_REPLY })).text, CHASING_AGAIN_REPLY);
  eq("a fault inside the window goes to the returns page", buildReply("return_state", sit("it arrived damaged", [delivered]), ctx("it arrived damaged", [delivered])).text, RETURN_PAGE_REPLY);
  const closed = order({ id: "AJUKI710092", status: "delivered", delivered_at: day(20) });
  eq("…and past it, to senior support", buildReply("return_state", sit("it arrived damaged", [closed]), ctx("it arrived damaged", [closed])).text, WINDOW_CLOSED_EMAIL_REPLY);
  eq("insisting after the page", buildReply("return_state", sit("it arrived damaged, please help", [delivered], { lastBotReply: RETURN_PAGE_REPLY }), ctx("it arrived damaged, please help", [delivered], { lastBotReply: RETURN_PAGE_REPLY })).text, NO_RETURN_EMAIL_REPLY);
  const none = buildReply("return_state", sit("where is my order", [shipped]), ctx("where is my order", [shipped]));
  eq("no return line for a situation that is not a return", [none.ok, none.text], [false, null]);
}

// ── delivery ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const first = buildReply("late_reassure", sit("where is my order", [overdue]), ctx("where is my order", [overdue]));
  eq("first time: the flag line, to the team", [first.text, first.escalates], [lateFirstText(overdue), true]);
  const told = buildReply("late_reassure", sit("when", [overdue], { lastBotReply: lateFirstText(overdue) }), ctx("when", [overdue], { lastBotReply: lateFirstText(overdue) }));
  eq("already told: 'already on it' with where to track (the founder's decision, 11 Oct)", told.text, LATE_INSIST_TRACK_REPLY);
  const withCase = buildReply("late_reassure", sit("when", [overdue], { openCase: true }), ctx("when", [overdue]));
  eq("an open case counts as told", withCase.text, LATE_INSIST_TRACK_REPLY);
  const st = buildReply("status_update", sit("when will it come", [shipped]), ctx("when will it come", [shipped]));
  eq("a status line from the record, with our own tracking page (never the courier link)", st.text?.startsWith("Order AJUKI710009 is on its way.") && st.text.includes("www.ajuki.in/track") && !st.text.includes("track.example"), true);
  eq("…its wording is approved", st.approved, true);
  const st2 = buildReply("status_update", sit("when", [overdue], { openCase: true }), ctx("when", [overdue]));
  eq("an open case is mentioned, on its own line", st2.text?.endsWith("\n\nIt is already with the team."), true);
  const none = buildReply("status_update", sit("when", [shipped, cancelled]), ctx("when", [shipped, cancelled]));
  eq("no single order, no status line", [none.ok, none.reason], [false, "no_subject_order"]);
}

// ── refunds ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const refunds = { AJUKI710030: { status: "REFUND_ELIGIBLE", amount: 634, since: "2026-10-04T02:59:53Z" } };
  const s = sit("still no refund", [cancelled], { refunds, hasRefundRecord: true });
  const b = buildReply("refund_status", s, ctx("still no refund", [cancelled]));
  eq("a refund on record is stated with its amount and date", b.text, "Your refund of ₹634 for order #AJUKI710030 is in progress, started on 4 Oct.");
  eq("…and is approved wording", b.approved, true);
  const none = buildReply("refund_status", sit("where is my refund, you promised it", [delivered], { refunds: {} }), ctx("where is my refund, you promised it", [delivered]));
  eq("nothing on record: the Senior Support email (the founder's E4 decision)", none.text,
    "I can't see a refund on record for order #AJUKI710050. Please email our Senior Support Team at ajukisupport@gmail.com with your order number so they can check this.");
  const done = buildReply("refund_status", sit("refund?", [cancelled], { refunds: { AJUKI710030: { status: "REFUND_COMPLETED", amount: 634, since: "2026-10-04T00:00:00Z" } } }), ctx("refund?", [cancelled]));
  eq("a completed refund is not built without its processed date", [done.ok, done.reason], [false, "completed_refund_needs_processed_date"]);
  const review = buildReply("refund_status", sit("refund?", [cancelled], { refunds: { AJUKI710030: { status: "REFUND_MANUAL_REVIEW", amount: 634, since: "2026-10-04T00:00:00Z" } } }), ctx("refund?", [cancelled]));
  eq("a refund that needs a person is not described", [review.ok, review.reason], [false, "refund_state_needs_a_person:REFUND_MANUAL_REVIEW"]);
}
eq("collect address asks for the address and promises nothing", buildReply("collect_address", sit("Address change h sir", [order({ id: "AJUKI1", status: "processing", created_at: day(0.2) })]), ctx("x", [])).text,
  "Please send the new full address, including the pincode.");

// ── the validator ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const record = [cancelled, shipped];
const refundMap = new Map([["AJUKI710030", { status: "REFUND_ELIGIBLE" as const, amount: 634, since: "2026-10-04T02:59:53Z", processedAt: null }]]);
const v = (text: string, source: "fixed" | "template" = "template", strategy: "state_cancelled" | "refund_status" | "hand_off_team" = "state_cancelled", refs: string[] = []) =>
  validateBuilt({ built: { text, source, strategy, approved: STRATEGIES[strategy].approved, refs }, orders: record as unknown as OrderRow[], refunds: refundMap, message: "x" });
eq("an approved fixed line is verbatim", v(FLAG_REPLY, "fixed", "hand_off_team").fixedVerbatim, true);
eq("a drifted copy of a fixed line is caught", v(FLAG_REPLY + " Soon.", "fixed", "hand_off_team").violations.some((x) => x.rule === "fixed_text_drifted"), true);
eq("a built line about a real order passes", v("Your order #AJUKI710030 is already cancelled.").ok, true);
eq("an order id that is not in the record is caught", v("Your order #AJUKI710001 is already cancelled.").violations.some((x) => x.rule === "order_id"), true);
eq("the refund line with the recorded amount passes", v("Your refund of ₹634 for order #AJUKI710030 is in progress, started on 4 Oct.", "template", "refund_status").ok, true);
eq("an amount that is not in the record is caught", v("Your refund of ₹999 for order #AJUKI710030 is in progress.", "template", "refund_status").violations.some((x) => x.rule === "amount"), true);
eq("a refund promise is caught", v("We will refund you within 2 days.").ok, false);
eq("a delivery promise is caught", v("Your order #AJUKI710009 will be delivered tomorrow.").ok, false);
eq("approved wording is not flagged", [v("Your refund of ₹634 for order #AJUKI710030 is in progress.", "template", "refund_status").ok, v("Your refund of ₹634 for order #AJUKI710030 is in progress.", "template", "refund_status").unapproved], [true, false]);
eq("a built result that says it is not approved is flagged", validateBuilt({ built: { text: "Your order #AJUKI710030 is already cancelled.", source: "template", strategy: "state_cancelled", approved: false, refs: [] }, orders: [cancelled] as unknown as OrderRow[], message: "x" }).unapproved, true);
eq("the tracking line passes the gate and is on the approved list", [FIXED_TEXTS.has(LATE_INSIST_TRACK_REPLY), v(LATE_INSIST_TRACK_REPLY, "fixed", "hand_off_team").violations.length], [true, 0]);
eq("nothing to send is fine", validateBuilt({ built: { text: null, source: "none", strategy: "stay_quiet", approved: true, refs: [] }, orders: [], message: "x" }).ok, true);
eq("every fixed constant the builder can return is on the approved list",
  [FLAG_REPLY, LATE_REPLY, LATE_INSIST_TRACK_REPLY, CHASING_AGAIN_REPLY, CANCEL_REPLY, PENDING_REPLY].every((t) => FIXED_TEXTS.has(t)), true);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
})();
