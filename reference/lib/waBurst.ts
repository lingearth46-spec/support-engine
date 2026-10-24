// Stopping the bot from talking over itself.
//
// Two rules, both pure, both about the same failure: a customer sends three
// messages in five seconds and gets three separate answers. Nineteen such pairs
// in the first eleven days — 3% of everything sent — including one customer who
// had their delivery address read back twice nine seconds apart, and another who
// got the same apology twice, two seconds apart, in Hindi.
//
// Kept out of waSupport.ts so they can be tested. That module reaches Sanity and
// Supabase at import time, which is the whole reason this repo keeps its
// decisions in modules that import nothing.

import { isAckOnly } from "./ackOnly";

/**
 * How long an escalation stays acknowledged.
 *
 * Once a customer has been told a person is coming, telling them again is the
 * single most robotic thing this bot can do — three messages in three minutes
 * drew three near-identical apologies, which reads worse than saying nothing.
 * Within this window a repeat escalation is logged and pinged to the team but
 * answered with silence; after it, the thread is cold enough that a fresh
 * acknowledgement is reassurance rather than parroting.
 */
export const RE_ACK_QUIET_MS = 6 * 60 * 60 * 1000;

/**
 * Has this customer already been told a person is coming?
 *
 * True only while the thread is still in an escalated state *and* the promise is
 * recent. A thread that the bot has since answered normally clears `escalated`,
 * so a later escalation is a fresh one and gets its own acknowledgement.
 *
 * The clock runs from the original acknowledgement, not from the last message —
 * a customer sending five chasers does not extend their own silence.
 */
export function alreadyAcknowledged(
  conv: { escalated: boolean; last_out_at: string | null } | null,
  now = Date.now(),
): boolean {
  if (!conv?.escalated || !conv.last_out_at) return false;
  const at = Date.parse(conv.last_out_at);
  return Number.isFinite(at) && now - at < RE_ACK_QUIET_MS;
}

/**
 * Which messages in one webhook payload are superseded by a later one from the
 * same sender.
 *
 * Meta batches a burst into a single payload and the webhook handles them in
 * order, awaiting each — so message 2 is not written to wa_messages until
 * message 1 has already replied, and the `overtaken` read inside the handler
 * cannot see what is still queued in memory. Only the loop over the batch
 * knows, so it works it out here and tells the handler.
 *
 * Returns a parallel array of flags rather than a filtered list: every message
 * still has to be stored, and only the answering is skipped.
 *
 * Per sender, not per batch. Two customers writing at the same moment land in
 * one payload, and "is this the last message in the batch" would answer one of
 * them and drop the other on the floor.
 */
export function supersededInBatch(from: (string | undefined)[], bodies?: (string | undefined)[]): boolean[] {
  // The last ANSWERABLE message per sender. A trailing "Okay" or thumbs-up is not answered, so it must not stand in for the real
  // messages before it: on 16 Oct a customer wrote "my hand is small" and "the bracelet won't fit", then "Okay", and the two real
  // messages were left to the "Okay" handler, which stays silent. With no bodies given every message counts, as before.
  const last = new Map<string, number>();
  from.forEach((f, i) => {
    if (!f) return;
    const b = bodies?.[i];
    if (b !== undefined && isAckOnly(b)) return;
    last.set(f, i);
  });
  // A message with no sender is never superseded — it cannot be matched to
  // anyone, so silencing it would silence it for good rather than deferring it
  // to a handler that is certain to cover it.
  return from.map((f, i) => (f && last.has(f) ? last.get(f)! > i : false));
}

/**
 * Does this message carry anything NEW, or is it only the customer chasing the answer they already have?
 *
 * Used when a fixed reply would be repeated. A bare chase ("any update", "hello??", "where is my order please reply") stays quiet; a
 * message with substance ("Product showing in the app is different than the order I have received") is not a chase, and going silent
 * on it leaves a customer with a real problem unanswered (16 Oct): it gets a short acknowledgement and the team is told.
 */
