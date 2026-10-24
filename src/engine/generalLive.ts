// LIVE use of the general conversational path (lib/generalReply2.ts) for customers. ON BY DEFAULT at 100% since the founder's decision
// of 2026-10-12 ("push and deploy 100% the general path"); every switch below turns it back down without a deploy.
//
//   SUPPORT_GENERAL_LIVE=0|false|off   turns it off entirely (anything else, or unset, = on)
//   SUPPORT_GENERAL_LIVE_RATE=0.1      the share of customers, by a stable hash of the phone number (default 1 = everybody)
//   SUPPORT_GENERAL_LIVE_PAUSE=1       pauses it instantly without touching the rate
//
// It replaces ONLY the model-written reply of the existing handler (lib/waSupport.ts), after the fixed override chain has had its say:
//   · a fixed reply (a founder-worded line, a policy line) is never replaced;
//   · a turn where the existing path asked for an order action (cancel, address, phone) is never replaced, because the general path has
//     no action field and must not turn "do this" into "I will do this";
//   · photos are never replaced.
// Every general-path reply is rated with the damage ruler (lib/replyRating.ts) BEFORE it is used. An irreparable finding, a model error
// or an empty result falls back to what the existing path produced, untouched. Hand-off is decided in code (lib/handoffDecision.ts) and
// then travels the existing escalation: acknowledgement once, team pinged, case recorded. The decision keeps its tag and its
// `model_verified` provenance, so the final guard, the repeat hold, the trace and the rating job treat it like any model reply.

import { createHash } from "node:crypto";
import type { SupportDecision } from "@adapters/ai/gemini";
import { BUSINESS_TRUTHS } from "@policy/businessTruths";
import { generalReplyV2, type GeneralV2Options } from "@engine/generalReply2";
import { decideHandoff } from "@engine/handoffDecision";
import { rateReply } from "@engine/replyRating";
import { recordFor } from "@engine/replyVerifier";
import { FLAG_REPLY } from "@policy/businessTruths";
import { analyseFollowUp, followUpNote } from "@engine/followUp";
import { withLateReassurance, lateTurnOf, lateNote, assuranceDue, isHinglish, contradictsAssurance, hasAssurance } from "@engine/lateReassurance";

export const followUpStageEnabled = (env: Record<string, string | undefined> = process.env): boolean => ["1", "true", "on"].includes((env.SUPPORT_FOLLOWUP_STAGE ?? "").trim().toLowerCase());

export const LIVE_VERSION = 1;

const on = (v: string | undefined) => ["1", "true", "on"].includes((v ?? "").trim().toLowerCase());

export function generalLiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.SUPPORT_GENERAL_LIVE ?? "").trim().toLowerCase();
  const off = v === "0" || v === "false" || v === "off";
  return !off && !on(env.SUPPORT_GENERAL_LIVE_PAUSE);
}

/** A stable sample: the same customer is always in or always out. A different salt from the shadow, so the two samples are independent. */
export function liveSampled(phone: string, env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.SUPPORT_GENERAL_LIVE_RATE;
  const rate = raw === undefined || raw.trim() === "" ? 1 : Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  const h = parseInt(createHash("sha1").update(`live:${phone}`).digest("hex").slice(0, 8), 16) / 0xffffffff;
  return h < rate;
}

export interface LiveInput {
  decision: SupportDecision;
  message: string;
  /** The thread so far, oldest first, as the existing handler holds it. */
  history: { direction: "in" | "out"; body: string }[];
  orderContext: string;
  products: string;
  scopedOrderIds: string[];
}
export interface LiveInfo {
  v: number;
  used: boolean;
  why: string;
  repair?: string;
  handoffSource?: string;
  alreadyOpen?: boolean;
  tier?: string;
  rules?: string[];
  tokens?: number;
  ms?: number;
  followUp?: string | null;
  retried?: boolean;
  /** A late-parcel turn: whether the reassurance was in the model's first draft, in its second, or had to be added as the fixed sentence. */
  assurance?: "written" | "retried" | "appended";
}
export type LiveResult = { decision: SupportDecision | null; info: LiveInfo };

/** Whether this turn may be answered by the general path at all. Pure. */
export function eligibleForLive(d: Pick<SupportDecision, "orderAction" | "meta">, imageCount: number): string | null {
  if (imageCount > 0) return "photo";
  if (d.orderAction) return "order_action";
  if (typeof d.meta?.fixedReply === "string" && d.meta.fixedReply) return "fixed_reply";
  if (typeof d.meta?.provenance === "string" && d.meta.provenance.startsWith("fixed:") && d.meta.provenance !== "fixed:flag") return "fixed_reply";
  return null;
}

