-- Unified customer identity.
--
-- WhatsApp, email and orders each know a customer differently: wa_conversations
-- is keyed on phone, email_threads on an email address, and orders match via
-- ownsOrder() against whichever of phone/altPhone/email happens to be on the
-- order. None of the three can answer "has this person already told us
-- something on another channel" — a customer told "no" by the WhatsApp bot can
-- restart the same conversation by email with no memory of the first refusal,
-- because nothing joins the two.
--
-- This does not replace any of those keys. It adds one row per person, holding
-- the *set* of exact identifiers seen for them, so a new order or conversation
-- can be attached to an existing customer the moment one of its identifiers is
-- already on file.
--
-- Identity here is exact-match only, never a confidence score. isAdminIdentity's
-- own reasoning applies just as much to customer data: the dangerous bug is a
-- stranger quietly matching, not a real match being missed. A near-match (same
-- address, a different unverified phone) is recorded in possible_duplicates for
-- a human to merge by hand — never merged automatically, because a wrong merge
-- here doesn't just mislabel a conversation, it can expose one customer's order
-- and refund history to another.

create table if not exists customers (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  -- Near-matches that didn't clear the exact-match bar: [{ kind, value,
  -- reason, seen_at }]. Surfaced on an admin screen, never auto-merged.
  possible_duplicates jsonb not null default '[]'::jsonb
);

-- One row per identifier ever seen for a customer. A phone or email belongs to
-- at most one customer — the unique index below is what makes "does this
-- already belong to someone" a single indexed lookup instead of a scan, and
-- what stops two customers from silently sharing an identifier.
--
-- value is normalized before it ever reaches this table: phone is the last 10
-- digits (matching phoneKey() in orderOwnership.ts), email is trimmed and
-- lowercased (matching how email_threads.email is already stored).
create table if not exists customer_identifiers (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references customers(id) on delete cascade,
  kind           text not null check (kind in ('phone', 'email')),
  value          text not null,
  -- OTP-verified (the way user.phone / a signed-in email already is) vs. only
  -- ever typed at checkout or seen as a delivery contact. Mirrors the
  -- verified/unverified distinction ownsOrder() already leans on.
  verified       boolean not null default false,
  first_seen_at  timestamptz not null default now()
);

create unique index if not exists customer_identifiers_value_idx
  on customer_identifiers (kind, value);
create index if not exists customer_identifiers_customer_idx
  on customer_identifiers (customer_id);

-- Only the service role touches these; never read from the browser.
alter table customers enable row level security;
alter table customer_identifiers enable row level security;
