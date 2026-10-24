// The reference shop's OrderSource: an `orders` table in Supabase. The queries are the ones its bot has always run.
// The order-id format below (AJUKI plus digits) is the one place the reference prefix is spelled for reading ids out of free text:
// change it to your own format (or use shopify.ts, which reads `#1001`-style names).

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@engine/phone";
import { ORDER_COLUMNS, ORDER_COLUMNS_WITH_SCAN, type OrderRow } from "@engine/orderLines";
import type { OrderSource } from "@adapters/orders/types";

/** Order ids the customer typed, e.g. "AJUKI123456": the handle they have when they are messaging from a number they did not order with. */
export function extractOrderIds(text: string): string[] {
  const hits = text.toUpperCase().match(/AJUKI\s*\d{4,}/g) ?? [];
  return [...new Set(hits.map((s) => s.replace(/\s+/g, "")))].slice(0, 5);
}

/** Orders placed from a number, newest first. Matched in JS on the normalised number because stored formats are mixed (+91…, 0…, spaced). */
async function ordersByPhone(db: SupabaseClient, phone: string): Promise<OrderRow[]> {
  if (phone.length !== 10) return [];
  const q = (cols: string) => db
    .from("orders")
    .select(cols)
    .or(`address->>phone.like.%${phone}%,address->>altPhone.like.%${phone}%`)
    .order("created_at", { ascending: false })
    .limit(5);
  // Try with the scan snapshot; drop back to the base set if the column is not there yet (migration run by hand, code ships first).
  let res = await q(ORDER_COLUMNS_WITH_SCAN);
  if (res.error && /column .* does not exist|could not find/i.test(res.error.message)) {
    res = await q(ORDER_COLUMNS);
  }
  return ((res.data as unknown as OrderRow[]) ?? []).filter(
    (o) => normalizePhone(o.address?.phone ?? "") === phone || normalizePhone(o.address?.altPhone ?? "") === phone,
  );
}

export function supabaseOrderSource(db: SupabaseClient): OrderSource {
  return {
    byPhone: (phone) => ordersByPhone(db, phone),
    byIds: async (ids) => {
      if (!ids.length) return [];
      const { data } = await db.from("orders").select(ORDER_COLUMNS).in("id", ids);
      return (data as unknown as OrderRow[]) ?? [];
    },
    idsIn: extractOrderIds,
  };
}
