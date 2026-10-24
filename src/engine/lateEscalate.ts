// A customer who is angry about a late parcel, or says the courier never came, and whose parcel really is late or failed, is answered with a
// reassurance and nothing else when no rule picks the message up: no case, no person. 24 Oct: AJUKI710054 (undelivered since 15 Oct, due 21 Oct),
// messaged from a different number than the order's, got "no need to worry" twice and nobody was told; a customer disputing "3 attempts" on a
// returning parcel got the same line three times. This is the net under those: the reply still goes, and a person is also asked to look. Pure.

export type LateOrder = { id: string; status?: string | null; estimated_delivery?: string | null };

const DAY = 86_400_000;
/** Past its date by this much and still not delivered, a parcel counts as late for this purpose. */
export const LATE_AFTER_DAYS = 3;

const UNHAPPY =
  /\b(unfit|not capable|useless|worst|fraud|cheat\w*|scam\w*|pathetic|unacceptable|not at all (?:acceptable|happy)|not happy|disappointed|fed up|stop doing|accept your defeat|consumer (?:court|forum)|legal action|waiting (?:for )?\d+ days|since \d+ days|ages)\b/i;
const NEVER_CAME =
  /\b(no ?one|nobody|none)\b[^.!?\n]{0,20}\b(came|called|attempt\w*|visited|delivered)\b|\bnever (?:came|called|attempt\w*|visited)\b|\bnot (?:at all )?attempt\w*|\b(?:did ?n'?t|did not|not) (?:even )?(?:attempt|come|call|try)\b|\bonly (?:once|one attempt|1 attempt)\b|\bno attempt\b/i;

/** @returns why a person should look (for the case), or null when the net does not apply. */
export function lateEscalation(opts: { message: string; orders: LateOrder[]; now: number }): string | null {
  const msg = String(opts.message ?? "");
  const unhappy = UNHAPPY.test(msg);
  const neverCame = NEVER_CAME.test(msg);
  if (!unhappy && !neverCame) return null;
  for (const o of opts.orders) {
    const status = String(o.status ?? "").toLowerCase();
    if (status === "undelivered") return `unhappy customer, order ${o.id} is undelivered`;
    if (neverCame && status === "rto") return `customer disputes the delivery attempts on order ${o.id}, which is returning to us`;
    if (status === "shipped" || status === "out_for_delivery" || status === "in_transit") {
      const due = Date.parse(o.estimated_delivery ?? "");
      if (Number.isFinite(due) && opts.now - due >= LATE_AFTER_DAYS * DAY) return `unhappy customer, order ${o.id} is ${Math.floor((opts.now - due) / DAY)} days past its date`;
    }
  }
  return null;
}
