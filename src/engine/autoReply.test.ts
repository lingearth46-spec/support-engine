// Run with `npx tsx lib/autoReply.test.ts`.
// Another business's greeting and scam menus are not customers (real messages from 9 Oct 2026), and real customers are not either.
import { notACustomer } from "@engine/autoReply";

let passed = 0, failed = 0;
const eq = <T>(name: string, got: T, want: T) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; console.error(`FAIL: ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

// Real messages that arrived and were answered by the bot.
eq("another business's greeting (1)", notACustomer("Thank you for contacting vishal tent catters! Please let us know how we can help you."), "auto_reply");
eq("another business's greeting (2)", notACustomer("Thank you for contacting Karthik! Please let us know how we can help you."), "auto_reply");
eq("the scam menu", notACustomer("Thank you for contacting *Customer Support* Tell Me How Can I Help you. 1. *Use Another Card* ✅ 2. *Limit Increase*✅ New Apply"), "spam");
eq("a scam menu with no greeting", notACustomer("1. Use another card 2. Limit increase 3. Apply for a new loan today"), "spam");

// Other shapes of a business greeting.
eq("welcome to + hours", notACustomer("Welcome to Sharma Traders! Our business hours are 10 AM to 8 PM. We will get back to you soon."), "auto_reply");
eq("away message", notACustomer("Hello! Thanks for reaching out to us. We are currently closed and will get back to you as soon as we can."), "auto_reply");
eq("explicit auto reply", notACustomer("Thanks for contacting Zoya Boutique. This is an automated message — we will reply shortly."), "auto_reply");

// Customers, which must never be swallowed.
eq("customer thanks us", notACustomer("Thank you for contacting me back, my order arrived today"), null);
eq("thank you for contacting us (customer)", notACustomer("thank you for contacting us, I will wait for the update on my order"), null);
eq("a plain question", notACustomer("Where is my order AJUKI710013? It was supposed to come yesterday."), null);
eq("a greeting from a customer", notACustomer("Hello, I have a question about my bracelet size please"), null);
eq("a thank you", notACustomer("Thank you so much for the quick delivery, loved the bracelet!"), null);
eq("a short message", notACustomer("Hi"), null);
eq("a customer mentioning a card for payment", notACustomer("Can I pay with my credit card instead of cash on delivery for this order?"), null);
eq("a customer asking about a loan-free offer", notACustomer("Is there any investment needed to become a reseller of your jewellery? Please tell me"), null);
eq("empty", notACustomer(""), null);
eq("null", notACustomer(null), null);
eq("a very long message is left to the bot", notACustomer("Thank you for contacting " + "x".repeat(700)), null);

// a forwarded advert is not a customer; a customer who mentions an app or a code AND their order is
const advert = "🔥 ₹20 instant FamCash on Fam App - India's most loved UPI app for lightning-fast payments 🔥 How it works: 1. Download Fam App 2. Use code ABC to get cashback on your first payment today only, hurry up and share with friends";
eq("a forwarded app advert is spam", notACustomer(advert), "spam");
eq("a customer who mentions the app and their order is a customer", notACustomer("Where is my order AJUKI710013 I downloaded the app and used code for cashback but order not delivered yet please help me now thanks a lot"), null);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
