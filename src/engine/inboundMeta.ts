// Merge keys into an inbound message's ai_meta without losing what is already there.
//
// Several best-effort writers put a small record on the same inbound row (the decision trace, the general-path shadow). A plain update of
// ai_meta would let whichever writes last erase the others, and they finish at different times (the shadow takes seconds). This reads the
// current value, merges the patch over it and writes back. It never throws and never blocks a reply: a failure just means that record is
// not kept. A lost race between two writers can still drop one key; both are diagnostics, not state anything depends on.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function mergeAiMeta(db: SupabaseClient, rowId: string | undefined, patch: Record<string, unknown>): Promise<void> {
  if (!rowId) return;
  let existing: Record<string, unknown> = {};
  try {
    const { data } = await db.from("wa_messages").select("ai_meta").eq("id", rowId).maybeSingle();
    const cur = (data as { ai_meta?: unknown } | null)?.ai_meta;
    if (cur && typeof cur === "object" && !Array.isArray(cur)) existing = cur as Record<string, unknown>;
  } catch { /* nothing to merge with: write the patch alone */ }
  try {
    await db.from("wa_messages").update({ ai_meta: { ...existing, ...patch } }).eq("id", rowId);
  } catch (err) {
    console.warn("[support] ai_meta merge failed:", err instanceof Error ? err.message : String(err));
  }
}
