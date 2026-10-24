// "Update phone" (the button on the on-its-way message, order_arrival_headsup_v1) and the number that answers it are fixed lines that need no model and no
// person to read them first, so they are answered at any hour instead of waiting for the next opening (24 Oct: five taps after 19:00 got the hours notice and
// would have waited until Monday). Everything else outside 11-19 IST Mon-Sat is unchanged. Pure.

import { PHONE_ASK_REPLY, phoneChangeReply } from "@engine/topicReplies";
import { barePhone } from "@engine/lookupReply";

const TITLE = /^\s*update phone\s*[.!]?\s*$/i;
type Own = Parameters<typeof phoneChangeReply>[0]["ownOrders"];

/** The message is the Update phone title for a parcel that is with the courier, or the number given in answer to our ask for it. */
export function phoneAnyHour(opts: { message: string; lastBotReply: string | null | undefined; ownOrders: Own }): boolean {
  const msg = String(opts.message ?? "");
  if (TITLE.test(msg)) return phoneChangeReply({ message: "Update phone", ownOrders: opts.ownOrders })?.kind === "phone_flag";
  return !!opts.lastBotReply && opts.lastBotReply.startsWith(PHONE_ASK_REPLY.slice(0, 40)) && !!barePhone(msg);
}
