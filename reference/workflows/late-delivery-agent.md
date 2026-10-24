# Late-delivery agent: plan, wording, reasoning and limits

Status: DRAFT for founder decision, 16 Oct 2026. Nothing in this document is built. No customer-facing change, flag or template is submitted until the founder approves it.

## 1. Purpose

Late delivery is the largest single cause of escalation. This plan describes a narrow workflow agent that handles late and failed parcels end to end: it works out why the parcel is late, takes the courier actions that exist today, tells the customer what is true, watches the parcel, texts the customer when it moves, and prompts a human only when nothing has moved for 48 hours or when no courier action is possible.

The goal is founder bandwidth, not throughput (AGENT_CHARTER.md): fewer escalations, with no new promises the business cannot keep.

## 2. Decisions already taken (founder, 16 Oct 2026)

1. The agent may take any courier action that is available today, without asking. This means defer, re-attempt, edit phone or address, and raise a courier issue. Assumption to confirm: it never cancels an order, authorises a return to origin, or touches money. Those stay with a person.
2. The agent follows up on the case itself. It prompts a human after 48 hours with no movement.
3. At each follow-up, if the parcel has moved, the bot texts the customer directly.
4. Dispute branch: when a delivery failed with a customer-side courier reason and the customer says nobody contacted them, the bot does not accept the courier's reason. It reports the complaint to the courier, tells the customer, and says it will message them when the parcel moves. This is on the first claim.
5. A request for the rider's phone number is answered "cannot share it, the rider will contact you", not "escalated".
6. An address change after dispatch can be done through the couriers, so the old "cannot be changed now" line is replaced.
7. The wording below is still a draft for the founder to edit.

Where a decision overrides an earlier rule, it is listed in section 9.

## 3. What the data says (9 to 16 Oct)

- 157 of 728 bot messages escalated (21.6%). Late-delivery replies are 76 of them (48%): late_first 51, late_insist 18, return_and_late 5, lookup_late 2.
- Late delivery is 80 of the 195 WhatsApp support cases. The case reasons include 26 late-delivery fixed replies, 22 Shadowfax parcels undelivered over 5 days, 13 "Contact support" taps on a failed delivery, and 15 callback requests.
- Every repeat chase re-escalates today: 18 escalating "still waiting" replies in the week, whether or not anything changed.
- Of 15 chased orders that could be traced: 8 Shadowfax, 6 Delhivery, 1 DTDC. Courier reasons: vehicle breakdown, heavy rain and "not attempted" (about 5, no customer action needed); customer not contactable or consignee unavailable (6, needs a question to the customer); none recorded (4). Four of the 15 were delivered within a day of the first chase.
- Customers dispute the courier's reason in their own words: "he didn't call me", "the attempt was never made", "the rider is not contactable".

Limitation of this evidence: the older reply wording carried no order ID, so only 15 orders could be traced to their courier and scan. The numbers are indicative, not a measurement. A full 80-case breakdown by courier and cause should be run before the thresholds are fixed.

Estimated effect: if about half of late chases are courier-side or transient, late-related escalations could fall by a third to a half, which would lift "bot handled" from about 69% to the high 70s. It will not reach 90% on its own, because some cases need a person at the courier.

## 4. What exists today

Live and acting on real parcels:
- Hourly Delhivery cron `ndr-reattempt`: re-tracks the parcel, defers delivery for "customer unavailable" codes (EOD-11, EOD-6, EOD-16), re-attempts the others, and reconciles the outcome the next hour. 184 requests since 9 Oct: DEFER_DLV 163, RE-ATTEMPT 16, EDIT_DETAILS 5. Outcomes: 70 accepted, 74 `deferred_retry`, 19 rejected.
- WhatsApp NDR buttons (Deliver tomorrow, Update phone, Update address, Contact support), wired to real courier actions with a support-case fallback. 93 taps since 9 Oct.
- Shadowfax delay issues switched on (`SHADOWFAX_DELAY_ISSUES_ENABLED=true`).
- MCP tools for an agent: `respond_to_courier` (submits a Delhivery action; limits from NDR_POLICY.md enforced in code; dry run by default; needs a write token), `verify_courier_actions`, `send_case_closing_note`, `resolve_case`, `escalate_case_now`. Whether the cloud routine calls them was not checked.
- Support follow-up watches (`support_watches`) and the hourly follow-up job, currently `SUPPORT_FOLLOWUPS=dry`.

