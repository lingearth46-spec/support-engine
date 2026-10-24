// Runs every test file under src/ (each is a plain script: `npx tsx src/.../x.test.ts`) and prints a summary.
// Usage: npm test            all tests
//        npm test -- late    only test files whose path contains "late"
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const filter = process.argv[2] ?? "";
const found = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".test.ts") && p.includes(filter)) found.push(p);
  }
})("src");
found.sort();

const tsx = process.platform === "win32" ? join("node_modules", ".bin", "tsx.cmd") : join("node_modules", ".bin", "tsx");
let failed = 0;
for (const f of found) {
  const r = spawnSync(tsx, [f], { encoding: "utf8", shell: process.platform === "win32", timeout: 120_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split(/\r?\n/);
  const last = out[out.length - 1] ?? "";
  const bad = r.status !== 0 || /[1-9]\d* failed/.test(last);
  if (bad) failed++;
  console.log(`${bad ? "FAIL" : "ok  "} ${f}  ${bad ? out.slice(-6).join("\n      ") : last}`);
}
console.log(`\n${found.length - failed}/${found.length} test files passed`);
process.exit(failed ? 1 : 0);
