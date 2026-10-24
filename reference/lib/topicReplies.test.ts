import assert from "node:assert/strict";
import {
  productInfoReply, complaintEmailReply, addressChangeReply, sizeQuestionReply, discountReply, topicReply,
  noStoreReply, NO_STORE_REPLY,
  QUALITY_REPLY, CARE_REPLY, COMPLAINT_EMAIL_REPLY, WARRANTY_REPLY, PHOTOS_REPLY, ADDRESS_FLAG_REPLY, ADDRESS_ASK_REPLY, LEGACY_ADDRESS_FLAG_REPLY, PHONE_GIVEN_REPLY, isPhoneOnly, bookedOrderForAddressEdit, SIZE_REPLY, SIZE_INSIST_REPLY, DISCOUNT_REPLY,
} from "@/lib/topicReplies";

let passed = 0;
const eq = (name: string, got: unknown, want: unknown) => { assert.deepEqual(got, want, name); passed++; };
const text = (r: { text: string } | null) => r?.text ?? null;

// ── quality and photos ──
for (const m of ["Is this good product?", "what is the quality of this", "will it get damaged?", "Are you sure that product will not get damage", "will it tarnish or fade", "what material is it", "is it made of steel", "is this genuine"]) {
  eq(`quality: ${m}`, text(productInfoReply({ message: m })), QUALITY_REPLY);
}
for (const m of ["can you send photos", "Send me real pics", "do you have more pictures", "can I see the actual product", "show me a video"]) {
  eq(`photos: ${m}`, text(productInfoReply({ message: m })), PHOTOS_REPLY);
}
eq("water question stays with the model", productInfoReply({ message: "is it good for the shower, waterproof?" }), null);
eq("offering photos of a fault is not a photo request", productInfoReply({ message: "I will send you photos of the damaged bracelet" }), null);
eq("unrelated", productInfoReply({ message: "do you have a gold chain in stock" }), null);
eq("photo request wins over quality", text(productInfoReply({ message: "send photos, I want to see the quality" })), PHOTOS_REPLY);

