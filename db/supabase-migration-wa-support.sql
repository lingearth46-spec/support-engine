-- AI WhatsApp customer support: storage.
--
-- Customer questions on WhatsApp used to fire a Telegram ping and then vanish —
-- the text was never stored, so there was no inbox, no history, and nothing to
-- answer from twice. This is the foundation for an autonomous Gemini bot that
-- answers grounded on our own policies, and for the admin dashboard that watches
-- it. Four tables:
--
--   wa_messages          every message in and out, the audit log
--   wa_conversations     one row per customer, the inbox
--   wa_knowledge_chunks  the retrievable policy/suggestion snippets the bot reads
--   wa_support_config    the single-row brain: kill switch, persona, escalation
--
-- Phone is always the last 10 digits (normalizePhone), so a customer's messages,
-- conversation and orders all join on the same key regardless of how the number
-- was stored (+91…, 0…, spaced).

-- ── Messages ─────────────────────────────────────────────────────────────────
-- Both directions. wa_message_id is Meta's own id on inbound messages and is the
-- idempotency key: Meta retries webhooks, and without a unique guard an
-- autonomous bot would answer the same question two or three times.
create table if not exists wa_messages (
  id             uuid primary key default gen_random_uuid(),
  phone          text not null,
  direction      text not null check (direction in ('in', 'out')),
  body           text not null default '',
  -- who produced an outbound message: the bot, a human in the dashboard, or the
  -- system (an escalation acknowledgement). 'customer' for every inbound.
  source         text not null check (source in ('customer', 'ai', 'admin', 'system')),
  wa_message_id  text unique,
  tag            text,
  order_id       text,
  ai_meta        jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists wa_messages_phone_idx on wa_messages (phone, created_at);

-- ── Conversations ────────────────────────────────────────────────────────────
-- Derivable from wa_messages, kept separate so the inbox lists in one cheap query
-- and can hold state the messages do not: whether a human has taken over (the bot
-- must then stand down), whether it is escalated, whether it is unread.
create table if not exists wa_conversations (
  phone           text primary key,
  name            text,
  last_in_at      timestamptz,
  last_out_at     timestamptz,
  status          text not null default 'open'
                    check (status in ('open', 'ai_handled', 'escalated')),
  escalated       boolean not null default false,
  escalate_reason text,
  last_tag        text,
  -- A human replied from the dashboard. While true the bot does not auto-answer —
  -- two voices on one thread is worse than a slow one. Cleared by "release to AI".
  taken_over      boolean not null default false,
  unread          boolean not null default false,
  last_preview    text,
  updated_at      timestamptz not null default now()
);
create index if not exists wa_conversations_updated_idx on wa_conversations (updated_at desc);

-- ── Knowledge ────────────────────────────────────────────────────────────────
-- The bot reads these, not the whole policy corpus: each message embeds the
-- question and pulls only the few most relevant chunks. Embedding is a float
-- array in jsonb — the corpus is small enough that cosine similarity in JS beats
-- taking on a pgvector dependency. source tells a seeded policy from a
-- hand-written suggestion from one the bot learned off a good human reply.
create table if not exists wa_knowledge_chunks (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('policy', 'suggestion')),
  topic      text not null default '',
  content    text not null,
  embedding  jsonb,
  source     text not null default 'admin' check (source in ('seed', 'admin', 'learned')),
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

-- ── Config ───────────────────────────────────────────────────────────────────
-- One row (id = 1). enabled is the kill switch, deliberately in the database
-- rather than an env var so it flips without a redeploy — the one control you
-- want in the second something goes wrong. Seeded off so nothing auto-sends until
-- the knowledge has been reviewed and it is turned on by hand.
create table if not exists wa_support_config (
  id                integer primary key default 1 check (id = 1),
  enabled           boolean not null default false,
  persona           text not null default '',
  escalate_keywords jsonb not null default '[]'::jsonb,
  holding_message   text not null default
    'I''m really sorry for the trouble 🙏 I''m not able to fully resolve this myself right now — I''ve escalated it to my senior, who will get back to you shortly. Thank you for your patience.',
  updated_at        timestamptz not null default now()
);

insert into wa_support_config (id) values (1) on conflict (id) do nothing;
