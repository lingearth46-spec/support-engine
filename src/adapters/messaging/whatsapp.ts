// WhatsApp notifications via the official Business Cloud API.
//
// Required env vars — if any is missing this file is a no-op, matching how the
// other optional integrations here degrade rather than failing an order:
//   WHATSAPP_ACCESS_TOKEN     — permanent system-user token
//   WHATSAPP_PHONE_NUMBER_ID  — the sender's id (not the phone number)
//
// Why this exists: order notifications go out by email, and email is the one
// detail most of these customers never give. Of 579 orders, 268 carry an email
// and all 579 carry a phone — so 311 people were buying and hearing nothing
// back, not even an order confirmation. WhatsApp is the channel that reaches
// them.
//
// This replaced Green API, which drove a real handset. That works until it
// doesn't: WhatsApp flagged the number with a yellow card — outgoing messages
// filtered, new contacts blocked — because 31 transactional messages a day to
// people who have never messaged you is indistinguishable from broadcast spam
// when the mechanism is a phone. Cloud API is the sanctioned route for exactly
// this traffic, and at ~₹0.13 per utility message it costs less than the relay
// did.
//
// The constraint that shapes everything below: **you cannot send free text to
// someone who has not messaged you in the last 24 hours.** Every order
// notification goes to precisely that person, so each one is a pre-approved
// template. Once a customer replies, a 24-hour window opens in which free text
// is allowed — which is why the replies to their "Yes"/"No" can be written
// normally.

