// Run with `npx tsx lib/replyDelay.test.ts`.
// The deliberate quiet period before the bot answers: configuration parsing, the per-batch budget, and the batch clock.
import {
  DEFAULT_REPLY_DELAY_MS, MAX_REPLY_DELAY_MS, BATCH_DELAY_BUDGET_MS,
  configuredReplyDelayMs, delayToApply, runInBatchClock, elapsedInBatchMs, withQuietWait,
} from "./replyDelay";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

// Configuration.
eq("unset ⇒ the default", configuredReplyDelayMs(undefined), DEFAULT_REPLY_DELAY_MS);
eq("empty ⇒ the default", configuredReplyDelayMs(""), DEFAULT_REPLY_DELAY_MS);
eq("blank ⇒ the default", configuredReplyDelayMs("   "), DEFAULT_REPLY_DELAY_MS);
eq("unreadable ⇒ the default", configuredReplyDelayMs("twelve"), DEFAULT_REPLY_DELAY_MS);
eq("NaN ⇒ the default", configuredReplyDelayMs("NaN"), DEFAULT_REPLY_DELAY_MS);
eq("0 turns it off", configuredReplyDelayMs("0"), 0);
eq("negative turns it off", configuredReplyDelayMs("-5"), 0);
eq("a normal value is used", configuredReplyDelayMs("8000"), 8000);
eq("a fractional value is rounded", configuredReplyDelayMs("8000.6"), 8001);
eq("a huge value is capped", configuredReplyDelayMs("9999999"), MAX_REPLY_DELAY_MS);
eq("the default is 60 s", DEFAULT_REPLY_DELAY_MS, 60_000);
eq("the default is within the cap", DEFAULT_REPLY_DELAY_MS <= MAX_REPLY_DELAY_MS, true);

// The batch budget.
eq("a fresh batch gets the full delay", delayToApply({ configured: 60_000, elapsedInBatchMs: 0 }), 60_000);
eq("a batch still inside its budget gets the full delay", delayToApply({ configured: 60_000, elapsedInBatchMs: BATCH_DELAY_BUDGET_MS - 1 }), 60_000);
eq("a batch past its budget gets none", delayToApply({ configured: 60_000, elapsedInBatchMs: BATCH_DELAY_BUDGET_MS }), 0);
eq("a batch far past its budget gets none", delayToApply({ configured: 60_000, elapsedInBatchMs: 250_000 }), 0);
eq("a disabled delay stays disabled", delayToApply({ configured: 0, elapsedInBatchMs: 0 }), 0);
eq("the budget leaves room under the 300 s ceiling", BATCH_DELAY_BUDGET_MS + MAX_REPLY_DELAY_MS < 300_000, true);

// Stamping the wait onto a reply's meta.
eq("a wait is stamped", withQuietWait({ provenance: "model_verified" }, 60_000), { provenance: "model_verified", quietWaitMs: 60_000 });
eq("no wait, nothing stamped", withQuietWait({ provenance: "model_verified" }, 0), { provenance: "model_verified" });
eq("a missing meta is handled", withQuietWait(undefined, 0), {});
eq("a missing meta still takes the stamp", withQuietWait(undefined, 5_000), { quietWaitMs: 5_000 });
eq("the original meta is not mutated", (() => { const m = { a: 1 }; withQuietWait(m, 100); return m; })(), { a: 1 });
eq("the wait is rounded", withQuietWait({}, 59_999.6), { quietWaitMs: 60_000 });

async function main() {
  // The batch clock.
  eq("outside any batch the clock reads 0", elapsedInBatchMs(), 0);
  const inside = await runInBatchClock(async () => {
    const a = elapsedInBatchMs(Date.now() + 5_000); // pretend 5 s later
    await new Promise((r) => setTimeout(r, 5));
    const b = elapsedInBatchMs();
    return { a, b };
  });
  eq("inside a batch the clock counts from its start", inside.a >= 4_900 && inside.a <= 5_100, true);
  eq("and advances", inside.b >= 4 && inside.b < 1_000, true);

  // Two batches running at once do not share a clock.
  const slow = runInBatchClock(async () => { await new Promise((r) => setTimeout(r, 40)); return elapsedInBatchMs(); });
  await new Promise((r) => setTimeout(r, 25));
  const fresh = await runInBatchClock(async () => elapsedInBatchMs());
  const slowElapsed = await slow;
  eq("a batch started later has its own clock", fresh < 20, true);
  eq("the earlier batch kept its own", slowElapsed >= 38, true);
  eq("the clock does not leak out of the batch", elapsedInBatchMs(), 0);

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main();
