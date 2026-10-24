import assert from "node:assert/strict";
import { finalGuard, isSendable } from "@engine/finalGuard";
import { FLAG_REPLY } from "@policy/businessTruths";
import type { SupportDecision } from "@adapters/ai/gemini";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const d = (text: string | undefined, meta: Record<string, unknown>): SupportDecision => ({ action: "reply", tag: "other", text, meta });

eq("fixed reply passes", isSendable(d("hello", { fixedReply: "greeting" })), true);
eq("fast-path fixed reply passes", isSendable(d("hello", { fastPath: true, fixedReply: "lookup" })), true);
eq("verified model text passes", isSendable(d("hello", { provenance: "model_verified" })), true);
eq("repaired-and-rechecked model text passes", isSendable(d("hello", { provenance: "model_repaired_verified" })), true);
eq("the flag line passes", isSendable(d(FLAG_REPLY, { provenance: "fixed:flag" })), true);
eq("no text, nothing to send", isSendable(d(undefined, {})), true);
eq("text with no provenance is blocked", isSendable(d("hello", {})), false);
eq("a repaired-but-unverified claim is blocked", isSendable(d("hello", { repaired: true })), false);
eq("an unknown provenance is blocked", isSendable(d("hello", { provenance: "model_unchecked" })), false);

const blocked = finalGuard(d("I can refund you right now", {}));
eq("blocked text becomes the flag line", blocked.text, FLAG_REPLY);
eq("...and a real escalation", blocked.action, "escalate");
eq("...keeping what was withheld", (blocked.meta as Record<string, unknown>).withheld, "I can refund you right now");
const same = d("hello", { fixedReply: "greeting" });
eq("a sendable decision is returned untouched", finalGuard(same), same);
console.log(`${passed} passed, 0 failed`);
