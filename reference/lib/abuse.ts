// Abuse aimed at us. The founder's rule (13 Oct): do not answer it; stay silent, leave the thread unread, and tell the team on Telegram.
//
// Replying to a swear word with the return-rejected line (a real case on 12 Oct) reads as a bot that is not listening, and any reply keeps
// the exchange going. Deliberately conservative: strong profanity only, matched as whole words after repeated letters are collapsed
// ("Chutiyaaaa" -> "chutiya"), so ordinary frustration ("this is the worst service", "fraud", "cheating") is NEVER treated as abuse and
// still reaches the normal path and the legal/fraud keyword backstop. Pure, unit-tested.

const STRONG =
  /\b(?:chutiya|chutia|chutiye|madarchod|madrchod|maderchod|bhenchod|behenchod|bhosdi\w*|bhosda|gandu|gaandu|gaand|harami|haramkhor|randi|kutta|kutte|kamina|kamine|fuck\w*|motherfucker|bitch|bastard|asshole|cunt|mc|bc)\b/;

const collapse = (s: string) => (s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/(.)\1+/g, "$1");

export function isAbusive(message: string | null | undefined): boolean {
  const t = collapse(message ?? "");
  if (!t.trim()) return false;
  return STRONG.test(t);
}
