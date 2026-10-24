// The Telegram inline-button callback_data codec.
//
// `v1:<action>:<ref>[:<arg>]`. A full uuid fits (v1:snz: = 7 bytes + 36 + :1)
// comfortably inside Telegram's 64-byte cap, so no id truncation / prefix
// lookup is needed.
//
// Split out from lib/telegramActions.ts so the message side (which builds
// callback_data on buttons — lib/waSupport.ts, the briefing crons) and the
// handler side (which decodes it) can each import just this, with no cycle
// through the heavy action-runner module.

export interface Callback {
  action: string;
  ref: string;
  arg?: string;
}

export function encodeCallback(action: string, ref: string, arg?: string): string {
  const s = arg === undefined ? `v1:${action}:${ref}` : `v1:${action}:${ref}:${arg}`;
  if (Buffer.byteLength(s, "utf8") > 64) throw new Error(`callback_data too long (${s.length}): ${s}`);
  if (/[:\s]/.test(action) || /\s/.test(ref)) throw new Error(`bad callback parts: ${action} / ${ref}`);
  return s;
}

export function decodeCallback(data: string): Callback | null {
  const parts = data.split(":");
  if (parts[0] !== "v1" || parts.length < 3 || parts.length > 4) return null;
  if (!parts[1] || !parts[2]) return null;
  return { action: parts[1], ref: parts[2], arg: parts[3] };
}
