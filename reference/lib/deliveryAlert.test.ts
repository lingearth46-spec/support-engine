// Run with `npx tsx lib/deliveryAlert.test.ts`. The suppression alert: when it fires, what it shows, what it never shows.
import assert from "node:assert/strict";
import { suppressionAlert, alertsEnabled } from "@/lib/deliveryAlert";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const ok = (name: string, v: unknown) => { assert.ok(v, name); passed++; };

const line = (over: Record<string, unknown> = {}) => ({ replyId: "C1", text: "There is no newer update on order AJUKI1 since 12 Oct. We are doing everything we can to get your parcel delivered as soon as possible, so there is no need to worry. You can track it at www.ajuki.in/track.", person: false, escalate: "none" as const, ...over });
const alert = (over: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) => suppressionAlert({ line: line(over) as never, orderId: "AJUKI1", phone: "9000100014", message: "Where is my parcel? It is already 5 days", ...over }, env);

eq("on by default; off only for 0 / off / false", [alertsEnabled({}), alertsEnabled({ SUPPORT_DELIVERY_AGENT_ALERTS: "on" }), alertsEnabled({ SUPPORT_DELIVERY_AGENT_ALERTS: "off" }), alertsEnabled({ SUPPORT_DELIVERY_AGENT_ALERTS: "0" }), alertsEnabled({ SUPPORT_DELIVERY_AGENT_ALERTS: "false" })], [true, true, false, false, false]);
{
  const a = alert()!;
  ok("a line with no person prompt raises an alert", !!a);
  ok("it names the order, the line, what the customer wrote and what they were told", /AJUKI1/.test(a) && /Line C1/.test(a) && /Where is my parcel/.test(a) && /no newer update on order AJUKI1/.test(a));
  ok("the phone is only the last four digits", /…0014/.test(a) && !/9000100014/.test(a));
  ok("it says where to go", /admin inbox/.test(a));
}
eq("a line that prompted a person raises nothing (the team is already told)", alert({ person: true, escalate: "stall_48h" }), null);
eq("alerts off: nothing", alert({}, { SUPPORT_DELIVERY_AGENT_ALERTS: "off" }), null);
{
  const a = suppressionAlert({ line: line() as never, orderId: "AJUKI1", phone: "9000100014", message: "<b>hi</b> & <script>" })!;
  ok("customer text is escaped so Telegram's HTML cannot break or be injected", !/<script>|<b>hi/.test(a) && /&lt;b&gt;hi&lt;\/b&gt; &amp; &lt;script&gt;/.test(a));
  const long = suppressionAlert({ line: line({ text: "x".repeat(900) }) as never, orderId: "AJUKI1", phone: "9000100014", message: "y".repeat(900) })!;
  ok("long text is clipped", long.length < 700);
}
console.log(`deliveryAlert: ${passed} assertions passed`);
