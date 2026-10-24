// Run with `npx tsx lib/handoffDecision.test.ts`.
// Who decides a hand-off: code, from the message and the record.
import { decideHandoff } from "./handoffDecision";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

const NO_CASE = "#AJUKI710009 · shipped · ₹499 · expected around 14 Oct";
const OPEN = "=== CUSTOMER ===\nAlready with the team: 1 open support case (topic: late delivery), raised 10 Oct. If they chase this, say it is with the team.\n\n#AJUKI710009 · undelivered";

eq("legal language hands off", decideHandoff({ message: "I will file a consumer court case against you", record: NO_CASE }).source, "keyword");
eq("…even when a case is open (it is never for a model to answer)", decideHandoff({ message: "I will file a consumer court case against you", record: OPEN }).handOff, true);
eq("a damaged item with nothing open hands off", decideHandoff({ message: "the bracelet arrived damaged", record: NO_CASE }), { handOff: true, source: "fault_no_case", alreadyOpen: false });
eq("the same with a case already open does NOT open a second one", decideHandoff({ message: "the bracelet arrived damaged", record: OPEN }), { handOff: false, source: "none", alreadyOpen: true });
eq("a thank-you is never a hand-off", decideHandoff({ message: "Thank you so much", record: NO_CASE }).handOff, false);
eq("a status question is not", decideHandoff({ message: "where is my order", record: NO_CASE }).handOff, false);
eq("the model saying it cannot answer from the facts is the one thing it owns", decideHandoff({ message: "do you ship to the moon", record: NO_CASE, modelReason: "cannot_answer_from_facts" }).source, "model_cannot_answer");
eq("…but not when the team already has it open", decideHandoff({ message: "do you ship to the moon", record: OPEN, modelReason: "cannot_answer_from_facts" }).handOff, false);
eq("a model's other reasons do not decide anything", decideHandoff({ message: "ok", record: NO_CASE, modelReason: "complaint_about_handling" }).handOff, false);
eq("the same inputs give the same answer, every time", [1, 2, 3].map(() => decideHandoff({ message: "I got a rash from it", record: NO_CASE }).handOff), [true, true, true]);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
