-- The audit trail for Part 6 of the control-plane design: an eligibility
-- decision (can this order be cancelled, is this return within window) used to
-- exist only as a boolean returned to the caller and then forgotten. Nobody
-- could later answer "why was this return rejected three months ago" except by
-- re-running the rule against however the order looks today — which may no
-- longer be how it looked at decision time.
--
-- This does not add a new business rule. Every policy that writes here already
-- existed as real logic somewhere in the codebase (lib/supportActions.ts,
-- lib/returnPolicy.ts) — this just gives each one a version and a record.
--
-- Deliberately not used for every policy in the design doc's Part 6 table yet:
-- coupon redemption needs the coupon_redemptions ledger (Attack 5, not built),
-- COD eligibility needs a real risk_tier (Risk Engine, the next stage — wiring
-- today's static J&K-only rule in now would just be rewritten immediately
-- after), and replacement approval needs the replacements table (Attack 2, not
-- built). Refund authorization already has its own audit trail in the refunds
-- ledger's execution_status — a second row here would just duplicate it.

create table if not exists policy_decisions (
  id             uuid primary key default gen_random_uuid(),
  policy         text not null,
  -- A policy change is a new version, not an in-place edit (Part 6) — so a
  -- decision stays explained by the exact rule that produced it even after
  -- the rule is later tightened or loosened.
  policy_version integer not null default 1,
  order_id       text references orders(id),
  -- What the policy actually saw — order status, delivery date, whatever the
  -- specific policy's inputs are. Kept as the raw facts rather than only the
  -- verdict, since the verdict alone can't answer "why" once the order has
  -- moved on.
  input          jsonb not null default '{}'::jsonb,
  output         text not null,
  reason         text,
  decided_at     timestamptz not null default now()
);

create index if not exists policy_decisions_order_idx on policy_decisions (order_id);
create index if not exists policy_decisions_policy_idx on policy_decisions (policy, decided_at desc);

alter table policy_decisions enable row level security;