// ── warranty / guarantee ──
for (const m of ["Is there any warranty?", "Do you give guarantee", "warranty kitne din ki hai", "Mane jo order Kiya hai uska gerenty kitne din ki hai", "what is the guarantee of this product", "any warrenty?", "Is there a guarantee on plating"]) {
  eq(`warranty: ${m}`, text(productInfoReply({ message: m })), WARRANTY_REPLY);
}
eq("warranty wins over quality in one message", text(productInfoReply({ message: "quality and warranty?" })), WARRANTY_REPLY);
eq("a fault claim that mentions warranty is not the warranty line", productInfoReply({ message: "my bracelet is broken, I want to claim the warranty" }), null);
// ── hypoallergenic and plating care are quality questions ──
for (const m of ["Is your jewellery hypoallergenic? I have sensitive skin", "is it safe for allergy", "Will it cause skin irritation", "is there nickel in it"]) {
  eq(`quality (allergy): ${m}`, text(productInfoReply({ message: m })), QUALITY_REPLY);
}
for (const m of ["How do I clean the bracelet so the plating lasts?", "how to take care of it", "any care instructions", "does the plating peel off", "will it scratch easily", "can I polish it"]) {
  eq(`care: ${m}`, text(productInfoReply({ message: m })), CARE_REPLY);
}
for (const m of ["I got a rash after wearing the bracelet", "my skin turned green and I have an itch", "I developed an allergy from your chain"]) {
  eq(`a reported reaction is a complaint, not a quality question: ${m}`, productInfoReply({ message: m }), null);
}
eq("a repeat complaint is not a quality question", productInfoReply({ message: "Because again the golden colour will peel off" }), null);
eq("how do I clean it", text(productInfoReply({ message: "how do I clean it" })), CARE_REPLY);
for (const m of ["I got a rash after wearing the bracelet", "my skin turned green and I have an itch", "I developed an allergy from your chain", "Because again the golden colour will peel off", "the plating is fading again", "it turned my finger green"]) {
  eq(`complaint -> email: ${m}`, text(complaintEmailReply({ message: m })), COMPLAINT_EMAIL_REPLY);
  eq(`...and never the sales line: ${m}`, productInfoReply({ message: m }), null);
}
eq("ordering a green item is not a skin reaction", complaintEmailReply({ message: "I had ordered a green tennis bracelet and I have received a white one" }), null);
eq("a plain care question is not a complaint", complaintEmailReply({ message: "how do I clean it" }), null);
eq("a plain allergy question is not a complaint", complaintEmailReply({ message: "is it hypoallergenic" }), null);
eq("topicReply routes the complaint", text(topicReply({ message: "my skin turned green", tag: "complaint", ownOrders: [] })), COMPLAINT_EMAIL_REPLY);
// ── address change ──
const shipped = [{ id: "A1", status: "shipped", awb_code: "123" }];
const unbooked = [{ id: "A2", status: "confirmed", awb_code: undefined }];
const delivered = [{ id: "A3", status: "delivered", awb_code: "9" }];
// 18 Oct (founder, 16 Oct decision): after dispatch the address can sometimes still be changed through the courier. One booked parcel and no address in the message:
// ask for it (the proposal flow takes the answer, a person approves). Several booked parcels, or the address already in the message: a person decides.
for (const m of ["Change my delivery address", "I want change my adress", "I don't live there", "the address needs to change"]) {
  eq(`address, dispatched: ${m}`, text(addressChangeReply({ message: m, tag: "address_change", ownOrders: shipped })), ADDRESS_ASK_REPLY);
}
eq("address, one booked parcel: asks, does not escalate", [addressChangeReply({ message: "change my address", tag: "address_change", ownOrders: shipped })?.escalate, addressChangeReply({ message: "change my address", tag: "address_change", ownOrders: shipped })?.kind], [false, "address_ask"]);
eq("address, the new address is already in the message: a person decides", [addressChangeReply({ message: "change my address to Flat 4B, Green Park, New Delhi 110016", tag: "address_change", ownOrders: shipped })?.kind, addressChangeReply({ message: "change my address to Flat 4B, Green Park, New Delhi 110016", tag: "address_change", ownOrders: shipped })?.escalate], ["address_flag", true]);
eq("address, two booked parcels: a person decides which", [addressChangeReply({ message: "change my address", tag: "address_change", ownOrders: [...shipped, { id: "A9", status: "shipped", awb_code: "55" }] })?.kind, addressChangeReply({ message: "change my address", tag: "address_change", ownOrders: [...shipped, { id: "A9", status: "shipped", awb_code: "55" }] })?.text], ["address_flag", ADDRESS_FLAG_REPLY]);
eq("bookedOrderForAddressEdit: the one open booked parcel, not a delivered one", [bookedOrderForAddressEdit([...shipped, ...delivered])?.id, bookedOrderForAddressEdit([...shipped, { id: "A9", status: "shipped", awb_code: "55" }]), bookedOrderForAddressEdit(unbooked)], ["A1", null, null]);
eq("the new lines carry no 'cannot be changed' and no promise that it is changed", [ADDRESS_ASK_REPLY, ADDRESS_FLAG_REPLY].some((t) => /cannot be changed|has been changed|will be changed/i.test(t)), false);
eq("the old line is still a known line", LEGACY_ADDRESS_FLAG_REPLY, "This order is already with the courier, so the address cannot be changed now. I have escalated this to the team.");
eq("address before dispatch -> the model changes it", addressChangeReply({ message: "change my address", tag: "address_change", ownOrders: unbooked }), null);
eq("address, one editable one dispatched -> the model", addressChangeReply({ message: "change my address", tag: "address_change", ownOrders: [...shipped, ...unbooked] }), null);
eq("address on a delivered order -> the model explains", addressChangeReply({ message: "change my address", tag: "address_change", ownOrders: delivered }), null);
eq("not about an address", addressChangeReply({ message: "where is my order", tag: "order_status", ownOrders: shipped }), null);

