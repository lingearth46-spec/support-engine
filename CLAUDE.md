# Working in your copy of the support bot

This file is for Claude Code. It sits at the root of the company's own copy of this repository.

- Read `README.md` and `docs/WHAT-TO-REPLACE.md` before changing anything.
- Run the `onboard` skill to set up a company. Do not guess the company's policy.
- Never change the reply checks (`replyGrounding`, `replyVerifier`, `finalGuard`, `supportGuardrails`), the identity rule, or the fixed-line ids to make something easier. Change the policy files they read instead. If a check blocks a legitimate reply, show the person and ask.
- The bot must never promise a refund, replacement, exchange, discount, callback, reply time or delivery time on its own.
- New behaviour ships off: behind a switch, in shadow mode first.
- Tests are run with `npm test` (all) or `npx tsx src/<folder>/<name>.test.ts` (one). Run the tests that cover a file before and after changing it.
- No credentials in the repository. Environment variable names are listed in `company/ENV-CHECKLIST.md`.
- Customer data in tests and fixtures must be fake.
