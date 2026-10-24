// The assisted-resolution classifier and gate. No database, no model — the
// module is pure so the rules can be exercised directly.
//
// Run with `npx tsx lib/assistedResolution.test.ts`.

import {
  classifyFaultClaim,
  gateProposal,
  matchItemChoice,
  holdingMessage,
  ASSISTED_CAP_RUPEES,
  CLAIM_WINDOW_DAYS,
  type GateInput,
} from "./assistedResolution";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : (failed++, console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`));
};

// ── classifyFaultClaim ────────────────────────────────────────────────────────
eq("damaged — plain", classifyFaultClaim("the bracelet arrived damaged"), "damaged");
eq("damaged — broke", classifyFaultClaim("my chain broke as soon as I opened it"), "damaged");
eq("damaged — hinglish toota", classifyFaultClaim("chain toota hua mila"), "damaged");
eq("damaged — clasp", classifyFaultClaim("the clasp is not working at all"), "damaged");
eq("wrong item", classifyFaultClaim("you sent the wrong item, I ordered a ring"), "wrong_item");
eq("wrong item — instead", classifyFaultClaim("I received a bracelet instead of the pendant"), "wrong_item");
eq("wrong item — not what I ordered", classifyFaultClaim("this is not what I ordered"), "wrong_item");
eq("missing item", classifyFaultClaim("one item is missing from the parcel"), "missing_item");
eq("missing — didn't receive", classifyFaultClaim("I didn't receive the second chain"), "missing_item");
eq("missing — hinglish", classifyFaultClaim("mera ek product nahi aaya"), "missing_item");

eq("not a claim — where is my order", classifyFaultClaim("where is my order, it hasn't arrived"), null);
eq("claim — not in the parcel (delivered WISMO shape)", classifyFaultClaim("parcel came but the ring was not in the box"), "missing_item");
// ^ a "not in the box" claim does trip missing — the gate (order must be
//   delivered, within window) is the backstop against a false proposal.
eq("not a claim — thanks", classifyFaultClaim("thank you so much, love it"), null);
eq("not a claim — sizing question", classifyFaultClaim("does this come in a larger size?"), null);
eq("billing wins — missing discount", classifyFaultClaim("my discount code is missing from the total"), null);
eq("empty string", classifyFaultClaim(""), null);

// ── gateProposal ──────────────────────────────────────────────────────────────
const g = (over: Partial<GateInput>): GateInput => ({
  fault: "damaged",
  escalationKeyword: false,
  orderDelivered: true,
  daysSinceDelivery: 2,
  priorReturnsOrRtos: 0,
  alreadyProposed: false,
  itemCount: 1,
  faultyItemValue: 499,
  hasPhoto: true,
  ...over,
});

eq("gate — clean single item with photo → propose", gateProposal(g({})), { ok: true, next: "propose" });
eq("gate — damaged, no photo → ask_photo", gateProposal(g({ hasPhoto: false })), { ok: true, next: "ask_photo" });
eq("gate — missing item needs no photo → propose", gateProposal(g({ fault: "missing_item", hasPhoto: false })), { ok: true, next: "propose" });
eq("gate — multi-item, unknown line → ask_item", gateProposal(g({ itemCount: 3, faultyItemValue: null })), { ok: true, next: "ask_item" });
eq("gate — multi-item, known line, under cap → propose", gateProposal(g({ itemCount: 3, faultyItemValue: 800 })), { ok: true, next: "propose" });

eq("gate — escalation keyword → no", gateProposal(g({ escalationKeyword: true })), { ok: false, reason: "escalation keyword" });
eq("gate — not delivered → no", gateProposal(g({ orderDelivered: false })), { ok: false, reason: "order not delivered" });
eq("gate — delivered 9 days ago → no", gateProposal(g({ daysSinceDelivery: CLAIM_WINDOW_DAYS + 2 })), { ok: false, reason: "outside claim window" });
eq("gate — delivery date unknown → no", gateProposal(g({ daysSinceDelivery: null })), { ok: false, reason: "outside claim window" });
eq("gate — prior return → no", gateProposal(g({ priorReturnsOrRtos: 1 })), { ok: false, reason: "prior returns/RTOs" });
eq("gate — already proposed → no", gateProposal(g({ alreadyProposed: true })), { ok: false, reason: "already proposed for this order" });
eq("gate — over cap → no", gateProposal(g({ faultyItemValue: ASSISTED_CAP_RUPEES + 1 })), { ok: false, reason: "over cap" });
eq("gate — exactly at cap → propose", gateProposal(g({ faultyItemValue: ASSISTED_CAP_RUPEES })), { ok: true, next: "propose" });
// ask_item is decided before the cap — a multi-item order over cap on the whole
// still asks which item first, then the cap applies to that line.
eq("gate — multi-item unknown line even if pricey → ask_item", gateProposal(g({ itemCount: 2, faultyItemValue: null })), { ok: true, next: "ask_item" });

// ── matchItemChoice ───────────────────────────────────────────────────────────
const items = ["Onyx Clover Chain", "Silver Cuban Bracelet", "Gold Signet Ring"];
eq("choice — number", matchItemChoice("2", items), 1);
eq("choice — number in a sentence", matchItemChoice("it's number 3", items), 2);
eq("choice — ordinal", matchItemChoice("the first one", items), 0);
eq("choice — by word", matchItemChoice("the bracelet is broken", items), 1);
eq("choice — no match", matchItemChoice("all of them", items), null);
eq("choice — out of range number", matchItemChoice("9", items), null);

// ── message builders ──────────────────────────────────────────────────────────
eq("holding message names the item and does not promise a remedy",
  /Onyx Clover Chain/.test(holdingMessage("damaged", "Onyx Clover Chain")) &&
  !/replacement|refund/i.test(holdingMessage("damaged", "Onyx Clover Chain")),
  true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
