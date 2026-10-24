// The 11:00 answer to a message that arrived overnight and says almost nothing.
//
// Messages sent outside support hours get the "we are open 11–7" notice at once and are answered when the desk opens
// (app/api/cron/wa-wake). A bare "Hey" sent at 5 AM was answered at 11:00 with a model-written "Hi — how can I help you today?",
// and a bare "Track" with "Which order would you like to track?" — six hours late, after the customer had already been told when
// we open. The model has nothing to add to those, so they get a short fixed line instead, the same words every time.
//
// Only a message that is NOTHING but a greeting or a tracking keyword. Anything with an order number, a question, or any other
// content still goes to the bot as before. Pure, so every rule is unit-tested.

import { greetingReply, GREETING_REPLY } from "@engine/lookupReply";

/** A bare tracking keyword is answered with where to track, not with a question about which order. */
export const TRACK_QUEUED_REPLY =
  "You can track your order at www.ajuki.in/track with your order ID and the phone number you ordered with. Or send your order ID here and I'll check it.";

const TRACK_WORDS = /^(?:please\s+)?(?:track(?:ing)?(?:\s+(?:my\s+)?(?:order|parcel|package|status|id|link|number|no\.?))?|order\s+status|status)\W*$/i;

export type QueuedBare = { text: string; kind: "queued_greeting" | "queued_track"; tag: "other" | "order_status" };

/**
 * The fixed line for a message that is only a greeting or a tracking keyword, else null (leave it to the bot).
 *
 * `ownOrderCount` is how many orders are on the sender's own number. A tracking keyword from someone with exactly ONE order is left
 * to the bot, which answers with that order's real status — better than a link. The fixed line is for the customer with none or
 * several, where the bot could only have asked which one.
 */
export function queuedBareReply(message: string | null | undefined, opts: { ownOrderCount?: number } = {}): QueuedBare | null {
  const t = (message ?? "").replace(/[‘’]/g, "'").trim();
  if (!t || t.length > 40) return null;
  // A greeting, judged as a first touch: the notice we just sent is not a conversation, so the quiet-hours rule does not apply.
  const g = greetingReply({ message: t, lastOutAt: null });
  if (g) return { text: g, kind: "queued_greeting", tag: "other" };
  if (TRACK_WORDS.test(t) && opts.ownOrderCount !== 1) return { text: TRACK_QUEUED_REPLY, kind: "queued_track", tag: "order_status" };
  return null;
}

export { GREETING_REPLY };
