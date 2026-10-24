// Run with `npx tsx lib/pipelineV2.test.ts`.
// The 10 Oct replay fixes behind SUPPORT_PIPELINE_V2, and — the point of the flag — that with it OFF nothing has changed.
import { pipelineV2Enabled, judgeKindsEnabled } from "./pipelineV2";
import { judgeReply, INSTRUCTIONS, INSTRUCTIONS_V2 } from "./groundingJudge";
import { groundingViolations } from "./replyGrounding";
import { sanitiseModelText, leakedInternalTerms } from "./replySanitize";
import { finalGuard } from "./finalGuard";
import { topicReply, productInfoReply, discountReply } from "./topicReplies";
import { returnStateReply } from "./returnStateReply";
import { repeatsRecentReply, repeatsLastReply } from "./waBurst";
import { FLAG_REPLY } from "./businessTruths";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const withFlag = async <T>(on: boolean, fn: () => T | Promise<T>): Promise<T> => {
  const before = process.env.SUPPORT_PIPELINE_V2;
  if (on) process.env.SUPPORT_PIPELINE_V2 = "1"; else delete process.env.SUPPORT_PIPELINE_V2;
  try { return await fn(); } finally { if (before === undefined) delete process.env.SUPPORT_PIPELINE_V2; else process.env.SUPPORT_PIPELINE_V2 = before; }
};

