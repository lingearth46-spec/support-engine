// Run with `npx tsx lib/decisionTrace.test.ts`.
// The decision trace: what is recorded for a sent, overridden, withheld or held reply, that nothing in it changes a decision, and that
// the generator's verifier verdicts reach it. generateSupportReply runs against a stubbed OpenAI (no network).
import {
  buildTrace, bucketOf, decisionTraceEnabled, pathOf, promptFingerprint, silentTrace, withTraceOutcome, writeInboundTrace, TRACE_VERSION,
} from "./decisionTrace";
import { generateSupportReply } from "./openaiSupport";
import { DEFAULT_ESCALATE_KEYWORDS } from "./supportGuardrails";
import type { WaConfig } from "./waSupport";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

(async () => {
// ── the switch ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("off when unset", decisionTraceEnabled({}), false);
eq("on with its own flag", decisionTraceEnabled({ SUPPORT_DECISION_TRACE: "1" }), true);
eq("implied by the pipeline flag", decisionTraceEnabled({ SUPPORT_PIPELINE_V2: "1" }), true);
eq("0 is off", decisionTraceEnabled({ SUPPORT_DECISION_TRACE: "0" }), false);

// ── the path ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("fixed rule", pathOf({ fixedReply: "return_state" }), "code:return_state");
eq("fast path", pathOf({ fixedReply: "greeting", fastPath: true }), "code:fast:greeting");
eq("keyword", pathOf({ keyword: "legal" }), "code:keyword");
eq("verified model text", pathOf({ provenance: "model_verified" }), "llm:verified");
eq("repaired model text", pathOf({ provenance: "model_repaired_verified" }), "llm:repaired");
eq("the flag line", pathOf({ provenance: "fixed:flag" }), "fallback:flag");
eq("a fixed rule wins over the model's provenance it was spread from", pathOf({ fixedReply: "already_cancelled", provenance: "model_verified" }), "code:already_cancelled");
eq("no text", pathOf({}, false), "none");

// ── a sent model reply ───────────────────────────────────────────────────────────────────────────────────────────────────────
const sentMeta = {
  model: "gpt-5-mini", latencyMs: 4200, usage: { total_tokens: 3100 }, provenance: "model_verified", promptHash: "abc123",
  verify: { judge: "ok", judgeModel: "gpt-5-mini", regen: "none", gate: [], claims: 0, kind_claims: 0, exempt: 1 },
};
{
  const t = buildTrace({
    decision: { action: "reply", tag: "order_status", text: "Your order is out for delivery.", meta: sentMeta },
    modelDraft: { action: "reply", tag: "order_status", text: "Your order is out for delivery.", provenance: "model_verified" },
    scope: { basis: "single", subject: "AJUKI710013", orders: 1 }, v2: true, wake: false, quietWaitMs: 60000,
  });
  eq("version", t.v, TRACE_VERSION);
  eq("sent by default", t.outcome, "sent");
  eq("path", t.path, "llm:verified");
  eq("situation carries scope and subject", [t.situation.scope, t.situation.subject, t.situation.orders], ["single", "AJUKI710013", 1]);
  eq("…and no subtype until the classifier is given", [t.situation.subtype, t.situation.agree, t.situation.facts], [null, null, []]);
  eq("selection slots exist and are empty until a later phase", t.selection, { strategy: null, rule_ids: [], fact_ids: [] });
  eq("verifier verdict", [t.verifier.judge, t.verifier.regen, t.verifier.exempt], ["ok", "none", 1]);
  eq("the draft is not repeated when it WAS what was sent", t.draft?.text, null);
  eq("model facts", t.model, { generator: "gpt-5-mini", judge: "gpt-5-mini", ms: 4200, tokens: 3100, prompt: "abc123" });
  eq("flags", t.flags, { v2: true, wake: false, fast: false });
  eq("quiet wait", t.quietWaitMs, 60000);
}

// ── an override: the draft is kept, the path says which rule ─────────────────────────────────────────────────────────────────
{
  const t = buildTrace({
    decision: { action: "reply", tag: "cancellation", text: "Your order #AJUKI710073 is already cancelled.", meta: { ...sentMeta, fixedReply: "already_cancelled", scope: "message" } },
    modelDraft: { action: "reply", tag: "cancellation", text: "Understood — it will not be cancelled.", provenance: "model_verified" },
    v2: true, wake: false,
  });
  eq("override path", t.path, "code:already_cancelled");
  eq("the model's own draft is kept", t.draft?.text, "Understood — it will not be cancelled.");
  eq("…with its provenance", t.draft?.provenance, "model_verified");
}

// ── a withheld draft ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const t = buildTrace({
    decision: { action: "escalate", tag: "other", reason: "ungrounded: unsupported_claim", text: "I have flagged this to the team.",
      meta: { provenance: "fixed:flag", withheld: "I'll update the address for you.", grounding: [{ rule: "unsupported_claim", detail: "x" }],
        verify: { judge: "claims", claims: 1, kind_claims: 1, exempt: 0, regen: "flag_line", judgeModel: "gpt-5-mini" } } },
    modelDraft: { action: "reply", tag: "other", text: "I'll update the address for you.", provenance: null },
    v2: false, wake: false,
  });
  eq("fallback path", t.path, "fallback:flag");
  eq("the withheld text is the draft", t.draft?.text, "I'll update the address for you.");
  eq("the reason is kept", t.reason, "ungrounded: unsupported_claim");
  eq("mechanical rules", t.checks.gate, ["unsupported_claim"]);
  eq("regeneration reason", t.verifier.regen, "flag_line");
}