const CHASE_WORDS = new Set([
  "any", "update", "updates", "status", "hello", "hi", "hii", "hey", "helo", "hlo", "reply", "please", "pls", "plz", "still", "waiting", "where", "is", "my", "order",
  "it", "when", "will", "i", "get", "this", "kab", "tak", "mera", "kya", "hua", "bhai", "sir", "mam", "yaar", "just", "tell", "me", "answer", "give", "are", "you",
  "there", "anyone", "team", "respond", "the", "what", "about", "so", "now", "ok", "okay", "na", "hai", "ho", "gaya", "kahan", "kab", "milega", "ayega", "request",
  "return", "refund", "decision", "result", "ka", "ki", "ke", "do", "dijiye", "kar", "karo", "kr", "bata", "batao", "bataiye", "abhi", "koi", "khabar", "jaldi", "fast", "asap", "urgent", "an", "a", "of", "on", "has", "been", "no", "not", "yet", "again", "same", "answer", "and", "why", "how", "long",
]);
export function addsNewContent(message: string): boolean {
  // A phone number, a pincode or an email address is an answer to something we asked for, whatever its length (22-23 Oct: "9000100018" and an email address got silence).
  if (/(?<!\d)[6-9]\d{9}(?!\d)|(?<!\d)[1-9]\d{5}(?!\d)|[\w.+-]+@[\w-]+\.[\w.]+/.test(message ?? "")) return true;
  const words = (message ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length <= 3) return false;
  if (words.every((w) => CHASE_WORDS.has(w))) return false;
  return true;
}

/** Is any of these newer messages something that needs an answer? An "Okay", a thank-you or an emoji does not, so it cannot take over from the real message before it. */
export const hasAnswerable = (bodies: (string | null | undefined)[]): boolean => bodies.some((b) => !isAckOnly(b ?? ""));

/** The short acknowledgement a held repeat gets when the message added something new. The founder-approved sentence, said alone. */
export const HELD_NEW_INFO_ACK = "I have escalated this to the team.";

/**
 * Would sending `text` repeat, word for word, what this customer was last told?
 *
 * A fixed reply is the same sentence for the same situation, so a customer who writes again about the same thing gets the
 * identical text back — on 9 Oct one customer was sent "Your return request is with our returns team" six times in a row, to
 * "that is really irritating" and "you can't leave this to chatbots", and another got the rejection text seven times, the last
 * one to a swear word. Repeating the line cannot help them and reads as a machine that is not listening. So a fixed reply is sent
 * once; after that the thread goes quiet and the team is told the customer is chasing — the same rule as an escalation
 * (alreadyAcknowledged).
 *
 * "Last told" means the most recent outbound message on the thread, whoever sent it: a person replying in between makes the
 * next fixed reply a different message, so it goes out. Quiet only for RE_ACK_QUIET_MS; after that the customer is asking again
 * rather than being repeated at.
 */
export function repeatsLastReply(
  text: string | null | undefined,
  lastBotReply: string | null | undefined,
  lastOutAt: string | null | undefined,
  now = Date.now(),
): boolean {
  const t = (text ?? "").trim();
  if (!t || !lastBotReply || t !== lastBotReply.trim()) return false;
  const at = lastOutAt ? Date.parse(lastOutAt) : NaN;
  // No usable timestamp: we cannot say how long ago it was, so say it again rather than go silent on someone.
  return Number.isFinite(at) && now - at < RE_ACK_QUIET_MS;
}

/**
 * Has `text` already been said to this customer in our last few lines, not only the very last one?
 *
 * repeatsLastReply compares with ONE line, so two canned answers that alternate defeat it: on 10 Oct one customer was sent "already
 * working on your issue" and "your return was rejected, please email" six times in turn while writing "I have emailed" and "Sure".
 * Each line differed from the one before it. With the pipeline fixes on, a fixed reply is held if it matches ANY of our last
 * `recent` outbound lines sent inside the quiet period — and then, as before, nothing is sent, the thread stays unread and the team
 * is told the customer is chasing. Nothing is invented to fill the silence.
 */
export function repeatsRecentReply(
  text: string | null | undefined,
  recentOut: { body: string | null | undefined; at: string | null | undefined }[],
  now = Date.now(),
): boolean {
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 90);
  const t = key(text ?? "");
  if (!t) return false;
  return recentOut.some((r) => {
    if (!r.body || key(r.body) !== t) return false;
    const at = r.at ? Date.parse(r.at) : NaN;
    return Number.isFinite(at) && now - at < RE_ACK_QUIET_MS;
  });
}
