// The late-delivery agent's reading of a parcel, as plain facts for the model that writes the reply where no approved line fits ("generator + verifier", founder's
// architecture 17 Oct: the supervisor and the analyst read, code decides, a model writes ONLY where no approved line fits, and the writer is checked).
//
// The writer is the existing general path (lib/generalReply2.ts), which already runs under the grounding gate and the verifier: it may state only what is in its record. These
// lines are added to that record, so what the agent knows (the phase from the scan history, how long since the courier last moved the parcel, the attempts, whether a person
// is already on it) becomes something it MAY say, and nothing else does. The scan text itself, the courier's reason and any remark are NOT in the block: the writer's own rules
// forbid quoting them, and a fact that is not given cannot be said. Pure.

import type { DeliveryShadowRecord } from "@/lib/deliveryShadow";

const PHASE: Record<string, string> = {
  in_transit: "moving through the courier's network",
  out_for_delivery: "out for delivery",
  failed_attempt: "a delivery attempt did not complete",
  on_hold: "on hold at a courier hub",
  rto: "on its way back to us",
  delivered: "marked delivered",
  none: "booked, no courier scan yet",
};
const PACKING = "The parcel is being packed and will be shipped as soon as possible. Say exactly that, politely and reassuringly. NEVER say it has not been picked up, that the courier has not collected it, or that it is in transit.";

/** "PARCEL FACTS" for the record, or "" when the agent read nothing (it did not run, or the scans were unreadable). */
export function agentFactsBlock(rec: Pick<DeliveryShadowRecord, "order" | "timeline" | "decision"> | null | undefined): string {
  if (!rec?.order || !rec.timeline) return "";
  const t = rec.timeline;
  const lines = [`=== PARCEL FACTS for order ${rec.order.id}, read from the courier's scan history (state these plainly; never quote a scan, a location or the courier's reason) ===`];
  lines.push(t.prePickup ? `Where it is: ${PACKING}` : `Where it is: ${PHASE[t.phase] ?? "in transit"}.`);
  if (t.cause === "customer_side") lines.push("The courier's record says the rider could not reach the customer on the last attempt. Say the courier reports the customer was not available; do NOT say the delay is the courier's fault.");
  if (t.hoursSinceMovement !== null && !t.prePickup) {
    const h = t.hoursSinceMovement;
    lines.push(h >= 48 ? `The courier has not updated it for about ${Math.floor(h / 24)} days.` : h >= 24 ? "The courier has not updated it for about a day." : `The courier last updated it ${h < 2 ? "within the last couple of hours" : `${Math.round(h)} hours ago`}.`);
  }
  if (t.attempts > 0) lines.push(`Delivery attempts that did not complete: ${t.attempts}.`);
  if (rec.decision) {
    if (rec.decision.chases > 1) lines.push(`The customer has asked about this parcel ${rec.decision.chases} times since it last moved.`);
    // NOT "a person has been asked": the agent's escalation only happens when its approved line is used, and these facts are given only when it is NOT. The replay of 17 Oct
    // showed the writer repeating that sentence to customers nobody had been asked about. An open case already says it, truthfully, in the order record.
  }
  return lines.length > 2 || t.hoursSinceMovement !== null ? lines.join("\n") : "";
}

/** The record the general path is given: the order record, then the facts when there are any. Unchanged when there are none. */
export function withAgentFacts(orderContext: string, rec: Pick<DeliveryShadowRecord, "order" | "timeline" | "decision"> | null | undefined): string {
  const facts = agentFactsBlock(rec);
  return facts ? `${orderContext}\n\n${facts}` : orderContext;
}
