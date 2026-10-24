import assert from "node:assert/strict";
import { isAckOnly, isAckAfterClose } from "@engine/ackOnly";

let passed = 0;
const eq = (m: string, want: boolean) => { assert.equal(isAckOnly(m), want, m); passed++; };

for (const m of ["Ok", "ok", "Okay!", "okk", "OK 👍", "Thanks", "Thank you", "thank you so much", "Thanku 🙏", "thx", "Ok thanks", "ok sir", "Thik hai", "theek hai ji", "👍", "🙏", "❤️", "[unhandled message type: reaction]", "Okay, thank you 😊"]) eq(m, true);
for (const m of ["", "Yes", "No", "Fine", "no thanks", "ok but where is my order", "thank you for the update, when will it arrive", "Ok cancel it", "not ok", "ok?? reply", "Thanks, I want to return it", "Hello?"]) eq(m || "(empty)", false);
for (const m of ["Oohh", "ohh", "Ahh", "Hmmm", "Ohhk", "Achaa", "Wow", "Oohh 🙏"]) eq(m, true);
for (const m of ["oh no where is it", "ahh when will it come", "Oohh price?"]) eq(m, false);
// a bare "sure" after our own courtesy close is an acknowledgement (21 Oct: it opened a case); after a question it is an answer
{
  const close = "You're welcome — if you need anything later, just message us here.";
  const ok2 = (name: string, v: boolean) => { if (!v) { console.error("FAIL:", name); process.exit(1); } passed++; };
  ok2("sure! after the courtesy close", isAckAfterClose("sure!", close));
  ok2("Sure after the courtesy close", isAckAfterClose("Sure", close));
  ok2("sure thanks after it", isAckAfterClose("sure thanks", close));
  ok2("not after a question of ours", !isAckAfterClose("sure", "Do you want me to pass this to the team?"));
  ok2("not after a close that asks something", !isAckAfterClose("sure", "You're welcome — anything else?"));
  ok2("not after an ordinary answer", !isAckAfterClose("sure", "Your order AJUKI1 is in transit."));
  ok2("not with no previous message", !isAckAfterClose("sure", null) && !isAckAfterClose("sure", ""));
  ok2("not when there is more to the message", !isAckAfterClose("sure but where is my order", close) && !isAckAfterClose("sure I want to return it now", close));
  ok2("a bare sure on its own is still not an ack", !isAckOnly("sure"));
}
// the "All good" button on the on-its-way message asks nothing (24 Oct)
for (const m of ["All good", "all good", "All good.", "All good!", "  All Good "]) eq(m, true);
for (const m of ["all good but where is it", "is all good?", "not all good", "all"]) eq(m, false);
console.log(`${passed} passed, 0 failed`);