Not live:
- The case engine (`lib/caseEngine`): mode OFF since 5 Oct, not called by any cron. It is not part of this plan.
- The pincode-ask flow: `NDR_PINCODE_ASK_ENABLED` is not set.
- Delhivery courier-portal ticket automation: built but uncommitted, and its login and keep-alive job are not done.
- Any action for DTDC or Shiprocket: they expose no NDR, re-attempt or edit endpoint.

## 5. Design

### 5.1 Principle: code decides, the model reads

Decisions come from code and the order and scan data, following NDR_POLICY.md. The model is used only to understand a customer's reply (a date, a phone number, an address, "he never called") and to fill fixed wording. A free-writing model is not allowed to decide an action or claim an outcome. Reasons: an unconstrained model made the worst replies in this audit (invented sizes, "already closed", repeated answers), and the policy limits (no bare re-attempt on EOD-11/6/16, no ST-108 action) must hold every time.

### 5.2 Diagnose

For each chased order, read: courier, scan status, NDR code or reason, attempt count, days late against the estimate, and whether a case and a watch already exist. Classify:

| Class | Typical signal | Customer action needed? |
|---|---|---|
| Courier-side delay | vehicle breakdown, weather, hub delay, "not attempted" (EOD-86) | No |
| Customer-side failed delivery | not contactable, consignee unavailable, refused, address issue | Yes, one question |
| Stuck, no scan movement | no new scan for the threshold time | No, but a human prompt at 48 hours |
| On hold at a hub (Shadowfax `on_hold`) | edit window open | Only if details unknown |
| Returning to us | RTO status | No |
| Marked delivered but not received | delivered status, customer disagrees | Email Senior Support, escalate |

### 5.3 Act

- Courier-side: re-attempt only where policy allows (a plain re-attempt is allowed for EOD-86, not for EOD-11/6/16); otherwise tell the customer the state and watch.
- Customer-side: ask one question; then defer or edit with the answer (Delhivery), or edit or raise an issue (Shadowfax). Confirm only after the courier's outcome is verified; a 201 proves nothing.
- No lever (ST-108, DTDC, Shiprocket, a Shadowfax date request, a pincode change): raise a courier request automatically where a channel exists, otherwise prepare the ready-to-send request for the founder (NDR_POLICY.md section 9.5) and tell the customer it was escalated.

### 5.4 Dispute branch (customer says they were not contacted)

1. Read the courier's reason from the scan.
2. Ask once: did the rider contact you? Buttons: [Rider did call me] [No call received] [My number changed].
3. "No call received" (or the same in free text):
   - Delhivery: ask for a delivery date and the number to call, defer to that date, and file the rider-conduct complaint with the waybill, attempt time, phone on the order and the customer's statement.
   - Shadowfax: raise an issue with the same evidence (Shadowfax cannot schedule).
   - Record the case as "disputed by the customer" beside the courier's reason, so disputes can be counted and the courier's accuracy tracked.
4. Reply to the customer only with what is confirmed (section 8, B2 to B4).
5. Start the watch.

The bot cannot verify whether the rider really called: we hold no call logs. The branch treats the customer's account as a claim to report, not a fact.

### 5.5 Follow-up cycle and the 48-hour rule

- Movement means a new courier scan (a different stage or new scan text). A re-poll showing the same scan is not movement.
- Each follow-up check: if the parcel moved, text the customer directly (section 8, D). If not, say nothing new to the customer unless they chase (C1).
- No movement for 48 hours: prompt a human with the full timeline, and tell the customer it was escalated (E1).
- This replaces the 12-hour "we are on it" message, which carried no information.
- Cap: at most one proactive message per movement and three per watch (the current cap). Messages only inside support hours, 11:00 to 19:00 IST, Monday to Saturday, as the existing follow-ups do (to confirm).
- The watch ends on delivery, return to origin, cancellation, 14 days, or the cap.

### 5.6 Repeat chasing

A customer who chases again after an update gets the current state from the watch ("no newer update since {date}"), not a new escalation. The second-line apology ("I am sorry you are still waiting. I have escalated this to the team again") should be used only when something changed or the 48 hours passed.

### 5.7 Address change after dispatch

The agent asks for the full new address with the same pincode, checks it, and pushes the edit through the courier: Delhivery `EDIT_DETAILS`, Shadowfax `updateShadowfaxDeliveryDetails`. It confirms only after the courier accepts. A different pincode or city, or a refused edit, becomes a request to the courier's account manager and a human prompt.

