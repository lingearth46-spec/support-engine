// What the customer is told after the agent has TRIED a delivery-day request at the courier (founder 19 Oct: "do they want delivery at a later time"). Pure.
//
// The agent's line B2 says the courier was asked. That is only true if the request was actually submitted, so the line is built from the OUTCOME:
//   · submitted  -> the approved "passed your request" wording (lib/deliveryCourierAction.ts submittedLine), with the date the courier was really sent. The promise of a later
//                   message stays out unless the movement updates are ON (SUPPORT_DELIVERY_UPDATES=on), because nothing else would keep it.
//   · anything else (refused, failed, dry run, off, the courier cannot take a date) -> the request goes to the team, a person is prompted, and the customer is told exactly that.
// Never "confirmed": a 201 proves nothing on this API.

import { submittedLine, type ActResult } from "@late/deliveryCourierAction";
import type { LiveLiteLine } from "@late/deliveryCaseState";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const IST_MS = 5.5 * 3_600_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The delivery day the customer named, as YYYY-MM-DD in IST, or null (then the courier planner picks the next working day). "Today" is null: a same-day change is not possible. */
export function dateFromMessage(message: string, now: number): string | null {
  const m = (message ?? "").toLowerCase();
  const today = new Date(now + IST_MS); today.setUTCHours(0, 0, 0, 0);
  const base = today.getTime();
  if (/\b(?:day after tomorrow|parso)\b/.test(m)) return ymd(base + 2 * 86_400_000);
  if (/\b(?:tomorrow|kal)\b/.test(m)) return ymd(base + 86_400_000);
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/.exec(m);
  if (dm) {
    let year = today.getUTCFullYear(); const month = MONTHS.indexOf(dm[2]); const day = Number(dm[1]);
    let t = Date.UTC(year, month, day); if (t < base) t = Date.UTC(year + 1, month, day);
    return day >= 1 && day <= 31 ? ymd(t) : null;
  }
  const sl = /\b(\d{1,2})\/(\d{1,2})\b/.exec(m);
  if (sl) { const day = Number(sl[1]); const month = Number(sl[2]) - 1; if (month >= 0 && month < 12 && day >= 1 && day <= 31) { let t = Date.UTC(today.getUTCFullYear(), month, day); if (t < base) t = Date.UTC(today.getUTCFullYear() + 1, month, day); return ymd(t); } }
  for (let k = 0; k < DAYS.length; k++) if (new RegExp(`\\b${DAYS[k]}\\b`).test(m)) { const diff = (k - today.getUTCDay() + 7) % 7 || 7; return ymd(base + diff * 86_400_000); }
  return null;
}

const LATER = /\s*I will message you here when it moves\.?/;

/** The line to send for B2 once the action has been tried. */
export function deferLine(line: LiveLiteLine, orderId: string, res: ActResult | null, o: { promiseLater: boolean }): LiveLiteLine {
  if (res?.outcome === "submitted" && res.act === "DEFER_DLV") {
    let text = submittedLine({ orderId, act: "DEFER_DLV", deferredDate: res.deferredDate ?? null, clamped: res.clamped });
    if (!o.promiseLater) text = text.replace(LATER, "").replace(/\s+/g, " ").trim();
    return { replyId: "B2", text, escalate: "none", person: false };
  }
  return {
    replyId: "F2", text: `I have passed your request for that date to the team. I have escalated this to the team. You can track it at www.ajuki.in/track.`,
    escalate: "no_lever", person: true,
  };
}
