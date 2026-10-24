// Who answers when a customer sends three messages at once.
//
// Meta batches a burst into one webhook payload, and the handler works through
// them in order, awaiting each. So message 2 is not in wa_messages until message
// 1 has already replied — which means the `overtaken` read inside the handler
// cannot see it, and both get answered. That is how one customer had the same
// delivery address read back to them twice nine seconds apart, and how another
// got two near-identical apologies in Hindi two seconds apart. Nineteen such
// pairs in the first eleven days.
//
// Only the loop over the batch can see the whole burst, so it decides. The rule:
// every message is stored, but only the last one from each sender is answered,
// because that handler is the one holding the complete conversation.

import { supersededInBatch, alreadyAcknowledged, repeatsLastReply, RE_ACK_QUIET_MS, addsNewContent, hasAnswerable, HELD_NEW_INFO_ACK } from "./waBurst";

let passed = 0;
let failed = 0;
const eq = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; console.error(`FAIL ${label}: expected ${e}, got ${a}`); }
};

// ── One sender, one message: nothing to supersede ─────────────────────────────
eq("single message answers", supersededInBatch(["919000100028"]), [false]);
eq("empty batch", supersededInBatch([]), []);

// ── The burst this exists for ─────────────────────────────────────────────────
// "Where is the adress" / "Can you please comfirm" — the second handler has both
// in its history and answers them together.
eq("last of three wins",
  supersededInBatch(["919000100008", "919000100008", "919000100008"]),
  [true, true, false]);

// ── Two customers writing at the same time must not silence each other ────────
// The naive version of this — "is this the last message in the batch?" — would
// answer one customer and drop the other on the floor.
eq("interleaved senders each keep their own last",
  supersededInBatch(["919000100028", "919000100008", "919000100028"]),
  [true, false, false]);
eq("two senders, one message each",
  supersededInBatch(["919000100028", "919000100008"]),
  [false, false]);

// ── A message with no sender is never silenced ────────────────────────────────
// It cannot be matched to anyone, so treating it as superseded would silence it
// for good rather than deferring it to a handler that is going to cover it.
eq("undefined sender is answered", supersededInBatch([undefined]), [false]);
eq("undefined senders do not group",
  supersededInBatch([undefined, undefined]), [false, false]);
eq("undefined among real senders",
  supersededInBatch(["919000100028", undefined, "919000100028"]),
  [true, false, false]);

// ── Length and order are preserved, because the caller indexes into it ────────
{
  const from = ["a", "b", "a", "c", "b", "a"];
  const flags = supersededInBatch(from);
  eq("one flag per message", flags.length, from.length);
  eq("exactly one survivor per sender", flags.filter((f) => !f).length, new Set(from).size);
  eq("survivors are the last of each", flags, [true, true, true, false, false, false]);
}

// ── The re-acknowledgement quiet period ───────────────────────────────────────
//
// Separate mechanism, same problem: a customer who has been told a person is
// coming should not be told again on every chaser. Included here because the two
// together are what stop the bot repeating itself.
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const SIX_HOURS = 6 * 60 * 60 * 1000;

eq("recently acknowledged stays quiet",
  alreadyAcknowledged({ escalated: true, last_out_at: at(60_000) }), true);
eq("an old acknowledgement has expired",
  alreadyAcknowledged({ escalated: true, last_out_at: at(SIX_HOURS + 60_000) }), false);
// A thread the bot has since answered normally clears `escalated`, so the next
// escalation is a fresh one and earns its own acknowledgement.
eq("not escalated means not acknowledged",
  alreadyAcknowledged({ escalated: false, last_out_at: at(60_000) }), false);
eq("never replied to", alreadyAcknowledged({ escalated: true, last_out_at: null }), false);
eq("no conversation at all", alreadyAcknowledged(null), false);
eq("an unparseable timestamp is not an acknowledgement",
  alreadyAcknowledged({ escalated: true, last_out_at: "not a date" }), false);


