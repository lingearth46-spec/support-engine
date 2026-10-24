// What is this message to the conversation? A small model call BEFORE the reply is written.
//
// The 12 Oct review found the writer answering a follow-up as if it were a first question: "It's not showing gold for me either" got the
// same stock answer again, "499" got an unrelated product, "Oohh" got a full paragraph, "Please keep me updated" got the case line again.
// Instructions to "read your last reply" did not fix it, and a rule that hands off on repeats was the wrong answer (founder, 13 Oct).
// So the thread is read once by a separate, narrow call that only classifies and says what the message refers to; the writer is then
// told, in plain words, what kind of message it is answering and what the customer already has.
//
//   new_question  a new topic or a first question
//   follow_up     continues the last answer: asks again, adds a detail, pushes back, asks for the next step
//   reaction      a feeling or acknowledgement with no question ("Oohh", "okay", "hmm")
//   correction    the customer says the last answer was wrong or misread them
//
// It cannot write to the customer and cannot change the decision: a failure returns null and the writer runs as before. Pure parts are
// unit-tested; the model call is stubbed in tests.

import { withTimeout } from "@engine/withTimeout";

export const FOLLOWUP_KINDS = ["new_question", "follow_up", "reaction", "correction"] as const;
export type FollowUpKind = (typeof FOLLOWUP_KINDS)[number];
export interface FollowUp {
  kind: FollowUpKind;
  /** One short phrase: what the customer is referring to ("the Gold Dorian bracelet being out of stock"). */
  refersTo: string;
  /** What our last answer already told them, in one phrase. */
  alreadyTold: string;
  /** What, if anything, is NEW that they are asking or adding. Empty when nothing. */
  newPart: string;
  model: string;
  tokens: number;
  ms: number;
}

const MODEL = () => process.env.OPENAI_FOLLOWUP_MODEL || "gpt-5.4-mini";
const TIMEOUT_MS = 9_000;

const SCHEMA = {
  name: "followup_analysis",
  strict: true,
  schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...FOLLOWUP_KINDS] },
      refers_to: { type: "string" },
      already_told: { type: "string" },
      new_part: { type: "string" },
    },
    required: ["kind", "refers_to", "already_told", "new_part"],
    additionalProperties: false,
  },
};

export const FOLLOWUP_INSTRUCTIONS =
  "You read a WhatsApp support chat for an online jewellery shop and classify ONLY the customer's latest message(s), given the conversation. You do not write a reply.\n" +
  "kind: 'new_question' = a new topic or a first question; 'follow_up' = continues our last answer (asks again, adds a detail, pushes back, asks for the next step, asks about the same thing from another angle); " +
  "'reaction' = only a feeling or acknowledgement with no question ('Oohh', 'okay then', 'hmm'); 'correction' = says our last answer was wrong or misunderstood them.\n" +
  "refers_to: in one short phrase, the topic or item the message is about. already_told: in one short phrase, what OUR last reply already told them (empty if we have not answered yet). " +
  "new_part: in one short phrase, what is genuinely new in this message (a new detail, a new question); empty if it only repeats or reacts.\n" +
  "A bare number, a short fragment or a one-word reply is almost always a follow_up or reaction to our last message, never a new question.";

/** Whether to bother: with nothing from us in the thread, the message is a first question by definition. */
export const hasOurAnswer = (thread: { direction: "in" | "out"; body: string }[]): boolean => thread.some((t) => t.direction === "out");

export function followUpNote(f: FollowUp | null): string {
  if (!f || f.kind === "new_question") return "";
  const told = f.alreadyTold ? ` Our last reply already told them: ${f.alreadyTold}.` : "";
  const fresh = f.newPart ? ` What is new in their message: ${f.newPart}.` : " Nothing new is asked.";
  const how =
    f.kind === "reaction"
      ? " Reply in ONE short friendly line (or nothing more than an acknowledgement). Do not restate the facts."
      : f.kind === "correction"
        ? " They say the last answer was wrong: acknowledge it plainly and answer what they actually meant."
        : " This is a FOLLOW-UP, not a first question. Do NOT repeat what they were already told. Answer only the new part; if there is nothing new, say so in one short sentence. " +
          "Do not open with 'As mentioned', 'As noted' or 'As the record shows'. Everything else in your instructions still applies (for example, a parcel returning to us cannot have its phone or address changed).";
  return `=== READING OF THE CUSTOMER'S LATEST MESSAGE (from a separate pass) ===\nKind: ${f.kind}. It refers to: ${f.refersTo || "our last reply"}.${told}${fresh}${how}`;
}

export async function analyseFollowUp(
  message: string,
  thread: { direction: "in" | "out"; body: string }[],
  o: { fetchImpl?: typeof fetch; model?: string } = {},
): Promise<FollowUp | null> {
  if (!hasOurAnswer(thread)) return null;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = o.model ?? MODEL();
  const f = o.fetchImpl ?? fetch;
  const started = Date.now();
  const convo = thread.slice(-8).map((t) => `${t.direction === "in" ? "Customer" : "We"}: ${t.body.replace(/\s+/g, " ").slice(0, 600)}`).join("\n");
  try {
    const raw = await withTimeout(async (signal) => {
      const res = await f("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model, reasoning_effort: process.env.OPENAI_FOLLOWUP_EFFORT || "low",
          response_format: { type: "json_schema", json_schema: SCHEMA },
          messages: [{ role: "system", content: FOLLOWUP_INSTRUCTIONS }, { role: "user", content: `CONVERSATION (oldest first):\n${convo}\n\nCUSTOMER'S LATEST MESSAGE(S):\n${message}` }],
        }),
        signal,
      });
      if (!res.ok) return { httpStatus: res.status } as const;
      return res.json();
    }, TIMEOUT_MS);
    if (!raw || "httpStatus" in raw) return null;
    const p = JSON.parse(raw?.choices?.[0]?.message?.content ?? "null") as { kind?: string; refers_to?: string; already_told?: string; new_part?: string } | null;
    if (!p || !(FOLLOWUP_KINDS as readonly string[]).includes(p.kind ?? "")) return null;
    return {
      kind: p.kind as FollowUpKind, refersTo: String(p.refers_to ?? "").slice(0, 160), alreadyTold: String(p.already_told ?? "").slice(0, 200), newPart: String(p.new_part ?? "").slice(0, 160),
      model, tokens: raw?.usage?.total_tokens ?? 0, ms: Date.now() - started,
    };
  } catch {
    return null;
  }
}