(async () => {
// ── the flag ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("off when unset", pipelineV2Enabled({}), false);
eq("off when 0", pipelineV2Enabled({ SUPPORT_PIPELINE_V2: "0" }), false);
eq("on when 1", pipelineV2Enabled({ SUPPORT_PIPELINE_V2: "1" }), true);

// ── the DTDC link (tracking_results) ─────────────────────────────────────────────────────────────────────────────────────────
const DTDC = "https://www.dtdc.in/tracking/tracking_results.asp?strCnno=7X121426160";
const evidence = [`#AJUKI710023 · delivered · track: ${DTDC} (DTDC, AWB 7X121426160)`];
const withLink = `Your parcel was delivered on 5 Oct. You can see it here: ${DTDC}`;
eq("control (flag off): the link's path segment is called an internal term",
  (await withFlag(false, () => groundingViolations(withLink, evidence, []))).map((v) => v.rule).includes("internal_term"), true);
eq("flag on: a link from the record is not an internal term",
  (await withFlag(true, () => groundingViolations(withLink, evidence, []))).map((v) => v.rule).includes("internal_term"), false);
eq("flag on: a link NOT in the record is still caught by the url rule",
  (await withFlag(true, () => groundingViolations("see https://example.com/some_page", evidence, []))).map((v) => v.rule).includes("url"), true);
eq("flag on: a bare snake_case word in prose is still an internal term",
  (await withFlag(true, () => groundingViolations("The tracking_results are ready.", evidence, []))).map((v) => v.rule).includes("internal_term"), true);

// the sanitiser: prose rewritten, link untouched
eq("flag on: prose 'tracking_results' becomes 'tracking page'",
  (await withFlag(true, () => sanitiseModelText("The tracking_results are ready.").text)), "The tracking page are ready.");
eq("flag on: the link keeps its path",
  (await withFlag(true, () => sanitiseModelText(`Open ${DTDC} now.`).text)), `Open www.ajuki.in/track now.`);
eq("flag on: prose is rewritten and the link beside it is not",
  (await withFlag(true, () => sanitiseModelText(`The tracking_results: ${DTDC}`).text)), `The tracking page: www.ajuki.in/track`);
eq("flag off: unchanged — tracking_results is not a known term", (await withFlag(false, () => sanitiseModelText("The tracking_results are ready.").text)), "The tracking_results are ready.");
eq("the final-text check ignores links", leakedInternalTerms(`See ${DTDC}`), []);
eq("the final-text check finds a leaked name", leakedInternalTerms("Your order is marked OVERDUE and tracking_results is empty."), ["tracking_results", "OVERDUE"]);
// …end to end: a sanitised final text has nothing left to find
{
  const out = await withFlag(true, () => sanitiseModelText(`Order AJUKI710023 is OVERDUE. The tracking_results: ${DTDC}`).text);
  eq("sanitise → final-text check: clean", leakedInternalTerms(out), []);
}
// the final guard
const modelDecision = (text: string) => ({ action: "reply" as const, tag: "other" as const, text, meta: { provenance: "model_verified" } });
{
  const g = await withFlag(true, () => finalGuard(modelDecision("Your order is tracking_results pending.")));
  eq("flag on: a leaked name in model text becomes the flag line", g.text, FLAG_REPLY);
  eq("…with a real escalation", g.action, "escalate");
  const ok = await withFlag(true, () => finalGuard(modelDecision(`Track it: ${DTDC}`)));
  eq("flag on: a clean model text with a link passes", ok.text, `Track it: ${DTDC}`);
  const fixed = await withFlag(true, () => finalGuard({ action: "reply", tag: "other", text: "a late_delivery thing", meta: { fixedReply: "x" } }));
  eq("a fixed reply is not second-guessed here", fixed.text, "a late_delivery thing");
  const off = await withFlag(false, () => finalGuard(modelDecision("Your order is tracking_results pending.")));
  eq("flag off: unchanged", off.text, "Your order is tracking_results pending.");
}

// ── the judge's instructions (the request body is inspected; no network) ─────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
const sent: { system: string; user: string }[] = [];
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = JSON.parse(init?.body ?? "{}");
  sent.push({ system: body.messages[0].content, user: body.messages[1].content });
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ unsupported: [] }) } }] }) } as Response;
}) as typeof fetch;
process.env.OPENAI_API_KEY = "test";
{
  // 18 Oct: the claim-kind reading is a switch of its own (SUPPORT_JUDGE_KINDS), ON by default; "flag off" here is both off.
  process.env.SUPPORT_JUDGE_KINDS = "off";
  await withFlag(false, () => judgeReply("Please send the new full address.", { evidence: ["e"], context: ["c"], exempt: ["Please send the new full address."] }));
  delete process.env.SUPPORT_JUDGE_KINDS;
  eq("flag off: the original instructions are sent", sent[0].system, INSTRUCTIONS);
  eq("flag off: no EXEMPT block is sent", sent[0].user.includes("EXEMPT"), false);
  eq("V2 unset, judge kinds at their default (on): the claim-kind instructions and the EXEMPT block are sent",
    await withFlag(false, async () => { await judgeReply("Please send the new full address.", { evidence: ["e"], context: ["c"], exempt: ["Please send the new full address."] }); return [sent[sent.length - 1].system === INSTRUCTIONS_V2, sent[sent.length - 1].user.includes("EXEMPT (not claims; do not list):")]; }), [true, true]);
  eq("judgeKindsEnabled: on by default, off only for 0 / off / false, always on with V2",
    [judgeKindsEnabled({}), judgeKindsEnabled({ SUPPORT_JUDGE_KINDS: "off" }), judgeKindsEnabled({ SUPPORT_JUDGE_KINDS: "0" }), judgeKindsEnabled({ SUPPORT_JUDGE_KINDS: "false" }), judgeKindsEnabled({ SUPPORT_JUDGE_KINDS: "on" }), judgeKindsEnabled({ SUPPORT_JUDGE_KINDS: "off", SUPPORT_PIPELINE_V2: "1" })], [true, false, false, false, true, true]);
  await withFlag(true, () => judgeReply("Please send the new full address.", { evidence: ["e"], context: ["c"], exempt: ["Please send the new full address."] }));
  eq("flag on: the claim-kind instructions are sent", sent[1].system, INSTRUCTIONS_V2);
  eq("flag on: the exempt sentences are listed", sent[1].user.includes("EXEMPT (not claims; do not list):\n- Please send the new full address."), true);
  eq("flag on: promises and outcome claims are still named as needing evidence", /PROMISE or COMMITMENT/.test(INSTRUCTIONS_V2) && /OUTCOME claim/.test(INSTRUCTIONS_V2), true);
  eq("flag on: 'not on record' is checked against the evidence", /NOT on record[^.]*supported when EVIDENCE truly does not contain it/.test(INSTRUCTIONS_V2), true);
  eq("flag on: it is not a bypass — unsupported outcome examples are listed", /I'll update it/.test(INSTRUCTIONS_V2) && /it will not be cancelled/.test(INSTRUCTIONS_V2), true);
}
globalThis.fetch = realFetch;

// ── topic matchers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const E1 = "Yeah fine If nothing available get me my original undelivered order";
eq("E1 control: 'original' is read as a quality question", productInfoReply({ message: E1 })?.kind, "quality");
eq("E1 flag on: it is not", productInfoReply({ message: E1, v2: true }), null);
eq("flag on: 'is it original?' still is a quality question", productInfoReply({ message: "is it original product?", v2: true })?.kind, "quality");
eq("flag on: '100% original?' too", productInfoReply({ message: "is this 100% original", v2: true })?.kind, "quality");
const E4 = "It has now been 3 days since I was promised a full refund. This is a great deal of trouble and I received a damaged product.";
eq("E4 control: 'deal' is a discount question", discountReply({ message: E4, tag: "complaint" })?.kind, "discount");
eq("E4 flag on: a refund chase is not", discountReply({ message: E4, tag: "complaint", v2: true }), null);
eq("flag on: a real discount question still is", discountReply({ message: "any discount code available?", tag: "offer_discount", v2: true })?.kind, "discount");
eq("topicReply threads the flag through", topicReply({ message: E1, tag: "other", ownOrders: [], v2: true }), null);

// ── refund chase is not sent to the returns page ───────────────────────────────────────────────────────────────────────────────
const delivered = [{ id: "AJUKI710023", status: "delivered", delivered_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), return_request: null }];
const CHASE = "Dear AJUKI Support Team, it has now been 3 days since I was promised a full refund within 1–2 days, and I have still not received my refund.";
// 14 Oct: the refund-chase fix no longer waits for the flag (founder, "route Hinglish refund questions away from the raise-a-return line"), so with the flag off too a refund chase is left to the model.
eq("E4 flag off: the refund chase is no longer sent to the returns page", returnStateReply({ ownOrders: delivered as never, message: CHASE, tag: "complaint" }), null);
eq("E4 flag on: left to the model", returnStateReply({ ownOrders: delivered as never, message: CHASE, tag: "complaint", v2: true }), null);
eq("flag on: a plain return request still gets the page",
  /returns\/start/.test(returnStateReply({ ownOrders: delivered as never, message: "I want to return this", tag: "return", v2: true }) ?? ""), true);

