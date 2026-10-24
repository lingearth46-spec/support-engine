// The two model reads of the late-delivery agent (the supervisor's reading of the chat and the analyst's reading of the scans), and nothing else.
// Constrained output only: a strict JSON schema with closed lists, no free text out, no decisions. Same model as the live general path (gpt-5-mini);
// no live model setting is touched. The fetch is injectable so every branch is testable without the network.

export interface LlmCall<T> { value: T | null; tokens: number; ms: number; error: string | null }

const MODEL = () => process.env.OPENAI_GENERAL_MODEL || "gpt-5-mini";
const TIMEOUT_MS = 45_000;

export async function callJson<T>(opts: { system: string; user: string; name: string; schema: Record<string, unknown>; validate: (v: unknown) => T | null; fetchImpl?: typeof fetch; apiKey?: string }): Promise<LlmCall<T>> {
  const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const t0 = Date.now();
  if (!key) return { value: null, tokens: 0, ms: 0, error: "no_key" };
  const f = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await f("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, signal: ctl.signal,
      body: JSON.stringify({ model: MODEL(), reasoning_effort: "low", response_format: { type: "json_schema", json_schema: { name: opts.name, strict: true, schema: opts.schema } }, messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.user }] }),
    });
    if (!res.ok) return { value: null, tokens: 0, ms: Date.now() - t0, error: `http_${res.status}` };
    const j: { usage?: { total_tokens?: number }; choices?: { message?: { content?: string } }[] } = await res.json();
    let parsed: unknown = null;
    try { parsed = JSON.parse(j?.choices?.[0]?.message?.content ?? "null"); } catch { parsed = null; }
    const value = opts.validate(parsed);
    return { value, tokens: j?.usage?.total_tokens ?? 0, ms: Date.now() - t0, error: value ? null : "unparseable" };
  } catch (e) {
    return { value: null, tokens: 0, ms: Date.now() - t0, error: e instanceof Error && e.name === "AbortError" ? "timeout" : "error" };
  } finally {
    clearTimeout(timer);
  }
}

// ── the supervisor's reading of the chat ──
export const INTENTS = [
  "status_question", "no_contact_complaint", "rider_number", "address_change_request", "address_provided", "date_request", "date_answer",
  "rider_called_yes", "number_changed", "phone_provided", "call_me", "contact_info", "not_received_but_marked_delivered",
  "courier_complaint", "change_courier_request", "refund_or_cancel", "abusive_or_legal", "photo_or_media_only", "acknowledgement", "other",
] as const;
export const SITUATIONS = ["late_delivery", "return", "refund", "cancel", "address_change", "product_question", "payment", "general", "unclear"] as const;
export interface IntentRead { situation: (typeof SITUATIONS)[number]; intent: (typeof INTENTS)[number]; confidence: "high" | "low"; date: string | null; phone: string | null; pincode: string | null }

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    situation: { type: "string", enum: [...SITUATIONS] }, intent: { type: "string", enum: [...INTENTS] }, confidence: { type: "string", enum: ["high", "low"] },
    date: { type: ["string", "null"] }, phone: { type: ["string", "null"] }, pincode: { type: ["string", "null"] },
  },
  required: ["situation", "intent", "confidence", "date", "phone", "pincode"], additionalProperties: false,
};

const INTENT_SYSTEM = `You are the supervisor of AJUKI's WhatsApp customer support (an online jewellery store in India). You read the chat and name the situation and what the customer's LAST message is asking. Output only the classification; you never answer the customer and you know nothing about the parcel. Messages may be English, Hindi or Hinglish.
situation: late_delivery (a late, stuck or failed delivery, rider issues, where is my order, a delivery date or address for a parcel on its way), return, refund, cancel, address_change (not about a delivery in progress), product_question, payment, general, unclear.
intent (the last customer message):
- status_question: where is it, when will it arrive, an update, or a chase ("please fast", "any news").
- no_contact_complaint: the delivery person did not call, did not come, did not attempt, or did not answer.
- rider_number: asks for the delivery person's number.
- address_change_request: wants the delivery address changed, without giving it. address_provided: gives a new or corrected address.
- date_request: asks for delivery on a day or date ("deliver tomorrow"). date_answer: answers a question we asked about which day.
- rider_called_yes: says the delivery person did call. number_changed: their phone number is different or wrong, without giving it. phone_provided: gives a phone number.
- call_me: asks us to call them. contact_info: asks how to contact the store or for a support number or email.
- not_received_but_marked_delivered: the parcel shows delivered but they did not get it.
- courier_complaint: complains about the courier's or rider's behaviour, or says a delivery was declined or returned. change_courier_request: asks us not to use this courier or to use another.
- refund_or_cancel: wants a refund or to cancel. abusive_or_legal: abuse, threats, fraud or scam accusations, legal language.
- photo_or_media_only: only a photo, video or voice note. acknowledgement: only thanks or ok. other: anything else, or you are not sure.
If the last message mixes a status question with a complaint, choose the complaint. If you are not sure, choose other with confidence low. The context tells you what the store last asked the customer; use it to read short replies like "No", "tomorrow" or a bare number.`;

