# How the late-delivery agent requests a courier ticket (contract)

Status: DRAFT for founder decision, 18 Oct 2026. Nothing here is built. Written from a read of the code on 18 Oct; items marked UNVERIFIED have not been tried against a live portal.

The rule: the agent never talks to a courier portal. It writes a request; the existing ticket machinery sends it. The agent's decisions stay in code (lib/deliveryCaseState.ts); this contract only says how a decision becomes a ticket and how the result comes back.

## 1. What exists today (read on 18 Oct)

### Delhivery: the Courier Desk
- Nightly run, 22:03 UTC (03:33 IST), `app/api/cron/courier-desk` -> `lib/courierDesk/run.ts` -> `raiseStep.ts`. Needs a portal login through a Chrome sidecar; three failed logins lock it and alert Telegram.
- Config in `courier_desk_config`: `enabled`, `delhivery_raise_enabled`, `dry_run`, `raise_cap_per_night` (10). Live per the 16 Oct notes (re-check the row).
- The night job finds its own candidates: direct Delhivery bookings (`courier_name='Delhivery'`, no Shiprocket id) past Delhivery's OWN promised date. `candidates.ts` drops: terminal orders, any open failed delivery (`ndr_reason` set: "the NDR system owns it"), a pending edit, an unverified NDR request, an open ticket, an active request, parcels out for delivery, on hold, customer-side, or with attempts exhausted. Delhivery itself refuses a delay ticket before its promised date.
- Queue table `courier_requests` (migration `supabase-migration-courier-requests.sql`): `courier` in (delhivery, shadowfax), `kind` in ('delay') only, `source` ('system_late'), `order_id`, `awb`, `status` (queued, raising, raised, deflected, duplicate, refused, unknown, dry_run, expired, lost), `attempts`, `deflections` (max 3, retry after 24 h), `next_try_at`, `ticket_id`, `courier_request_id`, `reason`, `evidence` (jsonb), `run_id`. A partial unique index allows one active request per (awb, kind).
- `drainDelhivery` claims atomically (queued -> raising), looks for an open ticket first, POSTs the create exactly once, and an unclear answer becomes `unknown` which is only ever reconciled by READING the portal (never re-sent; `lost` after 48 h).
- The ticket text is fixed (`DELAY_DESCRIPTION`, no customer details, portal limit 300 characters, longer is rejected not trimmed). Category is fixed to Shipment Issue > Reattempt or Delay in delivery / consignee pickup / return > Reattempt or Delay in delivery / consignee pickup.
- A raised ticket is recorded in `courier_tickets` and `courier_ticket_events`; the same nightly run syncs status and the courier's replies. The Tickets page shows them.
- Other portal categories are only partly mapped (COURIER_PORTAL_RUNBOOK_DELHIVERY.md section 4): "Shipment not delivered (need POD) / Fake remark" and "Behaviour complaint against staff" exist; their wizard steps have never been submitted by us.

### Shadowfax: the Escalation API
- `raiseShadowfaxIssue(awb, category)` in `lib/shadowfax.ts`: one API call with our token, no portal login, real time. Our code sends only `awb_number` and `issue_category` (1 delayed_delivery, 2 expedite_pickup_customer, 3 expedite_pickup_seller, 4 status_mismatch, 5 delivery_dispute). Shadowfax's published blueprint (the Escalation API section, re-read 18 Oct) also documents only those two fields and a response of `{"message":"Issue received","status":"SUCCESS"}` with no ticket id. **How the claim is carried (checked 18 Oct, read-only, on all 67 tickets on the portal):** by the CATEGORY, not by text. The existing escalation's "comment" is the category label itself: 66 tickets are "My shipment is delayed" (`issue_category` 1, source `client_api_escalations`) and every one has an empty `comments` field; the one `status_mismatch` ticket is "Fake status" (id 17) and also has none. So the agent chooses the category that says what the customer claims and cannot add free text through this API.
- Valid only for direct Shadowfax bookings (`isDirectShadowfax`: courier name exactly "Shadowfax", no Shiprocket id, has an AWB). Each category is valid in a specific window. Only `delayed_delivery` is verified; `status_mismatch` is used by the admin button (unverified); `delivery_dispute` applies only once the order is marked Delivered (unverified).
- Duplicate guard: the `[sfx-escalated <date>]` line in `orders.admin_notes`, written by every route (hourly delay step, admin Raise ticket button, bulk script, NDR "Contact support" and "Deliver tomorrow" after 5 days). **It never expires: one issue per parcel, ever.**
- The hourly delay step (`lib/shadowfaxDelayIssues.ts`, `SHADOWFAX_DELAY_ISSUES_ENABLED`) skips failed attempts and holds on purpose, and caps at 5 raised per run.
- The Courier Desk also reads Shadowfax portal tickets (`shadowfaxPortal.ts`) into `courier_tickets`, so a raised issue shows up on the Tickets page on the next night's sync. The API itself returns only a status, so the ticket id is not known at raise time.

