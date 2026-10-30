import crypto from 'node:crypto';
import { all, get, run, tx, type Row } from '../db/index.ts';
import { config } from '../config.ts';
import { HttpError, conflict, notFound, badRequest } from './http.ts';
import { quote, refundFor, type CancellationPolicy, type Coupon } from './pricing.ts';
import { todayIST, isValidDate, nowIso } from './dates.ts';
import { notify, getSetting, sendEmail, emailTemplates } from './services.ts';

/** SQL fragment: booking row `b` currently occupies inventory. Bind :now. */
export const ACTIVE_BOOKING = `(b.status IN ('confirmed','checked_in') OR (b.status IN ('requested','pending_payment') AND b.hold_expires_at > :now))`;

export function expireHolds() {
  const now = nowIso();
  const expired = all<{ id: number; customer_id: number; code: string }>(
    "SELECT id, customer_id, code FROM bookings WHERE status IN ('requested','pending_payment') AND hold_expires_at <= ? AND payment_status NOT IN ('paid','pending')",
    now,
  );
  for (const b of expired) {
    run("UPDATE bookings SET status = 'expired' WHERE id = ?", b.id);
    notify(b.customer_id, 'booking', `Booking ${b.code} expired`, 'The bed hold lapsed before payment was completed.', `/account/bookings/${b.code}`);
  }
}

export function validateRange(checkIn: string, checkOut: string) {
  if (!isValidDate(checkIn) || !isValidDate(checkOut)) throw badRequest('Choose valid check-in and check-out dates');
  if (checkIn < todayIST()) throw badRequest('Check-in date cannot be in the past');
  if (checkOut <= checkIn) throw badRequest('Check-out must be after check-in');
}

export function availability(propertyId: number, checkIn: string, checkOut: string) {
  const now = nowIso();
  const rooms = all(
    'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY price_daily',
    propertyId,
  );
  const beds = all(
    `SELECT bd.id, bd.room_id, bd.label,
       EXISTS (SELECT 1 FROM bookings b WHERE b.bed_id = bd.id AND ${ACTIVE_BOOKING} AND b.check_in < :out AND b.check_out > :in) AS booked,
       EXISTS (SELECT 1 FROM bed_blocks k WHERE k.bed_id = bd.id AND k.start_date < :out AND k.end_date > :in) AS blocked
     FROM beds bd JOIN rooms r ON r.id = bd.room_id
     WHERE r.property_id = :pid AND bd.active = 1 ORDER BY bd.label`,
    { now, in: checkIn, out: checkOut, pid: propertyId },
  );
  return rooms.map((r) => {
    const rb = beds.filter((b) => b.room_id === r.id).map((b) => ({ id: b.id, label: b.label, available: !b.booked && !b.blocked }));
    return { ...r, beds: rb, available_beds: rb.filter((b) => b.available).length };
  });
}

export function findCoupon(code: string | undefined | null, propertyId: number): (Coupon & Row) | null {
  if (!code) return null;
  const today = todayIST();
  const c = get<Coupon & Row>('SELECT * FROM coupons WHERE code = ? AND active = 1', code.trim());
  if (!c) throw badRequest('This coupon code is not valid');
  if (c.property_id && c.property_id !== propertyId) throw badRequest('This coupon is not valid for this property');
  if (today < c.valid_from || today > c.valid_to) throw badRequest('This coupon has expired');
  if (c.usage_limit !== null && c.used_count >= c.usage_limit) throw badRequest('This coupon has reached its usage limit');
  return c;
}

export function pricingOptions() {
  return {
    gstPercent: Number(getSetting('gst_percent', 5)),
    commissionPercent: Number(getSetting('commission_percent', 10)),
  };
}

export function quoteFor(propertyId: number, roomId: number, checkIn: string, checkOut: string, couponCode?: string | null) {
  const property = get('SELECT * FROM properties WHERE id = ?', propertyId);
  const room = get('SELECT * FROM rooms WHERE id = ? AND property_id = ? AND active = 1', roomId, propertyId);
  if (!property || !room) throw notFound('Room');
  const coupon = findCoupon(couponCode, propertyId);
  return { property, room, coupon, quote: quote(room as any, property as any, checkIn, checkOut, { ...pricingOptions(), coupon }) };
}

const genCode = () => 'ODH-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);

export interface CreateBookingInput {
  property_id: number;
  room_id: number;
  bed_id?: number | null;
  check_in: string;
  check_out: string;
  guest_name: string;
  guest_phone: string;
  guest_email?: string | null;
  guest_gender?: 'male' | 'female' | 'other' | null;
  guest_id_type?: string | null;
  special_requests?: string | null;
  coupon_code?: string | null;
  idempotency_key?: string | null;
  accept_policies: boolean;
}

