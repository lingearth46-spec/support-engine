// lib/openaiSupport.ts — the parts that need no network.
//
// Three things are checked here:
//   1. RESPONSE_SCHEMA is a well-formed OpenAI strict json_schema — every
//      property in `required`, additionalProperties:false at each object level.
//      A malformed strict schema is a 400 on *every* message (CLAUDE.md), which
//      would take the whole bot offline the instant it shipped.
//   2. The escalate-keyword short-circuit in generateSupportReply returns
//      action:"escalate" before it ever looks at the API key — a legal threat
//      or a chargeback must never reach the model.
//   3. An unset OPENAI_API_KEY escalates with reason:"ai_unconfigured".
//
// Plus decisionFromModelOutput() (shared, imported from lib/gemini.ts): the
// parse-and-decide step openaiSupport delegates to once it has raw JSON text.
//
// Run with `npx tsx lib/openaiSupport.test.ts`.

import { RESPONSE_SCHEMA, generateSupportReply } from "@adapters/ai/openaiSupport";
import { decisionFromModelOutput } from "@adapters/ai/gemini";
import { DEFAULT_ESCALATE_KEYWORDS } from "@engine/supportGuardrails";
import type { WaConfig } from "@engine/waSupport";

// generateSupportReply reads the key at call time; clearing it here forces the
// ai_unconfigured path and guarantees no test can accidentally hit the API.
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_MODEL;

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => {
  cond ? pass++ : (fail++, console.log(`FAIL ${name}`));
};

type ObjSchema = { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };

/** Every key in `properties` also appears in `required`, and additionalProperties
 *  is exactly false — the two rules OpenAI strict mode enforces per object. */
function strictObjectOk(s: ObjSchema): boolean {
  const props = Object.keys(s.properties ?? {});
  const req = new Set(s.required ?? []);
  return s.additionalProperties === false && props.every((p) => req.has(p)) && props.length === req.size;
}

async function main() {
  // ── 1. RESPONSE_SCHEMA is well-formed strict mode ──────────────────────────
  const root = RESPONSE_SCHEMA.schema as ObjSchema;
  ok("schema is strict", RESPONSE_SCHEMA.strict === true);
  ok("root object: every property required + additionalProperties:false", strictObjectOk(root));
  ok("root requires exactly reply/tag/needs_human/reason/action",
    JSON.stringify([...(root.required ?? [])].sort()) ===
    JSON.stringify(["action", "needs_human", "reason", "reply", "tag"]));

  const actionAnyOf = (root.properties!.action as { anyOf: ObjSchema[] }).anyOf;
  ok("action is nullable (anyOf includes a null branch)", actionAnyOf.some((b) => b.type === "null"));
  const actionObj = actionAnyOf.find((b) => b.type === "object")!;
  ok("action object: every property required + additionalProperties:false", strictObjectOk(actionObj));
  ok("action object requires kind + order_id",
    (actionObj.required ?? []).includes("kind") && (actionObj.required ?? []).includes("order_id"));

  // ── 2 + 3. generateSupportReply's no-network paths ─────────────────────────
  const CONFIG: WaConfig = {
    id: 1, enabled: true, persona: "", holding_message: "",
    escalate_keywords: [...DEFAULT_ESCALATE_KEYWORDS],
    email_enabled: true, email_auto_reply: false, email_persona: "", instagram_persona: "",
  };
  const baseOpts = { history: [], orderContext: "", productContext: "", chunks: [] };

  const kw = await generateSupportReply({
    ...baseOpts, config: CONFIG,
    message: "I am filing a consumer court case against you",
  });
  ok("keyword hit → escalate", kw.action === "escalate");
  ok("keyword hit → reason names the keyword", (kw.reason ?? "").startsWith("keyword:"));
  ok("keyword hit → tag complaint", kw.tag === "complaint");

  const noKey = await generateSupportReply({
    ...baseOpts, config: { ...CONFIG, escalate_keywords: [] },
    message: "do you ship to india and is cod available",
  });
  ok("no API key → escalate", noKey.action === "escalate");
  ok("no API key → reason ai_unconfigured", noKey.reason === "ai_unconfigured");

  // ── 4. decisionFromModelOutput ────────────────────────────────────────────
  const parseFail = decisionFromModelOutput("{ not valid json", {});
  ok("bad JSON → escalate ai_parse_fail",
    parseFail.action === "escalate" && parseFail.reason === "ai_parse_fail");

  const undef = decisionFromModelOutput(undefined, {});
  ok("undefined output → escalate ai_parse_fail",
    undef.action === "escalate" && undef.reason === "ai_parse_fail");

  const badReply = decisionFromModelOutput(
    JSON.stringify({ reply: "Track it here: [no tracking link in the data]", tag: "order_status", needs_human: false }),
    {},
  );
  ok("placeholder in reply → escalate, reason reply_rejected",
    badReply.action === "escalate" && (badReply.reason ?? "").startsWith("reply_rejected"));

  const carry = decisionFromModelOutput(
    JSON.stringify({ reply: "So sorry about this — I've passed it to a colleague who will follow up shortly.", tag: "complaint", needs_human: true }),
    {},
  );
  ok("needs_human → escalate but the model's acknowledgement is carried through",
    carry.action === "escalate" && carry.reason === "needs_human" && !!carry.text);

  const unknownAction = decisionFromModelOutput(
    JSON.stringify({ reply: "All done for you.", tag: "cancellation", needs_human: false, action: { kind: "teleport_order", order_id: "AJUKI710013" } }),
    {},
  );
  ok("unknown action kind is dropped, reply still stands",
    unknownAction.action === "reply" && unknownAction.orderAction === undefined);

  const goodAction = decisionFromModelOutput(
    JSON.stringify({ reply: "Cancelling that for you now.", tag: "cancellation", needs_human: false, action: { kind: "cancel_order", order_id: "AJUKI710013" } }),
    {},
  );
  ok("a known action kind is kept on the decision",
    goodAction.action === "reply" && goodAction.orderAction?.kind === "cancel_order");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
