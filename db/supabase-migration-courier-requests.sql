-- Courier desk — the raise queue and the Delhivery raise switch.
--
-- Why: the nightly job will raise "parcel delayed" tickets on Delhivery for parcels whose own
-- promised date has passed. Every attempt is a row here, so nothing is ever raised twice and every
-- outcome (raised / deflected with Delhivery's reason / refused / unknown) is on record.
--
--   courier_requests — one row per attempt for an AWB. status:
--       queued     found tonight, not yet sent
--       raising    claimed by a run (atomic queued -> raising, so two runs cannot both send)
--       raised     Delhivery created the ticket (ticket_id = its J... id)
--       deflected  Delhivery declined for now (its reason is stored); retried after next_try_at,
--                  at most 3 times
--       duplicate / refused   Delhivery already has one / rejected it
--       unknown    the create was sent but the answer is unclear. NEVER re-sent: reconciled by
--                  reading the portal list, 'lost' after 48 h
--       dry_run    evaluated with dry_run on; nothing was sent
--       expired / lost   given up
--     A partial unique index allows ONE active request per (awb, kind).
--   courier_desk_config.delhivery_raise_enabled — OFF by default. With it off the nightly run only
--     PREVIEWS (counts what it would raise, writes nothing).
--
-- RLS on, no policies: service role only.
-- Rollback: drop table courier_requests; alter table courier_desk_config drop column delhivery_raise_enabled;
-- Blast radius: one new table and one new column; nothing raises until the switch is turned on.
-- Safe to run more than once.

alter table courier_desk_config add column if not exists delhivery_raise_enabled boolean not null default false;

create table if not exists courier_requests (
  id              uuid primary key default gen_random_uuid(),
  courier         text not null default 'delhivery' check (courier in ('delhivery', 'shadowfax')),
  kind            text not null default 'delay' check (kind in ('delay')),
  source          text not null default 'system_late',
  order_id        text,
  awb             text not null,
  status          text not null default 'queued'
                  check (status in ('queued', 'raising', 'raised', 'deflected', 'duplicate', 'refused', 'unknown', 'dry_run', 'expired', 'lost')),
  attempts        int  not null default 0,
  deflections     int  not null default 0,
  next_try_at     timestamptz,
  ticket_id       text,                 -- the courier's public ticket id once raised
  courier_request_id text,              -- Delhivery's escalation request id, kept for reconciling 'unknown'
  reason          text,                 -- the courier's own words for a deflection / refusal
  evidence        jsonb,                -- why it was judged late: promised date, days late, last scan
  run_id          uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists courier_requests_one_active
  on courier_requests (awb, kind)
  where status in ('queued', 'raising', 'raised', 'deflected', 'unknown');
create index if not exists courier_requests_status_idx on courier_requests (status, next_try_at);
create index if not exists courier_requests_order_idx on courier_requests (order_id);

alter table courier_requests enable row level security;

-- Verify (expect one row rowsecurity = true; then delhivery_raise_enabled = false):
--   select tablename, rowsecurity from pg_tables where tablename = 'courier_requests';
--   select delhivery_raise_enabled from courier_desk_config;
