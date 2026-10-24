// Run with `npx tsx lib/deliveryActionReply.test.ts`. The day the customer named, and what they are told after the courier request was tried.
import assert from "node:assert/strict";
import { dateFromMessage, deferLine } from "@/lib/deliveryActionReply";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

// 19 Oct 2026 is a Monday; 12:00 IST
const NOW = Date.parse("2026-10-19T06:30:00Z");
eq("tomorrow", dateFromMessage("deliver tomorrow please", NOW), "2026-10-20");
eq("kal", dateFromMessage("kal deliver karo", NOW), "2026-10-20");
eq("day after tomorrow", dateFromMessage("day after tomorrow", NOW), "2026-10-21");
eq("22 Oct", dateFromMessage("on 22 Oct", NOW), "2026-10-22");
eq("22nd of October", dateFromMessage("22nd of october", NOW), "2026-10-22");
eq("a date already past this year rolls to next year", dateFromMessage("5 jan", NOW), "2027-01-05");
eq("22/10", dateFromMessage("22/10", NOW), "2026-10-22");
eq("Thursday is the coming Thursday", dateFromMessage("thursday", NOW), "2026-10-22");
eq("Monday said on a Monday is next Monday, not today", dateFromMessage("monday", NOW), "2026-10-26");
eq("today is not a date the courier can take", dateFromMessage("today", NOW), null);
eq("no date", dateFromMessage("whenever", NOW), null);
eq("late evening IST is still the same IST day", dateFromMessage("tomorrow", Date.parse("2026-10-19T19:00:00Z")), "2026-10-21");

const line = { replyId: "B2", text: "x", escalate: "none" as const, person: false };
{
  const l = deferLine(line, "AJUKI1", { outcome: "submitted", act: "DEFER_DLV", deferredDate: "2026-10-22", clamped: false, confirmed: false }, { promiseLater: false });
  ok("a submitted request names the date it was sent for", /22 Oct/.test(l.text));
  ok("it says passed to the courier, never done or confirmed", /passed your request/.test(l.text) && !/confirmed|will be delivered/i.test(l.text));
  ok("no promise of a later message while the movement updates are not on", !/I will message you/.test(l.text));
  eq("no person is prompted", [l.replyId, l.person, l.escalate], ["B2", false, "none"]);
  ok("with the updates on, the promise stays", /I will message you here when it moves/.test(deferLine(line, "AJUKI1", { outcome: "submitted", act: "DEFER_DLV", deferredDate: "2026-10-22", clamped: false, confirmed: false }, { promiseLater: true }).text));
  ok("a clamped date says it is the latest the courier accepts", /latest date they accept/.test(deferLine(line, "AJUKI1", { outcome: "submitted", act: "DEFER_DLV", deferredDate: "2026-10-22", clamped: true, confirmed: false }, { promiseLater: false }).text));
}
for (const [name, res] of [["refused", { outcome: "refused", reason: "x", to: "person", confirmed: false }], ["failed", { outcome: "failed", confirmed: false }], ["dry run", { outcome: "dry_run", act: "DEFER_DLV", confirmed: false }], ["off", { outcome: "off", confirmed: false }], ["no result", null]] as const) {
  const l = deferLine(line, "AJUKI1", res as never, { promiseLater: false });
  eq(`${name}: the request goes to the team and a person is prompted`, [l.replyId, l.person, l.escalate], ["F2", true, "no_lever"]);
  ok(`${name}: the customer is not told the courier was asked`, !/asked the courier|passed your request for \d|to the courier/i.test(l.text));
}
console.log(`deliveryActionReply: ${passed} assertions passed`);
