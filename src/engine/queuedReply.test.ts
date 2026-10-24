// Run with `npx tsx lib/queuedReply.test.ts`. The 11:00 answer to an overnight message that is only a greeting or a tracking word.
import { queuedBareReply, TRACK_QUEUED_REPLY, GREETING_REPLY } from "@engine/queuedReply";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
const kind = (m: string | null) => queuedBareReply(m)?.kind ?? null;

// Real overnight messages from 9 Oct.
eq("Hey", kind("Hey"), "queued_greeting");
eq("Hi", kind("Hi"), "queued_greeting");
eq("Hii", kind("Hii"), "queued_greeting");
eq("Hello", kind("Hello"), "queued_greeting");
eq("greeting text is the existing fixed welcome", queuedBareReply("Hey")?.text, GREETING_REPLY);
eq("the website's prefilled text", kind("Hi, I have a question about AJUKI"), "queued_greeting");
eq("Track", kind("Track"), "queued_track");
eq("tracking", kind("tracking"), "queued_track");
eq("Track my order", kind("Track my order"), "queued_track");
eq("please track order", kind("please track order"), "queued_track");
eq("tracking id", kind("Tracking id"), "queued_track");
eq("order status", kind("Order status"), "queued_track");
eq("track text is the fixed line", queuedBareReply("Track")?.text, TRACK_QUEUED_REPLY);
eq("track tag", queuedBareReply("Track")?.tag, "order_status");
eq("one order on the number: left to the bot, which has its real status", queuedBareReply("Track", { ownOrderCount: 1 }), null);
eq("two orders: the fixed line", queuedBareReply("Track", { ownOrderCount: 2 })?.kind, "queued_track");
eq("no orders: the fixed line", queuedBareReply("Track", { ownOrderCount: 0 })?.kind, "queued_track");
eq("a greeting is answered whatever the order count", queuedBareReply("Hey", { ownOrderCount: 1 })?.kind, "queued_greeting");
eq("where is my order is a real question, left to the bot", kind("Where is my order"), null);

// Everything else still goes to the bot.
eq("an order number is not bare", kind("track AJUKI710013"), null);
eq("a real question", kind("Where is my order, it was due yesterday"), null);
eq("a greeting with content", kind("Hi, I want to return my order"), null);
eq("a complaint", kind("Hello?? nobody is replying to me"), null);
eq("a product question", kind("How much is the gold bracelet"), null);
eq("empty", kind(""), null);
eq("null", kind(null), null);
eq("very long", kind("track " + "x".repeat(60)), null);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
