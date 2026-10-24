// SHADOW of the general conversational path on live traffic. Records, never sends.
//
// For a turn the live bot answered with the model (no fixed rule decided it), this writes what lib/generalReply2.ts WOULD have said and
// what lib/handoffDecision.ts would have done about a person, onto the inbound message's ai_meta.generalShadow, beside what was really
// sent. It is how the path gets a sample no arm has seen, with order state and courier data as the live bot had them.
//
// Guarantees, because it runs inside the live handler:
//   · DEFAULT OFF (SUPPORT_GENERAL_SHADOW). With it unset nothing here runs and nothing changes.
//   · It is started AFTER the reply is final and is not awaited: it adds no latency and cannot change the text, the action, the
//     escalation or the order of anything the handler does. Every error is swallowed.
//   · It only runs for turns the model answered (no fixed rule) and that have an inbound row to write to.
//   · It performs nothing: the path has no action field, and the hand-off decision is a record, not an escalation.
// Cost: one model call per sampled turn (~2.3K tokens, ~45% of the live generator's), plus a rewrite on ~5% of replies.
// SUPPORT_GENERAL_SHADOW_RATE (0–1, default 1) samples by a stable hash of the phone number.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { generalReplyV2, type GeneralV2Options } from "@engine/generalReply2";
import { decideHandoff } from "@engine/handoffDecision";
import { mergeAiMeta } from "@engine/inboundMeta";
import type { GeneralInput } from "@engine/generalReply";

export const SHADOW_VERSION = 1;

export function generalShadowEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.SUPPORT_GENERAL_SHADOW ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** A stable sample: the same customer is always in or always out, so a thread is shadowed whole. */
export function sampled(phone: string, env: Record<string, string | undefined> = process.env): boolean {
  const rate = Number(env.SUPPORT_GENERAL_SHADOW_RATE ?? "1");
  if (!Number.isFinite(rate) || rate >= 1) return true;
  if (rate <= 0) return false;
  const h = parseInt(createHash("sha1").update(phone).digest("hex").slice(0, 8), 16) / 0xffffffff;
  return h < rate;
}

export interface GeneralShadowRecord {
  v: number;
  at: string;
  /** What the general path would have sent. */
  final: string | null;
  /** The model's first draft, only when it had to be repaired. */
  draft: string | null;
  repair: "none" | "regenerated" | "dropped" | "flag";
  firstBlocked: string[] | null;
  /** The code's decision about a person (lib/handoffDecision.ts), and what it rested on. */
  handOff: boolean;
  handoffSource: string;
  alreadyOpen: boolean;
  /** What the model said, for comparison only; it decides nothing. */
  modelReason: string;
  model: string | null;
  tokens: number;
  calls: number;
  ms: number;
  error: string | null;
  /** What the live bot actually did on this turn. */
  live: { kind: string; action: string; flag: boolean; sameText: boolean };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9₹@. ]/g, "").trim();

export interface ShadowInput extends GeneralInput {
  live: { text: string | null; action: string; kind: string };
  /** The record text the hand-off decision reads (the full order context). */
  handoffRecord: string;
}

export async function runGeneralShadow(i: ShadowInput, o: GeneralV2Options = {}): Promise<GeneralShadowRecord> {
  const r = await generalReplyV2(i, o);
  const h = decideHandoff({ message: i.message, record: i.handoffRecord, modelReason: r.handoffReason });
  const liveText = i.live.text ?? "";
  return {
    v: SHADOW_VERSION, at: new Date().toISOString(),
    final: r.final, draft: r.repair !== "none" ? r.draft : null, repair: r.repair, firstBlocked: r.firstBlocked ? r.firstBlocked.slice(0, 3).map((b) => b.slice(0, 200)) : null,
    handOff: h.handOff, handoffSource: h.source, alreadyOpen: h.alreadyOpen, modelReason: r.handoffReason,
    model: r.model ?? null, tokens: r.tokens, calls: r.calls, ms: r.ms, error: r.error ?? null,
    live: { kind: i.live.kind, action: i.live.action, flag: liveText.startsWith("I have flagged this to the team") || liveText.startsWith("I do not have that information"), sameText: !!r.final && norm(r.final) === norm(liveText) },
  };
}

/** Write the record onto the inbound row. Best-effort; never throws. */
export async function storeGeneralShadow(db: SupabaseClient, inboundId: string | undefined, rec: GeneralShadowRecord): Promise<void> {
  await mergeAiMeta(db, inboundId, { generalShadow: rec });
}