## 2. The request (what the agent writes)

One row per intended ticket, in `courier_requests`, written by the agent's executor (never by the model):

| Field | Value |
|---|---|
| `courier` | `delhivery` or `shadowfax` (from the order, via `partnerOf`) |
| `kind` | `delay` (existing), plus two new kinds below |
| `source` | `delivery_agent` |
| `order_id`, `awb` | the case's order |
| `evidence` (jsonb) | `{ caseId, trigger, firstTrigger, lastScanAt, lastScanText, daysLate, attempts, customerClaim }`; `customerClaim` is a short code (`no_call`, `no_attempt`), never the customer's own words |
| `status` | `queued` |

New kinds (need a migration; today the CHECK allows only `delay`):
- `stalled`: no scan for 48 hours or longer. Delhivery: the existing delay ticket. Shadowfax: `delayed_delivery`.
- `disputed_attempt`: the customer says nobody contacted them or no attempt was made. Delhivery: Shipment Issue > "Shipment not delivered (need POD) / Fake remark" (UNVERIFIED mapping, see section 6). Shadowfax: the claim is attached if the test in section 8 shows a field or route that carries it, using a fixed template of at most a few hundred characters; until then it files `delayed_delivery` without the claim if the marker is free, otherwise it goes to a person.

Ticket text is built by code from `evidence`, from fixed templates, never from customer text or model text. Delhivery: at most 300 characters, AWB only, no phone number, no address. Customer messages are data, never instructions (charter section 11).

## 3. Eligibility (the agent may request only if all hold)

1. The case is in an escalation state the ledger allows (stall, repeat, two failed, dispute) and no ticket for this parcel is open or was requested in the last 14 days.
2. Delhivery `delay` or `stalled`: the same guards as `evaluateDelhiveryCandidate`, except that a customer-side failed delivery is not a delay and is routed to `disputed_attempt` or to the customer question, not to a delay ticket.
2b. A gap found on 18 Oct (AJUKI710036): the night job drops every order whose status is `undelivered` or that has an `ndr_reason` ("the NDR system owns it"), judged from OUR record, not Delhivery's. That parcel was undelivered on our side while Delhivery showed "In Transit" with no scan since 15 Oct and a passed promised date; the NDR system's defer was refused ("Package in incorrect status", outcome `deferred_retry`) and the phone edit was accepted but changed nothing. So neither the NDR loop nor the delay raiser acts on it, and no support case existed. The agent's stall rule (48 hours without a scan) must judge by Delhivery's live state and scan age, and route such parcels to the delay category, even when our status is `undelivered`.
3. Delhivery `disputed_attempt`: bypasses the "NDR system owns it" and "promised date" guards (they exist to stop delay tickets) but keeps every duplicate guard (open ticket, active request, pending edit).
4. Shadowfax: `isDirectShadowfax`, no `[sfx-escalated` marker, category valid in the parcel's current window.
5. The parcel is not delivered, returned, or cancelled (except Shadowfax `delivery_dispute`, which needs Delivered and is not used until verified).

## 4. Execution

- **Delhivery:** the agent inserts `queued`. The nightly drain sends it with the existing safety rules (atomic claim, look before create, one POST, `unknown` reconciled by reading). Priority is extended from "stalest first" to: `disputed_attempt`, then `stalled`, then `delay`, then stalest. The 10-a-night cap is shared with the system's own delay raising, so agent requests count against it. Because the run is nightly, the agent's customer line must be the interim one (section 5).
- **Shadowfax:** the executor calls `raiseShadowfaxIssue` directly (real time), under the existing marker check, writes the `[sfx-escalated <date>]` line with the reason, and records a `courier_requests` row (`courier='shadowfax'`, status `raised`, `ticket_id` null until the sync finds it). A failure leaves the case with a person and a Telegram note, exactly as the NDR button path does.
- **Notifications:** every agent-requested ticket sends one Telegram line (OPS) with order, courier, kind, and outcome, batched into the daily digest later.
- **Dry run:** `courier_desk_config.dry_run` and a new `SUPPORT_DELIVERY_AGENT_TICKETS=off|dry|on` switch (default off) both apply; `dry` writes the request with status `dry_run` and sends nothing.

