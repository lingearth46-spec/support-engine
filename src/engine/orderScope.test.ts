// Run with `npx tsx lib/orderScope.test.ts`.
// Fixed overrides are decided from the order the message is about, not from every order the customer has (10 Oct replay: B1, B2).
import { scopeOrders, alreadyCancelledReply, orderIdsIn } from "@engine/orderScope";
import { cancelStateReply, CANCEL_REPLY } from "@engine/cancelStateReply";
import { returnStateReply } from "@engine/returnStateReply";
import { lateDeliveryReply } from "@engine/lateDeliveryReply";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

type O = { id: string; status: string; awb_code?: string | null; created_at?: string | null; estimated_delivery?: string | null; return_request?: null };
const o = (id: string, status: string, extra: Partial<O> = {}): O => ({ id, status, awb_code: null, created_at: "2026-10-04T01:57:00Z", ...extra });
const NOW = Date.parse("2026-10-10T12:00:00Z");

// The B2 customer: five orders, three shipped and booked, one cancelled, one delivered.
const five: O[] = [
  o("AJUKI710084", "shipped", { awb_code: "SF1" }),
  o("AJUKI710026", "shipped", { awb_code: "SF2" }),
  o("AJUKI710028", "delivered", { awb_code: "SF3" }),
  o("AJUKI710005", "cancelled"),
  o("AJUKI710075", "shipped", { awb_code: "SF4" }),
];
const B2_MESSAGE = "I'm contacting you regarding my cancelled order #AJUKI710005, for which I paid ₹634. I still haven't received my refund.";

// ── B2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The old behaviour, kept as the control: every order counted, so a booked shipment answers for the cancelled one.
eq("B2 control: judged over all five, the cancel override refuses 'dispatched'",
  cancelStateReply({ ownOrders: five, message: "cancel", tag: "refund", now: NOW }), CANCEL_REPLY);
{
  const s = scopeOrders({ message: B2_MESSAGE, recent: [], own: five });
  eq("B2: scope is the named order", s.orders.map((x) => x.id), ["AJUKI710005"]);
  eq("B2: basis", s.basis, "message");
  eq("B2: the cancel override has nothing to refuse for a cancelled order",
    cancelStateReply({ ownOrders: s.orders, message: B2_MESSAGE.replace("regarding my cancelled order", "about my order cancel"), tag: "refund", now: NOW }), null);
  eq("B2: a refund question is not answered by the 'already cancelled' line",
    alreadyCancelledReply({ scoped: s.orders, message: B2_MESSAGE, recentCustomer: [] }), null);
}

// ── B1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const own = [o("AJUKI710073", "cancelled"), o("AJUKI710009", "shipped", { awb_code: "SF9" })];
  const recent = [
    { direction: "in" as const, body: "Confirm" },
    { direction: "out" as const, body: "No worries — understood. Order #AJUKI710073 was placed on 9 Oct. I have flagged this to the team and we are working on it." },
    { direction: "in" as const, body: "No bro Oder cancel" },
  ];
  const s = scopeOrders({ message: "I don’t want", recent, own });
  eq("B1: scope comes from the order our own last line named", s.orders.map((x) => x.id), ["AJUKI710073"]);
  eq("B1: basis", s.basis, "thread");
  const r = alreadyCancelledReply({ scoped: s.orders, message: "I don’t want", recentCustomer: ["Confirm", "No bro Oder cancel"] });
  eq("B1: the answer is the state", r?.text, "Your order #AJUKI710073 is already cancelled.");
}

// ── B3: no id anywhere, one cancelled order, a regret phrase ─────────────────────────────────────────────────────────────────
{
  const own = [o("AJUKI710085", "wa_cancelled")];
  const s = scopeOrders({ message: "I order by mistake", recent: [], own });
  eq("B3: single order", s.basis, "single");
  eq("B3: says it is cancelled", alreadyCancelledReply({ scoped: s.orders, message: "I order by mistake", recentCustomer: [] })?.text, "Your order #AJUKI710085 is already cancelled.");
}

// ── conflicting statuses, nothing names an order ──────────────────────────────────────────────────────────────────────────────
{
  const own = [o("AJUKI710001", "cancelled"), o("AJUKI710002", "shipped", { awb_code: "SF5" })];
  const s = scopeOrders({ message: "Cancel", recent: [], own });
  eq("two orders in different states, none named: scope is empty", s.orders, []);
  eq("…basis ambiguous", s.basis, "ambiguous");
  eq("…so the cancel override stands down (the model asks which)", cancelStateReply({ ownOrders: s.orders, message: "Cancel", tag: "cancellation", now: NOW }), null);
  eq("…and the return override stands down", returnStateReply({ ownOrders: s.orders as never, message: "I want to return", tag: "return" }), null);
  eq("…and the late override stands down", lateDeliveryReply({ ownOrders: s.orders, message: "where is my order", tag: "late_delivery" }), null);
}
{
  const own = [o("AJUKI710001", "shipped", { awb_code: "SF5" }), o("AJUKI710002", "shipped", { awb_code: "SF6" })];
  const s = scopeOrders({ message: "Cancel", recent: [], own });
  eq("two live orders in the same state: all of them, as before", s.basis, "all");
  eq("…and the booked-parcel answer still applies", cancelStateReply({ ownOrders: s.orders, message: "Cancel", tag: "cancellation", now: NOW }), CANCEL_REPLY);
}

// ── a named order that is not theirs ────────────────────────────────────────────────────────────────────────────────────────────
{
  const s = scopeOrders({ message: "cancel AJUKI710092 please", recent: [], own: five });
  eq("a named order we do not have: empty scope, nothing inferred from their other orders", s.orders, []);
  eq("…basis", s.basis, "unknown_named");
}
{
  const s = scopeOrders({ message: "what about AJUKI710061", recent: [], own: [o("AJUKI710009", "shipped")], mentioned: [o("AJUKI710061", "delivered")] });
  eq("a named order found by id but not matched to their number is recognised", s.orders.map((x) => x.id), ["AJUKI710061"]);
}

// ── settled order, other messages ──────────────────────────────────────────────────────────────────────────────────────────────
eq("a shipped order is never called cancelled", alreadyCancelledReply({ scoped: [o("AJUKI1", "shipped")], message: "cancel", recentCustomer: [] }), null);
eq("two orders: no single answer", alreadyCancelledReply({ scoped: [o("AJUKI1", "cancelled"), o("AJUKI2", "cancelled")], message: "cancel", recentCustomer: [] }), null);
eq("a cancelled order and a refund wish: left to the model and the refund line",
  alreadyCancelledReply({ scoped: [o("AJUKI1", "cancelled")], message: "cancel and give me my money back", recentCustomer: [] }), null);
eq("a cancelled order and an unrelated question: no reply from this", alreadyCancelledReply({ scoped: [o("AJUKI1", "cancelled")], message: "do you have a gold chain", recentCustomer: [] }), null);
eq("ids in text, upper-cased and de-duplicated", orderIdsIn("ajuki710013 and AJUKI710013, then AJUKI710051"), ["AJUKI710013", "AJUKI710051"]);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
