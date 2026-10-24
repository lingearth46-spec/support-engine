-- Granular courier tracking: keep the scans the webhooks already receive.
--
-- app/api/shipping/delhivery and app/api/shipping/shadowfax already take a push
-- on every parcel movement. They collapse each one into orders.status
-- (shipped / undelivered / rto / delivered) plus ndr_reason, and throw the rest
-- away — the hub name, the "re-routed to your nearest facility", the
-- "pincode updated" events. This keeps them.
--
-- Two pieces:
--
--   parcel_scans   append-only, one row per scan. The trail.
--   orders.courier_status*   the latest scan, denormalised onto the order so the
--                            bot and the admin read it with no join.
--
-- Why the raw event matters beyond nicer bot answers: a failed_attempt /
-- rerouting / address_updated scan is the moment to reach the customer before
-- the parcel becomes an RTO, which costs freight both ways plus the ad spend
-- that bought the order.
--
-- Code ships before this runs (migrations are by hand). lib/parcelScan.ts
-- recordScan() swallows "relation does not exist" (42P01) and "column does not
-- exist" (42703) so the webhooks keep working in the gap.

create table if not exists parcel_scans (
  id                 uuid primary key default gen_random_uuid(),
  order_id           text,
  awb                text not null default '',   -- '' not null, so the dedupe index is consistent
  courier            text not null,              -- 'delhivery' | 'shadowfax'
  -- The courier's own words, kept verbatim for the audit and because their
  -- wording carries detail our vocabulary drops ("Consignee refused to accept").
  raw_status         text not null default '',
  -- lib/parcelScan.ts ParcelEvent — the cross-courier vocabulary the bot and the
  -- RTO triggers read. Not a check constraint: the list lives in code and
  -- coerces anything unknown to 'unknown' before this table sees it.
  event              text not null default 'unknown',
  location           text,                       -- hub / facility / city, when the courier sends it
  remark             text,                       -- extra note attached to the scan
  -- When the courier says the scan happened, vs when the push reached us. They
  -- differ — pushes arrive late and out of order.
  scanned_at         timestamptz,
  received_at        timestamptz not null default now()
);

-- The trail for one parcel, newest first — the read the bot and the order page do.
create index if not exists parcel_scans_order_idx on parcel_scans (order_id, scanned_at desc nulls last);
create index if not exists parcel_scans_awb_idx on parcel_scans (awb);

-- Couriers replay pushes. A scan is the same scan if the AWB, the courier, the
-- wording and the courier's own timestamp all match — drop the duplicate rather
-- than grow the trail with copies. NULLS NOT DISTINCT so a scan that arrived
-- without a timestamp still dedupes (Postgres 15+).
create unique index if not exists parcel_scans_dedupe_idx
  on parcel_scans (awb, courier, raw_status, scanned_at) nulls not distinct;

-- ── Latest scan, on the order ────────────────────────────────────────────────
alter table orders add column if not exists courier_status          text;         -- ParcelEvent
alter table orders add column if not exists courier_status_detail    text;         -- raw wording
alter table orders add column if not exists courier_status_location  text;
alter table orders add column if not exists courier_status_at        timestamptz;  -- scanned_at of the latest

-- The reconciliation cron (app/api/cron/parcel-scan-sync) picks in-flight
-- parcels whose snapshot has gone stale; this index keeps that scan cheap.
create index if not exists orders_courier_status_at_idx
  on orders (courier_status_at nulls first)
  where status in ('shipped', 'manifested', 'undelivered');
