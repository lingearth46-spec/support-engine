# What to replace, and in what order

`reference/` is the code of one shop's bot. This guide lists what ties it to that shop and how to replace each part. Counts are for the reference folder as published: 116 code files and 79 test files.

How the survey was done: every file reachable from the WhatsApp webhook route and `lib/waSupport.ts` (test files excluded). Groupings are by filename and approximate. Patterns were counted by search; not every file was read in full.

**Rule for every step:** the tests that passed before must still pass afterwards. They are your safety net, and the reason this kit includes them.

---

## 1. Branding written into the code
Across the files, the shop's domain appears about 90 times, its name about 100 times, its support email about 25 times, and its order-id pattern (`AJUKI` followed by digits) about 65 times. The heaviest files: `businessTruths.ts`, `replySanitize.ts`, `orderLines.ts`, `supportGuardrails.ts`, `menuFlows.ts`, `lookupReply.ts`, `waSupport.ts`, `replyVerifier.ts`, `topicReplies.ts`, `deliveryCaseState.ts` and the webhook route.

**Replace with:** one place that holds your brand name, site, support email, tracking URL and order-id pattern, read everywhere else. The order-id pattern is the riskiest: it is a regular expression in several places, and Shopify order names look different (`#1001`).

## 2. Policy written into the code
- Support hours (11:00 to 19:00 IST, Monday to Saturday) appear in about 35 files.
- The 24-hour cancel window appears in about 17 files, the returns charge in 7, the express fee in 3, the delivery time in 3, the warranty in 2.
- There are 55 exported fixed-line constants in 13 files (`topicReplies` 17, `returnStateReply` 9, `lateDeliveryReply` 6, `replyOverrides` 5, `menuFlows` 5, `cancelStateReply` 3, `clarifyReplies` 3, `businessTruths` 2).
- `businessTruths.ts` (about 76 lines) is the only place the model may take facts from.

**Replace with:** your own numbers and windows in one policy file; your own approved lines in a lines file (keep each line's id, because the reply checks recognise lines by id); your own facts in a truths file. The `onboard` skill writes these.

## 3. The order model (the biggest change)
- 23 files read an `orders` table. The shared selection is 26 columns: id, status, address, items, totals and payment fields, tracking number, courier, tracking URL, estimated delivery, delivered date, attempt count, failure reasons, return request and more.
- The status vocabulary has 15 values, several specific to the original shop (`call_1`, `call_2`, `wa_cancelled`, a hold used by its COD journey, `manifested`, `packed`).

**Replace with:** one function that returns your orders in the shape `lib/orderLines.ts` already reads (`OrderRow`). A draft mapping from Shopify, to verify against your own store:

| Reference field | Shopify source |
|---|---|
| id | `name` (for example `#1001`) |
| status | `cancelled_at`, `fulfillment_status`, the fulfilment's `shipment_status` |
| tracking number, courier, tracking URL | `fulfillments[].tracking_info` |
| COD or prepaid | payment gateway names or order tags (your convention) |
| address and phone | `shipping_address`, `phone` |
| return request | Shopify returns |
| estimated delivery, attempt count, failure reasons | not in Shopify: compute or take from your courier |

Start read-only. Cancel and address-change actions need write access and can come later.

## 4. Storage
The bot needs about nine tables: conversations, messages, cases, the support config (persona and flags), knowledge chunks, customers and their identifiers, case events, policy decisions and opt-outs. `reference/db/` has the migrations for the core ones. The original shop has about 25 other tables for commerce, couriers and email; they are not included and you do not need them.

## 5. Commerce code the bot happens to import
Five modules sit on the bot's import path and belong to the original shop's commerce: the COD confirmation journey (`rtoJourney`, imported directly by the webhook route), `orderOffers`, `cartOffers`, `prepaidOffer` and `wallet`. Cut them off behind small stubs or delete the features that use them. Check with the tests.

## 6. Messaging
`app/api/webhooks/whatsapp/route.ts` is about 1,000 lines and reads Meta's payload shape directly. It also holds the courier button handlers, the address-edit prompt and the confirmation flows. If your WhatsApp integration is custom, write a thin layer that turns your inbound events into the shape the route expects (text, button tap, image, reaction) and sends the replies the bot returns. Keep the duplicate-message check by message id.

## 7. Couriers (the late-delivery code)
About 50 files are courier or delivery related, and most mention Delhivery, Shadowfax, Shiprocket or DTDC. The original shop also automates a courier's web portal; that code is not included.

**Replace with:** a client per courier you use, offering the same few operations: read scans, reschedule, change phone or address, raise a ticket. Until you have one, run without the late-delivery behaviour: the general path answers from tracking and escalates.

## 8. Models and notifiers
- 14 `OPENAI_*` variables select models and reasoning effort per job. One provider is used throughout.
- Notifications go through Telegram with fixed channel roles ("OPS" and "LIVE"). Replace with whatever your team reads: Slack, email or Telegram.

## 9. Environment
About 66 variables in seven groups: models, WhatsApp, couriers, support switches, database, notifiers, other (payments, a CMS, a portal mailbox). Most of "other" does not belong in your copy.

---

## Suggested order
1. Brand tokens, then policy and fixed lines (steps 1 and 2): mechanical.
2. Your order source (step 3): the biggest change and the likeliest source of regressions.
3. Cut the commerce modules off (step 5).
4. Messaging layer (step 6) and notifiers (step 8).
5. Replay your real chats, then shadow mode.
6. Courier clients and the late-delivery behaviour (step 7), last.

## Not surveyed
The admin console, email and Instagram channels, and the cron routes beyond the support-related ones. Also not checked: how much of the late-delivery code is generic versus tied to particular scan wording, and whether all 15 order statuses matter to the bot's behaviour.
