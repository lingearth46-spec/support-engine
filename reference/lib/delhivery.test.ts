// The NDR toolkit — batch submit, reattempt, defer, edit-details, the Get NDR
// Status lookup, and the working-day helper.
//
// Every failure mode here is silent: a reattempt Delhivery never honoured
// (request_id thrown away), a defer whose date landed on a Sunday, a status
// response read off the wrong array. So the tests pin the exact request
// Delhivery receives and every branch of the outcome reader.
//
// No network: `fetch` is replaced with a stub that records the last request and
// returns a scripted body. Run with `npm run test:delhivery`.

process.env.DELHIVERY_API_TOKEN ||= "test-token";

import {
  requestDelhiveryNdrActions,
  requestDelhiveryReattempt,
  deferDelhiveryDelivery,
  editDelhiveryNdrDetails,
  getDelhiveryNdrStatus,
  ndrOutcomeForWaybill,
  nextWorkingDay,
  DEFER_PREFERRED_CODES,
  DEFER_ELIGIBLE_CODES,
  NDR_ELIGIBLE_CODES,
  MAXED_OUT_CODES,
  TRANSIENT_NDR_REJECT,
} from "./delhivery";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  good ? pass++ : fail++;
  if (!good) console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};
const ok = (name: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  if (!cond) console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
};

// ── fetch stub ───────────────────────────────────────────────────────────────

type Captured = { url: string; method?: string; headers: Record<string, string>; body: unknown };
let lastRequest: Captured | null = null;
let nextBody: unknown = {};
let nextStatus = 200;

const scriptResponse = (body: unknown, status = 200) => { nextBody = body; nextStatus = status; };

globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
  let body: unknown = init?.body;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { /* leave as string */ }
  }
  lastRequest = { url: String(url), method: init?.method, headers, body };
  const text = typeof nextBody === "string" ? nextBody : JSON.stringify(nextBody);
  return {
    ok: nextStatus >= 200 && nextStatus < 300,
    status: nextStatus,
    text: async () => text,
    json: async () => (typeof nextBody === "string" ? JSON.parse(nextBody) : nextBody),
  };
}) as unknown as typeof fetch;

const OK_201 = { message: "Request submitted successfully!", request_id: "UPL13988363159644869096" };

