// What the reply assistant is allowed to know, and what it is allowed to say.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// The Rewrite button has always been deliberately ignorant: it got the draft,
// the customer's name and six lines of chat, and nothing else. That made it
// safe (it cannot state a fact it was never given) and nearly useless (it
// cannot tell that "your parcel arrives tomorrow" is being written about an
// order that went RTO five days ago).
//
// Giving it the order data fixes the second problem and creates a worse one:
// a model that knows the AWB will happily write an AWB, and one digit wrong in
// a tracking number is a customer who spends an afternoon on a courier website
// that says "not found". The prompt says "copy them character for character",
// which is an instruction, not a guarantee.
//
// So the rule here is not "ask the model nicely". It is arithmetic:
//
//   every identifier in the output must already appear in the input.
//
// The input is the agent's own draft plus the context block below plus the
// retrieved policy text. Anything else is not a fact the assistant was given,
// which makes it a fact the assistant made up, whatever it looks like.
//
// Pure. No database, no fetch — the route fetches, this decides what may be
// said about what was fetched.

// ── The context block ───────────────────────────────────────────────────────

/**
 * The order fields the assistant reads. A structural subset of
 * waSupport's OrderPanelRow, declared here so this file imports nothing and
 * the tests need not build a database row.
 */
export interface ContextOrder {
  id: string;
  status?: string | null;
  items?: Array<{ name?: string; color?: string; size?: string; quantity?: number; price?: number }> | null;
  total?: number | null;
  amount_paid_online?: number | null;
  cod_due?: number | null;
  awb_code?: string | null;
  courier_name?: string | null;
  tracking_url?: string | null;
  estimated_delivery?: string | null;
  delivered_at?: string | null;
  created_at?: string | null;
  attempt_count?: number | null;
  ndr_reason?: string | null;
  rto_reason?: string | null;
  shipping_method?: string | null;
}

export interface ContextCase {
  tag?: string | null;
  status?: string | null;
  escalate_reason?: string | null;
  created_at?: string | null;
}

export interface AssistContext {
  /** How we address them is fixed (see EMAIL_GREETING) — this is for the model's
   *  own understanding, never to be written into the reply. */
  customerLabel: string;
  orders: ContextOrder[];
  cases: ContextCase[];
  /** Retrieved policy text. Facts here may be stated. */
  knowledge: string[];
}

/** The only tracking link a customer is ever given. Ours, never the courier's. */
export const TRACK_URL = "https://www.ajuki.in/track";

/** "26 Sep 2026" — one spelling of a date, used everywhere the model can see one,
 *  so that what it copies back is what the guard below is looking for. */
export function day(value?: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Money as the reply would write it: ₹699, never ₹699.00 and never 699. */
export function money(value?: number | null): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `₹${Math.round(value)}`;
}

/**
 * One order, as the model reads it.
 *
 * Deliberately not JSON. A model handed JSON copies the key names into prose
 * ("your order has status rto") and invents plausible values for keys it half
 * remembers. Lines of plain English, with every value in the exact spelling the
 * reply should use, give it less room to improvise and give the guard below an
 * exact string to match.
 */
export function orderLine(o: ContextOrder): string {
  const bits: string[] = [`Order ${o.id}`];
  if (o.status) bits.push(`status: ${o.status}`);
  const placed = day(o.created_at);
  if (placed) bits.push(`placed ${placed}`);

  const items = (o.items ?? [])
    .map((i) => [i.name, i.color, i.size].filter(Boolean).join(" ") + (i.quantity && i.quantity > 1 ? ` x${i.quantity}` : ""))
    .filter((s) => s.trim());
  if (items.length) bits.push(`items: ${items.join(", ")}`);

  const total = money(o.total);
  if (total) bits.push(`total ${total}`);
  const cod = money(o.cod_due);
  if (cod && (o.cod_due ?? 0) > 0) bits.push(`COD due ${cod}`);
  const paid = money(o.amount_paid_online);
  if (paid && (o.amount_paid_online ?? 0) > 0) bits.push(`paid online ${paid}`);

  if (o.courier_name) bits.push(`courier ${o.courier_name}`);
  if (o.awb_code) bits.push(`AWB ${o.awb_code}`);
  // NOT o.tracking_url. The courier's own page is the wrong thing to send a
  // customer: it is branded as someone else, it says "not found" for the first
  // day after booking, and it shows raw scan text that reads as alarming. We
  // have our own page for exactly this. Withholding the courier link also makes
  // the guard do the work — a courier URL in a reply now matches nothing in the
  // context and is refused as an invention, rather than relying on the model to
  // remember a rule.
  if (o.awb_code) bits.push(`track at ${TRACK_URL}`);

  const eta = day(o.estimated_delivery);
  if (eta) bits.push(`expected ${eta}`);
  const got = day(o.delivered_at);
  if (got) bits.push(`delivered ${got}`);

  if (o.attempt_count) bits.push(`${o.attempt_count} delivery attempt(s)`);
  if (o.ndr_reason) bits.push(`last delivery failure: ${o.ndr_reason}`);
  if (o.rto_reason) bits.push(`returned to us because: ${o.rto_reason}`);

  return bits.join(" · ");
}

