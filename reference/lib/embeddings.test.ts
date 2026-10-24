// lib/embeddings.ts — the guard paths only. No network: every assertion here
// runs with OPENAI_API_KEY unset, so embed() returns on its own guard before it
// would ever call fetch().
//
// EMBED_DIMS is load-bearing: it must equal the pgvector `embedding_v
// vector(3072)` column and every stored jsonb array (text-embedding-3-large's
// native width, the same as the Gemini model it replaced — so no migration).
// 3-small would be 1536 and would need both changed.
//
// Run with `npx tsx lib/embeddings.test.ts`.

import { embed, EMBED_DIMS } from "./embeddings";

// embeddings.ts reads OPENAI_API_KEY at call time, not import time, so clearing
// it here is enough to force every embed() below down its no-key guard.
delete process.env.OPENAI_API_KEY;

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => {
  cond ? pass++ : (fail++, console.log(`FAIL ${name}`));
};

async function main() {
  ok("EMBED_DIMS is 3072", EMBED_DIMS === 3072);

  ok('embed("") returns null (empty-string guard, no network)', (await embed("")) === null);
  ok("embed(whitespace) returns null (text.trim() guard)", (await embed("   \n\t  ")) === null);
  ok("embed(text) with no key returns null (key guard, no network)", (await embed("do you ship to India")) === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
