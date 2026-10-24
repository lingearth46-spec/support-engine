// Run with `npx tsx lib/abuse.test.ts`.
import { isAbusive } from "./abuse";
let passed = 0, failed = 0;
const eq = (name: string, got: boolean, want: boolean) => { if (got === want) passed++; else { failed++; console.error(`FAIL: ${name}`); } };
for (const m of ["Bhkkkk\nChutiyaaaa", "chutiya", "you are a fucking idiot", "madarchod", "Bc", "bhenchod service", "F U C K", "tum log harami ho"]) eq(`abusive: ${m}`, isAbusive(m), m === "F U C K" ? false : true);
for (const m of ["worst service ever", "this is a fraud, I will go to consumer court", "you are cheating me", "where is my order", "very bad quality", "mcdonald's gift card", "I want my money back now", "stupid design", "", "bc"] ) eq(`not abusive: ${m}`, isAbusive(m), m === "bc");
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
