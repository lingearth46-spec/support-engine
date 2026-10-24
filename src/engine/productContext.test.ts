// The rule this file holds: a bare size mention must never, on its own, pull in
// a product the customer was not talking about.
//
// Proven on a real thread: a photo established a silver snake chain bracelet,
// and two turns later "there is 2mm size only" — a comment on that bracelet's
// sizing — matched a wholly different "2mm Rope Chain Gold" and the bot answered
// about the wrong product with a straight face, on both Gemini and GPT. "2mm" is
// exactly as long and exactly as unusual-looking as a real keyword, so it scored
// like one.
//
// Everything runs inside main() for one reason: this module builds a Sanity
// client at import time, which throws "Configuration must contain `projectId`"
// with no environment set — so the file would abort before a single assertion
// runs. The placeholder below has to be set BEFORE the module loads, which
// rules out a static import (hoisted above any assignment) and, since tsx
// compiles this to CommonJS, rules out a top-level await too. matchProducts
// itself is pure and makes no request.

let passed = 0;
const eq = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`); process.exitCode = 1; }
  else passed++;
};

const CATALOGUE = [
  { name: "Rope Chain - (gold) 2mm" },
  { name: "Snake Chain Bracelet - Silver" },
  { name: "Royal Clover Bracelet - Black" },
  { name: "18K Gold Plated Cube Chain" },
];

async function main() {
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ||= "test";
  const { matchProducts } = await import("@engine/productContext");

  // ── The bug, reproduced and fixed ─────────────────────────────────────────
  eq("a bare size mention alone matches nothing — the exact real failure",
    matchProducts("In this there is 2mm size only.", CATALOGUE).map((p) => p.name),
    []);

  eq("size plus a real product word still matches, and ranks it first — the size does not disable matching",
    matchProducts("do you have the rope chain in 2mm?", CATALOGUE).map((p) => p.name),
    ["Rope Chain - (gold) 2mm", "Snake Chain Bracelet - Silver", "18K Gold Plated Cube Chain"]);

  eq("18K alone matches nothing either — same shape of token, same fix",
    matchProducts("is this 18k?", CATALOGUE).map((p) => p.name),
    []);

  // ── What must keep working ────────────────────────────────────────────────
  eq("a real distinctive word still ranks its product first",
    matchProducts("snake chain bracelet", CATALOGUE).map((p) => p.name)[0],
    "Snake Chain Bracelet - Silver");

  eq("a category noun alone still returns something, ranked below a specific match",
    matchProducts("do you have any bracelet", CATALOGUE).map((p) => p.name),
    ["Snake Chain Bracelet - Silver", "Royal Clover Bracelet - Black"]);

  eq("no meaningful words, no matches", matchProducts("hi there", CATALOGUE), []);
  eq("empty message, no matches", matchProducts("", CATALOGUE), []);

  console.log(`productContext: ${passed} assertions passed`);
}

main();
