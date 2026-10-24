-- Escalation with an owner.
--
-- Today an escalation is wa_conversations.escalated = true plus one Telegram
-- ping. For orders and WhatsApp threads, the existing tickets list
-- (lib/tickets.ts, supabase-migration-tickets.sql) only shows a row once a
-- human has typed an admin_note on it — so the escalation itself is not what
-- makes a ticket exist. Production evidence: 104 escalations, 3 ever taken
-- over, 101 never turned into a note and so never ticketed. The ping fires
-- reliably; nothing after it is durable.
--
-- support_cases is that durable record. One row is created the moment the bot
-- escalates — not when a human later decides to write something down — so the
-- queue reflects reality without depending on someone remembering to note it.
--
-- Scoped to one topic (tag) per customer, not one row per phone number or
-- thread: a customer with an open escalated "replacement_vs_refund" case can
-- still get a real answer to an unrelated "product_info" question, because
-- that is a different case. This is the same tag-based distinction
-- lib/waSupport.ts already uses to decide whether a follow-up is a chaser or a
-- new question (see alreadyAcknowledged) — reused here as a database
-- constraint, not reinvented.
--
-- Deliberately does not replace the existing tickets system for order notes or
-- manual_tickets — those are a founder's own record of a task, a different
-- concern from an AI's escalation. app/api/admin/tickets/route.ts folds this
-- table in alongside them.

create table if not exists support_cases (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references customers(id),

  -- Which channel raised it, and which row on that channel it came from. Only
  -- one of wa_phone / email_thread_id is set, matching channel.
  channel         text not null check (channel in ('whatsapp', 'email')),
  wa_phone        text,
  email_thread_id uuid references email_threads(id),

  -- The bot's own subject tag (lib/supportGuardrails.ts SUPPORT_TAGS) — not
  -- re-validated by a check constraint here, because the tag list lives in
  -- code and already coerces anything unrecognised to "other" before this
  -- table ever sees it; duplicating the list into SQL would just be a second
  -- place for the two to drift apart.
  tag             text not null,

  status          text not null default 'ESCALATED'
                    check (status in ('ESCALATED', 'OWNED', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'SLA_BREACHED')),
  escalate_reason text,

  -- Reuses lib/tickets.ts's own priority vocabulary rather than a new one.
  priority        text not null default 'medium' check (priority in ('high', 'medium', 'low')),

  -- The missing step: a founder acknowledging the case exists, distinct from
  -- ticket_action_at elsewhere, which only ever stamps when an actual action
  -- was recorded. owned_by is the admin identity string (adminIdentity.ts).
  owned_at        timestamptz,
  owned_by        text,

  -- When ESCALATED, the deadline the SLA cron checks against. Set at creation
  -- from a fixed window (see lib/supportCases.ts) rather than configurable
  -- per-case for now — one number to tune later beats a setting nobody sets.
  sla_deadline    timestamptz,

  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint support_cases_channel_ref check (
    (channel = 'whatsapp' and wa_phone is not null and email_thread_id is null) or
    (channel = 'email' and email_thread_id is not null and wa_phone is null)
  )
);

-- One open case per (customer, topic). This is what makes the tag-scoped mute
-- in lib/waSupport.ts safe to lean on as a database fact instead of a
-- convention: a second escalation on the same still-open topic finds the
-- existing row instead of forking a duplicate case.
create unique index if not exists support_cases_open_topic_idx
  on support_cases (customer_id, tag)
  where status <> 'RESOLVED';

create index if not exists support_cases_status_idx on support_cases (status);
create index if not exists support_cases_sla_idx on support_cases (sla_deadline) where status = 'ESCALATED';
create index if not exists support_cases_customer_idx on support_cases (customer_id);

-- Append-only transition history — feeds observability later, not a new UI to
-- build first. Mirrors admin_undo's before/after discipline: what changed and
-- when, kept separately from the row it happened to.
create table if not exists case_events (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references support_cases(id) on delete cascade,
  from_status text,
  to_status   text not null,
  note        text,
  -- Who or what caused the transition: 'bot' (escalation), 'admin' (acked or
  -- resolved it by hand), 'cron' (SLA breach), 'system' (customer replied).
  actor       text not null check (actor in ('bot', 'admin', 'cron', 'system')),
  created_at  timestamptz not null default now()
);

create index if not exists case_events_case_idx on case_events (case_id, created_at);

alter table support_cases enable row level security;
alter table case_events enable row level security;
