// Run with `npx tsx lib/courierAddressEdit.test.ts`. An address sent as several messages becomes one; the pincode is found; a courier edit we just confirmed is recognised.
import assert from "node:assert/strict";
import { composeAddress, pincodeOf, recentCourierAddressEdit } from "@late/courierAddressEdit";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };

eq("the pincode is the last six-digit group", [pincodeOf("201301 greenfield nagar"), pincodeOf("Flat 12, Pune 411011"), pincodeOf("no pincode"), pincodeOf("phone 9876543210"), pincodeOf(null)], ["201301", "411011", null, null, null]);
eq("a pincode never starts with 0 and is not part of a longer number", [pincodeOf("012345"), pincodeOf("1234567")], [null, null]);

// the AJUKI710081 burst, exactly as the customer sent it
const burst = ["Greenfield nagar wat no 7", "201301  greenfield nagar", "Wat no 7", "Temple lane", "Ok"];
const keep = (b: string) => !/^ok$/i.test(b);
const addr = composeAddress(burst, keep);
eq("all of it is sent, not only the second message, and without repeating itself", addr, "Greenfield nagar wat no 7, 201301 greenfield nagar, Temple lane");
eq("it carries the pincode the courier needs as a field", pincodeOf(addr), "201301");
eq("a message that is a button or an acknowledgement is left out", composeAddress(["Update address", "12 MG Road Pune 411001", "ok"], (b) => !/^(update address|ok)$/i.test(b)), "12 MG Road Pune 411001");
eq("the same message twice is one", composeAddress(["12 MG Road", "12 mg road", "Pune 411001"]), "12 MG Road, Pune 411001");
eq("empty and blank messages are dropped", composeAddress(["", "  ", "Pune 411001"]), "Pune 411001");
{
  const long = Array.from({ length: 12 }, (_, i) => `Building number ${i + 1} some long street name`);
  const out = composeAddress([...long, "Pune 411001"], undefined, 240);
  eq("capped at the courier's limit, keeping the latest", [out.length <= 240, out.endsWith("Pune 411001")], [true, true]);
}
eq("one message is itself", composeAddress(["Rose apartments b building near river bridge , pune, 411011"]), "Rose apartments b building near river bridge , pune, 411011");

// what we just told the customer
const NOW = Date.parse("2026-10-21T06:00:00Z");
const stub = (rows: { body: string }[] | null, error: unknown = null) => { const c: Record<string, unknown> = {}; for (const k of ["select", "eq", "gte", "order", "limit"]) c[k] = () => c; (c as { then: unknown }).then = (res: (v: unknown) => void) => res({ data: rows, error }); return { from: () => c } as never; };
(async () => {
  eq("a Shadowfax confirmation", await recentCourierAddressEdit(stub([{ body: "Thanks — I've passed your new address to the courier and they'll reattempt delivery." }]), "9000000001", 10, NOW), true);
  eq("a Delhivery confirmation", await recentCourierAddressEdit(stub([{ body: "Thanks — I've updated the delivery address and the courier will try again on Thursday." }]), "9000000001", 10, NOW), true);
  eq("a queued one", await recentCourierAddressEdit(stub([{ body: "Thanks — I've saved your correct address. Your parcel is out with the courier right now" }]), "9000000001", 10, NOW), true);
  eq("a phone edit is not an address edit", await recentCourierAddressEdit(stub([{ body: "Thanks — I've passed your new phone to the courier and they'll reattempt delivery." }]), "9000000001", 10, NOW), false);
  eq("nothing recent", await recentCourierAddressEdit(stub([]), "9000000001", 10, NOW), false);
  eq("a read error is false, never a throw", await recentCourierAddressEdit(stub(null, { message: "x" }), "9000000001", 10, NOW), false);
  console.log(`courierAddressEdit: ${passed} assertions passed`);
})();