export function createBooking(customerId: number, input: CreateBookingInput) {
  validateRange(input.check_in, input.check_out);
  if (!input.accept_policies) throw badRequest('Please accept the house rules and cancellation policy');
  expireHolds();
  return tx(() => {
    if (input.idempotency_key) {
      const existing = get('SELECT * FROM bookings WHERE customer_id = ? AND idempotency_key = ?', customerId, input.idempotency_key);
      if (existing) return existing;
    }
    const property = get("SELECT * FROM properties WHERE id = ? AND status = 'approved'", input.property_id);
    if (!property) throw notFound('Property');
    if (property.owner_id === customerId) throw badRequest('You cannot book your own property');
    if (property.gender_policy === 'men' && input.guest_gender === 'female') throw badRequest('This property accepts men only');
    if (property.gender_policy === 'women' && input.guest_gender === 'male') throw badRequest('This property accepts women only');

    const { room, coupon, quote: q } = quoteFor(input.property_id, input.room_id, input.check_in, input.check_out, input.coupon_code);
    const now = nowIso();
    const freeBeds = all<{ id: number }>(
      `SELECT bd.id FROM beds bd WHERE bd.room_id = :room AND bd.active = 1
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.bed_id = bd.id AND ${ACTIVE_BOOKING} AND b.check_in < :out AND b.check_out > :in)
         AND NOT EXISTS (SELECT 1 FROM bed_blocks k WHERE k.bed_id = bd.id AND k.start_date < :out AND k.end_date > :in)
       ORDER BY bd.label`,
      { room: room.id, now, in: input.check_in, out: input.check_out },
    );
    let bedId: number;
    if (input.bed_id) {
      const owned = get('SELECT id FROM beds WHERE id = ? AND room_id = ?', input.bed_id, room.id);
      if (!owned) throw notFound('Bed');
      if (!freeBeds.some((b) => b.id === input.bed_id)) throw conflict('Sorry, this bed was just booked for those dates. Please pick another bed.');
      bedId = input.bed_id;
    } else {
      if (!freeBeds.length) throw conflict('No beds are available in this room for the selected dates');
      bedId = freeBeds[0].id;
    }

    const instant = !!property.instant_book;
    const holdMs = instant ? Number(getSetting('booking_hold_minutes', config.holdMinutes)) * 60000 : 24 * 3600000;
    const r = run(
      `INSERT INTO bookings (code, customer_id, property_id, room_id, bed_id, check_in, check_out, nights, stay_type,
         guest_name, guest_phone, guest_email, guest_gender, guest_id_type, special_requests,
         base_amount, discount, tax_amount, deposit, total_amount, commission_amount, coupon_id,
         status, hold_expires_at, idempotency_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      genCode(), customerId, property.id, room.id, bedId, input.check_in, input.check_out, q.nights, q.stay_type,
      input.guest_name, input.guest_phone, input.guest_email ?? null, input.guest_gender ?? null, input.guest_id_type ?? null,
      input.special_requests ?? null, q.base_amount, q.discount, q.tax_amount, q.deposit, q.total_amount, q.commission_amount,
      coupon?.id ?? null, instant ? 'pending_payment' : 'requested', new Date(Date.now() + holdMs).toISOString(),
      input.idempotency_key ?? null,
    );
    const booking = get('SELECT * FROM bookings WHERE id = ?', r.id)!;
    notify(
      property.owner_id,
      'booking',
      instant ? `New booking started: ${booking.code}` : `New booking request: ${booking.code}`,
      `${input.guest_name} • ${input.check_in} → ${input.check_out} • ${room.name}`,
      `/owner/bookings?focus=${booking.code}`,
    );
    return booking;
  });
}

export function ownerRespond(ownerId: number, bookingId: number, accept: boolean, reason?: string) {
  return tx(() => {
    const b = get(
      'SELECT b.* FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.id = ? AND p.owner_id = ?',
      bookingId, ownerId,
    );
    if (!b) throw notFound('Booking');
    if (b.status !== 'requested') throw badRequest('Only pending requests can be accepted or declined');
    if (accept) {
      run("UPDATE bookings SET status = 'pending_payment', hold_expires_at = ? WHERE id = ?", new Date(Date.now() + 24 * 3600000).toISOString(), b.id);
      notify(b.customer_id, 'booking', `Request ${b.code} accepted`, 'Complete payment within 24 hours to confirm your bed.', `/account/bookings/${b.code}`);
    } else {
      run("UPDATE bookings SET status = 'rejected', cancel_reason = ?, cancelled_by = 'owner', cancelled_at = ? WHERE id = ?", reason ?? null, nowIso(), b.id);
      notify(b.customer_id, 'booking', `Request ${b.code} declined`, reason ?? 'The property could not accept this request.', `/account/bookings/${b.code}`);
    }
    return get('SELECT * FROM bookings WHERE id = ?', b.id);
  });
}

export async function cancelBooking(
  bookingId: number,
  by: 'customer' | 'owner' | 'admin',
  actorId: number,
  reason: string,
  overrideRefund?: number,
) {
  const result = tx(() => {
    const b = get('SELECT * FROM bookings WHERE id = ?', bookingId);
    if (!b) throw notFound('Booking');
    if (!['requested', 'pending_payment', 'confirmed'].includes(b.status)) {
      throw badRequest(b.status === 'checked_in' ? 'Checked-in stays cannot be cancelled. Please check out instead.' : 'This booking can no longer be cancelled');
    }
    const prop = get('SELECT * FROM properties WHERE id = ?', b.property_id)!;
    let refundAmount = 0;
    let percent = 0;
    const payment = get("SELECT * FROM payments WHERE booking_id = ? AND status = 'paid' ORDER BY id DESC LIMIT 1", b.id);
    if (payment) {
      if (by === 'owner') {
        refundAmount = payment.amount;
        percent = 100;
      } else {
        const r = refundFor(b as any, prop.cancellation_policy as CancellationPolicy, prop.check_in_time);
        refundAmount = Math.min(r.amount, payment.amount);
        percent = r.percent;
      }
      if (by === 'admin' && overrideRefund !== undefined) refundAmount = Math.max(0, Math.min(overrideRefund, payment.amount));
    }
    const now = nowIso();
    run(
      `UPDATE bookings SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ?, hold_expires_at = NULL,
         payment_status = CASE WHEN ? > 0 THEN 'refund_pending' ELSE payment_status END WHERE id = ?`,
      reason, by, now, refundAmount, b.id,
    );
    let refundId: number | null = null;
    if (payment && refundAmount > 0) {
      refundId = run('INSERT INTO refunds (booking_id, payment_id, amount, reason, initiated_by) VALUES (?, ?, ?, ?, ?)', b.id, payment.id, refundAmount, reason, actorId).id;
    }
    notify(b.customer_id, 'booking', `Booking ${b.code} cancelled`, refundAmount ? `Refund of ₹${refundAmount} initiated (${percent}% of stay charges + deposit).` : 'No refund applies to this cancellation.', `/account/bookings/${b.code}`);
    if (by !== 'owner') notify(prop.owner_id, 'booking', `Booking ${b.code} cancelled`, `${b.guest_name} • ${b.check_in}`, `/owner/bookings?focus=${b.code}`);
    const cust = get('SELECT name, email FROM users WHERE id = ?', b.customer_id)!;
    sendEmail(cust.email, emailTemplates.bookingCancelled(cust.name, b.code, refundAmount));
    return { booking: b, refundId, refundAmount, payment };
  });
  // Online payments moved to Firebase (Cashfree); legacy refunds stay pending for manual processing by finance.
  return { refund_amount: result.refundAmount, booking: get('SELECT * FROM bookings WHERE id = ?', bookingId) };
}

export function syncRefundStatus(bookingId: number) {
  const b = get('SELECT * FROM bookings WHERE id = ?', bookingId)!;
  const paid = get<{ s: number }>("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE booking_id = ? AND status = 'paid'", bookingId)!.s;
  const refunded = get<{ s: number }>("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE booking_id = ? AND status = 'processed'", bookingId)!.s;
  const pending = get<{ c: number }>("SELECT COUNT(*) c FROM refunds WHERE booking_id = ? AND status = 'pending'", bookingId)!.c;
  const status = pending ? 'refund_pending' : refunded >= paid ? 'refunded' : refunded > 0 ? 'partially_refunded' : b.payment_status;
  run('UPDATE bookings SET payment_status = ? WHERE id = ?', status, bookingId);
}

export function checkIn(bookingId: number, ownerId: number) {
  return tx(() => {
    const b = get('SELECT b.* FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.id = ? AND p.owner_id = ?', bookingId, ownerId);
    if (!b) throw notFound('Booking');
    if (b.status !== 'confirmed') throw badRequest('Only confirmed bookings can be checked in');
    if (b.check_in > todayIST()) throw badRequest(`Check-in opens on ${b.check_in}`);
    run("UPDATE bookings SET status = 'checked_in', checked_in_at = ? WHERE id = ?", nowIso(), b.id);
    notify(b.customer_id, 'booking', `Welcome! You're checked in`, `Booking ${b.code}`, `/account/bookings/${b.code}`);
    return get('SELECT * FROM bookings WHERE id = ?', b.id);
  });
}

export function checkOut(bookingId: number, ownerId: number) {
  return tx(() => {
    const b = get('SELECT b.* FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.id = ? AND p.owner_id = ?', bookingId, ownerId);
    if (!b) throw notFound('Booking');
    if (b.status !== 'checked_in') throw badRequest('Only checked-in guests can be checked out');
    run("UPDATE bookings SET status = 'completed', checked_out_at = ? WHERE id = ?", nowIso(), b.id);
    notify(b.customer_id, 'review', `How was your stay?`, `Share a review for booking ${b.code}`, `/account/bookings/${b.code}`);
    return get('SELECT * FROM bookings WHERE id = ?', b.id);
  });
}

export function recalcRating(propertyId: number) {
  const r = get<{ avg: number | null; n: number }>(
    "SELECT AVG(rating) avg, COUNT(*) n FROM reviews WHERE property_id = ? AND status = 'published'",
    propertyId,
  )!;
  run('UPDATE properties SET rating_avg = ?, rating_count = ? WHERE id = ?', r.avg ? Math.round(r.avg * 100) / 100 : 0, r.n, propertyId);
}

export { HttpError };
