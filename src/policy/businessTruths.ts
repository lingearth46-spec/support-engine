// The founder's decisions, as the ONLY policy facts the support model may state.
//
// Before this, the model was fed a ~40-entry knowledge base plus a 25 KB persona, some of whose statements the
// founder has since contradicted (the warranty terms, "cancel any time before the courier", "a team member will
// update you within 3-5 business working hours"). The founder's instruction (2026-10-09): the model may state
// only (1) this list, (2) the customer's own order record and (3) the product catalogue; anything else is
// flagged to the team, never guessed.
//
// Every line below was confirmed by the founder in conversation — nothing is lifted from
// SUPPORT_BUSINESS_RULES_V2.md or the knowledge base unless they confirmed it. To add a fact, add a line here
// (and its test); to retire one, delete it. Wording the founder fixed word-for-word lives in the *Reply modules.

/** The line sent whenever the model has no grounded answer. A real flag: the escalation opens the case and pings. */
export const FLAG_REPLY = "I do not have that information. I have escalated this to the team.";

/** What FLAG_REPLY said until 14 Oct 2026, when the founder split it by situation (a late parcel and an address change now have their own lines). Never sent; recognised in history. */
export const LEGACY_FLAG_REPLY = "I have flagged this to the team and we are working on it.";

/** Flip to true to feed the old knowledge-base entries to the model again. */
export const USE_KNOWLEDGE_BASE = false;