import { normalizePhone } from "@engine/phone";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Cloud API wants a bare international number: no +, no spaces, no @c.us. */
function toRecipient(phone: string): string | null {
  const digits = normalizePhone(phone);
  if (digits.length !== 10) return null;
  return `91${digits}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function credentials(): { token: string; phoneId: string } | null {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return null;
  return { token, phoneId };
}

/**
 * POSTs to the messages endpoint. Resolves either way — a notification must
 * never be the reason an order fails to save.
 */
async function send(payload: Record<string, unknown>): Promise<boolean> {
  const creds = credentials();
  if (!creds) return false;

  try {
    const res = await fetch(`${GRAPH}/${creds.phoneId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.token}`,
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });

    if (!res.ok) {
      const body = await res.text();
      // Logged in full rather than swallowed: Meta's errors are specific and
      // actionable — an unapproved template, a number outside the 24-hour
      // window, a spent quota — and each needs a different fix.
      console.error(JSON.stringify({
        event: "whatsapp_send_failed",
        status: res.status,
        body: body.slice(0, 400),
      }));
      return false;
    }
    return true;
  } catch (err) {
    console.error("WhatsApp send failed:", err);
    return false;
  }
}

/**
 * Download something a customer sent us.
 *
 * Meta does not put the file in the webhook, only an id, and fetching it takes
 * two hops: the id resolves to a short-lived URL, and that URL then needs the
 * same bearer token again — it is not public, which is easy to miss because it
 * looks like an ordinary lookaside link.
 *
 * Returns null rather than throwing on anything unexpected. A photo we cannot
 * read should degrade to answering without it, never take down the reply.
 */
export async function fetchWhatsAppMedia(
  mediaId: string,
): Promise<{ base64: string; mimeType: string; bytes: Buffer } | null> {
  const creds = credentials();
  if (!creds || !mediaId) return null;
  const auth = { Authorization: `Bearer ${creds.token}` };

  try {
    const lookup = await fetch(`${GRAPH}/${mediaId}`, { headers: auth });
    if (!lookup.ok) {
      console.error("[whatsapp] media lookup failed:", lookup.status, (await lookup.text()).slice(0, 200));
      return null;
    }
    const { url, mime_type } = await lookup.json();
    if (!url) return null;

    const file = await fetch(url, { headers: auth });
    if (!file.ok) {
      console.error("[whatsapp] media download failed:", file.status);
      return null;
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    // Gemini takes an inline image up to ~20MB across the whole request, and a
    // phone photo is well under that — but a stray large file should be dropped
    // rather than sent and rejected.
    if (bytes.byteLength > 12 * 1024 * 1024) {
      console.warn("[whatsapp] media too large to analyse:", bytes.byteLength);
      return null;
    }
    return { base64: bytes.toString("base64"), mimeType: mime_type ?? "image/jpeg", bytes };
  } catch (err) {
    console.error("[whatsapp] media fetch failed:", err);
    return null;
  }
}

/**
 * A template message — the only kind that reaches someone who has not written
 * to us recently, which is every customer at the moment an order is placed.
 *
 * `variables` fill {{1}}, {{2}}… in the order given, so the order matters and
 * has to match what was submitted for approval. See scripts that created them
 * or the template list in WhatsApp Manager.
 */
export async function sendTemplate(
  phone: string,
  template: string,
  variables: string[] = [],
  /**
   * The dynamic tails of the template's URL buttons, in the order the buttons
   * were submitted for approval.
   *
   * Meta's dynamic URL buttons are a fixed prefix plus a single variable, and
   * the prefix — including the domain — is frozen at approval time. That is
   * exactly why the shipped template links to our own /track rather than the
   * courier's page: parcels leave on Ekart, Shadowfax or Delhivery, three
   * different domains, and no one button can point at all three. Ours resolves
   * whichever it turned out to be.
   *
   * A string is the one-button case, kept because that is every template we had
   * before v3. An array addresses several: order_shipped_v3 has "Pay Now" at
   * index 0 and "Track Order" at index 1, and **every** dynamic button must be
   * filled — Meta rejects the whole message if one is missing, so a half-filled
   * template does not send a degraded notification, it sends nothing at all.
   */
  urlButtonParam?: string | (string | null | undefined)[],
  /** Fills an IMAGE header. Must be a public https JPEG or PNG, never WebP. */
  headerImageUrl?: string,
  /**
   * The payload each QUICK-REPLY button hands back when tapped, by button index. Without one the tap arrives as the button's label. The guided-flow
   * follow-ups send "m:menu" so "Need other help" brings the topic list back (lib/menuFlows.ts menuTapIdOf).
   */
  quickReplyPayloads?: (string | null | undefined)[],
): Promise<boolean> {
  const to = toRecipient(phone);
  if (!to) return false;

  const components: Record<string, unknown>[] = [];

  // A template with an IMAGE header will not send without one, so this goes
  // first — Meta reads components in order.
  //
  // The link must be a public https URL that answers with JPEG or PNG. **WebP
  // is rejected**, which matters because our product images are served as WebP
  // by default: the caller is responsible for asking the CDN for a JPEG (Sanity
  // does this with ?fm=jpg), and passing the plain image URL will fail.
  if (headerImageUrl) {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { link: headerImageUrl } }],
    });
  }

  if (variables.length) {
    components.push({
      type: "body",
      // Meta rejects a body parameter containing a newline or a tab, and our
      // item lists are multi-line by nature. Collapsed to a single line here
      // rather than at the call site so no caller can forget.
      parameters: variables.map((v) => ({
        type: "text",
        text: String(v ?? "").replace(/\s*\n\s*/g, " · ").trim() || "-",
      })),
    });
  }

  // index is the button's position in the template, counted from zero and fixed
  // at approval time. A blank entry is skipped rather than sent as an empty
  // string: an empty tail would resolve to the bare prefix, which for a payment
  // link is a page that cannot know which order it is for.
  const buttonParams = Array.isArray(urlButtonParam) ? urlButtonParam : [urlButtonParam];
  buttonParams.forEach((param, index) => {
    if (!param) return;
    components.push({
      type: "button",
      sub_type: "url",
      index: String(index),
      parameters: [{ type: "text", text: String(param) }],
    });
  });

  (quickReplyPayloads ?? []).forEach((payload, index) => {
    if (!payload) return;
    components.push({
      type: "button",
      sub_type: "quick_reply",
      index: String(index),
      parameters: [{ type: "payload", payload: String(payload).slice(0, 256) }],
    });
  });

  return send({
    to,
    type: "template",
    template: {
      name: template,
      language: { code: "en" },
      ...(components.length && { components }),
    },
  });
}

export type TemplateMessage = {
  template: string;
  variables: string[];
  /** Fills the dynamic tails of the template's URL buttons, in approval order.
   *  A bare string is the one-button case; an array addresses several. */
  urlButtonParam?: string | (string | null | undefined)[];
  /** Fills an IMAGE header, for the templates that carry one. */
  headerImageUrl?: string;
};

/**
 * Several templates to one person, in order, with a gap between them.
 *
 * An order can become due for two at once — shipped and delivered land together
 * when a courier report is uploaded late — and the gap keeps them arriving in a
 * readable order rather than as an indistinguishable pair.
 *
 * Returns the messages that actually sent, not just a count — the caller needs
 * to know *which* templates landed so it can log them, and a bare number would
 * throw that away.
 */
export async function sendTemplateSequence(
  phone: string,
  messages: TemplateMessage[],
): Promise<TemplateMessage[]> {
  const sent: TemplateMessage[] = [];
  for (const [i, m] of messages.entries()) {
    if (i > 0) await sleep(1500);
    if (await sendTemplate(phone, m.template, m.variables, m.urlButtonParam, m.headerImageUrl)) sent.push(m);
  }
  return sent;
}

/**
 * Free-form text. Only reaches someone inside the 24-hour service window their
 * own message opened — so this is for replying, never for initiating.
 */
export async function sendWhatsApp(phone: string, message: string): Promise<boolean> {
  const to = toRecipient(phone);
  if (!to) return false;

  // A reply that carries a product link gets its preview: the card shows the
  // product's image and name, which sells better than a bare URL. Everything
  // else stays preview-off so ordinary links don't balloon into cards.
  const hasProductLink = /ajuki\.in\/products\//i.test(message);

  return send({
    to,
    type: "text",
    text: { preview_url: hasProductLink, body: message },
  });
}

/**
 * Put an image on Meta's servers so it can be sent by id.
 *
 * By id rather than by link: sending a link would mean handing Meta a URL to a
 * customer-facing photo in our private media store, signed and fetchable by
 * anyone who has it. Meta keeps an uploaded file for 30 days, which is far past
 * the moment it is sent. WhatsApp takes JPEG and PNG images up to 5 MB; the
 * caller is responsible for meeting that.
 */
export async function uploadWhatsAppMedia(bytes: Buffer, mimeType: string): Promise<string | null> {
  const creds = credentials();
  if (!creds) return null;
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), mimeType === "image/png" ? "photo.png" : "photo.jpg");
    const res = await fetch(`${GRAPH}/${creds.phoneId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}` },
      body: form,
    });
    if (!res.ok) {
      console.error(JSON.stringify({ event: "whatsapp_media_upload_failed", status: res.status, body: (await res.text()).slice(0, 400) }));
      return null;
    }
    const { id } = (await res.json()) as { id?: string };
    return id ?? null;
  } catch (err) {
    console.error("WhatsApp media upload failed:", err);
    return null;
  }
}

/**
 * An image, optionally captioned, by the id uploadWhatsAppMedia returned.
 * Free-form, so the same 24-hour window rule as sendWhatsApp applies.
 */
export async function sendWhatsAppImage(phone: string, mediaId: string, caption?: string): Promise<boolean> {
  const to = toRecipient(phone);
  if (!to) return false;
  return send({
    to,
    type: "image",
    image: { id: mediaId, ...(caption ? { caption } : {}) },
  });
}

/**
 * Free-form text with a single link button under it.
 *
 * Same 24-hour window rule as sendWhatsApp — this is a reply, never an opener.
 * Used for the holding message, where the commonest thing a waiting customer
 * does next is ask where their parcel is: a tap that lands them on /track with
 * nothing to type answers that without costing anyone a reply.
 *
 * A `cta_url` button rather than a quick reply on purpose. A quick reply comes
 * back as an inbound message the bot then has to interpret and answer; a link
 * button resolves the question in the customer's browser and generates no
 * thread at all.
 *
 * Falls back to plain text if Meta refuses the interactive send. The holding
 * message is the one thing an escalated customer is owed, and a button is not
 * worth failing to send it over.
 */
export async function sendWhatsAppCta(
  phone: string,
  message: string,
  cta: { text: string; url: string },
): Promise<boolean> {
  const to = toRecipient(phone);
  if (!to) return false;

  // Meta caps the label at 20 characters and rejects the whole send if it is
  // longer, so it is trimmed here rather than trusted from the call site.
  const ok = await send({
    to,
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: message.slice(0, 1024) },
      action: {
        name: "cta_url",
        parameters: { display_text: cta.text.slice(0, 20), url: cta.url },
      },
    },
  });
  if (ok) return true;

  console.warn(`[whatsapp] cta_url refused for ${to}, falling back to plain text`);
  return sendWhatsApp(phone, message);
}

/**
 * Sends several messages to one person in order, with a gap between them.
 *
 * An order can become due for two at once — shipped and delivered land together
 * when a report is uploaded late — and the gap keeps them in a readable order
 * rather than arriving as an indistinguishable pair.
 */
export async function sendWhatsAppSequence(phone: string, messages: string[]): Promise<number> {
  let sent = 0;
  for (const [i, message] of messages.entries()) {
    if (i > 0) await sleep(1500);
    if (await sendWhatsApp(phone, message)) sent++;
  }
  return sent;
}

/**
 * A one-time login code.
 *
 * Authentication templates are their own category at Meta and do not go through
 * `sendTemplate`: the code appears twice, once as the body variable and once as
 * the button's payload, and the button is a `copy_code` rather than a `url`.
 * Meta also fixes the body text at approval time — you do not supply the
 * sentence, only the digits — which is why there is no message argument here.
 *
 * **The component shape below is unverified.** Meta's authentication-template
 * pages 404'd when this was written, so it is built from the pattern the rest of
 * the Cloud API follows and must be confirmed against the first real send —
 * exactly how the Instagram payload and Delhivery's `pt` field were settled.
 * If a send fails, the body will say which component it disliked; read it rather
 * than guessing again.
 *
 * The template must exist and be approved as category AUTHENTICATION with a
 * copy-code button. Name it in WHATSAPP_OTP_TEMPLATE.
 */
export async function sendAuthCode(phone: string, code: string): Promise<boolean> {
  const to = toRecipient(phone);
  if (!to) return false;

  const template = process.env.WHATSAPP_OTP_TEMPLATE;
  if (!template) {
    // Loud, because the failure is otherwise a login page that spins forever
    // while the code sits in a Supabase table nobody reads.
    console.error("[whatsapp] WHATSAPP_OTP_TEMPLATE unset — no login code can be sent");
    return false;
  }

  return send({
    to,
    type: "template",
    template: {
      name: template,
      language: { code: "en" },
      components: [
        { type: "body", parameters: [{ type: "text", text: code }] },
        // `sub_type: "url"`, not `"copy_code"`, even though the button in the
        // approved template IS a copy-code button. Meta rejects the obvious
        // spelling with `(#132018) buttons: Button at index 0 must be of type
        // Url`, which is how this was settled — the guess was wrong and the
        // error named the field. Verified against a real send.
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: code }],
        },
      ],
    },
  });
}