/**
 * Everything the assistant knows, in the order it matters.
 *
 * The header lines are not decoration. A model given a wall of facts with no
 * frame treats all of them as equally sayable; the ORDERS header plus the
 * explicit "do not state anything that is not here" is what makes the later
 * refusal behaviour legible to it.
 */
export function buildContextBlock(ctx: AssistContext): string {
  const parts: string[] = [];

  parts.push(`=== CUSTOMER ===\n${ctx.customerLabel}`);

  if (ctx.orders.length) {
    parts.push(`=== THEIR ORDERS (newest first) ===\n${ctx.orders.map(orderLine).join("\n")}`);
  } else {
    parts.push(`=== THEIR ORDERS ===\nNo orders found for this address. Do not guess at one.`);
  }

  if (ctx.cases.length) {
    const lines = ctx.cases.map((c) => {
      const raised = day(c.created_at);
      return `"${c.tag ?? "issue"}"${raised ? ` raised ${raised}` : ""}${c.escalate_reason ? ` — ${c.escalate_reason}` : ""}`;
    });
    parts.push(
      `=== ALREADY WITH THE TEAM ===\n${lines.join("\n")}\n` +
      `If they are chasing this, say it is with the team and give that date. Do not treat it as new.`,
    );
  }

  if (ctx.knowledge.length) {
    parts.push(`=== POLICY (you may state these) ===\n${ctx.knowledge.join("\n\n")}`);
  }

  return parts.join("\n\n");
}

// ── The guard ───────────────────────────────────────────────────────────────

/**
 * Identifiers the guard tracks, split by how badly a wrong one hurts.
 *
 * `hard` blocks the reply outright. Each of these is something the customer
 * will act on — paste into a courier site, check against their bank statement,
 * dial. Wrong is worse than absent.
 *
 * `soft` warns instead. Dates are written a dozen ways ("tomorrow", "by the
 * 26th", "early next week") and no normaliser catches them all; blocking on a
 * date means blocking good replies, and a feature that refuses good work stops
 * being pressed. The date is shown to the agent to check instead.
 */
export interface Facts {
  orderIds: string[];
  awbs: string[];
  amounts: string[];
  urls: string[];
  phones: string[];
  dates: string[];
}

const MONTH_RE = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Pull every checkable identifier out of a piece of text.
 *
 * Normalised on the way out, because the two sides of the comparison are
 * written by different authors: the context block says "AWB 60000000000008"
 * and the model writes "AWB: 6000 0000 000008", which is the same number and
 * must not read as an invention.
 */