/**
 * The record WITHOUT the courier's scan text. Customers do not understand "Manifest uploaded" or "Item OFD at IND_IndapureCA_SCC" and the
 * founder asked for it to go (12 Oct review, 10 of 78 replies). The model cannot quote what it is not shown, and the grounding check then
 * refuses a reply that tries. The status markers ("STILL MOVING", "OVERDUE", "STUCK") and the expected date stay, so lateness is still read.
 */
export function withoutScanText(record: string): string {
  return (record ?? "")
    .replace(/\s*·?\s*last courier scan[^"\n]*"[^"\n]*"/gi, "")
    .replace(/\(no courier scan in over \d+h\)/gi, "")
    // 18 Oct: the courier's own note ("courier note: Customer not contactable") is not for the customer; the writer quoted it (replay of 17 Oct), so it is not shown.
    .replace(/,?\s*courier note:[^\n·]*/gi, "");
}

const words = (s: string) => new Set((s ?? "").toLowerCase().replace(/[^a-z0-9₹ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));
/** Is `a` (nearly) the same answer as `b`? Word overlap, so a rewording of the same facts counts. */
export function nearDuplicate(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (x.size < 8 || y.size < 8) return false;
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.7;
}

/** Asking us to pick, change or avoid a courier. Only a person can decide that; the model kept answering with the order status instead. */
const COURIER_CHOICE = /(?:\b(?:another|other|different|else|alternate|alternative)\b[^.?!\n]{0,30}\b(?:courier|delivery partner|logistics|company)\b)|(?:\b(?:don'?t|do not|dont|never|not)\b[^.?!\n]{0,25}\b(?:send|ship|deliver)\b[^.?!\n]{0,30}\b(?:shadowfax|delhivery|dtdc|ekart|e-?kart|xpressbees|bluedart|shiprocket)\b)|(?:\b(?:use|send (?:it )?(?:by|through|via)|ship (?:it )?(?:by|through|via))\s+(?:delhivery|dtdc|ekart|e-?kart|bluedart|xpressbees)\b)/i;
export const COURIER_CHOICE_REPLY = "I can't choose or change the courier for an order here. I've passed your request to our team, and you can also email our Senior Support Team at ajukisupport@gmail.com with your order number.";

export async function generalLiveDecision(i: LiveInput, o: GeneralV2Options & { followUp?: boolean } = {}): Promise<LiveResult> {
  // Decided in code, before any model call.
  const recentIn = i.history.filter((t) => t.direction === "in").slice(-3).map((t) => t.body).join(" ");
  if (COURIER_CHOICE.test(`${i.message} ${recentIn}`.replace(/[‘’]/g, "'"))) {
    const info: LiveInfo = { v: LIVE_VERSION, used: true, why: "courier_choice_handoff", handoffSource: "courier_choice", repair: "none", tokens: 0, ms: 0 };
    return { decision: { action: "escalate", text: COURIER_CHOICE_REPLY, tag: i.decision.tag, reason: "general path: customer asks to choose or change the courier",
      meta: { ...(i.decision.meta ?? {}), provenance: "fixed:flag", fixedReply: "courier_choice", generalLive: info, replacedDraft: i.decision.text ?? null } }, info };
  }
  const clean = withoutScanText(i.orderContext);
  const record = recordFor(clean, i.scopedOrderIds);
  // What kind of message is this to the conversation? A separate, narrow reading (lib/followUp.ts) the writer is then told. OFF unless
  // SUPPORT_FOLLOWUP_STAGE=1 (or the caller asks), until its effect on real chats has been shown.
  const fu = (o.followUp ?? followUpStageEnabled()) ? await analyseFollowUp(i.message, i.history, { fetchImpl: o.fetchImpl }) : null;
  let note = followUpNote(fu);
  // 18 Oct (founder): a late-parcel reply says, in the writer's OWN words, that we are working to get it delivered as soon as possible and that there is no need to worry (and may blame the courier).
  const turn = lateTurnOf({ tag: i.decision.tag, record: i.orderContext });
  if (turn.late) note = `${note ? note + "\n" : ""}${lateNote(turn.blame)}`;
  const call = () => generalReplyV2({ message: i.message, thread: i.history, record, fullRecord: clean, products: i.products, note: note || undefined }, o);
  let r = await call();
  const lastOut = [...i.history].reverse().find((t) => t.direction === "out")?.body ?? "";
  let retried = false;
  // The same answer to the same customer again is not an answer. Ask once more, telling the writer that it repeated itself; only if it
  // STILL repeats is the customer handed to the team (acknowledged once, then quiet). 13 Oct: handing off straight away was the wrong
  // answer to a follow-up ("it needs to be treated like one").
  if (!r.error && r.final && lastOut && nearDuplicate(r.final, lastOut)) {
    retried = true;
    note = `${note ? note + "\n" : ""}YOUR DRAFT REPEATED YOUR LAST REPLY. The customer has already read it. Write something different: answer only what is new in one short sentence, or acknowledge what they said. Do not restate the facts they were already given.`;
    const first = r;
    r = await call();
    r = { ...r, tokens: r.tokens + first.tokens, ms: r.ms + first.ms, calls: r.calls + first.calls };
  }
  // It is asked ONCE more if it left the reassurance out; only if it still does is the fixed sentence used (below), so "always" holds without every reply ending the same way.
  let assurance: "written" | "retried" | "appended" | null = turn.late ? "written" : null;
  if (turn.late && !r.error && r.final && r.repair !== "flag" && assuranceDue(r.final, turn)) {
    retried = true;
    note = `${note}\nYOUR DRAFT LEFT OUT THE REASSURANCE. Write the reply again and add, in your own words, that we are doing everything we can to get the parcel delivered as soon as possible and that there is no need to worry.`;
    const first = r;
    r = await call();
    r = { ...r, tokens: r.tokens + first.tokens, ms: r.ms + first.ms, calls: r.calls + first.calls };
    assurance = "retried";
  }
  const base = { v: LIVE_VERSION, repair: r.repair, tokens: r.tokens + (fu?.tokens ?? 0), ms: r.ms + (fu?.ms ?? 0), followUp: fu?.kind ?? null, retried };
  if (r.error) return { decision: null, info: { ...base, used: false, why: `model_error:${r.error}` } };
  const final = (r.final ?? "").trim();
  if (!final) return { decision: null, info: { ...base, used: false, why: "empty" } };
  // Its own gate refused both attempts and it fell to the flag line: the existing path's reply (verified, or its own flag line) stands.
  // The trial must never make a turn worse than the path it replaces.
  if (r.repair === "flag") return { decision: null, info: { ...base, used: false, why: "general_flag_line" } };

  const h = decideHandoff({ message: i.message, record: i.orderContext, modelReason: r.handoffReason });
  if (lastOut && nearDuplicate(final, lastOut)) {
    const d: SupportDecision = {
      action: "escalate", text: FLAG_REPLY, tag: i.decision.tag, reason: "general path: customer chasing, same answer already sent",
      meta: { ...(i.decision.meta ?? {}), provenance: "fixed:flag", generalLive: { ...base, used: true, why: "repeat_handoff", handoffSource: "repeat" }, replacedDraft: i.decision.text ?? null },
    };
    return { decision: d, info: { ...base, used: true, why: "repeat_handoff", handoffSource: "repeat" } };
  }
  // The ruler sees what the customer would see, against the evidence the reply was written from.
  const rating = rateReply({
    reply: final, message: i.message, sources: [BUSINESS_TRUTHS, i.orderContext, i.products].filter(Boolean),
    context: [i.message, ...i.history.map((t) => t.body)], verifiedActions: [], handedOff: h.handOff,
  });
  // The model's own words are used. Only if it STILL left the reassurance out after being asked again is the fixed approved sentence added (never twice, never on a returning or
  // delivered parcel, never on the flag line): a last resort, so the rule holds, and the exception is visible in the trace (info.assurance).
  let shown = final;
  // A Hinglish reply is not given the English fixed sentence; it was asked again above and is left as the model wrote it.
  if (assuranceDue(final, turn) && !isHinglish(final)) { shown = withLateReassurance(final, { tag: i.decision.tag, record: i.orderContext }); assurance = "appended"; }
  // Never a reassurance about delivery on a reply that says the parcel is delivered, returning, or is about a cancellation or a payment (the writer sometimes adds one itself):
  // if it did, the reassurance is a contradiction, so the turn is sent back to the existing path rather than sent.
  if (turn.late && hasAssurance(final) && contradictsAssurance(final)) return { decision: null, info: { ...base, used: false, why: "assurance_contradicts_reply" } };
  const info: LiveInfo = { ...base, ...(assurance ? { assurance } : {}), used: false, why: "", handoffSource: h.source, alreadyOpen: h.alreadyOpen, tier: rating.tier, rules: [...new Set(rating.findings.map((f) => f.rule))] };
  if (rating.tier === "irreparable") return { decision: null, info: { ...info, why: "irreparable_finding" } };

  const decision: SupportDecision = {
    action: h.handOff ? "escalate" : "reply",
    text: shown,
    tag: i.decision.tag,
    ...(h.handOff ? { reason: `general path: ${h.source}` } : {}),
    meta: { ...(i.decision.meta ?? {}), provenance: "model_verified", generalLive: { ...info, used: true, why: "replaced_model_reply" }, replacedDraft: i.decision.text ?? null },
  };
  return { decision, info: { ...info, used: true, why: "replaced_model_reply" } };
}
