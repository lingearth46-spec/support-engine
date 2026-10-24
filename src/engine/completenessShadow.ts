// The "completeness" check, in SHADOW mode only.
//
// Asks a second model one set of questions about the finished reply: does it answer what the customer actually said, is it a whole
// reply and not a leftover fragment, does it offer something the record shows is not available, does it describe the order's state
// the way the record does. On the 10 Oct replay it caught real problems (a Bengali question answered with "how can I help", a
// reorder offer to someone chasing a parcel) and also passed others, and gave different answers to the same turn on different runs.
// That is not good enough to block or replace a reply, so it does neither.
//
// What it does: when COMPLETENESS_SHADOW=1, the verdict is written next to the reply (wa_messages.ai_meta.shadow.completeness) so
// it can be compared with a person's judgement over real traffic. It never changes the text, the action, the escalation or the
// timing beyond the call itself, and any failure (timeout, error, bad shape) is swallowed. Enforcement is a separate decision that
// needs measured agreement with human labels first.

import { withTimeout } from "@engine/withTimeout";

const BASE = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 8_000;

export type CompletenessVerdict = {
  answers_asked: boolean;
  coherent: boolean;
  offers_unavailable: boolean;
  wrong_state: boolean;
  issue: string;
};

export type ShadowRecord =
  | { ok: true; verdict: CompletenessVerdict; model: string; ms: number; wouldHold: boolean }
  | { ok: false; reason: string; model: string; ms: number };

export function completenessShadowEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.COMPLETENESS_SHADOW ?? "").trim() === "1";
}

const SCHEMA = {
  name: "completeness_check",
  strict: true,
  schema: {
    type: "object",
    properties: {
      answers_asked: { type: "boolean" },
      coherent: { type: "boolean" },
      offers_unavailable: { type: "boolean" },
      wrong_state: { type: "boolean" },
      issue: { type: "string" },
    },
    required: ["answers_asked", "coherent", "offers_unavailable", "wrong_state", "issue"],
    additionalProperties: false,
  },
};

export const COMPLETENESS_INSTRUCTIONS =
  "You check a DRAFT customer-support reply before it is sent. Use the ORDER RECORD and CONVERSATION (latest customer message last). " +
  "answers_asked: does the draft respond to what the customer actually said in their latest message(s), read in context — not a different question? " +
  "coherent: is it a complete, grammatical, meaningful reply on its own, not a leftover fragment? " +
  "offers_unavailable: does it offer, ask about or promise an option the record shows is not available (COD on a prepaid-only order, cancelling an order that is already cancelled, an action a support chat cannot perform)? " +
  "wrong_state: does it describe the order's state differently from the ORDER RECORD? " +
  "issue: one short sentence, empty if all is fine.";

/** Whether this verdict is one an enforcing version of the check would have held the reply for. Recorded, never acted on. */
export function wouldHold(v: CompletenessVerdict): boolean {
  return !v.answers_asked || !v.coherent || v.offers_unavailable || v.wrong_state;
}

export async function completenessShadow(i: {
  message: string;
  history: { direction: "in" | "out"; body: string }[];
  record: string;
  draft: string;
}): Promise<ShadowRecord> {
  const model = process.env.COMPLETENESS_MODEL || "gpt-5-mini";
  const started = Date.now();
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, reason: "no_key", model, ms: 0 };
  try {
    const conv = i.history.slice(-6).map((t) => `${t.direction === "in" ? "Customer" : "Reply"}: ${t.body}`).join("\n");
    const raw = await withTimeout(async (signal) => {
      const res = await fetch(BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          reasoning_effort: "low",
          response_format: { type: "json_schema", json_schema: SCHEMA },
          messages: [
            { role: "system", content: COMPLETENESS_INSTRUCTIONS },
            { role: "user", content: `ORDER RECORD:\n${i.record}\n\nCONVERSATION:\n${conv}\nCustomer (latest): ${i.message}\n\nDRAFT:\n${i.draft}` },
          ],
        }),
        signal,
      });
      if (!res.ok) return { httpStatus: res.status } as const;
      return res.json();
    }, TIMEOUT_MS);
    const ms = Date.now() - started;
    if (!raw) return { ok: false, reason: "timeout", model, ms };
    if ("httpStatus" in raw) return { ok: false, reason: `http_${raw.httpStatus}`, model, ms };
    const parsed = JSON.parse(raw?.choices?.[0]?.message?.content ?? "") as CompletenessVerdict;
    if (typeof parsed.answers_asked !== "boolean" || typeof parsed.coherent !== "boolean") return { ok: false, reason: "bad_shape", model, ms };
    return { ok: true, verdict: parsed, model, ms, wouldHold: wouldHold(parsed) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 80) : "error", model, ms: Date.now() - started };
  }
}