// ── A fixed reply is not repeated word for word ───────────────────────────────
{
  const now = Date.parse("2026-10-09T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const REJ = "Your return request was reviewed and rejected on 9 Oct. If you would like to appeal, please email our Senior Support Team at ajukisupport@gmail.com with your order number and any photos or video showing the issue.";
  eq("the same text, just sent, is a repeat", repeatsLastReply(REJ, REJ, ago(30_000), now), true);
  eq("still a repeat just inside the quiet period", repeatsLastReply(REJ, REJ, ago(RE_ACK_QUIET_MS - 1), now), true);
  eq("not a repeat once the quiet period is over", repeatsLastReply(REJ, REJ, ago(RE_ACK_QUIET_MS), now), false);
  eq("a different text is not a repeat", repeatsLastReply("Our Senior Support Team is already working on your issue. Please wait for their reply.", REJ, ago(30_000), now), false);
  eq("surrounding whitespace does not hide a repeat", repeatsLastReply("  " + REJ + "\n", REJ, ago(30_000), now), true);
  eq("a person's reply in between makes it a different last message", repeatsLastReply(REJ, "Please share the order number.", ago(30_000), now), false);
  eq("nothing was said before", repeatsLastReply(REJ, null, null, now), false);
  eq("empty text is never a repeat", repeatsLastReply("", "", ago(1_000), now), false);
  eq("no usable timestamp: say it rather than go silent", repeatsLastReply(REJ, REJ, null, now), false);
  eq("an unreadable timestamp: say it rather than go silent", repeatsLastReply(REJ, REJ, "not a date", now), false);
}

// ── 16-17 Oct: a trailing "Okay" must not stand in for the real messages before it ──────────────────────────────────────────────────────
{
  const A = "919000100028", B = "919000100008";
  eq("real, real, Okay: the first real message is superseded, the last real one answers, the Okay is not marked superseded",
    supersededInBatch([A, A, A], ["Mera hath Chhota hai", "Mere andar nahin aaega bracelet", "Okay"]), [true, false, false]);
  eq("real, Okay: the real message answers", supersededInBatch([A, A], ["the bracelet won't fit", "Okay"]), [false, false]);
  eq("Okay, real: the real one is last, as before", supersededInBatch([A, A], ["Okay", "where is my order"]), [true, false]);
  eq("all acknowledgements: none is superseded", supersededInBatch([A, A], ["ok", "thanks"]), [false, false]);
  eq("a thumbs-up and a reaction do not supersede", supersededInBatch([A, A, A], ["I want to return this", "👍", "[unhandled message type: reaction]"]), [false, false, false]);
  eq("two senders, each judged on their own messages", supersededInBatch([A, B, A, B], ["problem one", "problem two", "Okay", "thanks"]), [false, false, false, false]);
  eq("no bodies given: every message counts, as before", supersededInBatch([A, A, A]), [true, true, false]);
  eq("a body that is undefined (a button, a photo) counts as a real message", supersededInBatch([A, A], [undefined, "Okay"]), [false, false]);
  eq("hasAnswerable: only acknowledgements", hasAnswerable(["Okay", "thanks", "👍"]), false);
  eq("hasAnswerable: a real message among them", hasAnswerable(["Okay", "where is my order"]), true);
  eq("hasAnswerable: nothing newer", hasAnswerable([]), false);
  eq("hasAnswerable: an empty body still counts (as before: any newer message took over)", hasAnswerable([null, ""]), true);
}

// ── a held repeat: a chase stays quiet, a message with substance is acknowledged ─────────────────────────────────────────────────────────
{
  for (const m of ["any update", "hello??", "Hello", "where is my order please reply", "?", "kab tak milega", "return ka answer do", "Any update on my return"]) eq(`a chase: ${m}`, addsNewContent(m), false);
  for (const m of ["Product showing in the app is different than the order I have received", "The bracelet I received is too big for my wrist", "I sent the photos yesterday and nobody has seen them", "my phone number has changed please use 9876543210"]) eq(`new content: ${m}`, addsNewContent(m), true);
  eq("the acknowledgement is the approved sentence, said alone", HELD_NEW_INFO_ACK, "I have escalated this to the team.");
}

// 22-23 Oct: a phone number, a pincode or an email address is an answer to something we asked for, whatever its length
{
  const ok = (name: string, v: boolean) => { if (v) passed++; else { failed++; console.log("FAIL", name); } };
  for (const m of ["9000100018", "9000100005 & 9000100022", "+91 9876543210", "201301", "customer@example.com", "my email is a.b@gmail.com"]) ok(`new content: ${m}`, addsNewContent(m));
  for (const m of ["???", "hello", "any update", "ok", "where is my order", "1234", "12345"]) ok(`still a chaser: ${m}`, !addsNewContent(m));
}
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