// ── bounded size, no copied context ──────────────────────────────────────────────────────────────────────────────────────────
{
  const long = "x".repeat(5000);
  const t = buildTrace({
    decision: { action: "escalate", tag: "other", reason: long, text: "t", meta: { provenance: "fixed:flag", withheld: long, removed: [long, long, long, long, long] } },
    modelDraft: { action: "reply", tag: "other", text: long, provenance: null }, v2: false, wake: false,
  });
  eq("draft capped", (t.draft?.text ?? "").length <= 501, true);
  eq("removed capped in count and length", t.verifier.removed.length === 4 && t.verifier.removed.every((s) => s.length <= 241), true);
  eq("the whole record stays small", JSON.stringify(t).length < 2500, true);
}

// ── a repaired reply keeps what the model wrote before the cut ──────────────────────────────────────────────────────────────────
{
  const t = buildTrace({
    decision: { action: "reply", tag: "other", text: "Your order is with the courier.", meta: { provenance: "model_repaired_verified", repaired: true, preRepair: "Your order is with the courier. It will arrive tomorrow.", grounding: [{ rule: "delivery_promise" }] } },
    modelDraft: { action: "reply", tag: "other", text: "Your order is with the courier.", provenance: "model_repaired_verified" }, v2: false, wake: false,
  });
  eq("path", t.path, "llm:repaired");
  eq("the pre-repair text is the draft", t.draft?.text, "Your order is with the courier. It will arrive tomorrow.");
  eq("the rule that cut it", t.checks.gate, ["delivery_promise"]);
}

// ── silent / stood-down ──────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const t = silentTrace("silent", "ack_only", { v2: false, wake: true });
  eq("silent has no path", [t.outcome, t.path, t.reason], ["silent", "none", "ack_only"]);
  eq("wake flag kept", t.flags.wake, true);
}

// ── stamping the outcome ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const trace = buildTrace({ decision: { action: "reply", text: "ok", meta: { provenance: "model_verified" } }, v2: false, wake: false });
  const m = withTraceOutcome({ provenance: "model_verified", trace }, "escalated_ack", "late parcel");
  eq("outcome stamped", [(m.trace as any).outcome, (m.trace as any).reason], ["escalated_ack", "late parcel"]);
  eq("the rest of the meta is untouched", m.provenance, "model_verified");
  eq("the input trace is not mutated", trace.outcome, "sent");
  eq("no trace → meta returned as is", withTraceOutcome({ a: 1 } as Record<string, unknown>, "sent"), { a: 1 });
}

// ── the inbound writer is best-effort ────────────────────────────────────────────────────────────────────────────────────────
{
  const calls: unknown[] = [];
  const ok = { from: () => ({ update: (v: unknown) => { calls.push(v); return { eq: async () => ({ error: null }) }; } }) };
  const t = silentTrace("silent", "x", { v2: false, wake: false });
  await writeInboundTrace(ok as never, "row-1", t);
  eq("writes {trace} to ai_meta", calls, [{ ai_meta: { trace: t } }]);
  await writeInboundTrace(ok as never, undefined, t);
  eq("no inbound id → no write", calls.length, 1);
  const boom = { from: () => { throw new Error("db down"); } };
  let threw = false;
  try { await writeInboundTrace(boom as never, "row-1", t); } catch { threw = true; }
  eq("a failing write never throws into the reply path", threw, false);
}

