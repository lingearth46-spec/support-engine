// The last gate before a customer sees anything.
//
// A reviewer's point: the model's text was checked inside generateSupportReply, but the fixed overrides are applied AFTER
// that, in waSupport.ts — so "the text that was validated" and "the text that is sent" were not guaranteed to be the
// same string, and nothing stopped a future code path from sending text that had been through neither route.
//
// This is the single choke point. Every decision that carries text must declare where the text came from:
//   · a fixed reply  -> meta.fixedReply (set only by the deterministic rule modules)
//   · model text     -> meta.provenance "model_verified" or "model_repaired_verified" (set only by openaiSupport.ts, after the
//                       pattern gate and the verifier have passed, and the remainder of any repair has been re-checked)
// Text with neither is blocked and replaced by the fixed flag line, with the original kept in meta.withheld.
//
// It does not re-judge content — that is what the gates are for. It enforces that the content WAS judged, or is fixed.
// Pure, so every branch is unit-tested.

import { FLAG_REPLY } from "@policy/businessTruths";
import type { SupportDecision } from "@adapters/ai/gemini";
import { pipelineV2Enabled } from "@engine/pipelineV2";
import { leakedInternalTerms } from "@engine/replySanitize";

const VERIFIED = new Set(["model_verified", "model_repaired_verified"]);

export function isSendable(d: Pick<SupportDecision, "text" | "meta">): boolean {
  if (!d.text) return true; // nothing to send; the caller's own fallback applies
  const m = (d.meta ?? {}) as Record<string, unknown>;
  if (typeof m.fixedReply === "string" && m.fixedReply) return true;
  if (typeof m.provenance === "string" && (m.provenance.startsWith("fixed:") || VERIFIED.has(m.provenance))) return true;
  return false;
}

export function finalGuard(d: SupportDecision): SupportDecision {
  if (!isSendable(d)) {
    console.error(JSON.stringify({ event: "unvetted_text_blocked", tag: d.tag }));
    return {
      action: "escalate", tag: d.tag, text: FLAG_REPLY, reason: "unvetted text blocked by the final guard",
      meta: { ...(d.meta ?? {}), withheld: d.text, provenance: "fixed:flag" },
    };
  }
  // The exact text about to be sent, after every repair, sanitisation and override, looked at once more for an internal name
  // (a snake_case field, a tag, an order line's marker word). Model-written text only: a fixed reply is lint-tested in code.
  // sanitiseModelText should have removed these already — a hit means some path produced text that never went through it.
  if (pipelineV2Enabled() && d.text) {
    const m = (d.meta ?? {}) as Record<string, unknown>;
    const modelText = typeof m.provenance === "string" && VERIFIED.has(m.provenance) && !(typeof m.fixedReply === "string" && m.fixedReply);
    const leaks = modelText ? leakedInternalTerms(d.text) : [];
    if (leaks.length) {
      console.error(JSON.stringify({ event: "final_text_internal_term", terms: leaks.slice(0, 4) }));
      return {
        action: "escalate", tag: d.tag, text: FLAG_REPLY, reason: `internal term in final text: ${leaks[0]}`,
        meta: { ...(d.meta ?? {}), withheld: d.text, provenance: "fixed:flag", finalTextLeak: leaks.slice(0, 4) },
      };
    }
  }
  return d;
}