### 5.8 Rider's number

Never shared. The reply says the rider will contact the customer before delivery. If the customer then says the rider is not reachable, the dispute branch applies.

## 6. Rules every message follows

- The track link is always www.ajuki.in/track.
- No promise of a delivery time, refund, replacement or discount.
- REVERSED 18 Oct (founder): every late-parcel reply says we are working to get it delivered as soon as possible and that there is no need to worry, and the bot MAY say the delay is on the courier's side. Built in `lib/lateReassurance.ts` (`LATE_REASSURE`, `COURIER_BLAME`, `LATE_EFFORT`) and added by code, verbatim. It is a sentence after the facts, never the whole reply (the 14 Oct brush-off was the whole reply). Still true: no delivery date or time, and the courier's own reason or scan is never quoted; the courier is named only where the parcel is in its hands and has stopped moving, never for a failed attempt that waits on the customer.
- The courier's own reason (its note or a scan) is never quoted to the customer. The courier MAY be named as the source of a delay (18 Oct), see the reassurance rule below.
- "I have asked the courier" appears only when the courier confirmed the action. Otherwise the line says "I have escalated this to the team."
- "I will message you here when it moves" is a promise of a later message. It is approved only if the founder accepts it (open decision).
- English only for templates. A template variable is never first or last in the body (Meta refused this before).

## 7. Reasoning behind the main choices

- A bounded workflow, not a free agent: the failure modes seen in this audit were model inventions, and the courier limits must hold every time. A narrow tool set with decisions in code is auditable.
- Reuse the live functions, not the case engine: the Delhivery cron, the NDR button module and the MCP tools are running with verified outcomes. The case engine is off and has no run history.
- Dispute on the first claim: waiting for a second report leaves a customer who was really not called with the same unresolved parcel, and chasing is already the largest source of repeat contact.
- 48 hours, measured on scans: it matches the founder's rule and the existing policy escalation windows; a re-poll that shows nothing new should not reset the clock.
- Movement updates replace "we are on it": the customer chases because they have no information; a real update is information.

## 8. Wording (draft, English)

### A. First reply to a late or failed parcel

| ID | When | Draft |
|---|---|---|
| A1 | Failed delivery attempt | "Your order {id} had a delivery attempt that did not complete. Did the rider contact you?" Buttons: [Rider did call me] [No call received] [My number changed] |
| A2 | Overdue, no failed attempt | "Your order {id} was expected around {date} and is delayed. I have escalated this to the team. You can track it at www.ajuki.in/track." |
| A3 | Courier-side delay, re-attempt confirmed | "Your order {id} is delayed with the courier, and I have asked them to attempt it again. I will message you here when it moves. You can track it at www.ajuki.in/track." |

### B. Dispute branch

| ID | When | Draft |
|---|---|---|
| B1 | "No call received", Delhivery | "I am sorry about that. I will report this to the courier. Which day would you like the delivery, and is {phone} the right number to call?" |
| B2 | Date given, Delhivery deferral confirmed | "I have reported to the courier that you were not contacted, and asked them to deliver order {id} on {date}. I will message you here when it moves. You can track it at www.ajuki.in/track." |
| B3 | Shadowfax (cannot schedule) | "I am sorry about that. I have reported to the courier that you were not contacted, and escalated this to the team. I will message you here when it moves. You can track it at www.ajuki.in/track." |
| B4 | Date requested, courier has not confirmed | "I have reported to the courier that you were not contacted, and passed your request for {date} to the team. I have escalated this to the team. You can track it at www.ajuki.in/track." |
| B5 | "My number changed" | "Thank you. Please send the correct number for order {id}." After the edit is confirmed: "I have passed {phone} to the courier for order {id}. I will message you here when it moves." |
| B6 | "Rider did call me" | "Thank you. Which day would you like the delivery for order {id}?" |

### C. Repeat chase, nothing moved (under 48 hours)

| ID | Draft |
|---|---|
| C1 | "There is no newer update on order {id} since {date}. I will message you here as soon as it moves. You can track it at www.ajuki.in/track." |

### D. Proactive update when the parcel moves

Inside the 24-hour window as free text; after it, as a template.

