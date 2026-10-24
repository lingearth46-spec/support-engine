// Run with `npx tsx lib/generalShadow.test.ts`.
// The general-path shadow: off by default, sampled stably, records the path's reply and the code's hand-off decision beside the live one,
// and merges into the inbound row without erasing what is there. Model and database are stubbed.
import { FLAG_REPLY } from "@policy/businessTruths";
import { generalShadowEnabled, sampled, runGeneralShadow, storeGeneralShadow } from "@engine/generalShadow";
import { mergeAiMeta } from "@engine/inboundMeta";
import { writeInboundTrace, silentTrace } from "@engine/decisionTrace";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
process.env.OPENAI_API_KEY = "test";
process.env.SUPPORT_PIPELINE_V2 = "1";

// ── the switch and the sample ───────────────────────────────────────────────────────────────────────────────────────────────────
eq("off when unset", generalShadowEnabled({}), false);
eq("off when 0", generalShadowEnabled({ SUPPORT_GENERAL_SHADOW: "0" }), false);
eq("on when 1", generalShadowEnabled({ SUPPORT_GENERAL_SHADOW: "1" }), true);
eq("the whole population by default", sampled("9000000001", {}), true);
eq("none at rate 0", sampled("9000000001", { SUPPORT_GENERAL_SHADOW_RATE: "0" }), false);
{
  const env = { SUPPORT_GENERAL_SHADOW_RATE: "0.5" };
  const same = [1, 2, 3].map(() => sampled("9111111111", env));
  eq("a customer is always in or always out", new Set(same).size, 1);
  const n = Array.from({ length: 400 }, (_, i) => sampled(`9${String(i).padStart(9, "0")}`, env)).filter(Boolean).length;
  eq("about half at rate 0.5", n > 140 && n < 260, true);
}

(async () => {
// ── a fake inbound row ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const fakeDb = (initial: Record<string, unknown> | null) => {
  const state = { ai_meta: initial as Record<string, unknown> | null, writes: 0 };
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ai_meta: state.ai_meta } }) }) }),
      update: (v: { ai_meta: Record<string, unknown> }) => ({ eq: async () => { state.ai_meta = v.ai_meta; state.writes++; return { error: null }; } }),
    }),
  };
  return { db: db as never, state };
};
{
  const f = fakeDb({ trace: { v: 1 } });
  await mergeAiMeta(f.db, "row1", { generalShadow: { v: 1 } });
  eq("a new key does not erase the one already there", f.state.ai_meta, { trace: { v: 1 }, generalShadow: { v: 1 } });
  const g = fakeDb(null);
  await mergeAiMeta(g.db, "row1", { a: 1 });
  eq("an empty row just gets the patch", g.state.ai_meta, { a: 1 });
  const h = fakeDb({ x: 1 });
  await mergeAiMeta(h.db, undefined, { a: 1 });
  eq("no row id: nothing is written", h.state.writes, 0);
  const boom = { from: () => { throw new Error("db down"); } };
  let threw = false;
  try { await mergeAiMeta(boom as never, "row1", { a: 1 }); } catch { threw = true; }
  eq("a failing database never throws into the handler", threw, false);
  const t = fakeDb({ generalShadow: { v: 1 } });
  await writeInboundTrace(t.db, "row1", silentTrace("silent", "ack_only", { v2: false, wake: false }));
  eq("the trace writer no longer erases the shadow", Object.keys(t.state.ai_meta ?? {}).sort(), ["generalShadow", "trace"]);
}

// ── the record ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const RECORD = "=== CUSTOMER ===\n+91 9000000001 · 1 order(s)\n\n#AJUKI710009 · shipped · ₹499 · expected around 14 Oct · track: https://track.example/AWB1";
const reply = (text: string, reason = "none") => (async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: text, handoff_reason: reason }) } }], usage: { total_tokens: 700 } }), { status: 200 })) as unknown as typeof fetch;
const base = {
  message: "Time??", thread: [{ direction: "in" as const, body: "Time??" }], record: RECORD, fullRecord: RECORD, products: "",
  handoffRecord: RECORD,
};
  const r = await runGeneralShadow({ ...base, live: { text: FLAG_REPLY, action: "escalate", kind: "fixed:flag" } },
    { fetchImpl: reply("Your order AJUKI710009 is shipped; expected around 14 Oct.") });
  eq("what the path would have sent", r.final, "Your order AJUKI710009 is shipped; expected around 14 Oct.");
  eq("what the live bot did is beside it", r.live, { kind: "fixed:flag", action: "escalate", flag: true, sameText: false });
  eq("no hand-off for a status question", [r.handOff, r.handoffSource], [false, "none"]);
  eq("one call, tokens counted, no error", [r.calls, r.tokens, r.error], [1, 700, null]);

  const same = await runGeneralShadow({ ...base, live: { text: "Your order AJUKI710009 is shipped; expected around 14 Oct.", action: "reply", kind: "model_verified" } },
    { fetchImpl: reply("Your order AJUKI710009 is shipped; expected around 14 Oct.") });
  eq("an identical reply is marked so", same.live.sameText, true);

  const model = await runGeneralShadow({ ...base, message: "what happens next", live: { text: "ok", action: "reply", kind: "model_verified" } },
    { fetchImpl: reply("You're welcome!", "complaint_about_handling") });
  eq("the model's own reason is recorded but decides nothing", [model.modelReason, model.handOff], ["complaint_about_handling", false]);

  const dmg = await runGeneralShadow({ ...base, message: "it arrived damaged", live: { text: "x", action: "reply", kind: "model_verified" } },
    { fetchImpl: reply("I'm sorry about that. Please email ajukisupport@gmail.com with photos.", "none") });
  eq("the code hands off a fault with nothing open", [dmg.handOff, dmg.handoffSource], [true, "fault_no_case"]);

  const f = fakeDb({ trace: { v: 1 } });
  await storeGeneralShadow(f.db, "row1", r);
  eq("stored under generalShadow, trace kept", Object.keys(f.state.ai_meta ?? {}).sort(), ["generalShadow", "trace"]);

  const fail = await runGeneralShadow({ ...base, live: { text: "x", action: "reply", kind: "k" } }, { fetchImpl: (async () => new Response("{}", { status: 500 })) as never });
  eq("a model failure is a record with the error, not an exception", [fail.error, fail.final], ["http_500", FLAG_REPLY]);

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
