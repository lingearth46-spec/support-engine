---
name: onboard
description: Interview the company about its support policies and systems, write its policy files, and guide the adaptation of the reference support bot. Use when setting up the bot for a new company.
---

# Onboard a company onto the support bot

You are helping a company adapt the reference support bot in `src/` to their own business. Read `README.md` and `docs/WHAT-TO-REPLACE.md` first.

## Ground rules

- **Never invent policy.** Every rule, number, window, charge and wording comes from the company: quoted from their documents, or confirmed by the person you are talking to. If they do not know, write it in `company/OPEN-ITEMS.md` and move on. A guessed policy line is worse than a missing one.
- **One topic at a time.** Ask a small group of related questions, wait for the answers, restate what you will write, get a yes, then write it.
- **Quote, then confirm.** When they have a document, read it and show them the exact lines you are taking. Do not paraphrase a policy.
- **Never promise on the bot's behalf** a refund, replacement, exchange, discount, callback, reply time or delivery time unless their policy explicitly allows it and a person approves the wording. The reference bot is built never to.
- **Work in the company's own copy** (a fork or clone), never in the original kit repository.
- **Everything new ships off** (shadow mode, kill switch on) until the replay is clean and a person has approved going live.

## Phase 1: interview

Cover these topics in order. Skip nothing; record "unknown" as an open item.

1. **The business.** Name, website, what is sold, countries served, languages customers write in (the reference bot handles English and Latin-script Hinglish only).
2. **Support hours and handoff.** Hours and days. What happens outside them. Who answers escalations, where (Slack, email, Telegram), and when.
3. **Identity.** Order details only to the number the order was placed from? Is an order id plus phone enough? What may a typed order id alone reveal?
4. **Order system.** Shopify store domain, how an order id looks (`#1001`?), how phones are stored, how COD is recorded (gateway name or tag), how fulfilment and tracking appear, how returns are recorded.
5. **Cancellation.** Allowed when? Time window, status limit, who can do it. After dispatch?
6. **Returns, exchanges and refunds.** Windows, charges, who pays, what evidence, how requests are raised, refund method and timing. What the bot must say, word for word, for each outcome (pending, rejected, approved).
7. **Shipping and couriers.** Couriers, delivery times, free-shipping rules, express options, COD rules, what counts as late, failed-delivery handling, who contacts the courier.
8. **Discounts, coupons, warranty.** What may be said; what must never be offered.
9. **The never list.** Anything the bot must never say or promise. Legal and safety keywords that must escalate.
10. **Tone and persona.** Voice, formality, emoji use, forbidden words, three or four replies their team is proud of.
11. **Systems and hosting.** Where it will run, database, which model provider and key, data-retention requirements, secrets handling, cron limits.
12. **Rollout.** Who reviews the first weeks' chats daily, the first percentage to go live, who holds the kill switch.

## Phase 2: write the company pack

Create `company/` in their repository:

- `policy.yaml`: hours, windows, charges, thresholds, escalation keywords and destinations, order-id pattern, brand, site, support email, tracking URL.
- `truths.md`: the facts the model is allowed to state, one per line, each traceable to their words.
- `lines.yaml`: the fixed lines, with the same ids as the reference constants, `{{slots}}` for variables, each marked approved or pending.
- `persona.md`: voice and rules.
- `ENV-CHECKLIST.md`: every environment variable they need to set, grouped, with the ones that must never be committed marked.
- `TEST-CONVERSATIONS.md`: 30 or more conversations that follow from their policies, including refusals and escalations, in their customers' language.
- `OPEN-ITEMS.md`: everything still unknown, with who should answer.

Show each file to them before saving. Lines still marked pending must not be used by the bot.

## Phase 3: adapt the code

Follow the order in `docs/WHAT-TO-REPLACE.md`. For each step:

1. Say what you are about to change and which tests cover it.
2. Make the change.
3. Run the covering tests. If any test that passed before now fails, stop, show them, and fix the cause. Do not edit a test to make it pass unless the test encoded the original shop's policy, and say so when you do.
4. Commit that step alone.

## Phase 4: verify

1. Run every test and report the totals.
2. Replay their anonymised historical chats through the rating tools. Present every finding rated "irreparable" or "damaging" before anything else.
3. Turn on shadow mode only. Tell them how to compare shadow drafts with what their team sent.
4. Stop. Going live is their decision, a few percent at a time, with the kill switch ready.

## Stop and ask if

- They want the bot to promise something the reference never does.
- They want to change a safety check (the reply checks, the final guard, the identity rule) rather than the policy it reads.
- The order system cannot supply a field the bot needs.
- A change breaks tests you cannot explain.