export function extractFacts(text: string): Facts {
  const t = text ?? "";

  const orderIds = uniq((t.toUpperCase().match(/AJUKI\s*\d{4,}/g) ?? []).map((s) => s.replace(/\s+/g, "")));

  // Indian mobiles, with or without the country code. Taken BEFORE the AWB
  // sweep, which matches any run of nine digits or more and would otherwise
  // swallow every 10-digit number on the page.
  const phones = uniq(
    (t.match(/(?:\+?91[\s-]?)?[6-9]\d{9}\b/g) ?? []).map((s) => s.replace(/\D/g, "").slice(-10)),
  );

  // Nine digits or more, spaces and dashes ignored. Shorter runs are pincodes
  // and amounts, which have their own buckets. A value already read as a mobile
  // is left to that bucket — checkFacts cross-checks the two, so a number the
  // two sides bucket differently never reads as an invention.
  const awbs = uniq(
    (t.match(/\b[\d][\d\s-]{8,}\d\b/g) ?? [])
      .map((s) => s.replace(/[\s-]/g, ""))
      .filter((s) => s.length >= 9 && s.length <= 20),
  ).filter((a) => !phones.includes(a));

  // ₹ or Rs, then the number. Trailing .00 dropped so ₹699 and ₹699.00 match.
  const amounts = uniq(
    // The number is captured, not sliced off afterwards: stripping non-digits
    // from "Rs. 699" leaves ".699", which rounds to 1.
    [...t.matchAll(/(?:₹|\bRs\.?|\bINR)\s*([\d,]+(?:\.\d{1,2})?)/gi)]
      .map((m) => String(Math.round(Number(m[1].replace(/,/g, "")))))
      .filter((s) => s !== "NaN" && s !== "0"),
  );

  const urls = uniq(
    (t.match(/https?:\/\/[^\s<>()"']+/gi) ?? []).map((s) => s.replace(/[.,;:)\]]+$/, "").toLowerCase()),
  );

  const dates = uniq([
    ...(t.match(new RegExp(`\\b\\d{1,2}\\s*(?:${MONTH_RE})[a-z]*\\b`, "gi")) ?? []),
    ...(t.match(new RegExp(`\\b(?:${MONTH_RE})[a-z]*\\s*\\d{1,2}\\b`, "gi")) ?? []),
    ...(t.match(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g) ?? []),
  ].map(normalizeDate));

  return { orderIds, awbs, amounts, urls, phones, dates };
}

/** "26 Sep", "Sep 26", "26/09/2026" → "09-26". Year is dropped: nobody writes it
 *  in a support reply, and a date is only ever about the next few weeks. */
export function normalizeDate(raw: string): string {
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const s = raw.toLowerCase().trim();

  const named = s.match(new RegExp(`^(\\d{1,2})\\s*(${MONTH_RE})`)) ?? null;
  if (named) return `${String(MONTHS.indexOf(named[2]) + 1).padStart(2, "0")}-${named[1].padStart(2, "0")}`;

  const flipped = s.match(new RegExp(`^(${MONTH_RE})[a-z]*\\s*(\\d{1,2})`)) ?? null;
  if (flipped) return `${String(MONTHS.indexOf(flipped[1]) + 1).padStart(2, "0")}-${flipped[2].padStart(2, "0")}`;

  const numeric = s.match(/^(\d{1,2})[/-](\d{1,2})/) ?? null;
  // Day first: Indian convention, and every date the panel renders is dd/mm.
  if (numeric) return `${numeric[2].padStart(2, "0")}-${numeric[1].padStart(2, "0")}`;

  return s;
}

export interface FactCheck {
  /** Identifiers in the reply that were nowhere in what the model was given.
   *  Non-empty means the reply must not be offered as-is. */
  invented: { kind: "order" | "awb" | "amount" | "link" | "phone"; value: string }[];
  /** Dates the reply states that were not in the context. Shown, not blocked. */
  unverifiedDates: string[];
  ok: boolean;
}

/**
 * Does the reply say anything it was not told?
 *
 * `allowed` is every piece of text the model could legitimately have copied
 * from: the agent's own draft, the context block, the retrieved policy. An
 * identifier absent from all of them was produced by the model, and the only
 * honest description of that is an invention — even when it happens to be
 * right, which it will be most of the time, which is exactly what makes it
 * dangerous to wave through.
 */
export function checkFacts(reply: string, allowed: string[]): FactCheck {
  const corpus = allowed.join("\n\n");
  const said = extractFacts(reply);
  const known = extractFacts(corpus);

  // Every bare run of digits in what the model was given. A founder who types
  // "we are sending 1500 back" has stated the amount; that it carries no rupee
  // sign is punctuation, not doubt. Used only to widen what counts as already
  // known — never to decide that something in the reply is checkable.
  const digitRuns = new Set(
    (corpus.match(/\d[\d,]*(?:\.\d{1,2})?/g) ?? []).map((n) => String(Math.round(Number(n.replace(/,/g, ""))))),
  );

  const invented: FactCheck["invented"] = [];
  const miss = (kind: FactCheck["invented"][number]["kind"], said_: string[], known_: string[]) => {
    for (const v of said_) if (!known_.includes(v)) invented.push({ kind, value: v });
  };

  miss("order", said.orderIds, known.orderIds);
  // An AWB is checked against the known AWBs and also the known phone numbers
  // and amounts, because the same digits can be bucketed differently on the two
  // sides depending on the punctuation around them.
  miss("awb", said.awbs, [...known.awbs, ...known.phones, ...known.amounts, ...digitRuns]);
  miss("amount", said.amounts, [...known.amounts, ...known.awbs, ...digitRuns]);
  miss("link", said.urls, known.urls);
  miss("phone", said.phones, [...known.phones, ...known.awbs, ...digitRuns]);

  const unverifiedDates = said.dates.filter((d) => !known.dates.includes(d));

  return { invented, unverifiedDates, ok: invented.length === 0 };
}

// ── Contradictions ──────────────────────────────────────────────────────────

/** An order that has stopped moving. Nothing further is coming to the door. */
export const SETTLED_STATUSES: readonly string[] = ["delivered", "rto", "returned", "cancelled", "refunded", "rto_delivered"];

/** Language that tells a customer a parcel is still on its way to them. */
const ARRIVING = [
  /\bout for delivery\b/i,
  /\bwill (?:reach|arrive|be delivered|be with)\b/i,
  /\b(?:is|are) (?:on (?:its|their) way|arriving|coming)\b/i,
  /\bshould (?:reach|arrive|be with)\b/i,
  /\bdeliver(?:ed|y)? (?:by|on|tomorrow|today)\b/i,
  /\bexpect(?:ed)? (?:by|on|delivery)\b/i,
];

/**
 * Is the reply telling them a parcel is coming when no parcel is coming?
 *
 * Checked in code rather than asked of the model. The model was given this rule
 * and, handed "ur parcel is out for delivery and will reach u tomorrow morning
 * for sure" against an order that had already finished, returned it polished
 * and raised no concern at all — which is the exact shape of the failure this
 * whole feature has to survive: fluent, confident and wrong.
 *
 * Deliberately one-sided. It fires only when EVERY order in the context has
 * stopped moving, so a customer with one delivered order and one in transit
 * never trips it. A warning, not a block: the agent may know something the
 * orders table does not, and it is still their message.
 */
export function contradictions(reply: string, orders: ContextOrder[]): string[] {
  if (!orders.length) return [];
  if (!ARRIVING.some((re) => re.test(reply))) return [];

  const moving = orders.filter((o) => !SETTLED_STATUSES.includes(String(o.status ?? "").toLowerCase()));
  if (moving.length) return [];

  const newest = orders[0];
  const what = String(newest.status ?? "closed").replace(/_/g, " ");
  const when = day(newest.delivered_at) ?? day(newest.created_at);
  return [
    `This says a delivery is still coming, but ${newest.id} is marked "${what}"` +
    `${when ? ` (${when})` : ""}. Check before sending.`,
  ];
}

// ── Promises ────────────────────────────────────────────────────────────────

/**
 * Words that commit AJUKI to spending money.
 *
 * The founder decides these, always — it is the first rule in the charter and
 * the reason the bot escalates rather than settling. A drafted reply that
 * contains one of these and was not simply repeating something already recorded
 * in the context is the assistant making a decision that is not its to make,
 * and it is refused rather than shown, because a refusal gets read and a
 * plausible draft gets sent.
 */
export const PROMISE_PATTERNS: readonly RegExp[] = [
  /\brefund(ing|ed|s)?\b/i,
  /\breplace(ment|d|ing)?\b/i,
  /\bcompensat(e|ion|ing|ed)\b/i,
  /\bdiscount(ed|ing|s)?\b/i,
  /\bcoupon\b/i,
  /\bvoucher\b/i,
  /\bcashback\b/i,
  /\bwaive(d|r|s)?\b/i,
  /\bfree of (charge|cost)\b/i,
  /\bat no (charge|cost)\b/i,
  /\bstore credit\b/i,
  /\bwallet credit\b/i,
];

/** Which promise words a reply contains that the context did not already make. */
export function unbackedPromises(reply: string, allowed: string[]): string[] {
  const corpus = allowed.join("\n\n");
  const found: string[] = [];
  for (const re of PROMISE_PATTERNS) {
    const hit = reply.match(re);
    if (!hit) continue;
    // Already on the record — repeating a refund we have actually logged is
    // reporting, not deciding.
    if (re.test(corpus)) continue;
    found.push(hit[0].toLowerCase());
  }
  return [...new Set(found)];
}
