// Which order is this message about — so a fixed reply is decided from THAT order and no other.
//
// The fixed-wording overrides (lib/cancelStateReply.ts, returnStateReply.ts, lateDeliveryReply.ts, topicReplies.ts) all took every
// order the customer has and asked "is any of them …". That is right for someone with one order and wrong for someone with five.
// 10 Oct, AJUKI710005: the customer wrote "my cancelled order #AJUKI710005 … I still haven't received my refund". They also had
// three shipped parcels, so the cancel override saw a booked one and answered "Orders cannot be cancelled once they have been
// dispatched" — to a refund question about an order that was already cancelled. The named order's status was inferred from
// other orders.
//
// Resolution order, first that applies:
//   1. message    An order id in THIS message. The orders named, in order of appearance. If an id is named but is not one we have
//                 (not theirs, not found), the scope is empty: nothing may be inferred from their other orders.
//   2. thread     The most recent order id in the last turns, either side. The bot names the order it is talking about, so "I don't
//                 want" after "Order #AJUKI710073 was placed on 9 Oct" is about that order.
//   3. single     They have exactly one order.
//   4. all        They have several, all in the same state (every one settled, or every one still live): any is as good as another.
//   5. ambiguous  They have several in different states and nothing names one. Scope is EMPTY: the overrides stand down and the
//                 model, which sees every order, asks which one they mean.
//
// An empty scope means "do not apply a fixed reply that depends on an order's state". It never means "refuse". Pure, so every rule
// is unit-tested.

export type ScopeBasis = "message" | "thread" | "single" | "all" | "unknown_named" | "ambiguous" | "none";

const ID_RE = /\bAJUKI\d{4,10}\b/gi;

/** Order ids in `text`, upper-cased, first appearance first, no repeats. */
export function orderIdsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(ID_RE)) {
    const id = m[0].toUpperCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const SETTLED = new Set(["delivered", "cancelled", "wa_cancelled", "returned", "rto"]);
const isSettled = (status: string) => SETTLED.has(status);

export type ScopeResult<T> = { orders: T[]; basis: ScopeBasis; ids: string[] };

export function scopeOrders<T extends { id: string; status: string }>(o: {
  message: string;
  /** Recent turns, oldest first, WITHOUT the message being answered. */
  recent: { direction: "in" | "out"; body: string }[];
  own: T[];
  /** Orders found from an id typed in the chat that are not matched to their number. Only used to recognise a named order. */
  mentioned?: T[];
}): ScopeResult<T> {
  const pool = [...o.own, ...(o.mentioned ?? [])];
  const find = (id: string) => pool.find((x) => x.id.toUpperCase() === id);

  const named = orderIdsIn(o.message);
  if (named.length) {
    const found = named.map(find).filter((x): x is T => !!x);
    return found.length ? { orders: found, basis: "message", ids: named } : { orders: [], basis: "unknown_named", ids: named };
  }

  for (let i = o.recent.length - 1; i >= 0 && i >= o.recent.length - 6; i--) {
    const ids = orderIdsIn(o.recent[i].body);
    for (let j = ids.length - 1; j >= 0; j--) {
      const hit = find(ids[j]);
      if (hit) return { orders: [hit], basis: "thread", ids: [hit.id] };
    }
  }

  if (o.own.length === 0) return { orders: [], basis: "none", ids: [] };
  if (o.own.length === 1) return { orders: o.own, basis: "single", ids: [o.own[0].id] };
  const settled = o.own.filter((x) => isSettled(x.status)).length;
  if (settled === 0 || settled === o.own.length) return { orders: o.own, basis: "all", ids: o.own.map((x) => x.id) };
  return { orders: [], basis: "ambiguous", ids: [] };
}

// ── An order that is already cancelled ───────────────────────────────────────────────────────────────────────────────────
// "Cancel" / "I don't want it" / "ordered by mistake" about an order that is ALREADY cancelled is answered by saying so. It is not a
// request the bot can act on, not a case for the team, and not (as the model drifted into saying on 10 Oct) "your request to keep
// the order is with the team". Only the cancellation STATE is stated. Whether, when or how a refund is made is a different fact and
// is left to the model and the order's refund line — a customer asking about the refund never reaches this reply.

export const CANCELLED_STATUSES = new Set(["cancelled", "wa_cancelled"]);

const WANTS_IT_STOPPED =
  /\b(cancel(?:l?ed|l?ing|l?ation)?|cancle|kro|krdo|kar do|by mistake|mistake|(?:don'?t|do not|dont|no longer|not) (?:want|need|require)|not needed|changed my mind|wrong order|ordered wrong|i didn'?t (?:order|want)|no need)\b|कैन्सल|कॅन्सल|रद्द/i;

/** They are asking for something about money coming back — the refund's state is its own fact. */
const ABOUT_MONEY = /\b(refund|money|amount|credited|payment|paid|utr|arn|reference|transaction|wallet)\b/i;

/**
 * The fixed "already cancelled" reply, or null.
 *
 * Applies only when the scope is exactly one order, that order is cancelled, and the customer (this message, or the two before it)
 * is asking for the order to be stopped — and neither says anything about money.
 */
export function alreadyCancelledReply(o: {
  scoped: { id: string; status: string }[];
  message: string;
  recentCustomer: string[];
}): { text: string; kind: "already_cancelled" } | null {
  if (o.scoped.length !== 1) return null;
  const order = o.scoped[0];
  if (!CANCELLED_STATUSES.has(order.status)) return null;
  const lines = [o.message, ...o.recentCustomer.slice(-2)];
  if (lines.some((l) => ABOUT_MONEY.test(l ?? ""))) return null;
  if (!lines.some((l) => WANTS_IT_STOPPED.test(l ?? ""))) return null;
  return { text: `Your order #${order.id} is already cancelled.`, kind: "already_cancelled" };
}
