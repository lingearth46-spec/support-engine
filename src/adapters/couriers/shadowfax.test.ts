// The Shadowfax NDR helpers for delivery_attempt_failed_v2 — reopenShadowfaxNdr,
// updateShadowfaxDeliveryDetails, shadowfaxOrderStatus.
//
// Every one of these fires an order_update and then re-reads the parcel, because
// Shadowfax answers "Request accepted." to changes that never happen. The tests
// pin the exact request body (only the section that changed, never a null
// section — the documented spec bug) and every branch of the read-back:
// confirmed, silent no-op, hard 400, and the intercity-pincode pre-reject.
//
// No network: `fetch` is stubbed to route by URL + method and return a scripted
// body. The 6s read-back wait is collapsed so the suite runs fast.
// Run with `npm run test:shadowfax`.

process.env.SHADOWFAX_TOKEN ||= "test-token";

import {
  shadowfaxOrderStatus,
  reopenShadowfaxNdr,
  updateShadowfaxDeliveryDetails,
} from "@adapters/couriers/shadowfax";

let pass = 0;
let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};
const ok = (name: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  if (!cond) console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
};

// ── collapse the read-back wait ──────────────────────────────────────────────
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number) => {
  if ((ms ?? 0) >= 1000) {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }
  return realSetTimeout(fn, ms);
}) as typeof setTimeout;

// ── fetch stub ──────────────────────────────────────────────────────────────
type Req = { url: string; method: string; body: Record<string, unknown> | undefined };
let calls: Req[] = [];
let handler: (req: Req) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const method = (init?.method ?? "GET").toUpperCase();
  let body: unknown = init?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* leave */
    }
  }
  const req: Req = { url: String(url), method, body: body as Record<string, unknown> | undefined };
  calls.push(req);
  const { status, body: resBody } = handler(req);
  const text = typeof resBody === "string" ? resBody : JSON.stringify(resBody);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof resBody === "string" ? JSON.parse(resBody) : resBody),
  } as Response;
}) as typeof fetch;

const isUpdate = (r: Req) => r.method === "POST" && r.url.endsWith("/v3/clients/order_update/");
const isTrack = (r: Req) => r.method === "GET" && r.url.includes("/track/");
const reset = () => {
  calls = [];
};

