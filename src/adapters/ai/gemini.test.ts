// systemInstruction() is pure (no I/O), and it's the one function shared
// verbatim between lib/gemini.ts and lib/openaiSupport.ts — a prompt bug fixed
// here fixes both providers, and a regression here breaks both silently.
//
// This covers the "never invent a product link" instruction added after a
// real thread: the bot correctly matched "Franco Chain - (silver)" (real slug
// fox-chain-silver, a leftover from a rename) but sent a fabricated
// franco-chain-silver-free-size URL instead of the one actually given.
//
// Run with `npx tsx lib/gemini.test.ts`.

import { systemInstruction } from "@adapters/ai/gemini";
// Type-only: erased at compile time, so this does not pull in waSupport.ts's
// own Sanity/Supabase side effects at import time — see shipmentPartner.ts
// for the same reasoning.
import type { WaConfig } from "@engine/waSupport";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => {
  cond ? pass++ : (fail++, console.log(`FAIL ${name}`));
};

const CONFIG: WaConfig = {
  id: 1, enabled: true, persona: "", escalate_keywords: [], holding_message: "",
  email_enabled: true, email_auto_reply: false, email_persona: "", instagram_persona: "",
};

const LINK_RULE = /never construct, guess, or reformat/i;

const withMatch = systemInstruction(
  CONFIG, [], "", "Franco Chain - (silver), ₹1499, in stock, https://www.ajuki.in/products/fox-chain-silver", "",
);
const withoutMatch = systemInstruction(CONFIG, [], "", "", "");

ok("link rule present when a catalogue match exists", LINK_RULE.test(withMatch));
ok("link rule present even with no catalogue match (not buried in the empty-case fallback)", LINK_RULE.test(withoutMatch));
ok("still says never invent prices or stock", /never invent prices or stock/i.test(withoutMatch));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