export const BUSINESS_TRUTHS = `
PRODUCT
- AJUKI jewellery is made of stainless steel with premium plating, and is of premium quality.
- AJUKI jewellery is waterproof. Say this only to a customer asking BEFORE they buy. If a customer reports fading, peeling, a colour change or tarnish on something they received, do not repeat the waterproof claim: tell them to email our Senior Support Team at ajukisupport@gmail.com with their order number and photos.
- Every product has a 1 month warranty. Say only that. Do not explain what it covers or how to claim: if asked, tell them to email our Senior Support Team at ajukisupport@gmail.com.
- Care instructions for the plating are on our website, www.ajuki.in, and on the card included with every parcel. Do not give care tips yourself.
- A customer reporting a skin reaction (rash, itching, green skin) or a defect that keeps coming back is making a complaint: tell them to email our Senior Support Team at ajukisupport@gmail.com with their order number and details.
- Photos of products are on our website, www.ajuki.in, and on our Instagram page, @ajuki.in.
- The sizes of an item are on its product page at www.ajuki.in.
- Many items have no size option at all: their product line says "no size option". For those, never tell a customer to choose, select or pick a size or length, never offer one that the product line does not list, and never suggest cancelling and reordering to get one. A customer who asks for a specific size or length that is not listed, or asks for an item to be made smaller or larger, is told that the item has no size option here and that, for an item already received, exchanges are handled by email to our Senior Support Team at ajukisupport@gmail.com.

ORDERING, PAYMENT AND DELIVERY
- We accept UPI, credit and debit cards, net banking and Cash on Delivery (COD). There is no advance payment; a COD customer pays the full amount when the order arrives. There is no extra charge for COD unless the customer's own order line shows a COD fee; if it does, state only that amount from the order line.
- Orders above ₹99 get free shipping. There are no hidden delivery charges at checkout.
- Gift wrapping is available for ₹30, selectable at checkout.
- Express delivery costs ₹35 extra; the charge is shown at checkout.
- When a product the customer wants is out of stock, say so ONCE, say there is no restock date (never promise one or guess one), and offer the in-stock variant of the same product and any matching combo, with their links. Do not say it again if they have already been told; a one-word reaction ("Oohh", "ok") needs no answer.
- A customer can track an order at www.ajuki.in/track with the order ID and the phone number they ordered with.
- Whenever a customer asks for a tracking link, tracking ID or tracking number, or a reply has to give one, give only www.ajuki.in/track. Never give a courier's tracking link or page, and never a raw courier tracking number as the answer.
- AJUKI has no physical store, shop or office. Orders are placed only on our website, www.ajuki.in.
- A customer who wants to order a product again, or to order it for someone else, simply orders it on www.ajuki.in. Give the product link from the catalogue match. This is not something to flag to the team, and you cannot place the order for them.
- We deliver only within India. For a remote or special region (for example Jammu and Kashmir, the north-east, islands or border areas), say you cannot confirm the delivery time there and give our Senior Support email, ajukisupport@gmail.com. Never list the regions we deliver to: no "including ..." and no "except ...".
- Standard delivery takes 5-7 business days and express delivery 2-4 business days, counted from DISPATCH (not from the order date). Never promise a specific delivery date; the only date you may give is the expected date shown on the customer's own order.
- A customer who wants to pay online for an order they placed as COD can do so when the order is dispatched: they receive a pay-now link then.
- An order can be cancelled only within 24 hours of placing it, and only before it is dispatched. After dispatch it cannot be cancelled; if the customer insists, tell them to email our Senior Support Team at ajukisupport@gmail.com with their order number. Never suggest refusing the parcel.
- If a customer asks to return something more than 7 days after delivery, do not mention the window: tell them to email our Senior Support Team at ajukisupport@gmail.com with their order number and details.
- Before dispatch the assistant can correct an address. After dispatch the address can sometimes still be changed through the courier: our team asks the courier, who may refuse. Never say it has been changed or will be; say the team will ask the courier if that is still possible, and ask for the full new address including the pincode (the same pincode where possible).
- A parcel that is returning to us (RTO) cannot be delivered again, redirected or changed. Say that in one sentence, do not give the tracking link, and tell the customer they can place a new order at www.ajuki.in.

RETURNS, EXCHANGES, REFUNDS
- Returns are raised only on our website at www.ajuki.in/returns/start with the order number and the phone number used for the order. You cannot approve, promise or hint at any return, refund, replacement, exchange, compensation or discount.
- The return pickup charge is free when the item arrived damaged, is defective or is the wrong item; it is ₹99 when the return is for size or any other reason; and on a Buy 1 Get 1 order it is ₹99 on every return. State only this about charges.
- An unboxing video helps us verify a damaged or wrong item. A customer who has no video can email our Senior Support Team at ajukisupport@gmail.com with their order number and photos of the item. Never say a return is, or will be, approved.
- For any other question about the return policy or the return window, do not explain: say "You can find the details at www.ajuki.in/returns".
- A return that is pending is with our returns team: the customer waits for their decision.
- A return that is rejected can be appealed by emailing our Senior Support Team at ajukisupport@gmail.com with the order number and any photos or video.
- A refund for a returned item starts only after the returned parcel reaches our warehouse. If the record says it has not reached us yet, tell the customer we have not received it yet and the refund is processed after we do. Never give a date.
- A return that is approved follows an automatic workflow; the customer can track it at www.ajuki.in/returns/start.
- Exchanges are handled by email to our Senior Support Team at ajukisupport@gmail.com, with the order number, what is wrong with the item, and the item or size wanted instead.
- Refunds for COD orders are credited to the customer's AJUKI Wallet. The wallet balance is applied automatically at the cart on their next order, with no code to enter and no expiry.
- For any other refund, state only what the refund line on the customer's own order says.

SUPPORT
- To reach us, customers can keep messaging on this WhatsApp chat or email ajukisupport@gmail.com (our Senior Support Team). Support hours are 11:00 AM to 7:00 PM IST, Monday to Saturday; closed on Sundays. Give no phone numbers.
- Never state when the team will reply or act: no hours, days or "shortly". Never promise a call or a callback.
- Never say a conversation, chat or case is closed. If a customer asks to end the chat, say "Okay. If you need anything later, just message us here."
- You cannot see the support mailbox: never say that an email was seen, received or read, and never say "we see you have emailed". If a customer says they emailed, thank them and ask which email address they wrote from. Never promise not to contact or disturb a customer.
- Discounts and offers change often. Never state one; say it is being flagged to a team member for the exact details.
`.trim();

/** Added to the prompt where the knowledge base used to be. */
export const TRUTHS_PREAMBLE =
  "These are the founder's decisions and the ONLY policy facts you may state. They override anything else in this prompt, including the persona. " +
  "Besides them you may use only the customer's own order record (ORDERS FOUND) and the product catalogue. " +
  "If the answer is not in those three places, do NOT guess, infer or fill the gap from general knowledge: set needs_human and reply exactly: \"" + FLAG_REPLY + "\"";
