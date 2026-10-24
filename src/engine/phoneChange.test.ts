// Run with `npx tsx lib/phoneChange.test.ts`. A number written in plain words is a phone change; nothing else is.
import assert from "node:assert/strict";
import { phoneChangeNumber } from "@engine/phoneChange";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };

for (const [m, want] of [
  ["9000100003 new mobile no.", "9000100003"],
  ["My correct number is 9876543210", "9876543210"],
  ["new number 9876543210", "9876543210"],
  ["change the contact no to +91 9876543210", "9876543210"],
  ["Please use this phone number instead 9000100010", "9000100010"],
  ["number changed 9000100004", "9000100004"],
  ["Update phone: 9000100027 it was wrong", "9000100027"],
] as const) eq(`a phone change: ${m}`, phoneChangeNumber(m), want);

for (const m of [
  "9876543210",                                                       // a bare number can be an order lookup
  "my number is 9876543210",                                          // says number, but nothing about changing it
  "Rose apartments b building near river bridge , pune, 411011", // an address
  "new mobile no 9000100003 and address 411011",                      // a pincode beside it: an address
  "call 9876543210 or 9123456789 new number",                         // two numbers
  "Address is same but only contact no. changed",                     // no number
  "new order 9876543210 please",                                      // not about a phone
  "x".repeat(150) + " new mobile 9876543210",                         // too long to be this
  "", null, undefined,
] as const) eq(`not a phone change: ${String(m).slice(0, 50)}`, phoneChangeNumber(m as string), null);
eq("a number starting 5 is not a mobile", phoneChangeNumber("new mobile 5876543210"), null);
console.log(`phoneChange: ${passed} assertions passed`);
