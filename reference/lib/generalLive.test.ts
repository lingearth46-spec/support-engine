// Run with `npx tsx lib/generalLive.test.ts`. Live use: on by default at 100% (a flag turns it down), stable sample, never replaces fixed replies or actions,
// rates before using, falls back on damage or error, hands off through the existing escalation shape. Model stubbed.
import { FLAG_REPLY } from "@/lib/businessTruths";
import { generalLiveEnabled, liveSampled, eligibleForLive, generalLiveDecision, withoutScanText, nearDuplicate } from "./generalLive";
import { finalGuard } from "./finalGuard";
import type { SupportDecision } from "./gemini";
import { hasAssurance as hasAssuranceCheck } from "./lateReassurance";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
process.env.OPENAI_API_KEY = "test";

// ── switches ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
eq("on by default (founder, 2026-10-12)", generalLiveEnabled({}), true);
eq("explicitly on", generalLiveEnabled({ SUPPORT_GENERAL_LIVE: "1" }), true);
eq("off with 0", generalLiveEnabled({ SUPPORT_GENERAL_LIVE: "0" }), false);
eq("off with 'off'", generalLiveEnabled({ SUPPORT_GENERAL_LIVE: "off" }), false);
eq("pause beats the default", generalLiveEnabled({ SUPPORT_GENERAL_LIVE_PAUSE: "1" }), false);
eq("pause beats an explicit on", generalLiveEnabled({ SUPPORT_GENERAL_LIVE: "1", SUPPORT_GENERAL_LIVE_PAUSE: "1" }), false);
eq("everybody at the default rate", liveSampled("9000000001", {}), true);
eq("everybody at rate 1", liveSampled("9000000001", { SUPPORT_GENERAL_LIVE_RATE: "1" }), true);
eq("nobody at rate 0", liveSampled("9000000001", { SUPPORT_GENERAL_LIVE_RATE: "0" }), false);
eq("a blank rate is the default, not zero", liveSampled("9000000001", { SUPPORT_GENERAL_LIVE_RATE: "" }), true);
{
  const env = { SUPPORT_GENERAL_LIVE_RATE: "0.1" };
  eq("a customer is always in or always out", new Set([1, 2, 3].map(() => liveSampled("9111111111", env))).size, 1);
  const n = Array.from({ length: 1000 }, (_, i) => liveSampled(`9${String(i).padStart(9, "0")}`, env)).filter(Boolean).length;
  eq("about a tenth at rate 0.1", n > 60 && n < 150, true);
}

// ── eligibility ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const plain: SupportDecision = { action: "reply", tag: "other" as never, text: "Hello", meta: { provenance: "model_verified" } };
eq("a plain model reply is eligible", eligibleForLive(plain, 0), null);
eq("a photo is not", eligibleForLive(plain, 1), "photo");
eq("an order action is not", eligibleForLive({ ...plain, orderAction: { kind: "cancel_order", orderId: "AJUKI1" } as never }, 0), "order_action");
eq("a fixed reply is not", eligibleForLive({ ...plain, meta: { fixedReply: "late_insist" } }, 0), "fixed_reply");
eq("a fixed provenance is not", eligibleForLive({ ...plain, meta: { provenance: "fixed:greeting" } }, 0), "fixed_reply");

// ── the decision ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const RECORD = "=== CUSTOMER ===\n+91 9000000001 · 1 order(s)\n\n#AJUKI710009 · shipped · ₹499 · expected around 14 Oct · track: www.ajuki.in/track (Delhivery, AWB 6000)";
const reply = (text: string, reason = "none") => (async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: text, handoff_reason: reason }) } }], usage: { total_tokens: 500 } }), { status: 200 })) as unknown as typeof fetch;
const base = { decision: plain, message: "where is my order", history: [{ direction: "in" as const, body: "where is my order" }], orderContext: RECORD, products: "", scopedOrderIds: ["AJUKI710009"] };

