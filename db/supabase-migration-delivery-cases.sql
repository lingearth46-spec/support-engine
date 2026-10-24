-- delivery_cases: the memory of the late-delivery agent (lib/deliveryCaseState.ts, lib/deliveryShadow.ts).
-- One row per customer and parcel while a late or failed delivery is being handled. It holds what the agent needs to be state aware:
-- what we last asked the customer, how many times they have chased since the parcel last moved, which scan we last answered against,
-- and which escalations were already raised (one per stall, one per repeat run, one per failed-attempt count).
--
-- WHY: without it a repeat "still waiting" looks like a first message and re-escalates every time (18 escalating repeats in 9-16 Oct).
--
-- BLAST RADIUS: a new table only. Nothing existing is altered. The code tolerates the table being absent (the shadow records "no state" and
-- carries on stateless), so this can be applied before or after the code ships, but apply it BEFORE SUPPORT_DELIVERY_AGENT is set to shadow.
-- ROLLBACK: drop table delivery_cases;   (the agent then runs stateless; nothing else reads it)
--
-- Idempotent. RLS on with no policies: only the service role reads or writes it, like support_watches.

create table if not exists delivery_cases (
  id               bigserial primary key,
  phone            text        not null,                        -- 10-digit, same key as wa_messages.phone
  order_id         text        not null,                        -- AJUKI710013
  status           text        not null default 'open' check (status in ('open', 'closed')),
  mode             text        not null default 'shadow' check (mode in ('shadow', 'live')),
  awaiting         text        check (awaiting in ('rider_answer', 'date', 'address')),   -- what we last asked the customer, if anything
  chases           integer     not null default 0,              -- customer messages about this parcel since it last moved
  failed_attempts  integer     not null default 0,
  last_scan_at     timestamptz,                                  -- the scan we last answered against; a newer one is "movement"
  last_reply_at    timestamptz,
  ledger           jsonb       not null default '{}'::jsonb,    -- {stall, repeat, twoFailedAt, dispute, noLever}: what has already been escalated
  closed_reason    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One open case per customer and parcel.
create unique index if not exists delivery_cases_one_open
  on delivery_cases (phone, order_id) where status = 'open';

create index if not exists delivery_cases_open_by_age
  on delivery_cases (updated_at) where status = 'open';

alter table delivery_cases enable row level security;

-- Verify (should return one row; 0 open cases and 0 total on a fresh table):
-- select count(*) filter (where status = 'open') as open_cases, count(*) as total from delivery_cases;
