/** Last ten digits, so +91 / 0 / spaces / dashes all compare equal. */
export function normalizePhone(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * A real Indian mobile number: ten digits starting 6, 7, 8 or 9.
 *
 * normalizePhone only takes the last ten digits — it cannot tell a mobile from
 * ten digits of nonsense, because its job is comparison, not judgement. Where a
 * number is being collected rather than compared, that difference matters: a
 * WhatsApp template sent to an unreachable number is a message the customer
 * never sees and a delivery failure counted against the sender's quality
 * rating, which is the one metric that can get the number throttled.
 *
 * Landlines are deliberately rejected. Every use of this is a WhatsApp field.
 */
export function isIndianMobile(value: string | null | undefined): boolean {
  return /^[6-9]\d{9}$/.test(normalizePhone(value));
}

/**
 * What a phone field should hold as someone types into it.
 *
 * Strips formatting, drops a country code or trunk prefix that was pasted in
 * ("+91 98765 43210", "09876543210"), then caps at ten. Capping rather than
 * taking the last ten is deliberate: an eleventh keystroke should be ignored,
 * not silently shift the whole number left and change the first digit under
 * the customer's cursor.
 */
export function toPhoneInput(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (digits.length > 10 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length > 10 && digits.startsWith("0")) digits = digits.slice(1);
  return digits.slice(0, 10);
}

/** True when two numbers are the same person, whatever the formatting. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizePhone(a);
  return x.length === 10 && x === normalizePhone(b);
}

/**
 * Razorpay gives us two numbers per order and they are not always the same one:
 *
 *   shipping_address.contact — free text on the delivery address. This is who
 *     the courier should call, and for a "deliver to someone else" order it is
 *     deliberately a different person.
 *   customer_details.contact — the number the customer received an OTP on to
 *     log into Razorpay, so it is provably reachable and provably theirs.
 *
 * They disagreed on 2 of 18 checkable orders. Until now we kept whichever the
 * calling code happened to reach for and dropped the other, so an order could
 * carry a number nobody answers with no trace of the one that works. Keep both:
 * the delivery contact leads, the verified number rides along when it differs.
 */
/**
 * Which number to send a WhatsApp notification to.
 *
 * The verified one when we have it. `phone` is whatever was typed on the
 * delivery address and can simply be wrong — one customer's address contact was
 * a digit off, which is how a parcel ends up unreachable. `altPhone` is the
 * number Razorpay sent an OTP to, so it is provably a working handset and
 * provably the buyer's.
 *
 * It is also the right recipient on a "deliver to someone else" order: the
 * person who placed it wants to know it shipped, not the person receiving the
 * gift. The courier still gets the delivery contact — that is a separate field
 * and unaffected by this.
 */
export function notificationPhone(address?: { phone?: string; altPhone?: string } | null): string {
  return (address?.altPhone ?? "").trim() || (address?.phone ?? "").trim();
}

export function pickPhones(
  deliveryContact: string | null | undefined,
  verifiedContact: string | null | undefined,
): { phone: string; altPhone?: string } {
  const delivery = (deliveryContact ?? "").trim();
  const verified = (verifiedContact ?? "").trim();

  if (!delivery) return { phone: verified };
  if (!verified || samePhone(delivery, verified)) return { phone: delivery };

  return { phone: delivery, altPhone: verified };
}
