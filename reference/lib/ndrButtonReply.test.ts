// The delivery_attempt_failed_v2 button handler — every button × every courier,
// the pending-value follow-up, the validation-failure handoff, and the universal
// fallback.
//
// No network and no real Supabase: `fetch` is stubbed (courier calls + the
// no-op WhatsApp/Telegram sends), and `db` is a tiny chainable fake that records
// every write. The 6s Shadowfax read-back wait is collapsed.
// Run with `npm run test:ndrbuttons`.

process.env.DELHIVERY_API_TOKEN ||= "test-token";
process.env.SHADOWFAX_TOKEN ||= "test-token";
// waSupport (pulled in transitively) evaluates the Sanity client at module load,
// so the module under test is imported dynamically inside run() — after this.
process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ||= "test";

import type { PendingAction } from "./ndrButtonReply";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  if (!cond) console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
};

// ── collapse waits ──────────────────────────────────────────────────────────
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number) => {
  if ((ms ?? 0) >= 1000) {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }
  return realSetTimeout(fn, ms);
}) as typeof setTimeout;

// ── fetch stub (courier APIs; WA/Telegram are no-ops with no creds) ──────────
type Hit = { url: string; method: string; body: unknown };
let hits: Hit[] = [];
let delhiveryStatus = 201;
let sfxUpdateStatus = 200;
let sfxUpdateBody: unknown = { message: "Request accepted." };
let sfxTrackBody: unknown = { order_details: { status: "nc", delivery_details: {} }, tracking_details: [] };

const jsonRes = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  }) as Response;

globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  let body: unknown = init?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* leave */
    }
  }
  hits.push({ url: u, method, body });
  if (u.includes("track.delhivery.com/api/p/update")) {
    return jsonRes(delhiveryStatus, { message: "Request submitted successfully!", request_id: "UPL-TEST" });
  }
  if (u.includes("dale.shadowfax.in") && u.endsWith("/support/issue/")) {
    return jsonRes(200, { message: "Issue received", status: "SUCCESS" });
  }
  if (u.includes("dale.shadowfax.in") && u.endsWith("/order_update/")) {
    return jsonRes(sfxUpdateStatus, sfxUpdateBody);
  }
  if (u.includes("dale.shadowfax.in") && u.includes("/track/")) {
    return jsonRes(200, sfxTrackBody);
  }
  return jsonRes(200, {});
}) as typeof fetch;

// ── fake Supabase ───────────────────────────────────────────────────────────
type Call = { table: string; op: string; payload: unknown; single: boolean; filters: [string, ...unknown[]][] };
let calls: Call[] = [];
let msgId = 0;
type Override = (c: Call) => { data?: unknown; error?: unknown } | undefined;
let overrides: Record<string, Override> = {};
let orderRow: Record<string, unknown> | null = null;

function resolve(c: Call): { data: unknown; error: unknown } {
  const ov = overrides[c.table]?.(c);
  if (ov) return { data: ov.data ?? null, error: ov.error ?? null };
  switch (c.table) {
    case "wa_messages":
      return { data: { id: `m${++msgId}`, created_at: new Date().toISOString() }, error: null };
    case "wa_conversations":
      return { data: null, error: null };
    case "orders":
      return { data: c.op === "select" ? (c.single ? orderRow : orderRow ? [orderRow] : []) : null, error: null };
    case "delhivery_ndr_requests":
      return { data: null, error: null };
    case "customer_identifiers":
      return { data: c.op === "select" ? [] : null, error: null };
    case "customers":
      return { data: { id: "cust-1" }, error: null };
    case "support_cases":
      return { data: c.op === "select" ? null : { id: "case-1", status: "ESCALATED" }, error: null };
    case "case_events":
      return { data: null, error: null };
    default:
      return { data: null, error: null };
  }
}

function fakeDb(): { from: (t: string) => unknown; rpc: () => Promise<{ data: null; error: null }> } {
  const build = (table: string) => {
    const state: Call = { table, op: "select", payload: undefined, single: false, filters: [] };
    const settle = () => Promise.resolve(resolve(state)).then((r) => {
      calls.push({ ...state, filters: [...state.filters] });
      return r;
    });
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const p = settle();
            return p.then.bind(p);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => {
              state.single = true;
              return settle();
            };
          }
          return (...args: unknown[]) => {
            if (prop === "insert" || prop === "upsert") {
              state.op = prop;
              state.payload = args[0];
            } else if (prop === "update") {
              state.op = "update";
              state.payload = args[0];
            } else if (prop === "delete") {
              state.op = "delete";
            } else if (prop === "select") {
              // keep op
            } else {
              state.filters.push([prop, ...args]);
            }
            return chain;
          };
        },
      },
    ) as Record<string, unknown>;
    return chain;
  };
  // recordInbound (lib/waSupport.ts) records activity through this DB function.
  return { from: (t: string) => build(t), rpc: async () => ({ data: null, error: null }) };
}

