// Signed /track links for WhatsApp buttons. Server-only (node:crypto).
//
// WHY
//
// Track Order is gated (15 Sep 2026): a phone number is not a secret, so typing
// one must not show that person's parcels. A signed-in customer is proved by
// their session; anyone else proves the number with a WhatsApp OTP.
//
// The WhatsApp buttons are the exception. The message went to that handset, so
// holding the link is the proof, and asking for a code on top would just add a
// step between a customer and their parcel. What stops a copied link being
// edited to someone else's number is the signature: the tail is
// "<ten digits>-<expiry>-<hmac>", and changing any part breaks it.
//
// The tail rides in the approved templates' existing `?phone={{1}}` variable,
// so no template needed re-approval. Old links that carry a bare number now just
// ask for the OTP.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizePhone } from "@engine/phone";

/** How long a link keeps working: past delivery, through a return window. */
const LINK_TTL_DAYS = 30;

function secret(): string {
  // A dedicated secret if one is set; otherwise derived from the service role
  // key, which every environment that sends WhatsApp already has. Derived, not
  // used raw, so the key itself never becomes an HMAC input anywhere else.
  const own = process.env.TRACK_LINK_SECRET;
  if (own) return own;
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "local-dev-only";
  return createHash("sha256").update(`ajuki-track-link:${base}`).digest("hex");
}

function signature(phone: string, exp: string): string {
  return createHmac("sha256", secret()).update(`${phone}.${exp}`).digest("base64url").slice(0, 22);
}

/** "9000100017-t4k2c0-<sig>", or undefined when the number is not a 10-digit mobile. */
export function signTrackLink(rawPhone: string, now: Date = new Date()): string | undefined {
  const phone = normalizePhone(rawPhone);
  if (phone.length !== 10) return undefined;
  const exp = Math.floor(now.getTime() / 1000 + LINK_TTL_DAYS * 86400).toString(36);
  return `${phone}-${exp}-${signature(phone, exp)}`;
}

/** The ten-digit number a link was signed for, or null if it is forged, edited or expired. */
export function verifyTrackLink(token: string | null | undefined, now: Date = new Date()): string | null {
  const m = String(token ?? "").trim().match(/^(\d{10})-([0-9a-z]+)-([A-Za-z0-9_-]{22})$/);
  if (!m) return null;
  const [, phone, exp, sig] = m;
  const expected = Buffer.from(signature(phone, exp));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (parseInt(exp, 36) * 1000 < now.getTime()) return null;
  return phone;
}
