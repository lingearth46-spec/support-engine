// What goes in a replacement parcel.
//
// Worth testing rather than eyeballing because every failure here is stock out
// of the door for nothing. The order is free — nobody is charged and no courier
// collects — so an over-count is a pure giveaway with no invoice behind it to
// notice it later, and an under-count is a customer promised a replacement who
// receives half of one.
//
// The indices come from the browser, so the clamping is a trust boundary and not
// a convenience: a request naming index 7 on a two-item order, or a quantity of
// 99 on an order of one, must not be able to post goods that were never bought.

import {
  replacementItems,
  isWithinReturnWindow,
  daysLeftToReturn,
  RETURN_REASONS,
  CUSTOMER_RETURN_REASONS,
  RETURN_PICKUP_FEE,
  pickupFeeFor,
  photoRequiredFor,
  photoPromptFor,
  videoRequiredFor,
  videoNoticeFor,
  detailsRequiredFor,
  SUPPORT_EMAIL,
  returnWindowOverride,
  returnWindowNote,
} from "@policy/returnPolicy";

let passed = 0;
let failed = 0;

function eq(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
  }
}

function deepEq(label: string, actual: unknown, expected: unknown) {
  eq(label, JSON.stringify(actual), JSON.stringify(expected));
}

const bracelet = { name: "Atlas Bracelet", price: 499, quantity: 1 };
const chain = { name: "Franco Chain", price: 799, quantity: 2 };
const order = [bracelet, chain];

// ── A full replacement ────────────────────────────────────────────────────────
//
// No lines at all is the bulk-approve case and the default single case: the
// whole order goes again, at the quantities originally bought.
deepEq("no lines sends everything", replacementItems(order), order);
deepEq("empty lines sends everything", replacementItems(order, []), order);
eq("quantities are the ones ordered", replacementItems(order)?.[1].quantity, 2);

// ── A partial replacement ─────────────────────────────────────────────────────
deepEq(
  "one item of two",
  replacementItems(order, [{ index: 0, quantity: 1 }]),
  [bracelet]
);
deepEq(
  "one of a pair — the 'ordered two, got one' case",
  replacementItems(order, [{ index: 1, quantity: 1 }]),
  [{ ...chain, quantity: 1 }]
);
deepEq(
  "a zero drops the line rather than shipping nothing",
  replacementItems(order, [{ index: 0, quantity: 0 }, { index: 1, quantity: 2 }]),
  [chain]
);

// ── Nothing to send ───────────────────────────────────────────────────────────
//
// Null, never an empty array: the caller has to be able to tell "send these" from
// "send nothing", and an empty parcel must abort the approval rather than create
// an order with no items in it.
eq("all zeroes is null", replacementItems(order, [{ index: 0, quantity: 0 }]), null);
eq("an order with no items is null", replacementItems([]), null);
eq("null items is null", replacementItems(null), null);
eq("undefined items is null", replacementItems(undefined), null);

// ── The trust boundary ────────────────────────────────────────────────────────
eq(
  "an index past the end is dropped",
  replacementItems(order, [{ index: 7, quantity: 1 }]),
  null
);
eq(
  "a negative index is dropped",
  replacementItems(order, [{ index: -1, quantity: 1 }]),
  null
);
eq(
  "more than was bought is capped at what was bought",
  replacementItems(order, [{ index: 0, quantity: 99 }])?.[0].quantity,
  1
);
eq(
  "a fractional quantity floors rather than shipping 1.9 bracelets",
  replacementItems(order, [{ index: 1, quantity: 1.9 }])?.[0].quantity,
  1
);
eq(
  "a negative quantity drops the line",
  replacementItems(order, [{ index: 1, quantity: -3 }]),
  null
);
eq(
  "a non-numeric quantity drops the line",
  replacementItems(order, [{ index: 1, quantity: "two" as unknown as number }]),
  null
);

// The original must not be edited in place. It is the row we still have to write
// back, and a mutated copy would silently rewrite the customer's actual order.
const untouched = [{ name: "Atlas Bracelet", price: 499, quantity: 3 }];
replacementItems(untouched, [{ index: 0, quantity: 1 }]);
eq("the original order is not mutated", untouched[0].quantity, 3);

