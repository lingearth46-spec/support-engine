// The late-delivery agent's SUPPRESSION alert. At 100% with no shadow period (founder, 19 Oct 2026) the one thing nobody can see is a customer who needed a person and got a status
// line instead: the old fixed lines escalated every late chat, the agent's C1 / A2s / D lines deliberately do not. So every time the agent answers a late chat WITHOUT prompting
// a person, the ops chat gets one line with the order, the line used, what the customer wrote and what they were told, and can step in.
//
//   SUPPORT_DELIVERY_AGENT_ALERTS = on (default when the agent is live) | off
// Pure text building (tested); the send is one fire-and-forget Telegram call in the handler. Never throws, never delays the reply. The phone is shown by its last four digits only.

import type { LiveLiteLine } from "@/lib/deliveryCaseState";

export const alertsEnabled = (env: Record<string, string | undefined> = process.env): boolean => !["0", "off", "false"].includes((env.SUPPORT_DELIVERY_AGENT_ALERTS ?? "").trim().toLowerCase());

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n: number) => (s.replace(/\s+/g, " ").trim().length > n ? `${s.replace(/\s+/g, " ").trim().slice(0, n)}…` : s.replace(/\s+/g, " ").trim());

/** The alert for an agent line that did NOT prompt a person, or null when there is nothing to watch (a person was prompted, or the alerts are off). */
export function suppressionAlert(a: { line: Pick<LiveLiteLine, "replyId" | "text" | "person" | "escalate">; orderId: string; phone: string; message: string }, env: Record<string, string | undefined> = process.env): string | null {
  if (a.line.person || !alertsEnabled(env)) return null;
  return `🤖 <b>Late-delivery agent answered without a person</b> — <b>${esc(a.orderId)}</b> · …${esc(String(a.phone).slice(-4))}\n` +
    `Line ${esc(a.line.replyId)}\n` +
    `Customer: “${esc(clip(a.message, 160))}”\n` +
    `Told: “${esc(clip(a.line.text, 220))}”\n` +
    `<i>If they needed someone, open the thread in the admin inbox.</i>`;
}
