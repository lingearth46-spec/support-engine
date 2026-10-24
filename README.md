# support-engine: a WhatsApp support bot, as a reference kit

A WhatsApp customer-support bot for online shops, published as a **reference kit**. It is the working code of one shop's bot, with the shop's customer data removed, plus a guide and a Claude Code skill that walk your team through adapting it to your own policies, order system and couriers.

It is not a package you install. You copy the reference code into your own project and change what is specific to the original shop. This repository tells you what to change, and gives you the tests to prove you did not break the safety behaviour while changing it.

> **Licence:** all rights reserved. The code is public so you can read and evaluate it. Using it in a business requires a written licence from the owner. See [LICENSE](LICENSE).
> **Support:** none is promised. This is provided as is.

---

## What the bot is

It answers order, delivery, cancellation, return and product questions on WhatsApp in the shop's own words and rules, does a small set of safe actions itself, and hands everything else to a person with the case already written up.

**What it may say and do is decided by policy files and fixed rules, not by the model.** The model writes ordinary replies. Fixed rules, fact checks and a final guard decide what is allowed to leave.

## What it has been proven on

- **One deployment:** an Indian direct-to-consumer jewellery shop (AJUKI), English and Hinglish customers, WhatsApp Cloud API, cash-on-delivery and prepaid orders, two couriers.
- **In production** since October 2026. The late-delivery module has run at full traffic since 18 October 2026.
- **Day to day:** in its first weeks it needed a daily read of real chats to find and fix gaps. Plan for the same.
- **Tests:** 79 test files are included in `reference/`. They cover the rules, checks and state machines and run without a database or network.
- **Not yet proven:** a second company, Shopify as the order source, a different courier set, or a language other than English and Hinglish.

## Models it has been tested with

| Job | Model used in the reference deployment | Notes |
|---|---|---|
| Writing replies | `gpt-5-mini` (OpenAI) | Selected with `OPENAI_MODEL`. Replies come back as JSON with a reason and an optional action. |
| Checking a reply against the facts (grounding judge) | `gpt-5-mini` | `OPENAI_JUDGE_MODEL`. |
| Rating replies in tests and dashboards | `gpt-5.4-mini` | `OPENAI_RATING_JUDGE_MODEL`. Not used to answer customers. |
| Knowledge-base search | `gemini-embedding-001` (Google) | Embeddings only. |

**Not tested:** Claude models, Gemini models as reply writers, or any open model as the reply writer. The prompts, the JSON contract and the checks were tuned on the models above. If you switch the reply model, treat it as a new pilot: rerun the replay and shadow steps before going live.

Using Claude Code to adapt this kit is a separate matter from the models the bot runs on.

## What it can do

**Answer, from facts it is given**
- Order status, expected date and tracking link from the order record. A date is always given as an estimate.
- Product questions (price, stock, sizes) from a catalogue it is given.
- Policy questions (cancel, return, shipping, payment) from one business-truths file only.
- English and Hinglish (Hindi in Latin letters), matched to the customer.

**Act, within narrow limits**
- Cancel an order, only when your rules allow it (for example inside a time window and before dispatch).
- Correct a delivery address or phone number, only before the parcel reaches a courier.
- Take a phone number or address sent after it asks for one and pass it to your team.

**Hand over cleanly**
- Open a case with the reason, the order and the customer's words, and notify your team.
- Tell the customer once that the team has it, then stay quiet on repeats instead of looping.
- Escalate on your keywords (for example legal threats) and on anything it cannot answer from the facts.

**Fixed answers where wording matters**
- Pending or rejected returns, cancellation after dispatch, "no exchange", discounts and similar topics use exact approved lines. The model does not improvise them.

**Late-delivery module** (`reference/lib/delivery*`, `courier*`, `ndr*` and related)
- Reads a parcel's courier scans and decides the right reply for its state: being packed, in transit, failed attempt, customer unavailable, returning, stalled.
- Asks the right question after a failed attempt ("which day?", "did the rider call?") and remembers the answer.
- Where a courier allows it: reschedules delivery, passes a new phone or address to the courier, raises a courier ticket, and messages the customer when the parcel moves.
- The reference courier code is for Delhivery and Shadowfax (India). **It is the least portable part**; see below.

## What it will not do

Deliberate, and some enforced in code:

