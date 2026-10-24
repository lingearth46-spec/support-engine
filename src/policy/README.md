# Policy: the files a company edits

These are the files that say what the bot may state and when it may act. Edit them first; change the engine only if a policy cannot be expressed here.

| File | What it holds | Edit to |
|---|---|---|
| `businessTruths.ts` | The only facts the model may state: cancellation, returns, shipping, payment, warranty, contact. About 76 lines. | Your own policies, in your own words. **Start here.** |
| `supportHours.ts` | When the bot may auto-reply and the out-of-hours notice. | Your hours and days. |
| `returnPolicy.ts` | The return window, charges and conditions, used by the return flow and the replies. | Your return rules. |
| `codFee.ts` | Where cash on delivery costs extra, and how much. | Your COD fee rules, or delete if you have none. |
| `strategyCatalogue.ts` | The closed list of things the bot may do about a message, each with its rule. | Add or remove an action only with care: it is the bot's whole repertoire. |
| `policyEngine.ts` | Eligibility decisions (can this order be cancelled, changed, returned) with a version and an audit trail. | Your eligibility rules. |
| `personaV2.ts` | A proposed persona text (voice and rules). **The live persona is a database row** (`wa_support_config.persona`), edited from the admin screen; this file is the starting text. | Your voice. |

## What is still outside this folder (be aware)

The policy pack is not yet fully separated from the code. These still live in the engine and must be edited there:

- **Fixed lines.** 55 exported constants (`*_REPLY`, `*_LINE`, `*_MESSAGE`) in 13 files, mainly `src/engine/topicReplies.ts` (17), `returnStateReply.ts` (9), `lateDeliveryReply.ts` (6), `replyOverrides.ts` (5), `menuFlows.ts` (5), `cancelStateReply.ts`, `clarifyReplies.ts`. Keep each constant's name, because the reply checks recognise lines by it.
- **Brand strings.** The shop name, domain, support email and the `AJUKI<digits>` order-id pattern appear in about 70 files. Search for `ajuki` and replace deliberately.
- **Escalation keywords.** `DEFAULT_ESCALATE_KEYWORDS` in `src/engine/supportGuardrails.ts`, and a database row that overrides them.
- **Numbers inside logic.** Windows, charges and delivery times also appear as literals in code (for example the 24-hour cancel window in about 17 files). The `docs/WHAT-TO-REPLACE.md` guide lists them.

The `onboard` skill walks through all of this with you.
