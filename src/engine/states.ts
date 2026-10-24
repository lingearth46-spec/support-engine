/**
 * One label per state, whatever the courier or the customer typed.
 *
 * Jammu & Kashmir alone arrives spelled four ways ("Jammu And Kashmir", "Jammu &
 * Kashmir", "Jammu and Kashmir", "Jammu Kashmir"). Left raw, one state's RTOs
 * scatter across four rows and the worst region hides in plain sight.
 */
export function normalizeState(raw?: string | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "Unknown";
  if (/jammu|kashmir/i.test(s)) return "Jammu & Kashmir";
  if (/pondicherry|puducherry/i.test(s)) return "Puducherry";
  if (/chh?at+isgarh/i.test(s)) return "Chhattisgarh";
  if (/orissa|odisha/i.test(s)) return "Odisha";
  // Lowercase first, then title-case — uppercasing only each word's first letter
  // leaves "BIHAR" and "Bihar" distinct, splitting one state across two rows and
  // halving its apparent RTO rate.
  return s.toLowerCase().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * City names are typed by the customer, so they arrive in every casing with
 * stray spacing. There is no variant list worth keeping here — unlike states
 * there are hundreds of them and no fixed set — so this only does the tidying
 * that is certainly safe, and leaves genuinely different spellings apart rather
 * than guessing two places are the same one.
 */
export function normalizeCity(raw?: string | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "Unknown";
  return s.toLowerCase().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Logistics zones — the grain couriers actually price and plan on, coarser than a
 * state and the level a routing decision is made at ("stop sending North on
 * Ekart"). A pragmatic six-zone split of India; Central holds the two states that
 * sit awkwardly between North and South. Keyed on normalizeState output, so the
 * keys are title-cased and single-spelled.
 */
export type Zone = "North" | "South" | "East" | "West" | "Central" | "Northeast" | "Other";

export const ZONES: Zone[] = ["North", "West", "South", "East", "Central", "Northeast", "Other"];

const STATE_ZONE: Record<string, Zone> = {
  // North
  "Delhi": "North", "Haryana": "North", "Punjab": "North", "Chandigarh": "North",
  "Himachal Pradesh": "North", "Uttarakhand": "North", "Uttar Pradesh": "North",
  "Jammu & Kashmir": "North", "Ladakh": "North", "Rajasthan": "North",
  // West
  "Maharashtra": "West", "Gujarat": "West", "Goa": "West",
  "Dadra And Nagar Haveli And Daman And Diu": "West", "Daman And Diu": "West", "Dadra And Nagar Haveli": "West",
  // Central
  "Madhya Pradesh": "Central", "Chhattisgarh": "Central",
  // South
  "Karnataka": "South", "Kerala": "South", "Tamil Nadu": "South", "Andhra Pradesh": "South",
  "Telangana": "South", "Puducherry": "South", "Lakshadweep": "South",
  "Andaman And Nicobar Islands": "South",
  // East
  "West Bengal": "East", "Bihar": "East", "Jharkhand": "East", "Odisha": "East",
  // Northeast
  "Assam": "Northeast", "Meghalaya": "Northeast", "Manipur": "Northeast", "Mizoram": "Northeast",
  "Nagaland": "Northeast", "Tripura": "Northeast", "Arunachal Pradesh": "Northeast", "Sikkim": "Northeast",
  // Two-letter codes some customers type instead of the name (title-cased by
  // normalizeState to "Mp", "Up", …). Without these one order's state hides in
  // "Other". Ambiguous-looking ones (Or, Ap) still resolve to one real state.
  "Dl": "North", "Hr": "North", "Pb": "North", "Up": "North", "Rj": "North", "Uk": "North", "Hp": "North", "Jk": "North",
  "Mh": "West", "Gj": "West", "Ga": "West",
  "Mp": "Central", "Cg": "Central",
  "Ka": "South", "Kl": "South", "Tn": "South", "Ap": "South", "Ts": "South", "Tg": "South",
  "Wb": "East", "Br": "East", "Jh": "East", "Or": "East", "Od": "East",
  "As": "Northeast", "Tr": "Northeast",
};

/** The zone an order fell in, from its (raw) state. "Other" for anything we could
 *  not place — a blank state, or a spelling not in the map. */
export function zoneForState(rawState?: string | null): Zone {
  return STATE_ZONE[normalizeState(rawState)] ?? "Other";
}

/**
 * A rate computed from a handful of parcels is noise wearing a percentage sign:
 * 3 RTOs out of 7 reads as 43% and means almost nothing. Below this many
 * shipments a row is shown, but muted, and never called an outlier.
 */
export const MIN_CONFIDENT_SAMPLE = 10;

export type Severity = "good" | "warn" | "bad" | "unknown";

/** Green under 8%, amber to 15%, red above — thresholds picked around the ~11% overall rate. */
export function rtoSeverity(rate: number, shipped: number): Severity {
  if (shipped < MIN_CONFIDENT_SAMPLE) return "unknown";
  if (rate < 8) return "good";
  if (rate <= 15) return "warn";
  return "bad";
}

// `fill` is the same colour as `bar`, as a literal — SVG cannot take a Tailwind
// class, and keeping it here is what stops the map drifting from the table.
export const SEVERITY_STYLES: Record<Severity, { bar: string; text: string; fill: string }> = {
  good:    { bar: "bg-emerald-500", text: "text-emerald-600", fill: "#10b981" },
  warn:    { bar: "bg-amber-500",   text: "text-amber-600",   fill: "#f59e0b" },
  bad:     { bar: "bg-rose-500",    text: "text-rose-600",    fill: "#f43f5e" },
  unknown: { bar: "bg-[#d4d8e0]",   text: "text-[#a8b2c1]",   fill: "#d4d8e0" },
};

/** A state we have not shipped to at all — different from one with too few parcels. */
export const NO_DATA_FILL = "#f4f5f7";