## 5. What the customer is told

| State | Line |
|---|---|
| Request queued (Delhivery, not yet sent) | "I have escalated this to the team." (never "reported to the courier") |
| Delhivery ticket raised (a ticket id is on the row) | may say "I have raised this with the courier" |
| Shadowfax issue accepted by the API | "I have raised this with the courier". For `disputed_attempt`, say "I have raised this with the courier" only if the claim was really attached (confirmed by reading the ticket back); otherwise "I have escalated this to the team" |
| Deflected, refused, unknown, lost | "I have escalated this to the team", and a person is prompted |

"I will message you here when it moves" depends on the movement-update decision and is not part of this contract.

## 6. Coming back: the result feeds the agent

- `courier_tickets` (by `awb` and `order_id`) and `courier_ticket_events` are the source. The agent reads: ticket open, courier replied (text kept in the case timeline), resolved or closed.
- A courier reply with a new date or action counts as movement (resets the 48 hour clock, triggers a customer update when that is built).
- A ticket closed with no scan movement within 24 hours prompts a person with the full timeline.
- Deflected twice or three times (Delhivery refuses before the promised date): stay with a person.

## 7. Safety and limits

- All limits live in code (charter section 11); the model never chooses a category, a courier, or a count.
- One request per case per kind per 14 days; one active request per (awb, kind) enforced by the existing unique index.
- The Delhivery portal login can lock after three failures; a request is never lost when that happens, it stays `queued`.
- Shadowfax's marker means a parcel the system or a person already escalated cannot be escalated again for a dispute through this route; that case goes to a person (unless the portal comment route from section 8 can add the claim to the existing ticket).
- The nightly cap of 10 may be too low on a busy day; the priority order above decides who waits.
- Ticket text must be reviewed by the founder before the first live raise of each new kind.

## 8. To verify before building (in order)

1. Delhivery: one supervised real raise of "Shipment not delivered (need POD) / Fake remark" and of "Behaviour complaint against staff", capturing the wizard steps, the ticket id and Delhivery's response (the runbook marks both as mapped but never submitted).
2. Shadowfax: DONE for comments (the category carries the claim; no ticket has a comment) and for `status_mismatch` (accepted, "Fake status"). Still open: `delivery_dispute` (needs a parcel already marked Delivered that the customer disputes) and the label it files under. The API response carries no ticket id, so a ticket is matched by AWB, category and date on the next sync.
3. Whether the Courier Desk can run a second drain during the day (a midday drain would cut the wait from about 9 hours to under 1 for requests made before noon).
4. Cap sizing against real agent volume once shadow data exists.
5. The `kind` migration (add `stalled` and `disputed_attempt`) and a `priority` ordering, applied and verified before any code that writes them (migration before code).

## 8b. Verified on 18 Oct (read-only reads, and one supervised Shadowfax raise approved by the founder)

