// The Delhivery NDR action policy in one place (NDR_POLICY.md): which act a code gets, how many times one parcel may be asked for, how far a deferred date may reach, and how
// a request is counted. The hourly job (app/api/cron/ndr-reattempt) and the late-delivery agent (lib/deliveryCourierAction.ts) both read THIS, so a limit cannot drift between them.
// Moved here unchanged from the cron route on 18 Oct 2026; pure.

import { DEFER_ELIGIBLE_CODES, DEFER_PREFERRED_CODES } from "@adapters/couriers/delhivery";

/** The breadcrumb every request appends to orders.admin_notes. Its shape is parsed by lib/adminNotes.ts (anchored regex) and an RTO-alert feature: the line MUST stay
 *  `NDR reattempt requested <date> — live status was "<status>" (<code>).` with nothing appended. */
export const NOTE_PREFIX = "NDR reattempt requested";

/**
 * How many times one parcel may ever be asked for (RE-ATTEMPT + DEFER_DLV combined: both append the same breadcrumb, so both count). Delhivery's own ceiling is three
 * attempts (ST-108 IS "maximum attempts reached"), so a fourth request buys nothing.
 */
export const MAX_REQUESTS_PER_ORDER = 3;

/**
 * The last date Delhivery accepts a DEFER_DLV for a parcel: a FIXED per-parcel date at estimated_delivery + 5 to 7 days (measured 11 Sep from 10 live `'dfd' is beyond <date>`
 * rejections). 5 rather than 7 because a refusal costs a whole request and a day, while erring short only moves the attempt earlier.
 */
export const DEFER_HORIZON_DAYS = 5;
export function deferHorizon(o: { estimated_delivery?: string | null }): string | null {
  if (!o.estimated_delivery) return null;
  const edd = Date.parse(`${String(o.estimated_delivery).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(edd)) return null;
  return new Date(edd + DEFER_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
}

export const todayUtc = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const timesAsked = (notes?: string | null) => (String(notes ?? "").match(new RegExp(NOTE_PREFIX, "g")) ?? []).length;
export const askedToday = (notes?: string | null, now = Date.now()) => String(notes ?? "").includes(`${NOTE_PREFIX} ${todayUtc(now)}`);

/** Which act to send for a live NDR code: DEFER for the consignee-unavailable family (where DEFER is eligible), RE-ATTEMPT for the rest of the NDR list. */
export function actionForCode(code: string): "RE-ATTEMPT" | "DEFER_DLV" {
  if (DEFER_PREFERRED_CODES.has(code) && DEFER_ELIGIBLE_CODES.has(code)) return "DEFER_DLV";
  return "RE-ATTEMPT";
}
