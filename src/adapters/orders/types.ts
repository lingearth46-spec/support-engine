// Where the bot reads a customer's orders from. The bot never asks a database for an order directly: it asks an OrderSource.
// This folder holds three things: this interface, the reference shop's own source (supabase.ts, reads an `orders` table) and a read-only
// Shopify source (shopify.ts). Write your own for any other system by implementing OrderSource and returning OrderRow
// (src/engine/orderLines.ts), the one shape the rest of the bot reads. Pure orchestration here: no database, no network.

import { normalizePhone } from "@engine/phone";
import type { OrderRow } from "@engine/orderLines";

export interface OrderSource {
  /** Orders placed from this ten-digit number, newest first, at most five. Never throws for "none found". */
  byPhone(phone: string): Promise<OrderRow[]>;
  /** Orders with exactly these ids. An unknown id is simply absent; a failed read gives an empty list, not a throw. */
  byIds(ids: string[]): Promise<OrderRow[]>;
  /** Order ids a customer typed into free text, in this shop's id format (at most five, no repeats). */
  idsIn(text: string): string[];
}

/** Ten-digit Indian mobiles mentioned in the text, excluding the sender's own: "I ordered from 98765 43210". Pincodes and totals are shorter, so they do not match. */
export function extractPhones(text: string, exclude: string): string[] {
  const hits = text.match(/(?:\+?91[-\s]?)?[6-9]\d{9}/g) ?? [];
  const phones = hits.map((h) => normalizePhone(h)).filter((p) => p.length === 10 && p !== exclude);
  return [...new Set(phones)].slice(0, 3);
}

/** Orders the customer pointed us to by id or by another number, across the recent thread: "where's my order" works even from a different handset. */
export async function ordersFromMentions(source: OrderSource, text: string, senderPhone: string): Promise<OrderRow[]> {
  const ids = source.idsIn(text);
  const phones = extractPhones(text, senderPhone);
  const out: OrderRow[] = [];
  if (ids.length) out.push(...(await source.byIds(ids)));
  for (const p of phones) out.push(...(await source.byPhone(p)));
  return out;
}