| ID | When | Draft |
|---|---|---|
| D1 | New scan | "Update on your order {id}: the latest status is {status}. You can follow it at www.ajuki.in/track." |
| D2 | Out for delivery | "Your order {id} is out for delivery today. You can track it at www.ajuki.in/track." |
| D3 | Delivered | "Your order {id} shows as delivered. If you have not received it, please reply here." |
| D4 | Returning to us | "Your order {id} is on its way back to us and cannot be delivered again. You can place a new order at www.ajuki.in." |

Status words in D1 come from a fixed list (in transit, out for delivery, delivery attempted, on its way back to us); the model never writes them.

Template versions (new, English only):
- D1: "Update on your order {{1}}: the latest status is {{2}}. You can follow it at www.ajuki.in/track."
- D2: "Good news on your order {{1}}: it is out for delivery today. You can track it at www.ajuki.in/track."

### E. No movement for 48 hours

| ID | Draft |
|---|---|
| E1 | "There has been no movement on order {id} for 2 days. I have escalated this to the team. You can track it at www.ajuki.in/track." |

### F. Requests the bot cannot meet as asked

| ID | When | Draft |
|---|---|---|
| F1 | Asks for the rider's number (parcel out for delivery or with a rider) | "I cannot share the rider's number. The rider will contact you before delivery." |
| F2 | Asks for a specific date on Shadowfax | "I have passed your request for {date} to the team. I have escalated this to the team." |
| F3a | Asks to change the address after dispatch | "I can ask the courier to change the address for order {id}. Please send the full new address, keeping the same pincode." |
| F3b | Same pincode, courier confirms | "I have asked the courier to deliver order {id} to {address}. I will message you here when it moves. You can track it at www.ajuki.in/track." |
| F3c | Different pincode or city, or edit refused | "I have passed the new address to the team to request the change from the courier. I have escalated this to the team. A different pincode may not be possible." |

## 9. Rules this plan overrides or changes

- NDR_POLICY.md section 9.5 raises the rider-conduct complaint on the second report. This plan does it on the first (founder).
- The approved fixed line for the address after dispatch ("This order is already with the courier, so the address cannot be changed now. I have escalated this to the team.") and the business fact "address changes only before dispatch" are replaced for the agent.
- The "late, insisting" fixed line no longer escalates every time (section 5.6).
- The 12-hour "we are on it" follow-up is retired in favour of movement updates.
- F1 is a promise about the rider's contact, which the callback check in lib/replyGrounding.ts would block in a model reply. It must be an approved fixed line.
- Business rule 12 (Claude has zero money authority) and "no post-dispatch cancel" stand; this plan adds no cancel or refund.

## 10. Limitations and risks

Courier coverage
- Delhivery supports defer, re-attempt, edit and verify. Shadowfax supports edit and raising an issue, with no scheduling and no ticket status. DTDC and Shiprocket expose nothing, so those parcels can only be escalated.
- Address edits on Delhivery work only while the parcel is in its failed-delivery window; otherwise the API answers "Package in incorrect status". Pincode and city cannot be changed. Shadowfax edits are intra-city, capped at two per order, and locked while the parcel is out with a rider (queue and retry).
- Shadowfax masks the contact on read-back, so a phone change there is "submitted, unconfirmed" unless a scan proves it.
- Delhivery returns 201 to anything, including actions that do not exist; confirmation depends on the reconcile pass. About 40% of recent requests sit in `deferred_retry` and 10% were rejected. The `deferred_retry` constraint bug in the founder's notes was not re-checked. Any build on these retries depends on it.
- Delhivery has no comment thread. A "complaint" is a new action or a ticket; the ticket automation is not live, so until then a rider-conduct complaint is a prepared request for the founder to send, and the customer line must say "escalated", not "reported to the courier", unless that is true.
- It is open whether Shadowfax re-attempts on its own (a founder note from 15 Oct says RTOs show "No reattempt request by the admin"). The plan does not assume auto-retry.

Customer messaging
- Messages after 24 hours need new templates. Template approval takes days and Meta may reclassify to Marketing.
- Proactive messages carry a quality-rating and opt-out risk; the cap and the support-hours window limit it. Earlier proactive outreach was paused because one trigger only duplicated an existing template.
- Customers who dispute falsely cost a courier complaint each. The disputed marker lets us count them.
- No call logs exist, so "was the customer called" cannot be verified.

Data and measurement
- The scan feed that defines movement depends on the parcel scan sync; a late sync delays updates.
- The cause breakdown above is from 15 traced orders and is indicative only.
- Only 9 of 195 WhatsApp cases carry a resolved time, so human cost per escalation cannot be measured until cases are closed with a timestamp.
- The rating ruler covers about 65% of replies and starts on 12 Oct.