// ── size ──
for (const m of ["What size you send", "which size is the bracelet", "what is the size of the chain", "how long is it", "size of the pendant?"]) {
  eq(`size first: ${m}`, text(sizeQuestionReply({ message: m, ownOrders: shipped })), SIZE_REPLY);
}
for (const status of ["processing", "call_1", "call_2", "confirmed", "manifested", "shipped"]) {
  eq(`size, order ${status}`, text(sizeQuestionReply({ message: "what size is it", ownOrders: [{ id: "X", status }] })), SIZE_REPLY);
}
eq("size, delivered order -> return routing, not this", sizeQuestionReply({ message: "what size is it", ownOrders: delivered }), null);
eq("size, no orders -> the model", sizeQuestionReply({ message: "what size is it", ownOrders: [] }), null);
eq("size insist -> team member", text(sizeQuestionReply({ message: "but I need the exact size please", ownOrders: shipped, lastBotReply: SIZE_REPLY })), SIZE_INSIST_REPLY);
eq("size insist escalates", sizeQuestionReply({ message: "what size is it again", ownOrders: shipped, lastBotReply: SIZE_REPLY })?.escalate, true);
eq("size first does not escalate", sizeQuestionReply({ message: "what size is it", ownOrders: shipped })?.escalate, false);

// size line links the item's own page when the order names it
const one = [{ id: "A1", status: "shipped", awb_code: "1", items: [{ name: "Franco Bracelet - Gold", slug: "franco-bracelet---gold" }] }];
eq("size: the item's own page", text(sizeQuestionReply({ message: "what size is it", ownOrders: one })), "You can find the sizes of your item on its product page: https://www.ajuki.in/products/franco-bracelet---gold");
const two = [{ id: "A1", status: "shipped", awb_code: "1", items: [{ name: "Franco", slug: "franco" }, { name: "Atlas", slug: "atlas" }, { name: "Franco", slug: "franco" }] }];
eq("size: two distinct items, no duplicate", text(sizeQuestionReply({ message: "what size is it", ownOrders: two }))?.split("https").length, 3);
const many = [{ id: "A1", status: "shipped", awb_code: "1", items: [1, 2, 3, 4].map((n) => ({ name: "P" + n, slug: "p" + n })) }];
eq("size: too many items -> the generic line", text(sizeQuestionReply({ message: "what size is it", ownOrders: many })), SIZE_REPLY);
eq("size: a delivered order's items are not linked", text(sizeQuestionReply({ message: "what size is it", ownOrders: [...one, { id: "A9", status: "delivered", awb_code: "9", items: [{ name: "Old", slug: "old" }] }] }))?.includes("products/old"), false);
eq("size insist still recognised after the linked line", text(sizeQuestionReply({ message: "but I need the exact size please", ownOrders: one, lastBotReply: "You can find the sizes of your item on its product page: https://www.ajuki.in/products/franco-bracelet---gold" })), SIZE_INSIST_REPLY);
// ── discounts ──
for (const m of ["Do you provide any discount on student id", "In your website there's a BOGO sell", "any offer going on?", "is there a coupon code"]) {
  eq(`discount: ${m}`, text(discountReply({ message: m, tag: "offer_discount" })), DISCOUNT_REPLY);
}
eq("discount escalates", discountReply({ message: "any discount?", tag: "offer_discount" })?.escalate, true);
eq("campaign reply with no discount wording", discountReply({ message: "Please check", tag: "offer_discount" }), null);
eq("refund money question is not a discount", discountReply({ message: "till when will I receive my cancelled money back", tag: "refund" }), null);

