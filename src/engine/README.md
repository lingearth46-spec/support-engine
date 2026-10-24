# Engine: the bot's pipeline and safety checks

`waSupport.ts` is the handler. For each customer message it runs, in order: abuse check, acknowledgement-only check, escalation keywords, out-of-hours handling, the fixed rules (topic replies, return and cancel state lines, late-parcel lines), the late-delivery module if enabled, the general model path, then the reply checks and the final guard.

Files that matter most:

| File | Job |
|---|---|
| `waSupport.ts` | The handler and the order of the pipeline. |
| `replyOverrides.ts`, `topicReplies.ts`, `returnStateReply.ts`, `cancelStateReply.ts`, `lookupReply.ts`, `lateDeliveryReply.ts` | Fixed, code-written replies. The model does not write these. |
| `replyGrounding.ts`, `replyVerifier.ts`, `replyCheck.ts`, `replyValidate.ts`, `finalGuard.ts`, `groundingJudge.ts` | The checks that decide whether a model reply may be sent. **Do not weaken them to make a reply pass; change the policy they read.** |
| `supportGuardrails.ts` | The persona's guardrail text, intent matchers, and the escalation keywords. |
| `orderLines.ts` | Turns an order into the facts the model may use (the order record). |
| `supportActions.ts`, `supportActionRun.ts` | The few actions the bot may take (cancel, correct address or phone) and their eligibility. |
| `waBurst.ts`, `replyDelay.ts`, `ackOnly.ts` | Answering a burst of messages once, the deliberate delay, and ignoring acknowledgements. |
| `decisionTrace.ts` | The record of why each reply is what it is. |
| `lateModule.ts` | The single doorway to `src/modules/late-delivery`. |

Everything here is tested; run `npm test -- engine`.
