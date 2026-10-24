// Run with `npx tsx lib/deliveryFacts.test.ts`. The parcel facts the general path may state, and nothing else.
import assert from "node:assert/strict";
import { agentFactsBlock, withAgentFacts } from "@late/deliveryFacts";
import { groundingViolations } from "@engine/replyGrounding";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

const rec = (over: { phase?: string; hours?: number | null; attempts?: number; chases?: number; escalate?: string } = {}) => ({
  order: { id: "AJUKI710036", courier: "delhivery" as const },
  timeline: { attempts: over.attempts ?? 0, phase: (over.phase ?? "in_transit") as never, cause: "customer_side" as const, lastEvent: "in_transit", movedSinceFailure: false, prePickup: false, hoursSinceMovement: over.hours === undefined ? 60 : over.hours },
  decision: { replyId: "H1", text: "x", escalate: (over.escalate ?? "none") as never, action: null, moved: false, awaiting: null, chases: over.chases ?? 1 },
});

eq("nothing read, nothing added", [agentFactsBlock(null), agentFactsBlock(undefined), agentFactsBlock({ order: null, timeline: null, decision: null })], ["", "", ""]);
eq("the record is returned untouched when there are no facts", withAgentFacts("RECORD", null), "RECORD");
{
  const b = agentFactsBlock(rec());
  ok("a stalled parcel: where it is, and how long the courier has been quiet, in days", /moving through the courier's network/.test(b) && /about 2 days/.test(b));
  ok("the header says to state the facts plainly and never quote a scan, location or reason", /never quote a scan, a location or the courier's reason/.test(b));
  ok("the order id is there", /order AJUKI710036/.test(b));
  eq("the record gets the block after the order lines", withAgentFacts("RECORD", rec()).startsWith("RECORD\n\n=== PARCEL FACTS"), true);
}
eq("a day", /about a day/.test(agentFactsBlock(rec({ hours: 30 }))), true);
eq("recent: hours", /last updated it 5 hours ago/.test(agentFactsBlock(rec({ hours: 5 }))), true);
eq("very recent", /within the last couple of hours/.test(agentFactsBlock(rec({ hours: 1 }))), true);
eq("no movement time known: no sentence about it", /updated|not updated/.test(agentFactsBlock(rec({ hours: null, attempts: 2 }))), false);
ok("failed attempts are counted", /attempts that did not complete: 2/.test(agentFactsBlock(rec({ attempts: 2, phase: "failed_attempt" }))) && /a delivery attempt did not complete/.test(agentFactsBlock(rec({ attempts: 2, phase: "failed_attempt" }))));
ok("chases since it last moved are stated only when more than one", /3 times since it last moved/.test(agentFactsBlock(rec({ chases: 3 }))) && !/times since it last moved/.test(agentFactsBlock(rec({ chases: 1 }))));
ok("it never says a person has been asked, whatever the ledger says: that happens only when the agent's own line is used, and then these facts are not given (17 Oct replay)", !/person has been asked/i.test(agentFactsBlock(rec({ escalate: "stall_48h" }))) && !/person/i.test(agentFactsBlock(rec({ escalate: "two_failed", chases: 3 }))));
for (const [phase, words] of [["out_for_delivery", /out for delivery/], ["rto", /on its way back to us/], ["delivered", /marked delivered/], ["on_hold", /on hold at a courier hub/], ["none", /no courier scan yet/]] as const) ok(`phase ${phase} in words`, words.test(agentFactsBlock(rec({ phase }))));
{
  const b = agentFactsBlock(rec({ attempts: 2, phase: "failed_attempt", escalate: "two_failed", chases: 2 }));
  ok("no scan text, no remark, no courier reason, no location", !/consignee|not contactable|unavailable|hub name|remark|EOD-|DTUP|Delhi_|SF\d{6}/i.test(b));
  ok("the block names no phone number and no address", !/\d{10}/.test(b) && !/pincode/i.test(b));
}
// what the writer may then say is grounded in the block, and an invented fact still is not
{
  const record = withAgentFacts("AJUKI710036 · undelivered · expected around 15 Oct", rec({ hours: 60 }));
  const good = groundingViolations("Your parcel has not been updated by the courier for about 2 days.", [record], []);
  const bad = groundingViolations("Your parcel will be delivered tomorrow.", [record], []);
  ok("a statement the facts support passes the mechanical gate", !good.some((v) => v.rule === "delivery_promise" || v.rule === "amount"));
  ok("an invented delivery promise is still caught", bad.some((v) => v.rule === "delivery_promise"));
}
console.log(`deliveryFacts: ${passed} assertions passed`);
