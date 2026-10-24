// Fixed-wording reply for a customer asking to cancel an order that has already been dispatched.
//
// Same reason as lib/returnStateReply.ts: the founder wants the same words every time, and a model
// prompted with a sentence drifts around it. First ask: it cannot be cancelled after dispatch. If they
// insist: they can refuse the parcel at delivery. Nothing else — no refund promise, no forwarding.
//
// Only when NO order of theirs can still be cancelled: a pre-dispatch order stays with the model, which
// can actually cancel it (lib/supportActionRun.ts). Pure, so every branch is unit-tested.

import { cancellationAllowedInWindow } from "@engine/supportActions";
import type { ActionOrder } from "@engine/supportActions";
import { hasCancellationIntent } from "@engine/supportGuardrails";
import { courierPushesCancel } from "@engine/courierPushCancel";

export const CANCEL_REPLY = "Orders cannot be cancelled once they have been dispatched.";

export const CANCEL_TOO_OLD_REPLY = "Orders can only be cancelled within 24 hours of placing them.";

export const CANCEL_INSIST_REPLY = "If you still need help with this, please email our Senior Support Team at ajukisupport@gmail.com with your order number.";

/** Signs that the customer has been unhappy about the delay or the service before asking to cancel. */
const COMPLAINING = /\b(?:why|days|late|delay(?:ed)?|not (?:yet )?(?:received|delivered)|haven'?t (?:received|got)|take time|taking (?:so )?long|problem|complain|no (?:call|reply|response)|didn'?t (?:get|receive)|waiting)\b/i;

/** Pushing back after we said no: asking again, chasing, or just saying please. */
const PUSHING = /\b(please|plz|pls|reply|again|still|why|but|must|urgent|kindly)\b/i;

export function cancelStateReply(opts: {
  ownOrders: { id: string; status: string; awb_code?: string | null; created_at?: string | null }[];
  message: string;
  tag: string;
  lastBotReply?: string | null;
  now?: number;
  /** The customer's own earlier messages in this thread, oldest first (not the current one). */
  recentCustomer?: string[];
}): string | null {
  const last = opts.lastBotReply ?? "";
  const afterUs = [CANCEL_REPLY, CANCEL_TOO_OLD_REPLY, CANCEL_INSIST_REPLY].some((c) => last.startsWith(c.slice(0, 30)));
  // The message itself must say it. The model's tag alone is not enough: a bare "Ok" or "Fine" later in a cancellation
  // thread is tagged cancellation too, and answering it with the refusal again reads as not listening.
  const asksCancel = hasCancellationIntent(opts.message);
  if (!asksCancel && !(afterUs && PUSHING.test(opts.message))) return null;
  // "my order got cancelled by your delivery partner" TALKS ABOUT a cancellation; it does not ask for one. Answering it with the
  // dispatch rule was a wrong answer to "please use another courier" (12 Oct review). No imperative, no request: the model's.
  const talksAbout = /\b(?:got|was|were|been|is|has been|have been|gets?)\s+cancel(?:l)?ed\b|\bcancel(?:l)?ed by\b/i.test(opts.message);
  const requests = /\b(?:please |pls |plz |ok |okay |then )*(?:cancel|cancle|cancal)\b(?! by)|\b(?:want|wish|need|like) to cancel\b|\b(?:order|odar|oder) (?:nahi|nhi) (?:chahiye|chaiye)/i.test(opts.message.replace(/cancel(?:l)?ed/gi, "x"));
  if (talksAbout && !requests && !afterUs) return null;
  // "The courier guy wants me to cancel but I don't want to cancel it" (22 Oct): a refusal and a complaint about the rider, not a request. The dispatch rule is the wrong answer to it.
  if (!afterUs && courierPushesCancel(opts.message)) return null;
  // "he keeps sending cancellation messages" is a complaint about the courier, not a request (14 Oct, #66): the noun alone, beside
  // courier/message/call words and with no imperative, is the model's to answer.
  if (!requests && !afterUs && /\bcancellations?\b/i.test(opts.message) && /\b(?:courier|delivery (?:boy|guy|partner|person)|messages?|msgs?|calls?|called|texts?)\b/i.test(opts.message)) return null;

  const verdicts = opts.ownOrders.map((o) => cancellationAllowedInWindow({ status: o.status as ActionOrder["status"], awb_code: o.awb_code ?? undefined, created_at: o.created_at }, opts.now));
  // Something they could still cancel (inside 24 hours, nothing booked), or nothing to refuse: the model's to handle.
  if (verdicts.some((v) => v.ok)) return null;
  const booked = verdicts.some((v) => !v.ok && v.reason === "booked");
  const tooOld = verdicts.some((v) => !v.ok && v.reason === "too_old");
  if (!booked && !tooOld) return null;

  if (afterUs) return CANCEL_INSIST_REPLY;
  // A cancel request that comes AFTER the customer has been complaining about the delay or the service ("why 7 days", "ok then cancel the order")
  // is not a policy question: the bare refusal reads as not listening. The model answers with the thread in view and hands it to the team.
  if (booked && opts.recentCustomer?.length && COMPLAINING.test(opts.recentCustomer.slice(-4).join(" "))) return null;
  // Dispatched wins: that is the stronger fact. Otherwise it is simply past the 24 hours we promise.
  return booked ? CANCEL_REPLY : CANCEL_TOO_OLD_REPLY;
}