// Everything else on the item survives, since the parcel has to be packable.
const rich = [{ name: "Atlas", price: 499, quantity: 2, color: "Silver", size: "Free", sku: "ATL-S" }];
deepEq(
  "colour, size and sku carry across",
  replacementItems(rich, [{ index: 0, quantity: 1 }]),
  [{ ...rich[0], quantity: 1 }]
);

// ── The reasons a replacement can be raised against ───────────────────────────
//
// Pinned because the list is what the approval writes into the new order's note.
//
// Change of mind and fit were once removed for cause and are back as of
// 2026-09-11 — deliberately, by founder decision, and on different terms: they
// are now accepted with the customer paying the pickup, rather than offered and
// then refused. So the guard is no longer "these two must never reappear"; it is
// that whenever they appear they must carry customer fault and no photo demand.
// That is the property that made the old arrangement cruel, and it is the one
// worth pinning.
deepEq("every reason offered to a customer", CUSTOMER_RETURN_REASONS, [
  "Item arrived damaged",
  "Item is defective",
  "Wrong item received",
  "Size doesn't fit",
  "Something else",
]);

// "Other" is admin-only and must stay off the customer's dropdown.
eq("Other is not offered to customers", CUSTOMER_RETURN_REASONS.includes("Other"), false);
eq("Other still exists for admin recategorising", RETURN_REASONS.includes("Other"), true);

// Our fault: free pickup, and a photo is worth demanding because it can decide.
for (const reason of ["Item arrived damaged", "Item is defective", "Wrong item received"]) {
  eq(`${reason} is a free pickup`, pickupFeeFor(reason), 0);
  eq(`${reason} requires a photo`, photoRequiredFor(reason), true);
}

// Customer's choice: they pay for the collection either way.
for (const reason of ["Size doesn't fit", "Something else"]) {
  eq(`${reason} is charged for`, pickupFeeFor(reason), RETURN_PICKUP_FEE);
}

// But photos do NOT follow fault, and this is the distinction worth pinning.
//
// A sizing claim needs a post-wear photo: the item as it arrived proves nothing
// about fit, while the piece worn settles it at a glance. A change of mind needs
// none — nothing exists for a photo to prove, and asking anyway is what made
// these requests miserable before.
eq("sizing requires a photo", photoRequiredFor("Size doesn't fit"), true);
eq("and it must be a worn one", /worn/i.test(photoPromptFor("Size doesn't fit") ?? ""), true);
eq("the catch-all requires no photo", photoRequiredFor("Something else"), false);
eq("and asks for nothing", photoPromptFor("Something else"), null);

// The fault reasons ask for the item as it arrived, not for it worn.
eq("damage asks for the item, not the wearer", /worn/i.test(photoPromptFor("Item arrived damaged") ?? ""), false);

// An unknown reason must default to demanding a photo — the safe direction when
// we cannot tell what is being claimed.
eq("unknown reason still requires a photo", photoRequiredFor("Something we never listed"), true);

// ── The unboxing video ────────────────────────────────────────────────────────
//
// Required only where the claim is that the wrong thing came out of the bag. It
// settles the two disputes that actually arise — whether the damage happened
// before or after opening, and whether the parcel held what we say we packed.
eq("damaged needs the video", videoRequiredFor("Item arrived damaged"), true);
eq("wrong item needs the video", videoRequiredFor("Wrong item received"), true);

// The important exclusion, and the one most likely to be "tidied up" later by
// someone reasoning that all three of our-fault reasons should match: a clasp
// that jams on day five is a real defect and no unboxing video can show it.
// Demanding one would refuse exactly the claims this category exists to accept.
eq("defective does NOT need the video", videoRequiredFor("Item is defective"), false);

// Customer-fault reasons never do. Nothing about a change of mind or a fit
// problem is settled by watching the bag being opened.
eq("sizing does not need the video", videoRequiredFor("Size doesn't fit"), false);
eq("the catch-all does not need the video", videoRequiredFor("Something else"), false);

// The heaviest thing we ask of a customer must never be triggered by a label we
// do not recognise — the opposite default to photos, and deliberately so.
eq("unknown reason does not demand a video", videoRequiredFor("Something we never listed"), false);
eq("null reason does not demand a video", videoRequiredFor(null), false);

