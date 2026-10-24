// Tidy the model's text BEFORE it is checked, so the string that is verified is the string that is sent.
//
// Two things the checks used to treat as a reason to drop the whole reply, on 9 Oct 2026, replacing four good answers with the
// flag line:
//
//  1. An internal tag name written into a sentence — "a late_delivery case was raised on 7 Oct". The model copies it from the
//     case line it is shown. The facts around it were right (the parcel was out for delivery, the case date), and the customer
//     received only "I have flagged this to the team" while a person had to tell them the parcel was out for delivery. The tag
//     is replaced with its plain words; the sentence is otherwise untouched.
//  2. A sample order number — "please send your AJUKI order ID (looks like AJUKI12345)". The sample is not anyone's order and
//     was blocked as an invented one. Only the known sample forms are rewritten, and only when they appear nowhere in what the
//     model was shown; any other number it was not given is still an invented order id and is still blocked.
//
// Deliberately narrow: this never adds a claim, never removes a sentence, and never touches an amount, a date, a link or a
// number that could be a real one. Pure, so every rule is unit-tested.

import { SUPPORT_TAGS } from "@engine/supportGuardrails";
import { pipelineV2Enabled } from "@engine/pipelineV2";

/** Internal names that read as words once their underscores are spaces. Status names that mean something else get their own entry. */
const PLAIN_WORDS: Record<string, string> = {
  wa_cancelled: "cancelled",
};

/** Sample order numbers the model produces when it explains what an order ID looks like. None is a real order. */
const SAMPLE_ORDER_IDS = new Set(["AJUKI12345", "AJUKI710013", "AJUKI0710014", "AJUKI710000", "AJUKI710009", "AJUKI710092", "AJUKIXXXXXX"]);

export type Sanitised = { text: string; changes: string[] };

/** Courier and aggregator hosts whose pages the bot must never send. AJUKI's own domain is never a courier link. */
const COURIER_HOSTS = /(?:delhivery\.com|shadowfax\.in|dtdc\.in|dtdc\.com|shiprocket\.(?:co|in)|ekartlogistics\.in|ekart\.in|track\.amazon\.in|amazon\.in\/progress-tracker|bluedart\.com|xpressbees\.com|ecomexpress\.in|ithinklogistics\.com|ithink\.in|shipyaari\.com)/i;