// false positives found in real history
for (const m of ["Cheap quality", "I am not satisfied with the quality", "Why mam the quality of the product is very poor", "You guys provide so bad quality products", "This quality price only 200"]) {
  eq(`quality COMPLAINT is not answered with the quality line: ${m}`, productInfoReply({ message: m }), null);
}
for (const m of ["Where can I see my order?", "What is this i already send a photo with mail", "I cant upload any pic in exchange menu", "Do I have to give the photos of worn bracelet", "Can you send a pics of my stuff before packing", "There is not any photo on this page"]) {
  eq(`not a request to see product photos: ${m}`, productInfoReply({ message: m }), null);
}
for (const m of ["Can u pls send the actual pic of the product??", "Send me photo of earings", "Please send me pictures"]) {
  eq(`real photo request: ${m}`, text(productInfoReply({ message: m })), PHOTOS_REPLY);
}
for (const m of ["How long will it take for my order to arrive ??", "How long does this take", "Size is small", "And this size is big", "Its too loose the size is not perfect according to my hand size"]) {
  eq(`not a size question: ${m}`, sizeQuestionReply({ message: m, ownOrders: shipped }), null);
}
for (const m of ["Size mm", "Can you tell me the size of Radiant tennis bracelet", "Still whats the ideal size of this?", "Size?", "Can I ask what's the size of the bracelet??", "I need to now the size of pendant"]) {
  eq(`size question: ${m}`, text(sizeQuestionReply({ message: m, ownOrders: shipped })), SIZE_REPLY);
}
for (const m of ["And I don’t like the quality also", "Return it because its tarnish and looking white", "It is more that 2 weeks i spend money for something not in my size and not in the quality"]) {
  eq(`quality complaint (curly quotes / fault): ${m}`, productInfoReply({ message: m }), null);
}
for (const m of ["I’ll let you know about the size", "Is return policy available if I didn’t like the item size ??"]) {
  eq(`not a size question: ${m}`, sizeQuestionReply({ message: m, ownOrders: shipped }), null);
}
eq("negated address change", addressChangeReply({ message: "No sir I don't want to change my adress", tag: "address_change", ownOrders: shipped }), null);
eq("negated address change, curly quote", addressChangeReply({ message: "No sir I don’t want to change my address", tag: "other", ownOrders: shipped }), null);

// ── no physical store ──
for (const m of ["Where is the office", "where is your shop?", "Do you have a physical store", "can I visit your store", "your office address please", "do u have offline shop", "I want to come to your showroom"]) {
  eq(`no store: ${m}`, text(noStoreReply({ message: m })), NO_STORE_REPLY);
}
for (const m of ["where is my order", "how do I store the chain so it does not tarnish", "is the store on Instagram active", "the delivery boy went to the wrong office", "I want to visit my parcel status", "where is my parcel"]) {
  eq(`not a store question: ${m}`, noStoreReply({ message: m }), null);
}
eq("the store reply is reached through topicReply", text(topicReply({ message: "Where is the office", tag: "other", ownOrders: shipped })), NO_STORE_REPLY);

// ── precedence ──
eq("size beats quality", text(topicReply({ message: "what size is it and is it good quality", tag: "sizing", ownOrders: shipped })), SIZE_REPLY);
eq("nothing matched", topicReply({ message: "ok where is my parcel", tag: "order_status", ownOrders: shipped }), null);


// 23 Oct: "9000100005 & 9000100022", sent because we had just asked for the new phone number, was answered by asking for a delivery address
{
  const booked = [{ id: "AJUKI1", status: "shipped", awb_code: "SF123" }];
  for (const m of ["9000100005 & 9000100022", "9000100018", "+91 9876543210", "my new number is 9876543210", "9000100005 and 9000100022"]) {
    const r = addressChangeReply({ message: m, tag: "address_change", ownOrders: booked });
    eq(`phone given: ${m}`, [r?.kind, r?.escalate, r?.text], ["phone_given", true, PHONE_GIVEN_REPLY]);
  }
  eq("not after another topic", addressChangeReply({ message: "9000100018", tag: "order_status", ownOrders: booked }), null);
  eq("an address with a number in it is still an address", addressChangeReply({ message: "Flat 4, MG Road Pune 411001 phone 9876543210", tag: "address_change", ownOrders: booked })?.kind, "address_flag");
  eq("isPhoneOnly", [isPhoneOnly("9000100018"), isPhoneOnly("9000100018 9000100019"), isPhoneOnly("call 9000100018 tomorrow"), isPhoneOnly("hello"), isPhoneOnly(""), isPhoneOnly("12345")], [true, true, false, false, false, false]);
}
// 24 Oct: "Update phone" on a thread already tagged address_change was answered by asking for a delivery address
{
  const booked = [{ id: "AJUKI1", status: "shipped", awb_code: "SF123" }];
  for (const tag of ["address_change", "late_delivery", "other"]) {
    const r = topicReply({ message: "Update phone", tag, ownOrders: booked });
    eq(`Update phone (${tag}) is the phone request`, [r?.kind, r?.escalate], ["phone_flag", true]);
  }
  eq("a real address request on an address_change thread is unchanged", topicReply({ message: "I want to change my address", tag: "address_change", ownOrders: booked })?.kind, "address_ask");
}
console.log(`${passed} passed, 0 failed`);