// ── the repeat window ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const NOW = Date.parse("2026-10-10T10:00:00Z");
  const A = "Our Senior Support Team is already working on your issue. Please wait for their reply.";
  const B = "Your return request was reviewed and rejected on 9 Oct. If you would like to appeal, please email our Senior Support Team at ajukisupport@gmail.com with your order number and any photos or video showing the issue.";
  const mins = (n: number) => new Date(NOW - n * 60_000).toISOString();
  // D1: A, B, A, B … each line differs from the one before it
  const recent = [{ body: A, at: mins(30) }, { body: B, at: mins(20) }, { body: A, at: mins(10) }, { body: B, at: mins(2) }];
  eq("D1 control: the last-line check lets the alternating A through", repeatsLastReply(A, B, mins(2), NOW), false);
  eq("D1: the recent-lines window holds A", repeatsRecentReply(A, recent, NOW), true);
  eq("D1: and holds B", repeatsRecentReply(B, recent, NOW), true);
  eq("a line not said recently is sent", repeatsRecentReply("You can raise a return at www.ajuki.in/returns/start", recent, NOW), false);
  eq("a line said more than 6 hours ago is sent again", repeatsRecentReply(A, [{ body: A, at: mins(7 * 60) }], NOW), false);
  eq("case and punctuation do not defeat it", repeatsRecentReply(A.toUpperCase().replace(".", ""), recent, NOW), true);
}

// ── E3: a clarifying QUESTION is not a delivery promise ──────────────────────────────────────────────────────────────────────
{
  const Q = "Do you mean you want to reorder the same item, or do you want your current order delivered today?";
  const rules = async (on: boolean, text: string) => (await withFlag(on, () => groundingViolations(text, ["#AJUKI710045 · undelivered · ₹599"], []))).map((v) => v.rule);
  eq("control (flag off): the question is blocked as a delivery promise", (await rules(false, Q)).includes("delivery_promise"), true);
  eq("flag on: the same question is not", (await rules(true, Q)).includes("delivery_promise"), false);
  eq("flag on: a statement is still a delivery promise", (await rules(true, "Your order will be delivered tomorrow.")).includes("delivery_promise"), true);
  eq("flag on: a promise with a tag question is still caught", (await rules(true, "It will be delivered tomorrow, okay?")).includes("delivery_promise"), true);
  eq("flag on: a question that itself promises ('will it…') stays blocked (conservative)", (await rules(true, "It will be delivered today, shall I confirm?")).includes("delivery_promise"), true);
  eq("flag on: a statement then a question: only the statement counts", (await rules(true, "Your order is with the courier. Do you want it delivered today?")).includes("delivery_promise"), false);
}


console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
})();