(async () => {
  const ok = await generalLiveDecision(base, { fetchImpl: reply("Your order AJUKI710009 is shipped and expected around 14 Oct. Track it at www.ajuki.in/track.") });
  eq("a true reply is used", [ok.info.used, ok.decision?.action, ok.decision?.tag], [true, "reply", "other"]);
  eq("it carries the verified provenance so the final guard lets it through", finalGuard(ok.decision!).text, ok.decision!.text);
  eq("what it replaced is kept for the trace", (ok.decision!.meta as any).replacedDraft, "Hello");

  // 18 Oct (founder): a reply about a late parcel always says we are working to get it delivered as soon as possible and that there is no need to worry (code adds it, verbatim).
  const LATE_RECORD = "=== CUSTOMER ===\n+91 9000000001 · 1 order(s)\n\n#AJUKI710009 · shipped · ₹499 · expected around 10 Oct · OVERDUE · STUCK (no courier scan in over 48h) · track: www.ajuki.in/track (Delhivery, AWB 6000)";
  const lateReply = "Your order AJUKI710009 is delayed; you can track it at www.ajuki.in/track.";
  const lateTurn = { ...base, decision: { ...plain, tag: "late_delivery" as never }, orderContext: LATE_RECORD };
  // The founder (18 Oct): "I hope that has not been put as a fixed line". The model writes the assurance in its own words; code only checks it is there.
  const OWN = "Sorry for the delay: it is on the courier's side, but we are doing all we can to get it to you as soon as possible, so please don't worry. You can track it at www.ajuki.in/track.";
  const written = await generalLiveDecision(lateTurn, { fetchImpl: reply(OWN) });
  eq("the model's own words are used untouched: no fixed sentence is added", [written.decision?.text, written.info.assurance, written.info.retried], [OWN, "written", false]);
  const seq = (texts: string[]) => { let n = 0; const bodies: string[] = []; const f = (async (_u: unknown, init?: { body?: string }) => { bodies.push(String(init?.body)); return reply(texts[Math.min(n++, texts.length - 1)])(_u as never, init as never); }) as unknown as typeof fetch; return { f, bodies }; };
  const s1 = seq([lateReply, OWN]);
  const retried = await generalLiveDecision(lateTurn, { fetchImpl: s1.f });
  eq("a draft that left it out is sent back once; the second draft's own words are used", [retried.decision?.text, retried.info.assurance, s1.bodies.length], [OWN, "retried", 2]);
  eq("the writer is told, on the first call, that the parcel is late, to say it in its own words, and may blame the courier", /THIS PARCEL IS LATE/.test(s1.bodies[0]) && /OWN words/.test(s1.bodies[0]) && /courier's side/.test(s1.bodies[0]), true);
  eq("the retry says what was missing", /LEFT OUT THE REASSURANCE/.test(s1.bodies[1]), true);
  const s2 = seq([lateReply, lateReply]);
  const forced = await generalLiveDecision(lateTurn, { fetchImpl: s2.f });
  eq("only when it still leaves it out is the fixed sentence added, as a last resort, and the trace says so", [forced.decision?.text, forced.info.assurance], [`${lateReply} The delay is on the courier's side. We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry.`, "appended"]);
  const late = forced;
  eq("it is still sendable (verified provenance), and the trace keeps what it replaced", [finalGuard(late.decision!).text === late.decision!.text, late.info.used], [true, true]);
  // 17 Oct replay: the writer reassured a returning parcel, and quoted the courier's note.
  const rto = await generalLiveDecision(lateTurn, { fetchImpl: reply("Your order is on its way back to us (RTO). We are doing everything we can to get it delivered as soon as possible, so there is no need to worry.") });
  eq("a writer that reassures a returning parcel about delivery is not used: the existing path answers", [rto.decision, rto.info.why], [null, "assurance_contradicts_reply"]);
  const del = await generalLiveDecision(lateTurn, { fetchImpl: reply("Our record shows your order was delivered on 10 Oct. We are doing everything we can to get it delivered as soon as possible, so there is no need to worry.") });
  eq("same for a delivered parcel", del.info.why, "assurance_contradicts_reply");
  const hin = seq(["Aapka order shipped hai aur expected around 21 Oct hai, track karein www.ajuki.in/track.", "Aapka order shipped hai aur hum abhi bhi iss par kaam kar rahe hain, track karein www.ajuki.in/track."]);
  const hr = await generalLiveDecision(lateTurn, { fetchImpl: hin.f });
  eq("a Hinglish reply that still lacks it is NOT given the English fixed sentence", /We are doing everything we can/.test(hr.decision?.text ?? ""), false);
  eq("the courier's own note is not shown to the writer", /courier note/.test(withoutScanText("#AJUKI1 · undelivered · delivery attempt 2, courier note: Customer not contactable · expected around 17 Oct")), false);
  const s3 = seq(["Your order is shipped. Track it at www.ajuki.in/track."]);
  const plainStatus = await generalLiveDecision({ ...base, decision: { ...plain, tag: "order_status" as never } }, { fetchImpl: s3.f });
  eq("a turn that is not about a late parcel is not told to reassure, and is not asked twice", !/THIS PARCEL IS LATE/.test(s3.bodies[0]) && s3.bodies.length === 1 && plainStatus.info.assurance === undefined, true);
  eq("Hinglish assurance in the model's own words counts", hasAssuranceCheck("Courier ki taraf se deri hui hai, hum jaldi se jaldi pahunchane ki poori koshish kar rahe hain, aap chinta mat kijiye."), true);
  const notLate = await generalLiveDecision({ ...base, decision: { ...plain, tag: "order_status" as never } }, { fetchImpl: reply("Your order AJUKI710009 is shipped and expected around 14 Oct. Track it at www.ajuki.in/track.") });
  eq("an ordinary status question on a parcel that is not late is left alone", /no need to worry/.test(notLate.decision?.text ?? ""), false);
  const returning = await generalLiveDecision({ ...base, decision: { ...plain, tag: "late_delivery" as never }, orderContext: LATE_RECORD }, { fetchImpl: reply("Your order AJUKI710009 is on its way back to us and cannot be delivered again. You can place a new order at www.ajuki.in.") });
  eq("a returning parcel is not told it will be delivered: no reassurance", /no need to worry/.test(returning.decision?.text ?? ""), false);

  const bad = await generalLiveDecision(base, { fetchImpl: reply("I will arrange a replacement for you right away.") });
  eq("a reply that promises a replacement is not used (the gate, or the ruler, refuses it)", bad.info.used, false);
  eq("and the existing decision stands", bad.decision, null);

  const fault = await generalLiveDecision({ ...base, message: "it arrived damaged", history: [{ direction: "in", body: "it arrived damaged" }] }, { fetchImpl: reply("I'm sorry about that. Please email ajukisupport@gmail.com with photos.") });
  eq("a fault with no case is handed off by code, through the existing escalation", [fault.decision?.action, fault.info.handoffSource], ["escalate", "fault_no_case"]);

  const err = await generalLiveDecision(base, { fetchImpl: (async () => new Response("{}", { status: 500 })) as never });
  eq("a model failure falls back", [err.decision, err.info.why.startsWith("model_error")], [null, true]);

  // choosing a courier is for a person
  const cc = await generalLiveDecision({ ...base, message: "Last time you said same and my order got cancelled", history: [{ direction: "in", body: "Please don't send it with shadowfax again, you don't have other delivery partner like Delhivery?" }, { direction: "out", body: "We are already on it." }, { direction: "in", body: "Last time you said same and my order got cancelled" }] }, { fetchImpl: (async () => { throw new Error("no model call expected"); }) as never });
  eq("a courier-choice request is handed to the team without a model call", [cc.decision?.action, cc.decision?.text?.startsWith("I can't choose or change the courier"), cc.info.tokens], ["escalate", true, 0]);
  // scan text is not shown to the model; the status markers and the date are
  const rec = `${RECORD} · OVERDUE by 2 days · STILL MOVING · last courier scan 5h ago at Mumbai_KurlaWest_P: "Manifest uploaded" · expected around 14 Oct`;
  eq("scan text is removed from the record", /Manifest|KurlaWest|last courier scan/.test(withoutScanText(rec)), false);
  eq("markers and dates stay", /OVERDUE by 2 days/.test(withoutScanText(rec)) && /expected around 14 Oct/.test(withoutScanText(rec)), true);
  // the same answer again is handed to the team, not pasted again
  eq("a near-identical answer is a duplicate", nearDuplicate("The Dorian Bracelet - Gold is currently out of stock; the Dorian Bracelet - Silver is in stock: https://x/a.", "The Dorian Bracelet - Gold is currently out of stock; the Dorian Bracelet - Silver is in stock (https://x/a)."), true);
  eq("a different answer is not", nearDuplicate("Your order is shipped and expected around 14 Oct. Track it at www.ajuki.in/track.", "The Dorian Bracelet - Gold is currently out of stock; Silver is in stock."), false);
  const same = "Your order AJUKI710009 is shipped and expected around 14 Oct. Track it at www.ajuki.in/track.";
  const dup = await generalLiveDecision({ ...base, history: [{ direction: "in", body: "where" }, { direction: "out", body: same }, { direction: "in", body: "ok when" }] }, { fetchImpl: reply(same) });
  eq("repeating our last reply becomes a hand-off, once acknowledged then quiet", [dup.decision?.action, dup.decision?.text, dup.info.handoffSource], ["escalate", FLAG_REPLY, "repeat"]);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
