// Which couriers our NDR actions can actually reach, and how far — the one
// place this is defined, imported by both the agent-facing MCP server
// (app/api/mcp/[token]/route.ts) and the admin-facing Operations module, so
// the two never drift apart on what "full"/"partial"/"none" means.
//
// See NDR_POLICY.md §1, §11 for how this was established, and
// lib/dtdc.ndrprobe.ts for the live probe that confirmed DTDC has none.

export function carrierOf(o: { courier_name?: unknown; shiprocket_order_id?: unknown }): string {
  const c = String(o.courier_name ?? "").toLowerCase();
  if (c.includes("delhivery")) return o.shiprocket_order_id ? "delhivery-via-shiprocket" : "delhivery";
  if (c.includes("shadowfax")) return "shadowfax";
  if (c.includes("dtdc")) return "dtdc";
  if (c.includes("ekart")) return "ekart";
  if (c.includes("ithink")) return "ithink";
  return c || "unknown";
}

export type NdrCapabilityLevel = "full" | "partial" | "none";

/** full/partial/none, for anything that needs to branch on it rather than read it. */
export function ndrCapabilityLevel(carrier: string): NdrCapabilityLevel {
  if (carrier === "delhivery") return "full";
  if (carrier === "shadowfax") return "partial";
  return "none";
}

/** The human-readable detail — same wording everywhere this is shown. */
export function ndrCapability(carrier: string): string {
  if (carrier === "delhivery") return "full (defer + reattempt + edit + verify)";
  if (carrier === "shadowfax") return "partial (edit + raise issue; NO scheduling, NO ticket status)";
  return "none — every NDR is a §9.5 KAM request";
}