/**
 * Up to three reply buttons under a message.
 *
 * Free-form, like sendWhatsApp: it only reaches someone inside the 24-hour window their own message opened, and needs no template. A tap
 * comes back to the webhook as an interactive button_reply carrying the id given here. Meta caps the title at 20 characters, the id at 256
 * and the body at 1024, and refuses the whole send past any of them, so they are trimmed here rather than trusted from the call site. If
 * Meta refuses anyway the message goes as plain text with the options spelled out, so the customer is never left without an answer.
 */
export async function sendWhatsAppButtons(
  phone: string,
  body: string,
  buttons: { id: string; title: string }[],
): Promise<boolean> {
  const to = toRecipient(phone);
  if (!to) return false;
  const list = buttons.slice(0, 3);
  if (!list.length) return sendWhatsApp(phone, body);

  const ok = await send({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body.slice(0, 1024) },
      action: { buttons: list.map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 200), title: b.title.slice(0, 20) } })) },
    },
  });
  if (ok) return true;

  console.warn(`[whatsapp] reply buttons refused for ${to}, falling back to plain text`);
  return sendWhatsApp(phone, `${body}\n\n${list.map((b) => `• ${b.title}`).join("\n")}`);
}

/**
 * A list message: one button that opens up to ten rows. Same window and trimming rules as sendWhatsAppButtons. A row title is capped at
 * 24 characters and a description at 72. The plain-text fallback numbers the rows so the customer can still type one.
 */
export async function sendWhatsAppList(
  phone: string,
  body: string,
  list: { button: string; rows: { id: string; title: string; description?: string }[] },
): Promise<boolean> {
  const to = toRecipient(phone);
  if (!to) return false;
  const rows = list.rows.slice(0, 10);
  if (!rows.length) return sendWhatsApp(phone, body);

  const ok = await send({
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body.slice(0, 1024) },
      action: {
        button: list.button.slice(0, 20),
        sections: [{
          title: "Topics",
          rows: rows.map((r) => ({
            id: r.id.slice(0, 200),
            title: r.title.slice(0, 24),
            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
          })),
        }],
      },
    },
  });
  if (ok) return true;

  console.warn(`[whatsapp] list refused for ${to}, falling back to plain text`);
  return sendWhatsApp(phone, `${body}\n\n${rows.map((r, i) => `${i + 1}. ${r.title}`).join("\n")}`);
}