// ── fingerprint ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("fingerprint is stable", promptFingerprint("hello"), promptFingerprint("hello"));
eq("fingerprint differs", promptFingerprint("hello") === promptFingerprint("hellp"), false);
eq("fingerprint is short", promptFingerprint("hello").length, 10);

// ── failure buckets ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const tr = (path: string, draft: boolean) => ({ path, draft: draft ? { action: "reply", tag: null, provenance: null, text: "d" } : null });
eq("acceptable is ok", bucketOf(tr("llm:verified", false), { sentAcceptable: true }), "ok");
eq("flag line, draft was fine → verifier false-block", bucketOf(tr("fallback:flag", true), { sentAcceptable: false, draftAcceptable: true }), "verifier_false_block");
eq("flag line, draft was bad → generator error", bucketOf(tr("fallback:flag", true), { sentAcceptable: false, draftAcceptable: false }), "generator_error");
eq("a fixed rule's wrong text → override error", bucketOf(tr("code:return_state", true), { sentAcceptable: false, draftAcceptable: true }), "override_error");
eq("bad model text that passed every check", bucketOf(tr("llm:verified", false), { sentAcceptable: false }), "passed_but_wrong");
eq("stale record → data error", bucketOf(tr("llm:verified", false), { sentAcceptable: false, dataWrong: true }), "data_error");
eq("wrong selection → selector error", bucketOf(tr("llm:verified", false), { sentAcceptable: false, selectorWrong: true }), "selector_error");

// ── end to end: the verifier's verdicts reach the generator's meta, only when the trace is on ───────────────────────────────────
const CONFIG: WaConfig = {
  id: 1, enabled: true, persona: "", holding_message: "", escalate_keywords: [...DEFAULT_ESCALATE_KEYWORDS],
  email_enabled: true, email_auto_reply: false, email_persona: "", instagram_persona: "",
};
const realFetch = globalThis.fetch;
const stub = (gen: { reply: string; tag: string; needs_human: boolean }, judgeAnswers: string[][]) => {
  let j = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const isGen = body.response_format?.json_schema?.name === "support_reply";
    const content = isGen ? JSON.stringify({ ...gen, reason: null, action: null }) : JSON.stringify({ unsupported: judgeAnswers[Math.min(j++, judgeAnswers.length - 1)] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: "stub" }), { status: 200 });
  }) as typeof fetch;
};
const run = async (traceOn: boolean, judge: string[][]) => {
  process.env.OPENAI_API_KEY = "test";
  delete process.env.SUPPORT_PIPELINE_V2;
  if (traceOn) process.env.SUPPORT_DECISION_TRACE = "1"; else delete process.env.SUPPORT_DECISION_TRACE;
  stub({ reply: "Your order AJUKI710013 is out for delivery today.", tag: "order_status", needs_human: false }, judge);
  try {
    return await generateSupportReply({
      message: "where is my order", history: [], chunks: [], config: { ...CONFIG, escalate_keywords: [] }, productContext: "",
      orderContext: "#AJUKI710013 · out for delivery · ₹499",
    });
  } finally { globalThis.fetch = realFetch; delete process.env.SUPPORT_DECISION_TRACE; }
};
{
  const pass = await run(true, [[]]);
  eq("passes", pass.meta?.provenance, "model_verified");
  const v = pass.meta?.verify as Record<string, unknown>;
  eq("judge verdict recorded", [v.judge, v.regen, v.claims], ["ok", "none", 0]);
  eq("judge model recorded", typeof v.judgeModel, "string");
  eq("prompt fingerprint recorded", typeof pass.meta?.promptHash, "string");

  const off = await run(false, [[]]);
  eq("trace off: no verify key", "verify" in (off.meta ?? {}), false);
  eq("trace off: no prompt hash", "promptHash" in (off.meta ?? {}), false);
  eq("trace off: same decision", [off.action, off.text, off.meta?.provenance], [pass.action, pass.text, pass.meta?.provenance]);

  const blocked = await run(true, [["Your order AJUKI710013 is out for delivery today."], ["Your order AJUKI710013 is out for delivery today."]]);
  eq("an unsupported claim with nothing left → flag line", blocked.meta?.provenance, "fixed:flag");
  const bv = blocked.meta?.verify as Record<string, unknown>;
  eq("…judge said claims, regeneration fell to the flag line", [bv.judge, bv.regen, bv.claims], ["claims", "flag_line", 1]);
  eq("…and the withheld draft is on the record", blocked.meta?.withheld, "Your order AJUKI710013 is out for delivery today.");
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
})();
