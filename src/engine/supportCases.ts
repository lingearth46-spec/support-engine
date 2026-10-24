// Escalation with an owner (Part 5 of the control-plane design).
//
// One entry point per transition, so support_cases and its case_events log
// cannot drift apart the way wa_conversations and the tickets list already
// have: every write here logs what changed and why in the same call that
// changes it, rather than trusting a second piece of code to remember to.

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The short ticket reference a customer is given, derived from the case id.
 *
 * A uuid is unquotable over the phone and unreadable in a WhatsApp message, and
 * a customer who cannot name their ticket ends up re-describing the whole
 * problem instead. Six hex characters is short enough to read aloud and specific
 * enough to find: `select * from support_cases where id::text like 'a1b2c3%'`.
 *
 * Derived rather than stored, so it needs no column, no sequence and no second
 * source of truth — the same case always produces the same reference.
 */
export function ticketRef(caseId: string): string {
  return `AJK-${caseId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

export type CaseStatus = "ESCALATED" | "OWNED" | "IN_PROGRESS" | "WAITING_ON_CUSTOMER" | "RESOLVED" | "SLA_BREACHED" | "STALE";
export type CasePriority = "high" | "medium" | "low";

/**
 * The terminal states. A case in one of these is out of every queue, off the
 * digest, and no longer blocks a fresh case on the same (customer, tag).
 *
 * RESOLVED means an outcome was reached. STALE means a week passed and one
 * never was — deliberately a separate state, so "resolved" keeps meaning
 * resolved in the numbers (see supabase-migration-case-stale.sql).
 *
 * This constant exists because "still open" used to be spelled as a bare
 * not-equal against RESOLVED in eleven separate files. Adding a second
 * terminal state to eleven scattered predicates is how one gets missed; they
 * now all call closedStatusFilter().
 */
export const CLOSED_STATUSES: readonly CaseStatus[] = ["RESOLVED", "STALE"];

/** PostgREST `not.in` value for the closed states — `(RESOLVED,STALE)`. */
export const closedStatusFilter = (): string => `(${CLOSED_STATUSES.join(",")})`;

/** True when a case is in a terminal state and should not appear as live work. */
export const isCaseClosed = (status: string): boolean =>
  (CLOSED_STATUSES as readonly string[]).includes(status);

export interface SupportCase {
  id: string;
  customer_id: string;
  channel: "whatsapp" | "email";
  wa_phone: string | null;
  email_thread_id: string | null;
  tag: string;
  status: CaseStatus;
  escalate_reason: string | null;
  priority: CasePriority;
  owned_at: string | null;
  owned_by: string | null;
  sla_deadline: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  /** When the triage agent last read this case. Null = untriaged. Not ownership. */
  agent_triaged_at?: string | null;
  /** The agent's judgement. 'answerable' skips the SLA nudge — the case stays open
   *  and on the digest, it just stops interrupting. See findUnacknowledgedOverdue. */
  agent_verdict?: "needs_founder" | "answerable" | null;
}

// How long an escalation may sit un-acknowledged before the cron pins it and
// nudges. One fixed number rather than a per-case setting nobody would tune —
// see Part 15's "optimization" stage for revisiting this against real data.
const SLA_WINDOW_HOURS = 4;

// Once a founder has replied and the customer has gone quiet for this long with
// nothing new inbound, the SLA cron infers ownership of the case (ESCALATED →
// OWNED, actor 'system') so the nudge stops — it does NOT resolve it. Silence is
// not an outcome; see markOwnedByReply and the 2026-09 audit note there.
export const RESOLVE_AFTER_ADMIN_QUIET_HOURS = 24;

// How long a fresh SLA nudge suppresses the next one for the same case, so an
// overdue-and-unacknowledged case is a reminder every few hours rather than
// every ten minutes. Deduped against case_events, not a column.
export const SLA_NUDGE_EVERY_HOURS = 6;

/** Who caused a transition. 'agent' is the supervisor agent (app/api/mcp),
 *  deliberately distinct from 'bot' — one answers a customer, the other reasons
 *  about the case. Widened in supabase-migration-agent-triage.sql. */
export type CaseActor = "bot" | "admin" | "cron" | "system" | "agent";

async function logEvent(
  db: SupabaseClient,
  caseId: string,
  from: CaseStatus | null,
  to: CaseStatus,
  actor: CaseActor,
  note?: string,
): Promise<void> {
  // Never swallow this. The identical omission on delhivery_ndr_requests.outcome
  // hid a broken mechanism for months: the write failed 23514, the caller
  // discarded the error, and nobody knew until it was measured.
  const { error } = await db.from("case_events")
    .insert({ case_id: caseId, from_status: from, to_status: to, actor, note: note ?? null });
  if (error) {
    console.error(JSON.stringify({
      event: "case_event_write_failed", caseId, actor, code: error.code, message: error.message,
      hint: error.code === "23514" ? "case_events.actor CHECK may not allow this actor — see supabase-migration-agent-triage.sql" : undefined,
    }));
  }
}

/**
 * Open the case for this (customer, tag), or return the existing open one.
 *
 * Mirrors lib/waSupport.ts's own alreadyAcknowledged/last_tag check — a fresh
 * tag opens a new case, the same still-open tag returns the one already there
 * instead of forking a duplicate. Call this from the escalation path on every
 * channel; the unique index on (customer_id, tag) where the status is not a
 * terminal one is the actual guarantee, this is just the lookup-then-insert
 * around it. A STALE case does not block a new one — that is the point of
 * closing it, and why supabase-migration-case-stale.sql rebuilds that index.
 */
export async function openOrReuseCase(
  db: SupabaseClient,
  args: {
    customerId: string;
    channel: "whatsapp" | "email";
    waPhone?: string | null;
    emailThreadId?: string | null;
    tag: string;
    reason?: string | null;
    /**
     * Override the 4-hour SLA deadline.
     *
     * For a case nobody is waiting on. Proactive outreach opens one the moment
     * it messages a customer about a stuck parcel — that case needs queue
     * visibility, but the customer has not even replied yet, so letting it trip
     * findUnacknowledgedOverdue would page the founder about twenty
     * conversations a week that nobody has started.
     */
    slaHours?: number;
  },
): Promise<{ case: SupportCase; isNew: boolean }> {
  // Oldest open row, not maybeSingle(): the open-topic index keeps this to one row today, but maybeSingle() throws on
  // two, and the Customer Workspace migration widens that index to (customer, tag, issue_key). Taking the oldest
  // keeps a legacy caller (no issue key) working, and deterministic, either way.
  const { data: found, error: findError } = await db
    .from("support_cases")
    .select("*")
    .eq("customer_id", args.customerId)
    .eq("tag", args.tag)
    .not("status", "in", closedStatusFilter())
    .order("created_at", { ascending: true })
    .limit(1);
  if (findError) throw new Error(`support case lookup failed: ${findError.message}`);

  const existing = found?.[0];
  if (existing) return { case: existing as SupportCase, isNew: false };

  const slaDeadline = new Date(Date.now() + (args.slaHours ?? SLA_WINDOW_HOURS) * 3600_000).toISOString();
  const { data: created, error: createError } = await db
    .from("support_cases")
    .insert({
      customer_id: args.customerId,
      channel: args.channel,
      wa_phone: args.channel === "whatsapp" ? args.waPhone : null,
      email_thread_id: args.channel === "email" ? args.emailThreadId : null,
      tag: args.tag,
      status: "ESCALATED",
      escalate_reason: args.reason ?? null,
      sla_deadline: slaDeadline,
    })
    .select("*")
    .single();
  // A concurrent request may have created the same (customer, tag) case
  // between the lookup above and this insert — the unique index rejects the
  // second writer, who then re-reads and gets the winner's row rather than
  // erroring the customer's message into a failed reply.
  if (createError) {
    if (createError.code === "23505") {
      const { data: winner } = await db.from("support_cases")
        .select("*").eq("customer_id", args.customerId).eq("tag", args.tag).not("status", "in", closedStatusFilter()).single();
      if (winner) return { case: winner as SupportCase, isNew: false };
    }
    throw new Error(`support case creation failed: ${createError.message}`);
  }

  await logEvent(db, created.id, null, "ESCALATED", "bot", args.reason ?? undefined);
  return { case: created as SupportCase, isNew: true };
}

/**
 * Move a case from whatever state it is in to `to` — atomically with respect to other writers.
 *
 * The transitions used to read the status, then update unconditionally, then log the status they had read. Two writers
 * (two admins, or an admin and the SLA cron) could both read IN_PROGRESS, both write, and leave a final state and an event
 * history that disagree. Now the update carries the status that was read as a condition (`... where status = <read>`), so
 * if someone else moved the case in between, zero rows change: this writer re-reads and decides again against the new
 * state, and the event it logs always describes the transition that actually happened. Three attempts, then it gives up
 * quietly — a contended case is by definition being handled.
 *
 * Returns true when this call made the change.
 */
async function transition(
  db: SupabaseClient,
  caseId: string,
  spec: {
    skip: (cur: { status: CaseStatus; owned_at: string | null }) => boolean;
    to: CaseStatus;
    patch?: () => Record<string, unknown>;
    actor: CaseActor;
    note?: string;
    failMsg: string;
  },
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: current, error: readError } = await db.from("support_cases").select("status, owned_at").eq("id", caseId).single();
    if (readError) throw new Error(`case read failed: ${readError.message}`);
    const cur = current as { status: CaseStatus; owned_at: string | null };
    if (spec.skip(cur)) return false;
    const { data: updated, error } = await db.from("support_cases")
      .update({ status: spec.to, ...(spec.patch ? spec.patch() : {}), updated_at: new Date().toISOString() })
      .eq("id", caseId)
      .eq("status", cur.status)
      .select("id");
    if (error) throw new Error(`${spec.failMsg}: ${error.message}`);
    if (updated && updated.length === 1) {
      await logEvent(db, caseId, cur.status, spec.to, spec.actor, spec.note);
      return true;
    }
    // Somebody else moved the case between our read and our write. Read again.
  }
  console.warn(JSON.stringify({ event: "case_transition_contended", caseId, to: spec.to }));
  return false;
}

/**
 * The founder replied to the customer on the thread but never pressed
 * Acknowledge in the panel — infer the acknowledgement from the reply.
 *
 * This is what the SLA cron does now instead of resolving a case the moment a
 * reply lands and the thread goes quiet. A reply is not an outcome: the case
 * leaves ESCALATED (so the nudge stops firing at someone who has demonstrably
 * seen it) but stays open and on the digest until a real outcome is recorded —
 * a refund settled, a replacement shipped, the customer confirming, or the
 * founder resolving it by hand.
 *
 * Only ever ESCALATED → OWNED, and only when owned_at is still null; every other
 * state already means a person has engaged.
 */
export async function markOwnedByReply(db: SupabaseClient, caseId: string): Promise<void> {
  await transition(db, caseId, {
    skip: (cur) => cur.status !== "ESCALATED" || !!cur.owned_at,
    to: "OWNED",
    patch: () => ({ owned_at: new Date().toISOString(), owned_by: "system:replied-on-thread" }),
    actor: "system", note: "founder replied on the thread; not resolved", failMsg: "case infer-ownership failed",
  });
}

/** A founder acknowledging the case exists — the OWNED transition that today
 *  has no equivalent anywhere in the codebase. */
export async function acknowledgeCase(db: SupabaseClient, caseId: string, ownedBy: string): Promise<void> {
  await transition(db, caseId, {
    // Closed means RESOLVED *or* STALE. A STALE case revived here would sit open beside a fresh case on the same
    // (customer, tag) — the open-topic index treats STALE as closed, so it would not stop them.
    skip: (cur) => isCaseClosed(cur.status),
    to: "OWNED",
    patch: () => ({ owned_at: new Date().toISOString(), owned_by: ownedBy }),
    actor: "admin", failMsg: "case acknowledge failed",
  });
}

/**
 * Recording what was done moves a case forward even if nobody clicked
 * Acknowledge first — typing an action is itself proof someone has looked.
 * Safe from any non-resolved state: this only needs to matter for the SLA
 * cron, and that cron only ever looks at status === 'ESCALATED', so leaving
 * that state at all — by whichever route — is what stops a breach alert.
 */
export async function markInProgress(db: SupabaseClient, caseId: string): Promise<void> {
  await transition(db, caseId, {
    skip: (cur) => isCaseClosed(cur.status) || cur.status === "IN_PROGRESS",
    to: "IN_PROGRESS", actor: "admin", failMsg: "case in-progress update failed",
  });
}

/** The ball is in the customer's court, not ours — a distinct state from
 *  IN_PROGRESS so a founder scanning the queue can tell "I'm waiting to hear
 *  back" apart from "I still need to act on this." */
export async function markWaitingOnCustomer(db: SupabaseClient, caseId: string): Promise<void> {
  await transition(db, caseId, {
    skip: (cur) => isCaseClosed(cur.status) || cur.status === "WAITING_ON_CUSTOMER",
    to: "WAITING_ON_CUSTOMER", actor: "admin", failMsg: "case waiting-on-customer update failed",
  });
}

export async function resolveCase(
  db: SupabaseClient,
  caseId: string,
  actor: "admin" | "system" | "agent",
  note?: string,
): Promise<void> {
  await transition(db, caseId, {
    skip: (cur) => cur.status === "RESOLVED",
    to: "RESOLVED",
    patch: () => ({ resolved_at: new Date().toISOString() }),
    actor, note, failMsg: "case resolve failed",
  });
}

/**
 * How old a case gets before it is closed as STALE rather than carried
 * forever. A week: past that, in this business, the customer has moved on —
 * they have been refunded by hand, charged back, re-ordered, or given up — and
 * the row is a queue entry describing a conversation that ended days ago.
 */
export const STALE_AFTER_DAYS = 7;

/**
 * ...but only if nothing has happened on the thread recently. A case opened
 * nine days ago that both sides were messaging yesterday is slow, not dead —
 * a return pickup or a replacement genuinely takes that long. Closing it would
 * hide live work from every queue at once, which is worse than carrying it.
 */
export const STALE_REQUIRES_QUIET_HOURS = 48;

/**
 * Close a case that has aged out without an outcome.
 *
 * Deliberately NOT resolveCase: this records that we stopped, not that we
 * finished. `resolved_at` is left null for the same reason.
 */
export async function markCaseStale(
  db: SupabaseClient,
  caseId: string,
  note?: string,
): Promise<void> {
  // Surfaced, not swallowed. If supabase-migration-case-stale.sql has not been applied this throws 23514 here
  // rather than failing silently the way the deferred_retry write did for months.
  await transition(db, caseId, {
    skip: (cur) => isCaseClosed(cur.status),
    to: "STALE", actor: "cron", note, failMsg: "case stale-close failed",
  });
}

/**
 * Every case still in play — anything not in a terminal state.
 *
 * The SLA cron walks this set: for each, it either auto-resolves (a founder
 * replied and the customer has gone quiet past
 * RESOLVE_AFTER_ADMIN_QUIET_HOURS), closes it STALE once it ages past
 * STALE_AFTER_DAYS, or leaves it. SLA_BREACHED is retired as a terminal state —
 * the backfill (scripts/backfill-support-cases.mts) walks any that remain back
 * to ESCALATED — but is still selected here so a leftover row is not stranded.
 */
export async function findOpenCases(db: SupabaseClient): Promise<SupportCase[]> {
  const { data, error } = await db.from("support_cases")
    .select("*")
    .not("status", "in", closedStatusFilter())
    .order("created_at", { ascending: true });
  if (error) throw new Error(`open-case scan failed: ${error.message}`);
  return (data ?? []) as SupportCase[];
}

/**
 * Escalations past their SLA deadline that nobody has acknowledged.
 *
 * The cron pins these to the top of the queue (a derived property — no status
 * write) and sends a nudge, deduped to once per SLA_NUDGE_EVERY_HOURS. This is
 * the specific gap Phase 2B measured: 104 escalated, 3 ever taken over. Includes
 * the retired SLA_BREACHED status so a pre-backfill deploy still nudges those.
 */
export async function findUnacknowledgedOverdue(db: SupabaseClient): Promise<SupportCase[]> {
  const { data, error } = await db.from("support_cases")
    .select("*")
    .in("status", ["ESCALATED", "SLA_BREACHED"])
    .is("owned_at", null)
    .lt("sla_deadline", new Date().toISOString())
    // A case the triage agent has read and judged answerable does not nudge.
    // It is NOT resolved, closed or hidden — it stays ESCALATED, stays in the
    // queue, and still appears on the daily digest. It simply stops
    // interrupting, because the answer is already sitting on its timeline and
    // someone need only relay it.
    //
    // On the first live triage run (2026-09-11) four of six escalations were
    // already resolved and the customer had merely never been told: delivered,
    // cancelled, an admin-negotiated colour swap, an auto-raised return. All
    // four would otherwise have buzzed a phone every six hours indefinitely.
    //
    // The failure modes are deliberately asymmetric. A wrong 'answerable' costs
    // hours — the case waits for the digest. A nudge nobody needed costs
    // attention every six hours, forever, which is the thing this system exists
    // to protect.
    .or("agent_verdict.is.null,agent_verdict.eq.needs_founder")
    .order("sla_deadline", { ascending: true });
  if (error) throw new Error(`overdue-case scan failed: ${error.message}`);
  return (data ?? []) as SupportCase[];
}

/**
 * Cases the agent judged answerable that are still open — quiet, but not gone.
 *
 * findUnacknowledgedOverdue deliberately skips these so they stop interrupting.
 * This is the other half of that bargain: the daily digest reads them, so a case
 * the agent got wrong surfaces within a day instead of never.
 */
export async function findQuietedCases(db: SupabaseClient): Promise<SupportCase[]> {
  const { data, error } = await db.from("support_cases")
    .select("*")
    .in("status", ["ESCALATED", "SLA_BREACHED"])
    .is("owned_at", null)
    .eq("agent_verdict", "answerable")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`quieted-case scan failed: ${error.message}`);
  return (data ?? []) as SupportCase[];
}

/** Has the cron already nudged this case within the last `hours`? Deduped via
 *  case_events rather than a column — a nudge changes nothing on the row. */
export async function nudgedRecently(db: SupabaseClient, caseId: string, hours: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await db.from("case_events")
    .select("id")
    .eq("case_id", caseId)
    .eq("actor", "cron")
    .eq("note", "sla-nudge")
    .gte("created_at", cutoff)
    .limit(1);
  if (error) throw new Error(`nudge-history read failed: ${error.message}`);
  return Boolean(data?.length);
}

/** Record that a nudge went out. No status transition — from_status is null and
 *  to_status repeats the current ESCALATED purely to satisfy the NOT NULL
 *  column; `note` is what nudgedRecently keys on. */
export async function recordCaseNudge(db: SupabaseClient, caseId: string): Promise<void> {
  await logEvent(db, caseId, null, "ESCALATED", "cron", "sla-nudge");
}
