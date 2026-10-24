# Commerce extras: the reference shop's, not yours

These files implement features of the original shop that the bot happens to import: the cash-on-delivery confirmation journey (`rtoJourney`), automatic offers (`orderOffers`, `cartOffers`, `prepaidOffer`), the wallet, refund bookkeeping (`refunds`, `returnSettlement`), partial COD (`partialCod`) and GST invoices (`gstInvoice`).

They are kept so the code compiles and the tests run, not because you need them. For your own deployment:

1. Decide which of these features you have. Most companies need none of them.
2. For each one you do not have, replace the import with a small stub, or delete the feature and the code that calls it. `src/app/api/webhooks/whatsapp/route.ts`, `src/engine/orderLines.ts`, `src/engine/supportActionRun.ts` and `src/adapters/messaging/whatsappTemplates.ts` import them.
3. Run the tests after each removal.

The refund and return code (`refunds`, `returnSettlement`) touches money. Do not delete it blindly: your returns and refunds process decides what replaces it.