const run = async () => {
  // ── requestDelhiveryReattempt: payload shape + request_id ──────────────────

  scriptResponse(OK_201, 201);
  {
    const r = await requestDelhiveryReattempt("60000000000001");
    eq("reattempt: returns request_id as uploadId", r, { ok: true, uploadId: "UPL13988363159644869096" });
    eq("reattempt: hits /api/p/update", lastRequest!.url, "https://track.delhivery.com/api/p/update");
    eq("reattempt: Token auth header", lastRequest!.headers["authorization"], "Token test-token");
    eq("reattempt: body is data:[{waybill, act:RE-ATTEMPT}] with no action_data", lastRequest!.body, {
      data: [{ waybill: "60000000000001", act: "RE-ATTEMPT" }],
    });
  }

  // The old code read `data.upl`/`data.upload_id` and always got undefined.
  scriptResponse({ message: "ok", upl: "UPL-legacy" }, 201);
  eq("reattempt: falls back to legacy `upl` key", (await requestDelhiveryReattempt("x")).uploadId, "UPL-legacy");

  scriptResponse({ message: "ok" }, 201);
  eq("reattempt: no id in body → uploadId undefined, still ok",
    await requestDelhiveryReattempt("x"), { ok: true, uploadId: undefined });

  scriptResponse({ detail: "Authentication credentials were not provided" }, 401);
  {
    let msg = "";
    try { await requestDelhiveryReattempt("x"); } catch (e) { msg = (e as Error).message; }
    ok("reattempt: a non-2xx body is surfaced, not swallowed", /credentials/i.test(msg), `got "${msg}"`);
  }

  // ── deferDelhiveryDelivery: action_data nesting + date guard ───────────────

  scriptResponse(OK_201, 201);
  {
    const r = await deferDelhiveryDelivery("AWB1", "2026-09-07");
    eq("defer: returns request_id", r.uploadId, "UPL13988363159644869096");
    eq("defer: deferred_date nests inside action_data (not flat)", lastRequest!.body, {
      data: [{ waybill: "AWB1", act: "DEFER_DLV", action_data: { deferred_date: "2026-09-07" } }],
    });
  }
  {
    let msg = "";
    try { await deferDelhiveryDelivery("AWB1", "07-09-2026"); } catch (e) { msg = (e as Error).message; }
    ok("defer: rejects a non-YYYY-MM-DD date before calling out", /YYYY-MM-DD/.test(msg), `got "${msg}"`);
  }

  // ── editDelhiveryNdrDetails: only changed fields, under action_data ────────

  scriptResponse(OK_201, 201);
  {
    await editDelhiveryNdrDetails("AWB2", { phone: "+91 90001 00024" });
    eq("edit: phone-only change, normalised to 10 digits, under action_data", lastRequest!.body, {
      data: [{ waybill: "AWB2", act: "EDIT_DETAILS", action_data: { phone: "9000100024" } }],
    });
  }
  {
    let msg = "";
    try { await editDelhiveryNdrDetails("AWB2", {}); } catch (e) { msg = (e as Error).message; }
    ok("edit: nothing to change is rejected", /nothing to change/i.test(msg), `got "${msg}"`);
  }

  // ── requestDelhiveryNdrActions: batching ──────────────────────────────────

  scriptResponse(OK_201, 201);
  {
    const r = await requestDelhiveryNdrActions([
      { waybill: "A", act: "RE-ATTEMPT" },
      { waybill: "B", act: "DEFER_DLV", action_data: { deferred_date: "2026-09-07" } },
    ]);
    eq("batch: one request_id covers the whole batch", r.requestId, "UPL13988363159644869096");
    eq("batch: both items ride in one data[] array",
      (lastRequest!.body as { data: unknown[] }).data.length, 2);
  }
  {
    let msg = "";
    const many = Array.from({ length: 51 }, (_, i) => ({ waybill: `W${i}`, act: "RE-ATTEMPT" as const }));
    try { await requestDelhiveryNdrActions(many); } catch (e) { msg = (e as Error).message; }
    ok("batch: refuses over the 50-item cap", /cap/i.test(msg), `got "${msg}"`);
  }

  // ── getDelhiveryNdrStatus: reads success_wbns / failed_wbns ───────────────

  const PARTIAL = {
    status: "Partial",
    failed_wbns: [{ waybill: "12410124541", message: "Package in incorrect status", action: "RE-ATTEMPT" }],
    success_wbns: [{ waybill: "12410125716", message: "", action: "DEFER_DLV" }],
    request_id: "UPL66",
  };

  scriptResponse({ success_wbns: [{ waybill: "W1", message: "", action: "RE-ATTEMPT" }], failed_wbns: [] }, 200);
  eq("status: all-success → accepted", (await getDelhiveryNdrStatus("UPL1")).state, "accepted");

  scriptResponse({ success_wbns: [], failed_wbns: [{ waybill: "W1", message: "Package in incorrect status", action: "RE-ATTEMPT" }] }, 200);
  eq("status: all-failed → rejected", (await getDelhiveryNdrStatus("UPL1")).state, "rejected");

  scriptResponse(PARTIAL, 200);
  eq("status: partial batch → rejected (draws a look)", (await getDelhiveryNdrStatus("UPL1")).state, "rejected");

  scriptResponse({ success_wbns: [], failed_wbns: [] }, 200);
  eq("status: both arrays empty → pending", (await getDelhiveryNdrStatus("UPL1")).state, "pending");

  scriptResponse({}, 404);
  eq("status: 404 {} → pending (still processing)", (await getDelhiveryNdrStatus("UPL1")).state, "pending");

  scriptResponse("<html>bad gateway</html>", 200);
  eq("status: non-JSON → unknown (lookup itself is broken)", (await getDelhiveryNdrStatus("UPL1")).state, "unknown");

  scriptResponse(PARTIAL, 200);
  {
    const r = await getDelhiveryNdrStatus("UPL1");
    eq("status: raw passed through", (r.raw as { request_id: string }).request_id, "UPL66");
    eq("status: request carries ?verbose=true and the id in the path",
      lastRequest!.url, "https://track.delhivery.com/api/cmu/get_bulk_upl/UPL1?verbose=true");
  }

  // ── ndrOutcomeForWaybill: per (waybill, action) pair ──────────────────────

  eq("outcome: success pair → accepted",
    ndrOutcomeForWaybill(PARTIAL, "12410125716", "DEFER_DLV").state, "accepted");
  eq("outcome: failed pair → rejected, message surfaced",
    ndrOutcomeForWaybill(PARTIAL, "12410124541", "RE-ATTEMPT"),
    { state: "rejected", message: "Package in incorrect status" });
  eq("outcome: waybill not in either array → pending",
    ndrOutcomeForWaybill(PARTIAL, "99999", "RE-ATTEMPT").state, "pending");
  eq("outcome: right waybill, wrong action → pending (not a match)",
    ndrOutcomeForWaybill(PARTIAL, "12410125716", "RE-ATTEMPT").state, "pending");
  eq("outcome: action matched loosely (re-attempt vs RE-ATTEMPT)",
    ndrOutcomeForWaybill(
      { success_wbns: [{ waybill: "W1", message: "", action: "RE-ATTEMPT" }], failed_wbns: [] },
      "W1", "re-attempt",
    ).state, "accepted");

  // ── code sets ────────────────────────────────────────────────────────────

  eq("defer-preferred codes", [...DEFER_PREFERRED_CODES].sort(), ["EOD-11", "EOD-16", "EOD-6"]);
  ok("EOD-86 is NOT deferrable (rider never went)", !DEFER_ELIGIBLE_CODES.has("EOD-86"));
  ok("EOD-86 IS re-attemptable", NDR_ELIGIBLE_CODES.has("EOD-86"));
  ok("every defer-preferred code is itself defer-eligible",
    [...DEFER_PREFERRED_CODES].every((c) => DEFER_ELIGIBLE_CODES.has(c)));

  // ST-108 (max attempts) removed 2026-09-03 — Delhivery rejects every NDR
  // action on it live. It lives in MAXED_OUT_CODES so the cron can surface it.
  ok("ST-108 is NOT re-attemptable", !NDR_ELIGIBLE_CODES.has("ST-108"));
  ok("ST-108 is NOT deferrable", !DEFER_ELIGIBLE_CODES.has("ST-108"));
  ok("ST-108 IS a maxed-out code", MAXED_OUT_CODES.has("ST-108"));
  ok("NDR-eligible and maxed-out sets are disjoint",
    ![...NDR_ELIGIBLE_CODES].some((c) => MAXED_OUT_CODES.has(c)));
  ok("TRANSIENT_NDR_REJECT matches the live 'part of dispatch' reason",
    TRANSIENT_NDR_REJECT.test("Package is part of dispatch. Cannot update information now"));
  ok("TRANSIENT_NDR_REJECT matches the live 'incorrect status' reason (seen 2026-09-04)",
    TRANSIENT_NDR_REJECT.test("Package in incorrect status"));
  ok("TRANSIENT_NDR_REJECT does NOT match 'maximum attempt count'",
    !TRANSIENT_NDR_REJECT.test("Shipment has reached maximum attempt count"));
  ok("TRANSIENT_NDR_REJECT does NOT match a 'dfd beyond' rejection",
    !TRANSIENT_NDR_REJECT.test("'dfd' is beyond 2026-08-31"));

  // ── nextWorkingDay: tomorrow, skipping Sunday ────────────────────────────

  eq("nwd: midweek Wed → Thu", nextWorkingDay(new Date("2026-09-02T12:00:00Z")), "2026-09-03");
  eq("nwd: Fri → Sat (Delhivery works Saturdays)", nextWorkingDay(new Date("2026-09-04T12:00:00Z")), "2026-09-05");
  eq("nwd: Sat → Mon (Sunday skipped)", nextWorkingDay(new Date("2026-09-05T12:00:00Z")), "2026-09-07");
  eq("nwd: 23:00 IST Sat (17:30 UTC) still lands on Mon",
    nextWorkingDay(new Date("2026-09-05T17:30:00Z")), "2026-09-07");

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run();
