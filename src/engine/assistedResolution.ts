// Assisted resolution — the pure half.
//
// A small product-fault claim (item arrived damaged, wrong item sent, an item
// missing from the parcel) that the founder can clear with one Telegram tap.
// The bot classifies the message, checks the gate, and either holds the
// customer and proposes a replacement to the founder, or falls through to the
// normal support reply. See docs/cx/assisted-resolution.md.
//
// Everything here is a pure function of its arguments so it can be tested
// without a clock, a database or a model — the same discipline as
// lib/supportGuardrails.ts and lib/supportQueue.ts.

import { hasBillingIntent } from "@engine/supportGuardrails";

export type FaultKind = "damaged" | "wrong_item" | "missing_item";

// The most the bot will propose a replacement on without the founder having to
// think — measured against the faulty item's own line value, not the order
// total (a cheap item on a big order still qualifies). Founder decision,
// 2026-09-07.
export const ASSISTED_CAP_RUPEES = 1000;

// A genuine "it arrived broken" comes within days. Past this it is a warranty
// question, not a fresh-delivery fault, and gets handled by a person.
export const CLAIM_WINDOW_DAYS = 7;

const MISSING =
  /\b(missing|didn'?t (get|receive)|haven'?t (got|received)|not (received|delivered|in the (box|packet|parcel|package|bag))|only (got|received) \d|one (item|piece|product)?\s*(is )?(missing|short|less)|item short|short (shipped|delivery)|incomplete|kam mila|nahi mila|nahi aaya|nahi aya|empty (box|packet|parcel|package))\b/i;

const WRONG =
  /\b(wrong (item|items|product|piece|thing|one|colour|color|design|model|size|order)|incorrect (item|product|piece|size)|different (item|items|product|piece|design|colour|color) (than|from|to)|not what i (ordered|asked|wanted)|galat (product|item|cheez|size)|received .{0,20}\binstead\b|sent .{0,20}\binstead\b|mix(ed)?[ -]?up)\b/i;

const DAMAGED =
  /\b(damaged?|damage|broke|broken|breaking|crack(ed|s)?|bent|snapped|defective|faulty|chipped|torn|tarnish(ed|ing)?|rust(ed|ing|y)?|scratch(ed|es)?|toota|tuta|tuti|kharab (mila|nikla)|not working|stopped working|clasp (broke|broken|not working))\b/i;

/**
 * The claim in a WhatsApp message, or null if it is not a fault claim. Billing
 * language wins first — "the discount is missing" is a money question, not a
 * short shipment — and among the three, a missing item reads as the most
 * specific so it is checked before the looser "wrong" / "damaged" patterns.
 */
export function classifyFaultClaim(text: string): FaultKind | null {
  if (!text || hasBillingIntent(text)) return null;
  if (MISSING.test(text)) return "missing_item";
  if (WRONG.test(text)) return "wrong_item";
  if (DAMAGED.test(text)) return "damaged";
  return null;
}

export type GateInput = {
  fault: FaultKind;
  /** matchEscalateKeyword hit — legal / chargeback / consumer-court language. */
  escalationKeyword: boolean;
  orderDelivered: boolean;
  daysSinceDelivery: number | null;
  /** count of the customer's OTHER orders with a return raised or an RTO. */
  priorReturnsOrRtos: number;
  /** a resolve proposal for this order was already made (and maybe rejected). */
  alreadyProposed: boolean;
  itemCount: number;
  /** the faulty line's value in rupees, or null when we don't know which line. */
  faultyItemValue: number | null;
  hasPhoto: boolean;
};

export type GateOutcome =
  | { ok: true; next: "propose" | "ask_item" | "ask_photo" }
  | { ok: false; reason: string };

/**
 * Whether the bot may run the assisted flow, and if so what the next step is.
 * A `false` here is not a dead end — it just means this message goes to the
 * normal support reply / escalation path instead.
 */
export function gateProposal(g: GateInput): GateOutcome {
  if (g.escalationKeyword) return { ok: false, reason: "escalation keyword" };
  if (!g.orderDelivered) return { ok: false, reason: "order not delivered" };
  if (g.daysSinceDelivery === null || g.daysSinceDelivery > CLAIM_WINDOW_DAYS) {
    return { ok: false, reason: "outside claim window" };
  }
  if (g.priorReturnsOrRtos > 0) return { ok: false, reason: "prior returns/RTOs" };
  if (g.alreadyProposed) return { ok: false, reason: "already proposed for this order" };

  // Multi-item order and we don't yet know which one — ask the customer before
  // anything else, since the cap check needs that line's value.
  if (g.itemCount > 1 && g.faultyItemValue === null) return { ok: true, next: "ask_item" };

  if (g.faultyItemValue !== null && g.faultyItemValue > ASSISTED_CAP_RUPEES) {
    return { ok: false, reason: "over cap" };
  }

  const photoNeeded = g.fault === "damaged" || g.fault === "wrong_item";
  if (photoNeeded && !g.hasPhoto) return { ok: true, next: "ask_photo" };

  return { ok: true, next: "propose" };
}

const FAULT_PHRASE: Record<FaultKind, string> = {
  damaged: "arrived damaged",
  wrong_item: "was the wrong item",
  missing_item: "was missing from your parcel",
};

/** The one line the customer gets while the founder decides. No specific
 *  remedy is promised yet — only that it is being handled. */
export function holdingMessage(fault: FaultKind, itemName: string): string {
  return (
    `Thanks for letting us know — I've noted that your ${itemName} ${FAULT_PHRASE[fault]}. ` +
    `Let me get this sorted for you. I'll confirm the next step here shortly.`
  );
}

export function askItemMessage(fault: FaultKind, itemNames: string[]): string {
  const list = itemNames.map((n, i) => `${i + 1}. ${n}`).join("\n");
  return (
    `Sorry to hear that. Which item ${FAULT_PHRASE[fault]}? Reply with the number:\n${list}`
  );
}

export function askPhotoMessage(fault: FaultKind, itemName: string): string {
  const what = fault === "damaged" ? "showing the damage" : "showing what you received";
  return (
    `Sorry about that. Could you send a photo of the ${itemName} ${what}? ` +
    `That lets me sort a replacement for you straight away.`
  );
}

/**
 * Match a customer's reply to one of the order's line items, for the "which
 * item?" step. A bare number wins; otherwise the item whose name shares a
 * distinctive word with the reply. Null when nothing matches cleanly — the
 * caller then falls back to a person.
 */
export function matchItemChoice(reply: string, itemNames: string[]): number | null {
  const trimmed = (reply || "").trim();
  const numMatch = trimmed.match(/\b([1-9][0-9]?)\b/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < itemNames.length) return idx;
  }
  const ordinals = ["first", "second", "third", "fourth", "fifth"];
  for (let i = 0; i < ordinals.length && i < itemNames.length; i++) {
    if (new RegExp(`\\b${ordinals[i]}\\b`, "i").test(trimmed)) return i;
  }
  const lower = trimmed.toLowerCase();
  let best: { idx: number; len: number } | null = null;
  itemNames.forEach((name, idx) => {
    for (const word of name.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 3 && lower.includes(word) && (!best || word.length > best.len)) {
        best = { idx, len: word.length };
      }
    }
  });
  return best ? (best as { idx: number }).idx : null;
}