Build and operations
- The case engine is OFF; this plan does not need it, but any later gateway work (WP4) would have to meet this plan.
- Whether the cloud NDR routine currently calls the MCP action tools is unverified.
- Two code areas are shared with other workstreams (the WhatsApp webhook and the courier portal); changes need coordinating.
- Every new fixed line must be registered as an approved line, or the grounding checks will strip it.

## 11. Build order

1. No new agent: stop re-escalating on repeat chases, put the cause class in the first reply, and switch the follow-up job from `dry` to `on` after reviewing the dry runs.
2. Code that diagnoses the cause from scan and NDR state (section 5.2).
3. Route customer-side failures and the dispute branch to the existing button functions and `respond_to_courier`, behind a flag, Delhivery first.
4. Automate courier requests: Delhivery ticket automation and the Shadowfax issue path.
5. Address change after dispatch (section 5.7).
6. New templates D1 and D2, submitted only after approval.

Prerequisites: confirm the `deferred_retry` fix, the sending hours, the cap, and the open decisions below.

## 12. Measures of success

- Late-delivery escalations per late conversation, against the 9 to 16 Oct baseline (76 escalating late replies).
- Share of late chases closed with no human involvement.
- Repeat-chase rate after an update.
- Share of courier actions confirmed by the reconcile pass.
- Disputed-delivery count by courier.
- Bot handled rate and rated "irreparable" count, against the Phase 0 baseline (research/bot-review/phase0-baseline-16oct.md).

## 12b. Decisions added 16 Oct (evening)

- Keep the rule: three chases with no movement prompt a human once.
- Agent limits confirmed: it may cancel only inside the existing 24-hour cancellation window (reading to confirm), it never authorises a return to origin, and it touches no money.
- Proactive movement updates may be sent at any time, not only 11:00 to 19:00 IST. This differs from the follow-up job, which keeps the support-hours window.
- A first prototype replay (research/late-agent/) showed escalations on late cases falling from 75% to 42% on 112 real cases, but it was tuned on its own sample. A second version with parcel timeline, conversation state and escalation ledger is tested on a date split before anything is built live.

## 13. Open decisions for the founder

1. Confirm the agent never cancels, authorises RTO or touches money.
2. Approve "I will message you here when it moves" as a promise of later contact.
3. Sending hours for proactive updates: 11:00 to 19:00 IST only, or also for "out for delivery".
4. Cap per case (one per movement, three per watch)?
5. Say "asked the courier" only after courier confirmation, never on a 201.
6. Shadowfax date request: human prompt at once, or after 48 hours?
7. Mark disputed deliveries in the record beside the courier's reason?
8. Button titles in A1 and the apology in B1 and B3.
9. Whether to keep D3 or rely on the existing delivered message.
10. Which lines become templates (D1 and D2 first).
11. In F1, add "I have asked the courier to call you" only if we really ask; left out by default.
12. In F3a, ask for the full address and check the pincode against the order before the edit.

## 14. Build status (17 Oct 2026)

Built locally, uncommitted, behind a flag that is OFF by default (`SUPPORT_DELIVERY_AGENT`; only the value `shadow` does anything, and it sends nothing):
- `lib/deliveryCaseState.ts`: the pure state-aware core (parcel timeline, case state, escalation ledger, catch-all, the draft wording lines, the gate and the order choice). 91 assertions.
- `lib/deliveryLlm.ts`: the two constrained model reads (the supervisor's reading of the chat, the analyst's reading of the raw scans). Same model as the live general path.
- `lib/deliveryShadow.ts`: the shadow runner. Records what the agent would have said and done onto `ai_meta.deliveryAgent`, beside what the live bot did, and keeps its own memory in `delivery_cases`. 38 assertions with a fake database and a fake fetch.
- `supabase-migration-delivery-cases.sql`: the new table, to be run by hand BEFORE the flag is set.
- `lib/waSupport.ts`: one block added after the general shadow (11 lines). A backup of the file before the edit is in the session scratchpad.

Not built yet: the live mode (`on`), executing courier actions, proactive movement updates, the generator-and-verifier path for messages no approved line fits, templates, a dashboard section. The analyst's output is recorded and cross-checked against the code timeline but does not drive any decision yet.

Replay of the production module on the 112 cases (cached model reads): escalations 84 to 62 (-26%), matching the prototype (63).
