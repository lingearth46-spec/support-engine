// A customer who TYPES the title of a failed-delivery button ("Update phone", "Deliver tomorrow") instead of tapping it, or whose tap
// found no undelivered order to attach to, reaches the model with no instruction at all. On the 9-11 Oct replay the model answered
// "Which phone number should we update on the order?" (a promise of an action nobody has verified) and, for a parcel returning to us,
// "Would you like us to arrange redelivery?" (an offer). Real taps never get here: the webhook intercepts them
// (app/api/webhooks/whatsapp/route.ts → lib/ndrButtonReply.ts) and does the verified courier action.
//
// What is said instead is only ever a request for what is needed, or a statement from the record. Nothing is promised or done. Pure.

import { TRACK_URL } from "@engine/replyContext";

const TITLE = /^\s*(deliver tomorrow|update phone|update address|contact support)\s*[.!]?\s*$/i;

/** The exact lines this module can return, so the verifier and the rating ruler can treat them as approved wording. */
export const NDR_TITLE_LINES = {
  phone: "Please send the new mobile number you would like on your order, along with your order number.",
  address: "Please send the full new delivery address with the pincode, along with your order number.",
  returning:
    "Your parcel is on its way back to us, so it cannot be delivered again or changed now. You can place a new order at www.ajuki.in.",
  tomorrow: `I can't give a delivery date for this order. You can see where it stands at ${TRACK_URL.replace(/^https?:\/\//, "")}.`,
  noOrder: "Could you share your order number so I can check where your order stands?",
} as const;

/** @returns the reply for a typed button title, or null when the message is not one (or is one handled elsewhere). */
export function ndrTitleReply(message: string, record: string): string | null {
  const m = TITLE.exec((message ?? "").replace(/\s+/g, " "));
  if (!m) return null;
  const title = m[1].toLowerCase();
  if (title === "contact support") return null; // an escalation keyword: handled by the hand-off decision, not here
  // A parcel already coming back cannot be re-delivered or have its phone or address changed: asking for the new number then is a
  // dead end (12 Oct: "why update phone, you just said it is back with us").
  if (/ON ITS WAY BACK TO US/.test(record ?? "")) return NDR_TITLE_LINES.returning;
  if (title === "update phone") return NDR_TITLE_LINES.phone;
  if (title === "update address") return NDR_TITLE_LINES.address;
  const hasOrder = /#?AJUKI\d{4,10}\b/i.test(record ?? "");
  if (!hasOrder) return NDR_TITLE_LINES.noOrder;
  if (/ON ITS WAY BACK TO US/.test(record ?? "")) return NDR_TITLE_LINES.returning;
  return NDR_TITLE_LINES.tomorrow;
}
