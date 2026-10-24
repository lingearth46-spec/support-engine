// One switch for the support-pipeline fixes that came out of the 10 Oct replay (order-scoped overrides, the judge's claim kinds, the
// clarifying replies, the recent-lines repeat window, the final-text check).
//
// DEFAULT OFF. With the variable unset the pipeline behaves exactly as it did before these changes, so nothing customer-facing moves
// until the founder approves and SUPPORT_PIPELINE_V2=1 is set. Read at call time, never cached, so a test or a replay can flip it.

export function pipelineV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.SUPPORT_PIPELINE_V2 ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/**
 * The claim-kind reading in the verifier's judge, on its own: requests, questions, apologies and thanks are not claims, a wait is exempt only when the evidence
 * shows something open with the team, and a promise or a wait with nothing open is decided by code (lib/replyClaims.ts), not by the judge. It used to come only with
 * SUPPORT_PIPELINE_V2, so in production (V2 unset) the judge listed "Please wait for their reply" or "I'm really sorry about that" as unsupported and the customer got
 * the flag line (9-17 Oct: 28 of the 35 fallbacks). ON by default; SUPPORT_JUDGE_KINDS=0|off|false turns it back to the original judge; V2 on always includes it.
 */
export function judgeKindsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (pipelineV2Enabled(env)) return true;
  const v = (env.SUPPORT_JUDGE_KINDS ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}