const run = async () => {
  // ── shadowfaxOrderStatus ──────────────────────────────────────────────────
  reset();
  handler = (r) => (isTrack(r) ? { status: 200, body: { order_details: { status: "NC" } } } : { status: 404, body: {} });
  eq("orderStatus: lower-cases order_details.status", await shadowfaxOrderStatus("SF1"), "nc");

  reset();
  handler = () => ({ status: 500, body: "oops" });
  eq("orderStatus: unreadable → null", await shadowfaxOrderStatus("SF1"), null);

  // ── reopenShadowfaxNdr: payload shape ─────────────────────────────────────
  reset();
  handler = (r) =>
    isUpdate(r)
      ? { status: 200, body: { message: "Request accepted." } }
      : { status: 200, body: { order_details: { status: "nc" } } };
  {
    const res = await reopenShadowfaxNdr("SF47850936");
    const post = calls.find(isUpdate)!;
    eq("reopen: body is awb_number (singular) + status_update only", post.body, {
      awb_number: "SF47850936",
      status_update: { status: "reopen_ndr" },
    });
    ok("reopen: no other sections sent (no null delivery_details etc.)", Object.keys(post.body!).length === 2);
    ok("reopen: from nc, read-back shows unchanged → ok:false (expected, not an error)", res.ok === false, JSON.stringify(res));
    eq("reopen: reports the status it read back", res.status, "nc");
  }

  // ── reopenShadowfaxNdr: genuinely reattempting ────────────────────────────
  reset();
  handler = (r) =>
    isUpdate(r)
      ? { status: 200, body: { message: "Request accepted." } }
      : { status: 200, body: { order_details: { status: "reopen_ndr" } } };
  eq("reopen: parcel becomes reopen_ndr → ok:true", (await reopenShadowfaxNdr("SF1")).ok, true);

  reset();
  handler = (r) =>
    isUpdate(r)
      ? { status: 200, body: { message: "Request accepted." } }
      : { status: 200, body: { order_details: { status: "assigned_for_delivery" } } };
  eq("reopen: parcel already assigned_for_delivery → ok:true", (await reopenShadowfaxNdr("SF1")).ok, true);

  // ── reopenShadowfaxNdr: hard 400, no read-back ────────────────────────────
  reset();
  handler = () => ({ status: 400, body: { message: "Status transition from recd_at_fwd_hub to ndr is not allowed" } });
  {
    const res = await reopenShadowfaxNdr("SF1");
    ok("reopen: 400 → ok:false with the reason", res.ok === false && /not allowed/i.test(res.note), res.note);
    ok("reopen: 400 → does not bother reading the parcel back", !calls.some(isTrack));
  }

  // ── updateShadowfaxDeliveryDetails: contact-only payload shape ─────────────
  reset();
  handler = (r) =>
    isUpdate(r)
      ? { status: 200, body: { message: "Request accepted." } }
      : { status: 200, body: { order_details: { delivery_details: { contact: "" }, } } }; // contact masked
  {
    const res = await updateShadowfaxDeliveryDetails("SF1", { contact: "+91 98765 43210" });
    const post = calls.find(isUpdate)!;
    eq("update: body carries ONLY delivery_details.contact (no null sections)", post.body, {
      awb_number: "SF1",
      delivery_details: { contact: "9876543210" },
    });
    ok("update: contact masked on read-back → ok:true (submitted), applied empty", res.ok === true && res.applied.length === 0, JSON.stringify(res));
    ok("update: note says submitted-but-unconfirmed", /submitted/i.test(res.note), res.note);
  }

  // ── updateShadowfaxDeliveryDetails: address confirmed by read-back ─────────
  reset();
  handler = (r) =>
    isUpdate(r)
      ? { status: 200, body: { message: "Request accepted." } }
      : {
          status: 200,
          body: {
            order_details: { delivery_details: { address_line_1: "New Flat 4B Indiranagar", city: "Bengaluru" } },
            tracking_details: [{ status_id: "customer_details_updated", status: "Customer Details Updated" }],
          },
        };
  {
    const res = await updateShadowfaxDeliveryDetails("SF1", { address: "New Flat 4B, Indiranagar, Bengaluru 560038" });
    ok("update: address echoed back + update scan → applied includes address", res.ok === true && res.applied.includes("address"), JSON.stringify(res));
  }

  // ── updateShadowfaxDeliveryDetails: silent no-op vs hard 400 ──────────────
  reset();
  handler = (r) =>
    isUpdate(r)
      ? { status: 200, body: { message: "Request accepted." } }
      : { status: 200, body: { order_details: { delivery_details: {} }, tracking_details: [] } };
  {
    const res = await updateShadowfaxDeliveryDetails("SF1", { address: "Some Long Address Line, City 560001" });
    ok("update: 200 but nothing changed on read-back → ok:true, applied empty (submitted)", res.ok === true && res.applied.length === 0, JSON.stringify(res));
  }

  reset();
  handler = () => ({ status: 400, body: { message: "Customer details could not be updated for SF1 due to invalid status. Current status is Delivered to customer" } });
  {
    const res = await updateShadowfaxDeliveryDetails("SF1", { contact: "9876543210" });
    ok("update: hard 400 → ok:false with the reason", res.ok === false && /invalid status/i.test(res.note), res.note);
    ok("update: hard 400 is NOT flagged locked", res.locked !== true);
  }

  // ── updateShadowfaxDeliveryDetails: "active runsheet" → locked, not failed ──
  reset();
  handler = () => ({ status: 400, body: { message: "Customer details could not be updated for SF00000000012 as shipment is in active runsheet." } });
  {
    const res = await updateShadowfaxDeliveryDetails("SF1", { contact: "9000100007" });
    ok("update: 'active runsheet' → ok:false AND locked:true", res.ok === false && res.locked === true, JSON.stringify(res));
    ok("update: locked note carries the runsheet reason", /runsheet/i.test(res.note), res.note);
  }

  // ── updateShadowfaxDeliveryDetails: intercity pincode pre-reject ──────────
  reset();
  handler = (r) =>
    isTrack(r)
      ? { status: 200, body: { order_details: { delivery_details: { pincode: 302034 } } } }
      : { status: 200, body: { message: "Request accepted." } };
  {
    const res = await updateShadowfaxDeliveryDetails("SF1", { address: "X", pincode: "560038" });
    ok("update: non-intra-city pincode rejected up front", res.ok === false && /intra-city|intercity/i.test(res.note), res.note);
    ok("update: intercity pincode → no order_update POST fired at all", !calls.some(isUpdate));
  }

  // ── updateShadowfaxDeliveryDetails: intra-city pincode allowed through ─────
  reset();
  handler = (r) =>
    isUpdate(r)
      ? { status: 200, body: { message: "Request accepted." } }
      : { status: 200, body: { order_details: { delivery_details: { pincode: 560001 } }, tracking_details: [] } };
  {
    const res = await updateShadowfaxDeliveryDetails("SF1", { pincode: "560038" });
    const post = calls.find(isUpdate)!;
    eq("update: intra-city pincode is sent as a Number", (post.body!.delivery_details as Record<string, unknown>).pincode, 560038);
    ok("update: pincode is async — ok:true even though read-back still shows the old one", res.ok === true, JSON.stringify(res));
  }

  // ── 21 Oct (AJUKI710081): a pincode the parcel already holds must not drop the address that came with it ──
  reset();
  handler = (r) => {
    if (isUpdate(r)) {
      const dd = (r.body?.delivery_details ?? {}) as Record<string, unknown>;
      return "pincode" in dd
        ? { status: 400, body: { message: "Current Delivery Pincode and requested pincode for SF1 are same" } }
        : { status: 200, body: { message: "Request accepted." } };
    }
    return { status: 200, body: { order_details: { delivery_details: { address_line_1: "wat no 7 temple lane", pincode: "201301" } }, tracking_details: [] } };
  };
  {
    const res = await updateShadowfaxDeliveryDetails("SF1", { address: "Wat no 7, Temple lane, Greenfield, Meadowtown", pincode: "201301" });
    const posts = calls.filter(isUpdate);
    ok("same pincode: first the whole update is tried, then the address on its own", posts.length === 2 && "pincode" in (posts[0].body!.delivery_details as object) && !("pincode" in (posts[1].body!.delivery_details as object)), JSON.stringify(posts.map((x) => x.body)));
    ok("same pincode: the address was sent, and the result is ok", res.ok === true && res.applied.includes("address"), JSON.stringify(res));
    ok("same pincode: it says the pincode was already set", res.applied.includes("pincode") && /already 201301/.test(res.note), JSON.stringify(res));
  }
  reset();
  handler = (r) => (isUpdate(r) ? { status: 400, body: { message: "Current Delivery Pincode and requested pincode for SF1 are same" } } : { status: 200, body: {} });
  {
    const res = await updateShadowfaxDeliveryDetails("SF1", { pincode: "201301" });
    ok("same pincode with nothing else to send: the rejection stands", res.ok === false && calls.filter(isUpdate).length === 1, JSON.stringify(res));
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run();
