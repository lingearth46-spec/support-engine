// Run with `npx tsx lib/generalReply.test.ts`.
// The general conversational path: what the model is given, and the deterministic checks around what it writes. Model stubbed.
import { generalReply, buildGeneralPrompt, checkGeneralText, generalSchema } from "./generalReply";
import { FLAG_REPLY, BUSINESS_TRUTHS } from "./businessTruths";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

process.env.OPENAI_API_KEY = "test";
process.env.SUPPORT_PIPELINE_V2 = "1";
const RECORD = "=== CUSTOMER ===\n+91 9000000001 · 1 order(s)\n\n#AJUKI710009 · shipped · ₹499 · ordered 6 Oct · expected around 14 Oct · track: https://track.example/AWB1";
const input = {
  message: "Time??", thread: [{ direction: "in" as const, body: "Where is my order" }, { direction: "out" as const, body: "Your order AJUKI710009 is on its way." }, { direction: "in" as const, body: "Time??" }],
  record: RECORD, products: "",
};
const stub = (reply: string, needs = false, status = 200) =>
  (async (_u: unknown, init?: { body?: string }) => {
    void init;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply, needs_human: needs, reason: needs ? "needs a person" : null }) } }], usage: { total_tokens: 900 } }), { status });
  }) as typeof fetch;

(async () => {
// ── what the model is given ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const p = buildGeneralPrompt(input);
  eq("the system message carries the policies, the record and the product facts", [p.system.includes("BUSINESS FACTS"), p.system.includes(BUSINESS_TRUTHS.trim().slice(0, 40)), p.system.includes("#AJUKI710009"), p.system.includes("PRODUCT FACTS")], [true, true, true, true]);
  eq("the thread follows as turns", p.messages.slice(1).map((m) => m.role), ["user", "assistant", "user"]);
  eq("the last turn is the message being answered", p.messages.at(-1)?.content, "Time??");
  eq("it is told it cannot act", p.system.includes("You CANNOT perform actions"), true);
  eq("the output has no action field", Object.keys(generalSchema().schema.properties), ["reply", "needs_human", "reason"]);
}

// ── a good answer goes through ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const r = await generalReply(input, { fetchImpl: stub("Your order AJUKI710009 is on its way. Expected around 14 Oct. Track it here: https://track.example/AWB1") });
  eq("sent as written", [r.final, r.blocked, r.replacedByCode, r.handOff], ["Your order AJUKI710009 is on its way. Expected around 14 Oct. Track it here: https://track.example/AWB1", null, false, false]);
  eq("tokens are counted", r.tokens, 900);
}

// ── the checks around it ────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const refund = await generalReply(input, { fetchImpl: stub("Sorry about this. We will refund you ₹499 within 2 days.") });
  eq("a refund / time promise is replaced by the flag line, and that is recorded", [refund.final, refund.replacedByCode, (refund.blocked ?? []).length > 0, refund.draft?.startsWith("Sorry")], [FLAG_REPLY, true, true, true]);
  const invented = await generalReply(input, { fetchImpl: stub("Your order AJUKI710044 is on its way.") });
  eq("an order id that is not in the record is refused", [invented.final, (invented.blocked ?? []).some((b) => b.startsWith("order_id"))], [FLAG_REPLY, true]);
  const done = await generalReply(input, { fetchImpl: stub("I have updated your address as requested.") });
  eq("a claim that something was done is refused", [done.final, (done.blocked ?? []).some((b) => b.startsWith("action_claim"))], [FLAG_REPLY, true]);
  const cut = await generalReply(input, { fetchImpl: stub("Your order AJUKI710009 is on its way. It will be delivered tomorrow.") });
  eq("only a promise sentence is cut, the rest stands", [cut.final, cut.repaired, cut.replacedByCode], ["Your order AJUKI710009 is on its way.", true, true]);
  const human = await generalReply(input, { fetchImpl: stub("I understand. Our team will look at this for you.", true) });
  eq("a request for a person is carried, not blocked", [human.handOff, human.needsHuman, human.blocked], [true, true, null]);
  const q = await generalReply(input, { fetchImpl: stub("Do you want your current order delivered today?") });
  eq("a clarifying question that merely names 'today' is not a delivery promise (V2)", q.blocked, null);
}

// ── failure modes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("an HTTP error is the flag line", (await generalReply(input, { fetchImpl: stub("x", false, 500) })).error, "http_500");
{
  const k = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  const r = await generalReply(input, { fetchImpl: stub("x") });
  process.env.OPENAI_API_KEY = k;
  eq("no key: the flag line, with the reason", [r.final, r.error], [FLAG_REPLY, "no_key"]);
}
eq("the checker alone: clean text passes", checkGeneralText("Your order AJUKI710009 is on its way.", [RECORD], ["Time??"]).text, "Your order AJUKI710009 is on its way.");

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
})();