/** A link to a courier's tracking page: a known courier host, or any non-AJUKI link whose path says it is a tracking page. */
export function isCourierTrackingLink(url: string): boolean {
  const u = (url ?? "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").toLowerCase();
  if (!u || /^ajuki\.in(?:[\/?#]|$)/.test(u)) return false;
  if (COURIER_HOSTS.test(u.split(/[\/?#]/)[0] + "/")) return true;
  return /\/(?:tracking|track|trace)\b|[?&#\/](?:awb|waybill|trackid|tracking_?id)\b|tracking_results/.test(u);
}

/**
 * @param evidence everything the model was allowed to rely on, plus what the customer said (lower-casing is done here). A sample
 *                 number that appears there is not a sample: it is rewritten only when it appears nowhere.
 */
export function sanitiseModelText(text: string, evidence: string[] = []): Sanitised {
  let out = text ?? "";
  const changes: string[] = [];
  const seen = evidence.join("\n").toLowerCase();

  // 1. Internal tag and status names → plain words. With the pipeline fixes on, a link is never rewritten (the DTDC page is
  // ".../tracking_results.asp") and the one record-field name seen in prose, tracking_results, is named explicitly.
  const v2 = pipelineV2Enabled();
  const names = new Map<string, string>(Object.entries(PLAIN_WORDS));
  if (v2) names.set("tracking_results", "tracking page");
  for (const tag of SUPPORT_TAGS as readonly string[]) if (tag.includes("_")) names.set(tag, tag.replace(/_/g, " "));
  const URL_RE = /(?:https?:\/\/|www\.)[^\s)<>"']+/gi;
  for (const [name, plain] of names) {
    const re = new RegExp(`\\b${name}\\b`, "gi");
    if (re.test(out)) {
      // Always, even when the term is in the model's own context: the case line it is shown quotes the raw tag, which is exactly
      // where the leak comes from.
      if (v2) {
        // Rewrite only outside links.
        const parts = out.split(new RegExp(`(${URL_RE.source})`, "gi"));
        out = parts.map((seg, i) => (i % 2 === 1 ? seg : seg.replace(new RegExp(`\\b${name}\\b`, "gi"), plain))).join("");
      } else out = out.replace(re, plain);
      changes.push(`internal_term:${name}`);
    }
  }

  // 1b. The order line's own marker words, quoted back at the customer: "your order is marked OVERDUE and STUCK". They are
  // instructions to the model, not words for a customer. Lower-cased and the "marked" dropped, so it reads "is overdue and stuck".
  // Case-sensitive on purpose: ordinary lower-case text is never touched.
  const MARKERS: [RegExp, string][] = [
    [/\b(?:is\s+|are\s+)?(?:still\s+)?(?:marked|flagged|listed|shown)\s+(?:as\s+)?(?:OVERDUE|STUCK)\b/g, "__MARKED__"],
    [/\bNEEDS ATTENTION\b/g, "needs attention"],
    [/\bSTILL MOVING\b/g, "still moving"],
    [/\bNO COURIER SCANS\b/g, "has no courier scans"],
    [/\bOVERDUE\b/g, "overdue"],
    [/\bSTUCK\b/g, "stuck"],
  ];
  for (const [re, rep] of MARKERS) {
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    if (rep === "__MARKED__") {
      // "is still marked OVERDUE and STUCK" → "is overdue and stuck"
      out = out.replace(/\b(is|are)\s+(?:still\s+)?(?:marked|flagged|listed|shown)\s+(?:as\s+)?/g, "$1 ");
    } else out = out.replace(re, rep);
    changes.push(`marker:${re.source.slice(0, 24)}`);
  }

  // 1c. An empty attempt counter printed as a fact: "…delivery attempt 0" / "delivery attempts so far: 0". The count is only
  // ever said when it is positive.
  out = out.replace(/\s*(?:,|;|—|-)?\s*(?:and\s+)?(?:the\s+)?delivery attempts?(?:\s+so far)?\s*[:=]?\s*0\b(\s*[.!])?/gi, (_m, end) => {
    changes.push("attempt_count:0");
    return end ? end.trim() : "";
  });

  // 1d. A courier's own tracking page → ours. Founder's rule (2026-10-11): whenever a tracking link has to be given, it is always
  // www.ajuki.in/track, never a courier's page. The model reads courier links in older text and copies them, so any link to a
  // courier or any other non-AJUKI tracking page is rewritten here, before the checks, so the text verified is the text sent.
  out = out.replace(/(?:https?:\/\/|www\.)[^\s)<>"']+/gi, (m) => {
    const bare = m.replace(/[.,;:!?]+$/, "");
    const trail = m.slice(bare.length);
    if (!isCourierTrackingLink(bare)) return m;
    changes.push("courier_tracking_link");
    return `www.ajuki.in/track${trail}`;
  });

  // 2. Sample order numbers → "AJUKI followed by numbers".
  out = out.replace(/\bAJUKI[0-9Xx]{4,10}\b/g, (m) => {
    const up = m.toUpperCase();
    if (!SAMPLE_ORDER_IDS.has(up) || seen.includes(m.toLowerCase())) return m;
    changes.push(`sample_order_id:${up}`);
    return "AJUKI followed by numbers";
  });

  return { text: out, changes };
}

/**
 * Internal names still in text that is about to be sent: a snake_case token outside a link, a tag name, or one of the order line's
 * marker words in capitals. The last look before a model-written reply goes out (lib/finalGuard.ts) — sanitiseModelText should
 * already have removed them, so a hit here means a code path produced text that never went through it.
 */
export function leakedInternalTerms(text: string): string[] {
  const noLinks = (text ?? "").replace(/(?:https?:\/\/|www\.)[^\s)<>"']+/gi, " ");
  const found = new Set<string>();
  for (const m of noLinks.matchAll(/\b[a-z]{2,}(?:_[a-z0-9]+)+\b/g)) found.add(m[0]);
  for (const m of noLinks.matchAll(/\b(?:OVERDUE|STUCK|NEEDS ATTENTION|STILL MOVING|NO COURIER SCANS)\b/g)) found.add(m[0]);
  return [...found];
}