const db = () => fakeDb() as never;

const reset = () => {
  hits = [];
  calls = [];
  overrides = {};
  delhiveryStatus = 201;
  sfxUpdateStatus = 200;
  sfxUpdateBody = { message: "Request accepted." };
  sfxTrackBody = { order_details: { status: "nc", delivery_details: {} }, tracking_details: [] };
  orderRow = null;
};

const outbound = () => calls.filter((c) => c.table === "wa_messages" && c.op === "insert" && (c.payload as { direction?: string })?.direction === "out").map((c) => String((c.payload as { body?: string }).body ?? ""));
const wrote = (table: string, op: string) => calls.some((c) => c.table === table && c.op === op);
const upserts = (table: string) => calls.filter((c) => c.table === table && c.op === "upsert").map((c) => c.payload as Record<string, unknown>);
const updates = (table: string) => calls.filter((c) => c.table === table && c.op === "update").map((c) => c.payload as Record<string, unknown>);
const inserted = (table: string) => calls.filter((c) => c.table === table && c.op === "insert").map((c) => c.payload as Record<string, unknown>);
const hitUrl = (frag: string) => hits.some((h) => h.url.includes(frag));

const DEL_ORDER = { id: "AJUKI1", awb_code: "60000000000004", courier_name: "Delhivery", admin_notes: null, created_at: new Date().toISOString(), address: { name: "Asha" } };
const SFX_ORDER = { id: "AJUKI2", awb_code: "SF123", courier_name: "Shadowfax", admin_notes: null, created_at: new Date().toISOString(), address: { name: "Ravi" } };