// The notice must name the address the video is emailed to, and must not be
// shown at all where no video is wanted. The video is never uploaded through the
// form — see the comment on UNBOXING_VIDEO_PROMPT for why — so this sentence is
// the only place the customer is told what to keep and where to send it.
eq("the notice names the support inbox", (videoNoticeFor("Item arrived damaged") ?? "").includes(SUPPORT_EMAIL), true);
eq("the notice describes the sealed bag", /tamper-proof/i.test(videoNoticeFor("Wrong item received") ?? ""), true);
eq("no notice where no video is wanted", videoNoticeFor("Something else"), null);
eq("no notice for a defect", videoNoticeFor("Item is defective"), null);

// An unrecognised reason must never invent a charge. Wrongly charging someone is
// worse than wrongly absorbing a pickup — the same asymmetry the window applies.
eq("unknown reason is not charged", pickupFeeFor("Something we never listed"), 0);
eq("null reason is not charged", pickupFeeFor(null), 0);

// ── The window, which predates this file and had no test ──────────────────────
eq("no delivery date allows a return", isWithinReturnWindow(null), true);
eq("undefined delivery date allows a return", isWithinReturnWindow(undefined), true);
eq("delivered today is inside the window", isWithinReturnWindow(new Date().toISOString()), true);
eq(
  "delivered a fortnight ago is outside it",
  isWithinReturnWindow(new Date(Date.now() - 14 * 86_400_000).toISOString()),
  false
);
eq("no date leaves no day count", daysLeftToReturn(null), null);

if (failed > 0) process.exit(1);

// ── The catch-all has to carry words ──────────────────────────────────────────
//
// This is what makes "Something else" safe to offer at all. An option meaning
// "none of the above" tells us nothing on its own — it was removed once before
// for exactly that. It works now because it is priced (the pickup is charged)
// AND described (the customer has to say what is wrong). Drop either half and
// this is the old unbounded catch-all again.
eq("the catch-all demands a description", detailsRequiredFor("Something else"), true);

// The named reasons do not. Someone who picked "Item arrived damaged" and
// attached a photo of the damage has already said what is wrong; making them
// type it again is friction with nothing behind it.
for (const reason of ["Item arrived damaged", "Item is defective", "Wrong item received", "Size doesn't fit"]) {
  eq(`${reason} does not demand a description`, detailsRequiredFor(reason), false);
}

// The label itself is pinned. "Changed my mind" was replaced deliberately — it
// was a word we put in the customer's mouth, and it pushed people into claiming
// defects they did not have. It should not drift back in.
eq("the old label is gone", CUSTOMER_RETURN_REASONS.includes("Changed my mind"), false);


// ── Goodwill window overrides ────────────────────────────────────────────────
//
// A person reopening one order's window. The alternative was editing
// delivered_at, which feeds courier SLA stats, the delivery-estimate model and
// the line the bot reads back to the customer — three things that must not move
// to win one return.

const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

eq("a month-old delivery is out of the window", isWithinReturnWindow(longAgo), false);
eq("with a live override it is allowed", isWithinReturnWindow(longAgo, `[return-window-until:${soon}]`), true);
eq("an expired override does not reopen it", isWithinReturnWindow(longAgo, `[return-window-until:${past}]`), false);
eq("unrelated notes change nothing", isWithinReturnWindow(longAgo, "called customer, no answer"), false);
eq("no notes at all", isWithinReturnWindow(longAgo, null), false);

// The marker has to survive sitting among other ops notes, since that is the
// only way it will ever exist in practice.
eq(
  "found among other notes",
  isWithinReturnWindow(longAgo, `spoke to courier
[return-window-until:${soon}]
chased on WhatsApp`),
  true,
);

// An override never SHORTENS a live window.
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
eq("an expired override leaves a live window alone", isWithinReturnWindow(yesterday, `[return-window-until:${past}]`), true);

eq("no marker reads as no override", returnWindowOverride("nothing here"), null);
eq("a malformed date is not an override", returnWindowOverride("[return-window-until:soon]"), null);

// The note the granting script writes must be one the reader accepts.
eq("what we write is what we read", isWithinReturnWindow(longAgo, returnWindowNote(7)), true);
eq("a zero-day grant is already over", isWithinReturnWindow(longAgo, returnWindowNote(-1)), false);

console.log(`${passed} passed, ${failed} failed`);
