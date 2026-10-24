// Reading an opt-out request.
//
// Two failure directions, and they are not equally bad. Missing a real opt-out
// means we keep messaging someone who asked us to stop: they block the number,
// and a blocked number eventually cannot send order notifications either.
// Acting on a false positive is milder but still costs a customer their
// reminders, and silently — they never find out they were muted.
//
// The case this file exists to pin down is the overlap with order cancellation:
// "stop" is in confirmReply's CANCEL list, so a bare "stop" must NOT be read as
// a marketing opt-out or a live order would be quietly left alone while the
// customer is muted instead.
//
// Run with `npm run test:optout`.

import { isOptOutRequest, isOptInRequest, optOutConfirmation, optInConfirmation } from "./waOptOut";

let pass = 0, fail = 0;
const yes = (name: string, text: string) => {
  isOptOutRequest(text) ? pass++ : (fail++, console.log(`FAIL opt-out missed: ${name} — "${text}"`));
};
const no = (name: string, text: string) => {
  !isOptOutRequest(text) ? pass++ : (fail++, console.log(`FAIL false opt-out: ${name} — "${text}"`));
};
const ok = (name: string, cond: boolean) => {
  cond ? pass++ : (fail++, console.log(`FAIL ${name}`));
};

// ── real opt-outs ──
yes("unsubscribe", "unsubscribe");
yes("shouty", "UNSUBSCRIBE!!");
yes("opt out spaced", "opt out");
yes("optout joined", "optout");
yes("stop messages", "stop messages");
yes("stop msgs", "stop msgs");
yes("stop offers", "please stop offers");
yes("stop promotions", "stop promotions");
yes("stop all messages", "stop all messages");
yes("no more messages", "no more messages");
yes("dont send offers", "dont send me offers");
yes("do not message again", "do not message me again");
yes("remove me", "remove me");
yes("delete my number", "delete my number");
yes("hindi band karo", "band karo");
yes("hindi mat bhejo", "message mat bhejo");
yes("with emoji", "unsubscribe 🙏");

// ── must NOT be opt-outs ──
// The critical one: bare "stop" belongs to the order-cancellation flow.
no("bare stop", "stop");
no("stop it", "stop it");
no("cancel my order", "cancel my order");
no("no", "No");
no("question about unsubscribing", "how do I unsubscribe?");
no("question with opt out", "can I opt out?");
no("denial", "I did not opt out of anything, where is my order");
no("ordinary message", "when will my order arrive");
no("thanks", "thank you");
no("empty", "");
no("whitespace", "   ");
// A long sentence that happens to contain the words is a conversation.
no("long sentence", "hi i wanted to ask if you can remove me from the delivery list because I moved house last month");

// ── opting back in ──
ok("start resumes", isOptInRequest("START"));
ok("start lowercase", isOptInRequest("start"));
ok("subscribe", isOptInRequest("subscribe"));
ok("opt in", isOptInRequest("opt in"));
ok("resume", isOptInRequest("resume"));
// "start" inside a sentence is usually a question about shipping, not a request.
ok("not a sentence with start", !isOptInRequest("when will you start shipping to Nepal"));
ok("not a question", !isOptInRequest("should I start again?"));
ok("stop is not opt-in", !isOptInRequest("stop"));

// ── the replies say what does and does not stop ──
{
  const out = optOutConfirmation();
  ok("opt-out reply promises no more offers", /offers|reminders/i.test(out));
  ok("opt-out reply keeps order updates", /order/i.test(out));
  ok("opt-out reply explains the way back", /START/.test(out));
  ok("opt-in reply confirms", /\w/.test(optInConfirmation()));
}

// ── the two are mutually exclusive on every input we handle ──
for (const text of ["unsubscribe", "stop messages", "start", "subscribe", "remove me"]) {
  ok(`not both for "${text}"`, !(isOptOutRequest(text) && isOptInRequest(text)));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