const run = async () => {
  const { handleNdrButtonTap, handleNdrPendingReply, isRepeatTap, isNdrButton, ndrCourierOf, pendingActionFresh } =
    await import("./ndrButtonReply");
  const { isSystemNoteLine } = await import("./adminNotes");

  // ── pure helpers ─────────────────────────────────────────────────────────
  ok("isNdrButton: the four v2 titles, case-insensitive", isNdrButton("Deliver tomorrow") && isNdrButton("update PHONE") && !isNdrButton("yes"));
  ok("ndrCourierOf: name substring match", ndrCourierOf("Delhivery Surface") === "delhivery" && ndrCourierOf("Shadowfax") === "shadowfax" && ndrCourierOf("Ekart") === "other");
  ok("pendingActionFresh: >2h old is stale", !pendingActionFresh({ kind: "ndr_phone", order_id: "x", awb: "", courier: "other", set_at: new Date(Date.now() - 3 * 3600_000).toISOString() }));

  // ── Deliver tomorrow × Delhivery ─────────────────────────────────────────
  reset();
  await handleNdrButtonTap(db(), { phone: "9000000001", buttonText: "Deliver tomorrow", order: DEL_ORDER, courier: "delhivery" });
  ok("DT/delhivery: DEFER_DLV submitted to /api/p/update", hitUrl("track.delhivery.com/api/p/update"));
  ok("DT/delhivery: delhivery_ndr_requests row, act DEFER_DLV, source customer", inserted("delhivery_ndr_requests").some((r) => r.act === "DEFER_DLV" && (r.raw as { source?: string })?.source === "customer"));
  {
    const note = String(updates("orders")[0]?.admin_notes ?? "");
    const line = note.split("\n").pop() ?? "";
    ok("DT/delhivery: admin_notes breadcrumb parses as a system note", isSystemNoteLine(line), line);
  }
  ok("DT/delhivery: reply names a weekday", /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/.test(outbound().join(" ")), outbound().join(" | "));

  // ── Deliver tomorrow × Shadowfax, fresh parcel ───────────────────────────
  reset();
  await handleNdrButtonTap(db(), { phone: "9000000002", buttonText: "Deliver tomorrow", order: SFX_ORDER, courier: "shadowfax" });
  ok("DT/shadowfax: reopen_ndr fired best-effort", hitUrl("dale.shadowfax.in/api/v3/clients/order_update/"));
  ok("DT/shadowfax: honest 'still with the courier' reply, no 'tomorrow' promise", /still with the courier/i.test(outbound().join(" ")) && !/tomorrow/i.test(outbound().join(" ")));
  ok("DT/shadowfax fresh: no support case, no Delhivery breadcrumb", !wrote("support_cases", "insert") && !wrote("delhivery_ndr_requests", "insert"));

  // ── Deliver tomorrow × Shadowfax, stuck >5 days ──────────────────────────
  reset();
  const stuck = { ...SFX_ORDER, created_at: new Date(Date.now() - 9 * 86_400_000).toISOString() };
  await handleNdrButtonTap(db(), { phone: "9000000003", buttonText: "Deliver tomorrow", order: stuck, courier: "shadowfax" });
  ok("DT/shadowfax stuck: raiseShadowfaxIssue called", hitUrl("dale.shadowfax.in/api/v1/clients/support/issue/"));
  ok("DT/shadowfax stuck: support case opened", wrote("support_cases", "insert"));

  // ── Update phone × Delhivery → parks pending_action ──────────────────────
  reset();
  await handleNdrButtonTap(db(), { phone: "9000000004", buttonText: "Update phone", order: DEL_ORDER, courier: "delhivery" });
  {
    const pa = upserts("wa_conversations").map((u) => u.pending_action as PendingAction).find(Boolean);
    ok("UP/delhivery: pending_action ndr_phone parked with order+awb+courier", pa?.kind === "ndr_phone" && pa?.order_id === "AJUKI1" && pa?.awb === "60000000000004" && pa?.courier === "delhivery" && pa?.attempts === 0, JSON.stringify(pa));
  }
  ok("UP/delhivery: asks for the 10-digit number", /10-digit/i.test(outbound().join(" ")));
  ok("UP/delhivery: no courier call yet", !hitUrl("/api/p/update"));

  // ── Update address × Shadowfax → parks pending_action ────────────────────
  reset();
  await handleNdrButtonTap(db(), { phone: "9000000005", buttonText: "Update address", order: SFX_ORDER, courier: "shadowfax" });
  {
    const pa = upserts("wa_conversations").map((u) => u.pending_action as PendingAction).find(Boolean);
    ok("UA/shadowfax: pending_action ndr_address parked", pa?.kind === "ndr_address" && pa?.courier === "shadowfax");
  }
  ok("UA/shadowfax: asks for area/city/pincode", /pincode/i.test(outbound().join(" ")));

  // ── pending_action column missing → universal fallback ───────────────────
  reset();
  overrides = { wa_conversations: (c) => (c.op === "upsert" ? { error: { code: "42703", message: "column pending_action does not exist" } } : undefined) };
  await handleNdrButtonTap(db(), { phone: "9000000006", buttonText: "Update phone", order: DEL_ORDER, courier: "delhivery" });
  ok("UP/no-column: falls back to a support case", wrote("support_cases", "insert"));
  ok("UP/no-column: honest fallback reply", /flagged this with our team/i.test(outbound().join(" ")));

  // ── Contact support × Shadowfax ─────────────────────────────────────────
  reset();
  await handleNdrButtonTap(db(), { phone: "9000000007", buttonText: "Contact support", order: SFX_ORDER, courier: "shadowfax" });
  ok("CS/shadowfax: case opened + Shadowfax escalation raised", wrote("support_cases", "insert") && hitUrl("/v1/clients/support/issue/"));
  ok("CS/shadowfax: holding reply", /flagged this with our team and the courier/i.test(outbound().join(" ")));

  // ── Contact support × Delhivery (no Shadowfax escalation) ───────────────
  reset();
  await handleNdrButtonTap(db(), { phone: "9000000008", buttonText: "Contact support", order: DEL_ORDER, courier: "delhivery" });
  ok("CS/delhivery: case opened, no Shadowfax issue call", wrote("support_cases", "insert") && !hitUrl("/support/issue/"));

  // ── pending reply happy path × Delhivery phone ─────────────────────────
  reset();
  orderRow = { ...DEL_ORDER };
  const pendPhone: PendingAction = { kind: "ndr_phone", order_id: "AJUKI1", awb: "60000000000004", courier: "delhivery", attempts: 0, set_at: new Date().toISOString() };
  await handleNdrPendingReply(db(), { phone: "9000000009", text: "9876543210", pending: pendPhone });
  {
    const updateCalls = hits.filter((h) => h.url.includes("/api/p/update"));
    const acts = updateCalls.map((h) => (h.body as { data?: { act?: string }[] }).data?.[0]?.act);
    ok("PR/delhivery phone: EDIT_DETAILS then DEFER_DLV both submitted", acts.includes("EDIT_DETAILS") && acts.includes("DEFER_DLV"), JSON.stringify(acts));
  }
  ok("PR/delhivery phone: pending_action cleared", updates("wa_conversations").some((u) => u.pending_action === null));
  ok("PR/delhivery phone: confirms the update + a weekday", /updated the delivery phone/i.test(outbound().join(" ")) && /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/.test(outbound().join(" ")));

  // ── pending reply happy path × Shadowfax address ───────────────────────
  reset();
  orderRow = { ...SFX_ORDER };
  sfxTrackBody = { order_details: { status: "nc", delivery_details: { pincode: 560001 } }, tracking_details: [] };
  const pendAddr: PendingAction = { kind: "ndr_address", order_id: "AJUKI2", awb: "SF123", courier: "shadowfax", attempts: 0, set_at: new Date().toISOString() };
  // the pending action as the database holds it (the address flow claims it before it sends)
  overrides.wa_conversations = (c) => (c.op === "select" ? { data: { pending_action: pendAddr } } : undefined);
  await handleNdrPendingReply(db(), { phone: "9000000010", text: "Flat 5B, Palm Grove, Indiranagar, Bengaluru 560038", pending: pendAddr });
  ok("PR/shadowfax address: order_update carried delivery_details.customer_address", hits.some((h) => h.url.endsWith("/order_update/") && ((h.body as { delivery_details?: { customer_address?: string } }).delivery_details?.customer_address ?? "").includes("Palm Grove")));
  ok("PR/shadowfax address: reply is honest about hand-off to courier", /passed your new address to the courier/i.test(outbound().join(" ")));

  // ── pending reply × Shadowfax phone, parcel on a runsheet → queued ────────
  reset();
  orderRow = { ...SFX_ORDER };
  sfxUpdateStatus = 400;
  sfxUpdateBody = { message: "Customer details could not be updated for SF123 as shipment is in active runsheet." };
  const pendLocked: PendingAction = { kind: "ndr_phone", order_id: "AJUKI2", awb: "SF123", courier: "shadowfax", attempts: 0, set_at: new Date().toISOString() };
  await handleNdrPendingReply(db(), { phone: "9000000015", text: "9000100007", pending: pendLocked });
  {
    const q = calls.find((c) => c.table === "orders" && c.op === "update" && (c.payload as { pending_courier_edit?: unknown }).pending_courier_edit);
    const edit = (q?.payload as { pending_courier_edit?: { contact?: string; courier?: string; attempts?: number } })?.pending_courier_edit;
    ok("PR/shadowfax locked: value queued on orders.pending_courier_edit", edit?.contact === "9000100007" && edit?.courier === "shadowfax" && edit?.attempts === 0, JSON.stringify(edit));
  }
  ok("PR/shadowfax locked: no support case opened", !wrote("support_cases", "insert"));
  ok("PR/shadowfax locked: pending_action cleared", updates("wa_conversations").some((u) => u.pending_action === null));
  ok("PR/shadowfax locked: reply says saved + will update at the hub", /saved your correct phone/i.test(outbound().join(" ")) && /hub/i.test(outbound().join(" ")));

  // ── validation fails twice → support handoff ───────────────────────────
  reset();
  orderRow = { ...DEL_ORDER };
  let handedOffMsg = "";
  const pendRetry: PendingAction = { kind: "ndr_phone", order_id: "AJUKI1", awb: "60000000000004", courier: "delhivery", attempts: 1, set_at: new Date().toISOString() };
  await handleNdrPendingReply(db(), { phone: "9000000011", text: "not a number", pending: pendRetry }, async (_db, m) => {
    handedOffMsg = m.message;
  });
  ok("PR/2x-invalid: handed to support with the raw text", handedOffMsg === "not a number");
  ok("PR/2x-invalid: pending_action cleared", updates("wa_conversations").some((u) => u.pending_action === null));
  ok("PR/2x-invalid: no courier call", !hitUrl("/api/p/update"));

  // ── first invalid → re-ask, bump attempts ─────────────────────────────
  reset();
  orderRow = { ...DEL_ORDER };
  const pendFirst: PendingAction = { kind: "ndr_phone", order_id: "AJUKI1", awb: "60000000000004", courier: "delhivery", attempts: 0, set_at: new Date().toISOString() };
  await handleNdrPendingReply(db(), { phone: "9000000012", text: "123", pending: pendFirst }, async () => { fail++; console.log("FAIL PR/first-invalid: should not hand off"); });
  ok("PR/first-invalid: pending re-parked with attempts=1", upserts("wa_conversations").some((u) => (u.pending_action as PendingAction)?.attempts === 1));
  ok("PR/first-invalid: sends the hint, not a courier call", /doesn't look like a 10-digit/i.test(outbound().join(" ")) && !hitUrl("/api/p/update"));

  // ── reply looks like a question → handoff ─────────────────────────────
  reset();
  let q = "";
  await handleNdrPendingReply(db(), { phone: "9000000013", text: "why is my order so late??", pending: pendFirst }, async (_db, m) => { q = m.message; });
  ok("PR/question: routed to support, pending cleared", q === "why is my order so late??" && updates("wa_conversations").some((u) => u.pending_action === null));

  // ── courier throws mid-apply → universal fallback ─────────────────────
  reset();
  orderRow = { ...DEL_ORDER };
  delhiveryStatus = 401; // editDelhiveryNdrDetails will throw
  await handleNdrPendingReply(db(), { phone: "9000000014", text: "9876543210", pending: pendFirst });
  ok("PR/courier-throws: universal fallback reply", /flagged this with our team/i.test(outbound().join(" ")));
  ok("PR/courier-throws: support case opened + pending cleared", wrote("support_cases", "insert") && updates("wa_conversations").some((u) => u.pending_action === null));

  // ── 21 Oct (AJUKI710081): an address sent as several messages, the pincode as a field, the other messages absorbed ──
  {
    const old = (secs: number) => new Date(Date.now() - secs * 1000).toISOString();
    const sentAddr = () => hits.filter((h) => h.url.endsWith("/order_update/") && (h.body as { delivery_details?: unknown }).delivery_details).map((h) => (h.body as { delivery_details: Record<string, unknown> }).delivery_details);
    const asked = new Date(Date.now() - 120_000).toISOString();
    const pend: PendingAction = { kind: "ndr_address", order_id: "AJUKI2", awb: "SF123", courier: "shadowfax", attempts: 0, set_at: asked };

    // the whole burst reaches the courier, and the pincode goes as a field
    reset();
    orderRow = { ...SFX_ORDER };
    sfxTrackBody = { order_details: { status: "nc", delivery_details: { pincode: 262001 } }, tracking_details: [] };
    overrides.wa_conversations = (c) => (c.op === "select" ? { data: { pending_action: pend } } : undefined);
    overrides.wa_messages = (c) => (c.op === "select" ? { data: [
      { body: "Greenfield nagar wat no 7", created_at: old(100) }, { body: "201301  greenfield nagar", created_at: old(95) }, { body: "Wat no 7", created_at: old(94) },
      { body: "Temple lane", created_at: old(93) }, { body: "Ok", created_at: old(92) },
    ] } : undefined);
    await handleNdrPendingReply(db(), { phone: "9000000020", text: "201301  greenfield nagar", pending: pend });
    const dd = sentAddr()[0] ?? {};
    ok("burst: the whole address went, not only the message that passed validation", String(dd.customer_address ?? "") === "Greenfield nagar wat no 7, 201301 greenfield nagar, Temple lane", JSON.stringify(dd));
    ok("burst: the pincode went as a field", dd.pincode === 201301, JSON.stringify(dd));
    ok("burst: the customer is told once", outbound().filter((b) => /passed your new address to the courier/i.test(b)).length === 1, outbound().join(" | "));

    // a later message of the same burst finds the claim and sends nothing
    reset();
    orderRow = { ...SFX_ORDER };
    const claimed: PendingAction = { ...pend, collecting_since: new Date().toISOString() };
    overrides.wa_conversations = (c) => (c.op === "select" ? { data: { pending_action: claimed } } : undefined);
    await handleNdrPendingReply(db(), { phone: "9000000021", text: "Flat 9 Palm Road Bengaluru 560038", pending: claimed });
    ok("claimed: the other messages of the burst send nothing and touch no courier", outbound().length === 0 && !hits.some((h) => h.url.endsWith("/order_update/")), outbound().join(" | "));

    // a claim that was never released (the collecting handler died) does not freeze the customer
    reset();
    orderRow = { ...SFX_ORDER };
    const stale: PendingAction = { ...pend, collecting_since: new Date(Date.now() - 5 * 60_000).toISOString() };
    overrides.wa_conversations = (c) => (c.op === "select" ? { data: { pending_action: stale } } : undefined);
    await handleNdrPendingReply(db(), { phone: "9000000022", text: "Flat 9 Palm Road Bengaluru 560038", pending: stale });
    ok("stale claim: taken over after a minute", sentAddr().length === 1 && /passed your new address/i.test(outbound().join(" ")), outbound().join(" | "));

    // the collecting handler had already finished and cleared the pending action: the message is not lost
    reset();
    orderRow = { ...SFX_ORDER };
    let handedOff = false;
    overrides.wa_conversations = (c) => (c.op === "select" ? { data: { pending_action: null } } : undefined);
    await handleNdrPendingReply(db(), { phone: "9000000023", text: "Flat 9 Palm Road Bengaluru 560038", pending: pend }, async () => { handedOff = true; });
    ok("cleared meanwhile: handed to the support bot, nothing sent to the courier", handedOff && !hits.some((h) => h.url.endsWith("/order_update/")));

    // a phone number is not collected: no claim, no wait
    reset();
    orderRow = { ...DEL_ORDER };
    overrides = {};
    const ph: PendingAction = { kind: "ndr_phone", order_id: "AJUKI1", awb: "60000000000004", courier: "delhivery", attempts: 0, set_at: asked };
    await handleNdrPendingReply(db(), { phone: "9000000024", text: "9876543210", pending: ph });
    ok("phone: sent as before", hitUrl("track.delhivery.com/api/p/update") && /updated the delivery phone/i.test(outbound().join(" ")), outbound().join(" | "));
  }

  // ── 22 Oct (AJUKI710006): Delhivery takes a delivery day only up to estimated delivery + 5 days; past it the customer is not told "Done" ──
  {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    reset();
    orderRow = { ...DEL_ORDER, estimated_delivery: day(-10) };
    await handleNdrButtonTap(db(), { phone: "9000000030", buttonText: "Deliver tomorrow", order: DEL_ORDER, courier: "delhivery" });
    ok("DT/delhivery past the window: nothing is submitted to Delhivery", !hitUrl("track.delhivery.com/api/p/update"));
    ok("DT/delhivery past the window: not told Done, told it goes to the team", !/Done/.test(outbound().join(" ")) && /cannot book another delivery day/i.test(outbound().join(" ")), outbound().join(" | "));
    ok("DT/delhivery past the window: a support case is opened and no request row is written", wrote("support_cases", "insert") && !inserted("delhivery_ndr_requests").length);

    reset();
    orderRow = { ...DEL_ORDER, estimated_delivery: day(2) };
    await handleNdrButtonTap(db(), { phone: "9000000031", buttonText: "Deliver tomorrow", order: DEL_ORDER, courier: "delhivery" });
    ok("DT/delhivery inside the window: submitted and told Done, as before", hitUrl("track.delhivery.com/api/p/update") && /Done/.test(outbound().join(" ")), outbound().join(" | "));

    reset();
    orderRow = { ...DEL_ORDER };
    await handleNdrButtonTap(db(), { phone: "9000000032", buttonText: "Deliver tomorrow", order: DEL_ORDER, courier: "delhivery" });
    ok("DT/delhivery with no estimated delivery on record: unchanged", hitUrl("track.delhivery.com/api/p/update") && /Done/.test(outbound().join(" ")));
  }

  // ── 22 Oct: the same button tapped twice in seconds got two identical replies ──
  {
    const t0 = 1_800_000_000_000;
    ok("repeat tap: the first is not a repeat", isRepeatTap("9000100015", "deliver tomorrow", "AJUKI1", t0) === false);
    ok("repeat tap: the second, seconds later, is", isRepeatTap("9000100015", "deliver tomorrow", "AJUKI1", t0 + 1_000) === true);
    ok("repeat tap: another button is not", isRepeatTap("9000100015", "update phone", "AJUKI1", t0 + 1_500) === false);
    ok("repeat tap: another customer is not", isRepeatTap("9000100016", "deliver tomorrow", "AJUKI1", t0 + 1_500) === false);
    ok("repeat tap: after the window it counts again", isRepeatTap("9000100015", "deliver tomorrow", "AJUKI1", t0 + 25_000) === false);
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run();
