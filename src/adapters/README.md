# Adapters: what the bot talks to

Each folder is one outside system. The engine calls these; swap the implementation to fit your stack.

| Folder | Role | In this kit | You will likely |
|---|---|---|---|
| `orders/` | Reads a customer's orders. **The one real interface so far:** `OrderSource` in `types.ts`, wired into the handler (`handleSupportMessage(db, message, { orders })`). | `supabase.ts` (the reference shop's table) and `shopify.ts` (read-only Shopify Admin API, untested against a live store) | Use `shopify.ts` as the base, or implement `OrderSource` for your system. Verify every assumption listed at the top of `shopify.ts`. |
| `messaging/` | Sends WhatsApp messages and templates (Meta Cloud API). | `whatsapp.ts`, `whatsappTemplates.ts` | Wrap your own WhatsApp integration so these functions call it. |
| `notifier/` | Alerts your team (Telegram in the reference shop). | `telegram.ts`, `telegramCallback.ts` | Add Slack or email. Not yet behind an interface. |
| `ai/` | Model providers. | `openaiSupport.ts` (reply writer), `gemini.ts`, `embeddings.ts` | Keep OpenAI first (see the README on tested models). |
| `media/` | Stores customer photos (Cloudflare R2). | `r2.ts`, `r2Media.ts` | Point at your own storage, or drop it. |
| `couriers/` | Courier API clients for the late-delivery module. | `delhivery.ts`, `shadowfax.ts`, `shipmentPartner.ts` | Write one per courier you use. |

Only `orders/` is a clean interface today. The others are plain modules that the engine imports directly; wrapping them behind interfaces is part of your adaptation work (see `docs/WHAT-TO-REPLACE.md`).

## Testing an `OrderSource`
`orders/orders.test.ts` shows how: a fake `fetch`, fixtures, and the status mapping. Copy its approach for your own source, and always run it against your store in shadow mode before going live.