const ASK_LABEL: Record<string, string> = { rider_answer: "whether the delivery person contacted them", date: "which day they want the delivery", address: "their full new address" };

export function validateIntentRead(v: unknown): IntentRead | null {
  const o = v as Record<string, unknown> | null;
  if (!o || !(SITUATIONS as readonly string[]).includes(o.situation as string) || !(INTENTS as readonly string[]).includes(o.intent as string) || !["high", "low"].includes(o.confidence as string)) return null;
  const s = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 80) : null);
  return { situation: o.situation as IntentRead["situation"], intent: o.intent as IntentRead["intent"], confidence: o.confidence as "high" | "low", date: s(o.date), phone: s(o.phone), pincode: s(o.pincode) };
}

/** `chat` is the last turns, oldest first, as "Customer: ..." / "AJUKI: ..." lines. */
export function readIntent(chat: string[], awaiting: string | null, fetchImpl?: typeof fetch): Promise<LlmCall<IntentRead>> {
  const ctx = awaiting ? `We last asked the customer: ${ASK_LABEL[awaiting] ?? awaiting}.` : "We did not ask the customer anything.";
  return callJson<IntentRead>({ system: INTENT_SYSTEM, user: `${ctx}\n\nCHAT (oldest first)\n${chat.join("\n").slice(-3500)}`, name: "delivery_intent", schema: INTENT_SCHEMA, validate: validateIntentRead, fetchImpl });
}

// ── the late-delivery analyst's reading of the scans ──
export const CAUSES = ["courier_side", "customer_side", "stuck_no_movement", "on_track", "out_for_delivery", "returning_to_us", "delivered", "unknown"] as const;
export const NEXT_STEPS = ["state_status", "ask_customer_availability", "defer_delivery", "raise_courier_issue", "escalate_to_team", "wait_for_movement"] as const;
export interface Analysis {
  current_state: string; cause_class: (typeof CAUSES)[number]; attempts: number; last_scan_at: string; hours_since_last_scan: number;
  days_past_estimate: number | null; delivery_person_remarks: string[]; safe_facts: string[]; concerns: string[]; recommended_next_step: (typeof NEXT_STEPS)[number];
}
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    current_state: { type: "string" }, cause_class: { type: "string", enum: [...CAUSES] }, attempts: { type: "integer" }, last_scan_at: { type: "string" },
    hours_since_last_scan: { type: "number" }, days_past_estimate: { type: ["number", "null"] }, delivery_person_remarks: { type: "array", items: { type: "string" } },
    safe_facts: { type: "array", items: { type: "string" } }, concerns: { type: "array", items: { type: "string" } }, recommended_next_step: { type: "string", enum: [...NEXT_STEPS] },
  },
  required: ["current_state", "cause_class", "attempts", "last_scan_at", "hours_since_last_scan", "days_past_estimate", "delivery_person_remarks", "safe_facts", "concerns", "recommended_next_step"], additionalProperties: false,
};
const ANALYST_SYSTEM = `You are the late-delivery analyst for AJUKI. You see ONE parcel: its scan history from oldest to latest (IST), including the courier's status wording, the delivery person's remarks and locations, plus the order placed date, the estimated delivery date, the order status and the current time. You cannot see the customer's messages.
Analyse only what the scans show. Compute hours since the last scan and days past the estimate from the timestamps given. Never guess a reason the scans do not state. Report the delivery person's remarks verbatim.
cause_class: courier_side (breakdown, weather, not attempted, hub delay), customer_side (not contactable, unavailable, refused, address issue, customer asked another date), stuck_no_movement, on_track, out_for_delivery, returning_to_us (the order status says rto/returned, or the scans do), delivered, unknown.
safe_facts: short factual sentences safe to tell the customer (status, last scan date, attempts). Never put the courier's internal remarks there.`;

export function validateAnalysis(v: unknown): Analysis | null {
  const o = v as Record<string, unknown> | null;
  if (!o || !(CAUSES as readonly string[]).includes(o.cause_class as string) || !(NEXT_STEPS as readonly string[]).includes(o.recommended_next_step as string)) return null;
  if (typeof o.attempts !== "number" || typeof o.hours_since_last_scan !== "number" || typeof o.current_state !== "string") return null;
  const arr = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string").slice(0, 8) : []);
  return { current_state: o.current_state.slice(0, 400), cause_class: o.cause_class as Analysis["cause_class"], attempts: Math.round(o.attempts), last_scan_at: String(o.last_scan_at ?? ""), hours_since_last_scan: o.hours_since_last_scan,
    days_past_estimate: typeof o.days_past_estimate === "number" ? o.days_past_estimate : null, delivery_person_remarks: arr(o.delivery_person_remarks), safe_facts: arr(o.safe_facts), concerns: arr(o.concerns), recommended_next_step: o.recommended_next_step as Analysis["recommended_next_step"] };
}

/** `parcel` is the text block: order meta, current time, and the scans one per line. */
export function analyseParcel(parcel: string, fetchImpl?: typeof fetch): Promise<LlmCall<Analysis>> {
  return callJson<Analysis>({ system: ANALYST_SYSTEM, user: parcel.slice(-6000), name: "delivery_analysis", schema: ANALYSIS_SCHEMA, validate: validateAnalysis, fetchImpl });
}
