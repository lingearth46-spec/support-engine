// The one place that decides "is this the same customer as before."
//
// Generalizes the exact-match rule orderOwnership.ts already proved for orders
// (phone, altPhone, email — never a confidence score) into something WhatsApp,
// email and orders can all call, so a customer built from three siloed channels
// becomes one row with a set of identifiers instead of three strangers.
//
// A near-match that doesn't clear the exact-match bar is never merged
// automatically — it is written to customers.possible_duplicates for a human to
// resolve, because a wrong merge here can expose one customer's order and
// refund history to another.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";

export type IdentifierKind = "phone" | "email";

export type IdentifierInput = {
  kind: IdentifierKind;
  value: string | null | undefined;
  /** OTP-verified phone, or an email tied to a signed-in Supabase account. */
  verified?: boolean;
};

export type IdentityResult = {
  customerId: string;
  /** True when the given identifiers pointed at more than one existing
   *  customer — the collision is recorded, not silently resolved. */
  conflicted: boolean;
};

function normalizeValue(kind: IdentifierKind, value: string | null | undefined): string {
  if (kind === "phone") return normalizePhone(value);
  return String(value ?? "").trim().toLowerCase();
}

/** Dedupe by (kind, value); if the same value shows up both verified and
 *  unverified, verified wins. */
function dedupe(inputs: IdentifierInput[]): Map<string, { kind: IdentifierKind; value: string; verified: boolean }> {
  const out = new Map<string, { kind: IdentifierKind; value: string; verified: boolean }>();
  for (const input of inputs) {
    const value = normalizeValue(input.kind, input.value);
    if (input.kind === "phone" ? value.length !== 10 : !value) continue;
    const key = `${input.kind}:${value}`;
    const existing = out.get(key);
    out.set(key, { kind: input.kind, value, verified: Boolean(input.verified) || Boolean(existing?.verified) });
  }
  return out;
}

/**
 * Look up or create the customer these identifiers belong to, attaching any of
 * them that are new to the resolved customer.
 *
 * Returns null only when no usable identifier was given (e.g. a guest thread
 * with no phone and no email yet) — there is nothing to key a customer on.
 */
export async function getOrCreateCustomer(
  db: SupabaseClient,
  identifiers: IdentifierInput[],
): Promise<IdentityResult | null> {
  const wanted = [...dedupe(identifiers).values()];
  if (!wanted.length) return null;

  const { data: existingRows, error: lookupError } = await db
    .from("customer_identifiers")
    .select("customer_id, kind, value, verified")
    .in("kind", [...new Set(wanted.map((w) => w.kind))])
    .in("value", wanted.map((w) => w.value));
  if (lookupError) throw new Error(`customer identity lookup failed: ${lookupError.message}`);

  const matches = (existingRows ?? []).filter((r) =>
    wanted.some((w) => w.kind === r.kind && w.value === r.value));
  const distinctCustomerIds = [...new Set(matches.map((m) => m.customer_id))];

  // Nobody on file yet — a fresh customer, all given identifiers attached.
  if (!distinctCustomerIds.length) {
    const { data: created, error: createError } = await db
      .from("customers").insert({}).select("id").single();
    if (createError) throw new Error(`customer creation failed: ${createError.message}`);
    await attachIdentifiers(db, created.id, wanted);
    return { customerId: created.id, conflicted: false };
  }

  // Every identifier that already existed points at the same customer — the
  // ordinary case. Attach whichever of the given identifiers are new to them.
  if (distinctCustomerIds.length === 1) {
    const customerId = distinctCustomerIds[0];
    const already = new Set(matches.map((m) => `${m.kind}:${m.value}`));
    const fresh = wanted.filter((w) => !already.has(`${w.kind}:${w.value}`));
    if (fresh.length) await attachIdentifiers(db, customerId, fresh);
    return { customerId, conflicted: false };
  }

  // Collision: these identifiers belong to more than one existing customer —
  // e.g. a phone already on customer A and an email already on customer B.
  // Pick a primary (verified beats unverified; phone beats email as the
  // codebase's own "phone is the dominant identity" finding argues; earliest
  // customer wins any remaining tie) and record the rest as a duplicate to
  // review, rather than moving an identifier between customers.
  const rank = (id: string) => {
    const row = matches.find((m) => m.customer_id === id);
    const verifiedRank = row?.verified ? 0 : 1;
    const kindRank = row?.kind === "phone" ? 0 : 1;
    return [verifiedRank, kindRank, id] as const;
  };
  const primary = [...distinctCustomerIds].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : 1);
  })[0];

  const already = new Set(matches.filter((m) => m.customer_id === primary).map((m) => `${m.kind}:${m.value}`));
  const fresh = wanted.filter((w) => !already.has(`${w.kind}:${w.value}`) &&
    !matches.some((m) => m.kind === w.kind && m.value === w.value)); // truly unclaimed
  if (fresh.length) await attachIdentifiers(db, primary, fresh);

  const conflicting = matches.filter((m) => m.customer_id !== primary);
  if (conflicting.length) {
    await recordPossibleDuplicate(db, primary, conflicting.map((m) => ({
      kind: m.kind, value: m.value, other_customer_id: m.customer_id,
    })));
  }

  return { customerId: primary, conflicted: true };
}

async function attachIdentifiers(
  db: SupabaseClient,
  customerId: string,
  identifiers: Array<{ kind: IdentifierKind; value: string; verified: boolean }>,
): Promise<void> {
  const { error } = await db.from("customer_identifiers").upsert(
    identifiers.map((i) => ({ customer_id: customerId, kind: i.kind, value: i.value, verified: i.verified })),
    // A race with another request attaching the same identifier at the same
    // moment loses harmlessly here rather than throwing.
    { onConflict: "kind,value", ignoreDuplicates: true },
  );
  if (error) throw new Error(`attaching customer identifier failed: ${error.message}`);
}

async function recordPossibleDuplicate(
  db: SupabaseClient,
  customerId: string,
  entries: Array<{ kind: IdentifierKind; value: string; other_customer_id: string }>,
): Promise<void> {
  const { data } = await db.from("customers").select("possible_duplicates").eq("id", customerId).single();
  const existing: unknown[] = Array.isArray(data?.possible_duplicates) ? data!.possible_duplicates : [];
  const seen_at = new Date().toISOString();
  await db.from("customers").update({
    possible_duplicates: [...existing, ...entries.map((e) => ({ ...e, seen_at }))],
  }).eq("id", customerId);
}

/** Convenience wrapper for the common case: a phone, maybe an altPhone, maybe
 *  an email, exactly the shape orders and support threads already carry. */
export async function resolveCustomer(
  db: SupabaseClient,
  contact: { phone?: string | null; altPhone?: string | null; email?: string | null; verifiedPhone?: boolean; verifiedEmail?: boolean },
): Promise<string | null> {
  const identifiers: IdentifierInput[] = [];
  if (contact.phone) identifiers.push({ kind: "phone", value: contact.phone, verified: contact.verifiedPhone });
  if (contact.altPhone) identifiers.push({ kind: "phone", value: contact.altPhone, verified: contact.verifiedPhone });
  if (contact.email) identifiers.push({ kind: "email", value: contact.email, verified: contact.verifiedEmail });
  const result = await getOrCreateCustomer(db, identifiers);
  return result?.customerId ?? null;
}
