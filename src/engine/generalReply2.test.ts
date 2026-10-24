// Run with `npx tsx lib/generalReply2.test.ts`.
// The second general path: sentence-level checks that read meaning (who does what), repair before replacement, and hand-off by reason.
// The model is stubbed — no network.
import { generalReplyV2, analyseV2, dropOffending, generalV2Schema, HANDOFF_REASONS } from "@engine/generalReply2";
import { FLAG_REPLY, BUSINESS_TRUTHS } from "@policy/businessTruths";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

process.env.OPENAI_API_KEY = "test";
process.env.SUPPORT_PIPELINE_V2 = "1";
const RECORD = [
  "=== CUSTOMER ===", "+91 9000000001 · 1 order(s)", "Already with the team: 1 open support case (topic: late delivery), raised 10 Oct, reason: late parcel.", "",
  "#AJUKI710009 · shipped · ₹499 · ordered 6 Oct · expected around 14 Oct · track: https://track.example/AWB1 · COD, ₹499 due on delivery",
].join("\n");
const input = {
  message: "Time??", thread: [{ direction: "in" as const, body: "Where is my order" }, { direction: "out" as const, body: "Your order AJUKI710009 is on its way." }, { direction: "in" as const, body: "Time??" }],
  record: RECORD, products: "",
};
const EV = [BUSINESS_TRUTHS, RECORD];
const CTX = ["Time??"];

// A stub that answers with the next reply in the list, and records what it was asked.
const seq = (replies: { reply: string; reason?: string }[]) => {
  const asked: string[] = [];
  let i = 0;
  const fetchImpl = (async (_u: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    asked.push(String(body.messages?.at(-1)?.content ?? ""));
    const r = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: r.reply, handoff_reason: r.reason ?? "none" }) } }], usage: { total_tokens: 500 } }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, asked };
};

