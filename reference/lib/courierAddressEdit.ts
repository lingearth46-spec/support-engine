// The address as the customer writes it, and what was just sent to the courier. Pure text functions plus one small read.
//
// 21 Oct, AJUKI710081: a customer sent their address as several messages in a row ("Greenfield nagar wat no 7", "201301 greenfield nagar", "Wat no 7", "Temple lane"). The NDR
// address flow took the FIRST message that held a pincode and sent only that ("201301 greenfield nagar") to Shadowfax; the pincode went only inside the text, not as a field; and the
// messages that came after started the support bot's own address flow, which asked for the address again and opened a second request for the team. This module is the three
// small pieces the fix needs.

import type { SupabaseClient } from "@supabase/supabase-js";

const PIN = /(?<!\d)([1-9]\d{5})(?!\d)/g;

/** The pincode in an address (the last six-digit group), or null. */
export function pincodeOf(address: string | null | undefined): string | null {
  const all = [...String(address ?? "").matchAll(PIN)].map((m) => m[1]);
  return all.length ? all[all.length - 1] : null;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * One address from the several messages a customer sent: in the order written, a message that is already inside a longer one dropped ("Wat no 7" inside "Greenfield nagar wat no 7"),
 * the rest joined with commas, capped at `max` characters (the courier's limit), keeping the LATEST messages if it has to cut. `keep` says which messages are part of an address
 * (not a button, an acknowledgement or a question); the caller supplies it so this stays free of the NDR module.
 */
export function composeAddress(bodies: readonly string[], keep: (body: string) => boolean = () => true, max = 240): string {
  const parts = bodies.map(norm).filter((b) => b && keep(b));
  const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
  const kept = unique.filter((p) => !unique.some((q) => q !== p && q.length > p.length && q.toLowerCase().includes(p.toLowerCase())));
  let out = kept.join(", ");
  while (out.length > max && kept.length > 1) { kept.shift(); out = kept.join(", "); }
  return out.length > max ? out.slice(out.length - max) : out;
}

/** What our own confirmations say after a phone or address was passed to a courier (lib/ndrButtonReply.ts). */
const EDIT_CONFIRMATION = /(?:passed your new|updated the delivery|saved your correct) address/i;

/** Did we confirm a courier address edit to this customer in the last `minutes`? Then a fragment of the same address that arrives now is not a new request (the support bot's own flow would ask again). */
export async function recentCourierAddressEdit(db: SupabaseClient, phone: string, minutes = 10, now = Date.now()): Promise<boolean> {
  try {
    const since = new Date(now - minutes * 60_000).toISOString();
    const { data, error } = await db.from("wa_messages").select("body").eq("phone", phone).eq("direction", "out").gte("created_at", since).order("created_at", { ascending: false }).limit(10);
    if (error || !data) return false;
    return (data as { body: string | null }[]).some((r) => EDIT_CONFIRMATION.test(r.body ?? ""));
  } catch {
    return false;
  }
}
