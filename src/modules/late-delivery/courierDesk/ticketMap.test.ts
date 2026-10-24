// Run with `npm run test:courier-map`.
import { parcelStateFromDelhivery, parcelStateFromShadowfax, ticketStateFromStatus, stallLevelFor } from "@late/courierDesk/ticketMap";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  good ? pass++ : fail++;
  if (!good) console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};
const NDR = new Set(["EOD-104", "EOD-11"]);

eq("dlv delivered", parcelStateFromDelhivery({ status: "Delivered", statusType: "DL" }), "delivered");
eq("dlv RTO in transit is rto, not delivered", parcelStateFromDelhivery({ status: "In Transit", statusType: "RT", instructions: "RTO initiated" }), "rto");
eq("dlv returned text", parcelStateFromDelhivery({ status: "RTO", statusType: "DL" }), "rto");
eq("dlv branch collect is customer side", parcelStateFromDelhivery({ status: "Pending", statusType: "UD", instructions: "Consignee to collect from branch" }), "customer_side");
eq("dlv NDR code is customer side", parcelStateFromDelhivery({ status: "Pending", statusType: "UD", statusCode: "EOD-104" }, NDR), "customer_side");
eq("dlv out for delivery", parcelStateFromDelhivery({ status: "Out for delivery", statusType: "UD" }), "out_for_delivery");
eq("dlv moving", parcelStateFromDelhivery({ status: "In Transit", statusType: "UD" }), "in_transit");
eq("dlv nothing known", parcelStateFromDelhivery(null), "unknown");

eq("sfx delivered", parcelStateFromShadowfax({ status: "delivered" }), "delivered");
eq("sfx rts", parcelStateFromShadowfax({ status: "rts_initiated" }), "rto");
eq("sfx customer not contactable", parcelStateFromShadowfax({ status: "nc" }), "customer_side");
eq("sfx in transit", parcelStateFromShadowfax({ status: "bag_in_transit" }), "in_transit");
eq("sfx unknown", parcelStateFromShadowfax(null), "unknown");

eq("status resolved", ticketStateFromStatus("Resolved", true), "resolved");
eq("status closed", ticketStateFromStatus("Closed", false), "closed");
eq("status open, no reply", ticketStateFromStatus("Open", false), "open");
eq("status open, replied", ticketStateFromStatus("In Progress", true), "replied");

eq("stall 2 d", stallLevelFor(2, "open"), 0);
eq("stall 3 d", stallLevelFor(3, "open"), 1);
eq("stall 6 d", stallLevelFor(6, "replied"), 2);
eq("stall 9 d", stallLevelFor(9, "open"), 3);
eq("closed never stalls", stallLevelFor(20, "closed"), 0);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
