// Run with `npx tsx lib/addressKeep.test.ts`. Real replies from 22-23 Oct to the "reply with your updated full address" prompt.
import assert from "node:assert/strict";
import { keepsAddress, KEEP_ADDRESS_REPLY, KEEP_ADDRESS_CONFIRM } from "@/lib/addressKeep";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };

for (const m of ["Yahi address hai", "Sorry Same adress", "Ok", "Same address", "No no it's ok", "No sorry", "This address is right", "Okay", "sorry by mistake", "Address is correct", "no change"]) eq(`keeps: ${m}`, keepsAddress(m), true);
for (const m of [
  "Don't conform tha order",              // declining the order
  "On edit",                               // unclear: a person
  "Pk",                                    // unclear: a person
  "Jubilee hills",                         // a partial address
  "PSG art and science College coimbatore",
  "Tungarli Lonavala, house number 122 , jakhamata mandir , Vodafone tower",
  "Flat 4, MG Road Pune 411001",           // an address with a pincode
  "Same address 411001",                   // a pincode beside it: an address
  "This is not the right address",
  "address is wrong",
  "cancel my order",
  "I want to change the address",
  "I do not want this order",
  "",
] as const) eq(`does not keep: ${m}`, keepsAddress(m), false);
eq("nothing", [keepsAddress(null), keepsAddress(undefined)], [false, false]);
eq("a long message is not a keep", keepsAddress("same ".repeat(30)), false);
eq("the reply promises nothing and leaves the order alone", [/left your address as it is/.test(KEEP_ADDRESS_REPLY), /tap Confirm/.test(KEEP_ADDRESS_CONFIRM), /confirmed|updated/i.test(KEEP_ADDRESS_REPLY)], [true, true, false]);
console.log(`addressKeep: ${passed} assertions passed`);