- **No promises of money or goods:** never offers or promises a refund, replacement, exchange, discount or compensation.
- **No promises of time:** never promises a reply time, a callback or a delivery time. It says "estimate" and points to tracking.
- **Facts only:** it may state only the business truths, the customer's order record and the catalogue. Anything else is "I do not have that information", and a person is asked to look. Replies with an unsupported amount, date, link, email or order id are blocked.
- **No identity guessing:** order details are shared only with the number the order was placed from, or an order id typed with the matching phone. An order id alone gets status and date only.
- **Not a decision-maker:** it does not approve returns, refunds, exceptions or goodwill.
- **Cannot call people or contact couriers** except through the late-delivery code and its courier clients.
- **Does not announce faults in photos** and does not ask customers to send photos on WhatsApp.
- **No Devanagari or other scripts:** it replies in English or Latin-script Hinglish. Other languages get a fixed pointer.

## Limits to plan around

- **Hours:** it answers only inside the hours you set. Outside them it sends one notice and queues the real answer. The reference shop answers 11:00 to 19:00 IST, Monday to Saturday.
- **Deliberate delay:** it waits a short quiet period (60 seconds in the reference deployment) so it can answer a burst of messages once.
- **It escalates and goes quiet:** after telling a customer the team has it, it does not answer repeats. Your team must watch the case list.
- **One channel:** WhatsApp.
- **A gap in your policy files is a gap in behaviour.** The onboarding skill is built to expose gaps; it cannot invent your policy.
- **Courier code is written for two Indian couriers.** Scan vocabularies, ticket portals and reschedule rules differ by courier. Expect to rewrite it per courier.
- **Orders are read from the reference shop's own database.** You will replace that with your order system (for example Shopify's Admin API). This is the biggest change you will make.
- **Cost and speed:** each reply can involve more than one model call (write, then check). Measure on your own traffic in shadow mode.
- **Comments quote real situations.** Customer details have been removed or replaced, but comments describe real incidents and phrasing. Treat them as examples, not as your policy.

## How to use this kit

1. **Read** [docs/WHAT-TO-REPLACE.md](docs/WHAT-TO-REPLACE.md). It lists what ties the reference code to the original shop, and in what order to replace it.
2. **Create your own repository** and copy `reference/` into it. Do not edit this repository.
3. **Open it in Claude Code and run the `onboard` skill** (`.claude/skills/onboard/`). It interviews you about your business, hours, identity rule, cancel, return and refund policy, shipping and couriers, what the bot may never promise, who receives escalations, tone and hosting. It writes your policy files, an environment checklist, and a set of test conversations. Anything it cannot get from you or your documents is listed as an open item, never guessed.
4. **Adapt the code** following the replacement list, one step at a time. After each step the tests that passed before must still pass.
5. **Replay** your real historical chats through the rating tools and read the findings before anything else.
6. **Run in shadow mode.** The bot drafts replies and records them; nothing is sent. Compare with what your team actually sent and fix your policy files.
7. **Go live for a small share of customers** with the kill switch ready, then widen.
8. **Add the late-delivery behaviour** only once you have a courier client for your couriers.

## Safety switches

Every capability has an off switch that needs no deploy: the bot as a whole, the late-delivery behaviour, courier actions, ticket raising, customer movement updates, and the rollout percentage. All new behaviour ships off. Keep that rule in your adaptation.

## Your data

Messages, cases and orders stay in your own database. Model providers see the customer's message, the order facts needed for the reply, and your policy files, under your own API keys.

## What is in this repository

```
README.md                     this file
LICENSE                       all rights reserved
CLAUDE.md                     rules for Claude Code when working on your copy
docs/WHAT-TO-REPLACE.md       what ties the code to the original shop, in replacement order
.claude/skills/onboard/       the interview skill
reference/                    the bot's code and tests, with the original shop as the example
  lib/                        rules, checks, state machines, order and case logic
  app/api/                    the WhatsApp webhook route
  db/                         the migrations for the core tables
  workflows/                  notes from the reference deployment
  tsconfig.json               path settings only; this is not a complete project
```

`reference/` is **not runnable as it stands**: it has no `package.json`, and several modules call services (database, model provider, couriers) that you must provide. It is a reading and copying source, with tests you can run once you have a project around it.
