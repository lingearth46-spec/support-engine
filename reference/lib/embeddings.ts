// One embedding vector for one string — OpenAI text-embedding-3-large.
//
// Was Gemini gemini-embedding-001 until 1 Sept 2026. Moved off because the key's
// project (Doc Scan Project) sat on Google's free tier — 20 generateContent/day,
// and gemini-embedding-001 routing through a tight global Vertex quota that 429'd
// under any burst. OpenAI embeddings are ~$0.0001/day for the bot's question
// load, cents for a one-time re-embed, and share the OPENAI_API_KEY the reply
// model already uses.
//
// 3-large's native dimension is 3072 — the same as gemini-embedding-001, so the
// pgvector `embedding_v vector(3072)` column and the stored jsonb arrays need no
// migration. (3-small is 1536 and would need both changed.)
//
// The stored chunk vectors are still in Gemini's space until
// scripts/reembed-knowledge.mts runs — a query vector from here compared against
// those is meaningless, so retrieve() falls back to unranked exactly as it does
// when embed() returns null.

import { withTimeout } from "@/lib/withTimeout";

const BASE = "https://api.openai.com/v1/embeddings";
const MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-large";

/** Matches the pgvector column and every stored chunk array. */
export const EMBED_DIMS = 3072;

function apiKey(): string | null {
  return process.env.OPENAI_API_KEY || null;
}

/**
 * One vector for one string, or null when embeddings are unavailable — an unset
 * key, an API error, a timeout. Same contract as the Gemini embed() it replaces:
 * every caller (retrieve, retrieveChunks, the knowledge routes) already degrades
 * to unranked retrieval or a null-embedding chunk on null.
 */
export async function embed(text: string): Promise<number[] | null> {
  const key = apiKey();
  if (!key || !text.trim()) return null;
  return withTimeout(async (signal) => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, input: text, dimensions: EMBED_DIMS }),
      signal,
    });
    if (!res.ok) {
      console.error(JSON.stringify({ event: "openai_embed_error", status: res.status, body: (await res.text()).slice(0, 200) }));
      return null;
    }
    const data = await res.json();
    const v = data?.data?.[0]?.embedding;
    return Array.isArray(v) && v.length === EMBED_DIMS ? (v as number[]) : null;
  }, 10_000);
}