(async () => {
// ── meaning, not words ───────────────────────────────────────────────────────────────────────────────────────────────────────
const bad = (t: string) => analyseV2(t, EV, CTX).issues.map((x) => x.reasons.map((r) => r.split(":")[0]));
eq("'we have escalated it for you' is a performer claim", bad("We have escalated it for you.").flat().includes("performer_claim"), true);
eq("'I've flagged this request to the team' is too", bad("I've flagged this request to the team for a phone call.").flat().includes("performer_claim"), true);
eq("'we will look into it' is too", bad("We will look into it and update you.").flat().includes("performer_claim"), true);
eq("'I can check if your order is eligible' is an offer it cannot keep", bad("I can check if your order is eligible.").flat().includes("performer_claim"), true);
eq("'I'll confirm what the page shows' is an offer it cannot keep", bad("I’ll confirm what the page shows.").flat().includes("performer_claim"), true);
eq("'they'll respond from that case' is a promise to reply", bad("They'll respond from that case.").flat().includes("performer_claim"), true);
eq("'the team is handling this' is fine when the record shows an open case", analyseV2("The team is handling this; the case was raised on 10 Oct.", EV, CTX).ok, true);
eq("…and not when it does not", analyseV2("The team is handling this.", [BUSINESS_TRUTHS, "#AJUKI710009 · shipped"], CTX).ok, false);
eq("what the RECORD shows about the team is not", analyseV2("Your order is already with the team — a support case was raised on 10 Oct.", EV, CTX).ok, true);
eq("…but only when the record shows an open case", analyseV2("Your order is already with the team.", [BUSINESS_TRUTHS, "#AJUKI710009 · shipped"], CTX).ok, false);
eq("negation is read per clause: 'if you can’t open the link, I’ll confirm what the page shows' still promises", analyseV2("If you can’t open the link, tell me the length and I’ll confirm what the page shows.", EV, CTX).ok, false);
eq("'They'll respond from that case — I can't add a second escalation' still promises a reply", analyseV2("This is already with our support team; a case was raised on 10 Oct. They'll respond from that case — I can't add a second escalation.", EV, CTX).ok, false);
eq("a negated sentence is a statement, not a promise", analyseV2("We cannot place phone calls from here; you can email ajukisupport@gmail.com.", EV, CTX).ok, true);
eq("…including a negated delivery date", analyseV2("Your order AJUKI710009 is on its way back to us, so it will not arrive today or tomorrow.", EV, CTX).ok, true);
eq("a real delivery promise is still refused", analyseV2("Your order AJUKI710009 will be delivered tomorrow.", EV, CTX).ok, false);
eq("a refund offer is still refused", analyseV2("We will refund you within 2 days.", EV, CTX).ok, false);
eq("an order id that is not the customer's is still refused", analyseV2("Your order AJUKI710044 is on its way.", EV, CTX).ok, false);
eq("'you can check the status here' is the customer's action, not ours", analyseV2("You can check the status here: https://track.example/AWB1", EV, CTX).ok, true);
eq("any approved fixed line, verbatim, passes even though it says 'they will update you'", analyseV2("Your return request is with our returns team. Please wait until they decide on it — they will update you here.", EV, CTX).ok, true);
eq("the approved flag line, verbatim, passes", analyseV2(FLAG_REPLY, EV, CTX).ok, true);
eq("a clean status passes", analyseV2("Your order AJUKI710009 is shipped and expected around 14 Oct. Track it here: https://track.example/AWB1", EV, CTX).ok, true);
eq("the offending sentence is the one named, not the whole reply", analyseV2("Your order AJUKI710009 is shipped. We have escalated it for you.", EV, CTX).issues.map((x) => x.sentence), ["We have escalated it for you."]);
eq("dropping it keeps the rest", dropOffending("Your order AJUKI710009 is shipped. We have escalated it for you.", [{ sentence: "We have escalated it for you.", reasons: ["x"] }]), "Your order AJUKI710009 is shipped.");
eq("nothing worth sending is left → null", dropOffending("We have escalated it for you.", [{ sentence: "We have escalated it for you.", reasons: ["x"] }]), null);

// ── hand-off is a reason, from a closed list ──────────────────────────────────────────────────────────────────────────────────
eq("the schema has no needs_human, only a reason", [Object.keys(generalV2Schema().schema.properties), HANDOFF_REASONS.includes("none")], [["reply", "handoff_reason"], true]);
{
  const ok = seq([{ reply: "Your order AJUKI710009 is shipped; expected around 14 Oct.", reason: "none" }]);
  const r = await generalReplyV2(input, { fetchImpl: ok.fetchImpl });
  eq("a clean answer is sent as written, one call", [r.final, r.repair, r.handOff, r.calls], ["Your order AJUKI710009 is shipped; expected around 14 Oct.", "none", false, 1]);
  const h = seq([{ reply: "I'm sorry about the damage. Please email ajukisupport@gmail.com with photos.", reason: "damage_or_defect" }]);
  const rh = await generalReplyV2(input, { fetchImpl: h.fetchImpl });
  eq("a listed reason hands off", [rh.handOff, rh.handoffReason], [true, "damage_or_defect"]);
  const junk = seq([{ reply: "Your order AJUKI710009 is shipped.", reason: "bored" }]);
  const rj = await generalReplyV2(input, { fetchImpl: junk.fetchImpl });
  eq("a reason that is not on the list is treated as 'cannot answer from facts'", [rj.handoffReason, rj.handOff], ["cannot_answer_from_facts", true]);
}

// ── repair before replacement ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  // First draft claims an action; the rewrite is clean → sent, and the flag line is never used.
  const s = seq([
    { reply: "Your order AJUKI710009 is shipped. We have escalated it for you." },
    { reply: "Your order AJUKI710009 is shipped and expected around 14 Oct." },
  ]);
  const r = await generalReplyV2(input, { fetchImpl: s.fetchImpl });
  eq("regenerated once, with the refused sentence named", [r.repair, r.final, r.calls], ["regenerated", "Your order AJUKI710009 is shipped and expected around 14 Oct.", 2]);
  eq("…the second ask quotes what was refused", s.asked[1].includes("We have escalated it for you."), true);
  eq("…and the first block is on the record", (r.firstBlocked ?? []).some((b) => b.startsWith("performer_claim")), true);
}
{
  // Both drafts carry the bad sentence: only that sentence is dropped.
  const s = seq([
    { reply: "Your order AJUKI710009 is shipped. We have escalated it for you." },
    { reply: "Your order AJUKI710009 is shipped. I have flagged this for a call." },
  ]);
  const r = await generalReplyV2(input, { fetchImpl: s.fetchImpl });
  eq("the offending sentence alone is dropped, the answer stays", [r.repair, r.final], ["dropped", "Your order AJUKI710009 is shipped."]);
}
{
  // Nothing usable in either: the flag line is the last resort, and it says so.
  const s = seq([{ reply: "We have escalated it for you." }, { reply: "I have escalated this for you." }]);
  const r = await generalReplyV2(input, { fetchImpl: s.fetchImpl });
  eq("only then the flag line", [r.repair, r.final, r.handOff], ["flag", FLAG_REPLY, true]);
}
eq("an HTTP error is the flag line with the reason", await (async () => {
  const r = await generalReplyV2(input, { fetchImpl: (async () => new Response("{}", { status: 500 })) as never });
  return [r.final, r.error];
})(), [FLAG_REPLY, "http_500"]);

{
  // Decided in code, no model call at all.
  let called = 0;
  const spy = (async () => { called++; return new Response("{}", { status: 500 }); }) as never;
  const ack = await generalReplyV2({ ...input, message: "Ok" }, { fetchImpl: spy });
  eq("a bare acknowledgement gets no reply and no call", [ack.final, ack.handOff, ack.calls, called], ["", false, 0, 0]);
  const upd = await generalReplyV2({ ...input, message: "Update phone" }, { fetchImpl: spy });
  eq("a typed 'Update phone' is a request for the number, no call", [upd.final, upd.handOff, called], ["Please send the new mobile number you would like on your order, along with your order number.", false, 0]);
  const tom = await generalReplyV2({ ...input, message: "Deliver tomorrow" }, { fetchImpl: spy });
  eq("a typed 'Deliver tomorrow' promises no date", [/can't give a delivery date/.test(tom.final ?? ""), called], [true, 0]);
}

{
  const { analyseV2 } = await import("@engine/generalReply2");
  const ev = ["#AJUKI710077 · shipped · overdue by 2 days · NO COURIER SCANS on record"];
  eq("a passive 'has been escalated' with no case is refused", analyseV2("Your order is overdue and has been escalated.", ev, []).ok, false);
  eq("the same with an open case in the record is a statement of the record", analyseV2("Your order is overdue and has been escalated.", [...ev, "support case raised on 12 Oct, open"], []).ok, true);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
})();