Delhivery (read from the portal's existing tickets; nothing was raised):
- The portal already holds 12 tickets in the dispute category, raised by hand between 31 Aug and 10 Oct, all resolved or closed (1 to 13 days; several answered with a reattempt date). The exact strings are `category` = "Shipment not delivered (need POD) / Fake remark" and `sub_category` = "Delivery or consignee pickup failed due to incorrect / fake remark". So the category is proven; only our `raiseTicket` code path with a non-default category is untested.
- Other strings seen: "Behaviour complaint against staff" > "Behaviour complaint against staff" (3, all closed); "Update shipment details" > "Update consignee address or phone number" (4) and "Update payment mode / COD amount" (2).
- The founder's own descriptions run to about 230 characters and carry: the scan text and date, "the customer confirmed no attempt was made", a request for proof of attempt (call log, rider location), and a redelivery date. The agent's template should follow that shape (within the 300 character limit, no phone number or address).

Shadowfax (one real raise, AJUKI710015, SF00000000013):
- `status_mismatch` (code 4) was accepted: HTTP 200, `{"message":"Issue received","status":"SUCCESS"}`. The ticket appeared on the portal within 10 seconds: id 53578870, status `open`, category shown as **"Fake status"** (their `issue_category` id 17), source `client_api_escalations`, `comments` empty.
- So `status_mismatch` is Shadowfax's "fake status / false attempt" complaint category. That is the right route for a disputed attempt on a parcel that is not yet Delivered.
- The ticket's `comments` field was empty after the raise, exactly as on the 66 "My shipment is delayed" tickets raised the same way: the category is the whole message. A disputed attempt is therefore filed as `status_mismatch` ("Fake status"); a late parcel as `delayed_delivery` ("My shipment is delayed"). Free text, if ever wanted, would only come from the portal's Raise Issue form, which has not been opened.
- All 66 delayed tickets are still `open` on the portal; none has been resolved or answered (no comments). A Shadowfax ticket is a record, not a conversation, so the agent must not say or imply that Shadowfax replied or is acting.
- `delivery_dispute` (code 5) is untested: it needs a parcel already marked Delivered that the customer disputes.
- The parcel's one-ticket marker `[sfx-escalated]` was written, so no second issue can be raised for it.

Delhivery test raise (founder-approved, AJUKI710036, AWB 60000000000007, 18 Oct):
- Through our own `raiseTicket` with the "Fake remark" category and sub-category above. Delhivery **deflected** it: "Shipment not eligible for category", `currentStatus` "In Transit". No ticket was created (read-back found none open). Delhivery's live status for the parcel was "Pending" / DTUP-203 with the last scan on 15 Oct, and its own tracking shows it as in transit, not as a failed attempt.
- So the dispute category is gated on Delhivery's own shipment state: it accepts a "Fake remark" complaint only when the shipment is in a failed-delivery state (as on the 12 hand-raised tickets, which were all raised after a "Consignee Unavailable" style scan). A stalled in-transit parcel cannot use it; that case needs the delay category (which itself needs the promised date to have passed).
- Our code handled the answer correctly: it was parsed as `deflected` with Delhivery's remark, and nothing was recorded as raised. The existing retry rule (24 hours, at most 3) is wrong for this kind: a deflection for category eligibility should not be retried blindly; the agent re-checks Delhivery's state first and only then requests again.
- Contract change: `disputed_attempt` is requestable on Delhivery only when Delhivery's live tracking shows a failed-delivery state (the NDR-eligible and attempted codes), and a "not eligible for category" deflection moves the case to a person instead of the 24 hour retry.

## 9. Build steps (after approval)

1. Migration: extend the `kind` CHECK; add `case_id` (text) for traceability.
2. `lib/delivery/ticketRequest.ts`: pure builder (case + order -> request or refusal with a reason) with tests over every guard above.
3. Executor wiring behind `SUPPORT_DELIVERY_AGENT_TICKETS=dry`, then `on`.
4. Raise-step change: include `delivery_agent` rows in the queue ordering; no change to the send path.
5. Reader: ticket events into the case timeline.
6. Tests: fake Supabase and fake portal, as the existing courierDesk tests do.

## 10. Build status (18 Oct 2026)

Built, committed or not as noted in the session log, all OFF by default:
- `lib/deliveryTicketRequest.ts` (53 assertions): the pure builder, every guard of sections 3 and 8b.
- `supabase-migration-courier-requests-agent.sql`: APPLIED and verified on 18 Oct (the kinds `stalled` and `disputed_attempt`, `case_id`, `priority`, `ticket`, one active request per AWB).
- `lib/deliveryTicketExecutor.ts` (32 assertions): `SUPPORT_DELIVERY_AGENT_TICKETS = off (default) | dry | on`. `dry` writes a `dry_run` row and calls no courier; `on` queues Delhivery for the night run and raises Shadowfax at once (one API call, behind the one-active-request index and the `[sfx-escalated]` marker). A shadow run is forced to `dry`.
- `lib/courierDesk/raiseStep.ts` and `delhiveryRaise.ts`: the night run raises a request's own category and text, and sends the agent's requests ahead of its own rows by priority (a disputed attempt, a stalled parcel, a plain delay).
- Wired in `lib/waSupport.ts`: a live-lite person prompt (stall, repeat chase) requests the ticket; the shadow run dry-runs it.

Not built: the Courier Desk reading ticket replies back into the case timeline (section 6), the interim customer wording per state (section 5), and any request on a customer-reported dispute (live-lite does not send the dispute lines yet).

### 10b. Courier actions (18 Oct 2026), Delhivery first, all OFF

- `lib/ndrPolicy.ts`: the NDR action policy in one place (the breadcrumb, the three-requests-per-parcel cap, the estimated-delivery + 5 day horizon, which act a code gets). Moved unchanged out of `app/api/cron/ndr-reattempt/route.ts`, which now imports it, so the hourly job and the agent cannot drift.
- `lib/deliveryCourierAction.ts` (52 assertions): `planCourierAction` (pure) and `performCourierAction`. `SUPPORT_DELIVERY_AGENT_ACTIONS = off (default) | dry | on`; a shadow run is forced to `dry`, and only a date (DEFER_DLV) or a re-attempt is dry-run from the shadow, never an edit (it needs the customer's values).
  - Limits: direct Delhivery only; never a finished parcel or a blind one (the live status code must be read); ST-108 means a person chases the account manager; three requests per parcel ever with `deferred_retry` rejections forgiven, one a day; a date only for DEFER-eligible codes, clamped to estimated delivery + 5 days, never a Sunday; no bare re-attempt at EOD-11 / EOD-6 / EOD-16 (NDR policy 4.1); an edit only in the failed-delivery window and never a pincode.
  - A submitted action is recorded in `delhivery_ndr_requests` with its request id (the hourly pass reconciles it against get_bulk_upl) and, for a date or re-attempt, the breadcrumb the cap counts. The result is NEVER `confirmed`: a 201 proves nothing on this API.
- Not wired to the customer's reply. The lines that say the courier was asked (A3, B2, B5b, F3b) wait for the founder's decision on wording for "submitted, not yet confirmed" (open decision 5).

### 10c. Decision 18 Oct 2026: what the customer is told when a courier action is submitted, not confirmed

Founder: "I have passed your request for {date} to the courier. I will message you here when it moves." This approves the promise of a later message (open decision 5 in `late-delivery-agent.md`).
- `submittedLine()` in `lib/deliveryCourierAction.ts` builds it from the PLAN, so it names the date the courier was actually sent (and says "the latest date they accept for this parcel" when the date was clamped). Re-attempt and edit have the same shape ("I have passed a request for another delivery attempt ... to the courier", "I have passed your new number / address ... to the courier"). It says the request was passed, never that the courier did, will do, or confirmed anything.
- It may NOT go live until the proactive movement update exists (the D lines, free text inside 24 hours and templates after), because the promise must be kept. Until then live-lite C1 and A2s keep the promise stripped. Movement updates are the next build.

### 10d. Movement updates, the writer, and retiring the old lines (18 Oct 2026), all OFF

- **Movement updates** keep the approved promise. `lib/deliveryMovement.ts` (pure, 31 assertions) decides; `lib/deliveryUpdatesRun.ts` (20) sweeps; `app/api/cron/delivery-updates` runs hourly at :35 (heartbeat even when off; registered with the watchdog). `SUPPORT_DELIVERY_UPDATES = off | dry | on`. For open `live` cases only: a NEW scan at a NEW stage in the transit stages is told (D1, "the latest status is ..."), at most 3 per case, 6 hours apart, any hour, free text inside 23 hours and the template `order_delivery_update_v1` after it, never to an opted-out phone. It does NOT repeat what the order lifecycle already sends with approved templates (out for delivery, delivered, a failed attempt, a return): those stages only advance the baseline. The case is claimed before sending (a conditional update on `updated_at`) and a failed send hands the claim back. The template is NOT submitted: `scripts/create-delivery-update-templates.mts` (dry run checked) needs the founder's go.
- **The writer where no approved line fits** (generator and verifier): the agent runs before the general path, and what it read about the parcel (`lib/deliveryFacts.ts`: where it is, how long the courier has been quiet, attempts, chases, whether a person is on it; never a scan, a location or the courier's reason) is added to the record the general path writes from, so the reply is written and verified under the same grounding gate. Where the agent has an approved line the line is used.
- **Retiring the old lines** is a switch, not a deletion: `SUPPORT_LATE_LINES=off` (default on) stops `late_first` and `late_insist`. The plan, preconditions and measures are in `workflows/late-lines-retirement.md`.

### 10e. Decision 18 Oct 2026: the courier may be blamed; every late-parcel reply reassures

Founder: the bot can blame the courier but must always say we are trying to get the parcel delivered as soon as possible and assure the customer they need not worry. This REVERSES the 14 Oct removal of "no need to worry". `lib/lateReassurance.ts` (25 assertions) holds the three sentences and `withLateReassurance`; the old fixed lines (`late_first`, `late_insist`), the agent's late lines (A2, A2s, A5, C1, E1, E2), and every model-written late-parcel reply (added by code in `lib/generalLive.ts`, after the ruler has read the model's own text) carry it. Movement updates (D1 and the template body) carry the short effort sentence only. The three sentences are approved fixed text, so the verifier and the ruler do not judge them as claims. It is never added on a returning or delivered parcel, never twice, never on the "I do not have that information" flag line.
