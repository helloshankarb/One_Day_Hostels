import crypto from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { Transaction, DocumentReference } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db, audit } from './admin.ts';
import { parseOrThrow, requireAuth } from './profile.ts';
import { PHONE_RE, todayIST, type BookingDoc, type PropertyDoc, type RoomDoc } from '../../shared/model.ts';
import { quote, stayNights, PricingError, isValidDate, refundFor, type Quote } from '../../shared/pricing.ts';
import { createRefundRecord, processRefund, logPayment } from './paymentFlow.ts';
import { PAYMENT_SECRETS } from './payments/index.ts';

export interface PlatformSettings {
  gstPercent: number;
  commissionPercent: number;
  holdMinutes: number;
}

export async function platformSettings(): Promise<PlatformSettings> {
  const s = (await db.doc('settings/platform').get()).data() ?? {};
  return { gstPercent: Number(s.gstPercent ?? 5), commissionPercent: Number(s.commissionPercent ?? 10), holdMinutes: Number(s.holdMinutes ?? 15) };
}

export const nightRef = (propertyId: string, roomId: string, bedId: string, date: string) =>
  db.collection('bedNights').doc(`${propertyId}__${roomId}__${bedId}__${date}`);

interface NightDoc {
  propertyId: string;
  roomId: string;
  bedId: string;
  date: string;
  bookingId: string;
  status: 'held' | 'booked';
  holdExpiresAt: number | null;
}

/** A night blocks inventory if it is booked, or held by an unexpired hold. */
export const nightActive = (n: NightDoc | undefined, now = Date.now()) => !!n && (n.status === 'booked' || (n.holdExpiresAt ?? 0) > now);

/** Deletes the nights still owned by this booking (another booking may have taken a lapsed hold). */
export async function releaseNights(tx: Transaction, bookingId: string, b: Pick<BookingDoc, 'propertyId' | 'roomId' | 'bedId' | 'checkIn' | 'checkOut'>) {
  const refs = stayNights(b.checkIn, b.checkOut).map((d) => nightRef(b.propertyId, b.roomId, b.bedId, d));
  const snaps = await Promise.all(refs.map((r) => tx.get(r)));
  return () => snaps.forEach((s) => s.exists && (s.data() as NightDoc).bookingId === bookingId && tx.delete(s.ref));
}

async function occupiedBeds(propertyId: string, checkIn: string, checkOut: string) {
  const snap = await db.collection('bedNights').where('propertyId', '==', propertyId).where('date', '>=', checkIn).where('date', '<', checkOut).get();
  const now = Date.now();
  const set = new Set<string>();
  snap.docs.forEach((d) => {
    const n = d.data() as NightDoc;
    if (nightActive(n, now)) set.add(`${n.roomId}__${n.bedId}`);
  });
  return set;
}

async function loadProperty(propertyId: string) {
  const snap = await db.collection('properties').doc(propertyId).get();
  const p = snap.data() as PropertyDoc | undefined;
  if (!p || p.status !== 'approved') throw new HttpsError('not-found', 'This property is not available for booking');
  return p;
}

const rangeInput = z.object({
  propertyId: z.string().min(1).max(80),
  checkIn: z.string().refine(isValidDate, 'Choose a valid check-in date'),
  checkOut: z.string().refine(isValidDate, 'Choose a valid check-out date'),
});

function assertRange(checkIn: string, checkOut: string) {
  if (checkIn < todayIST()) throw new HttpsError('invalid-argument', 'Check-in date cannot be in the past');
  if (checkOut <= checkIn) throw new HttpsError('invalid-argument', 'Check-out must be after check-in');
}

function quoteOrThrow(room: RoomDoc, p: PropertyDoc, checkIn: string, checkOut: string, s: PlatformSettings): Quote {
  try {
    return quote(room, p, checkIn, checkOut, s);
  } catch (e) {
    if (e instanceof PricingError) throw new HttpsError('invalid-argument', e.message);
    throw e;
  }
}

/** Live bed availability and per-room quotes for a stay window. */
export const getAvailability = onCall(async (req) => {
  const input = parseOrThrow(rangeInput, req.data);
  assertRange(input.checkIn, input.checkOut);
  const p = await loadProperty(input.propertyId);
  const [rooms, occupied, s] = await Promise.all([
    db.collection('properties').doc(input.propertyId).collection('rooms').where('active', '==', true).get(),
    occupiedBeds(input.propertyId, input.checkIn, input.checkOut),
    platformSettings(),
  ]);
  return {
    rooms: rooms.docs.map((d) => {
      const r = d.data() as RoomDoc;
      let q: Quote | null = null;
      let quoteError: string | null = null;
      try {
        q = quote(r, p, input.checkIn, input.checkOut, s);
      } catch (e) {
        quoteError = e instanceof PricingError ? e.message : 'Unavailable';
      }
      const beds = r.beds.filter((b) => b.active).map((b) => ({ id: b.id, label: b.label, available: !occupied.has(`${d.id}__${b.id}`) }));
      return { id: d.id, name: r.name, roomType: r.roomType, beds, availableBeds: beds.filter((b) => b.available).length, quote: q, quoteError };
    }),
  };
});

const bookingInput = rangeInput.extend({
  roomId: z.string().min(1).max(40),
  bedId: z.string().min(1).max(40).nullish(),
  guestName: z.string().trim().min(2, 'Enter the guest name').max(80),
  guestPhone: z.string().trim().transform((s) => s.replace(/[\s-]/g, '')).pipe(z.string().regex(PHONE_RE, 'Enter a valid Indian mobile number')),
  guestEmail: z.email('Enter a valid email').nullish().or(z.literal('')),
  guestGender: z.enum(['male', 'female', 'other']).nullish(),
  specialRequests: z.string().trim().max(500).nullish(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid request key'),
  acceptPolicies: z.literal(true, 'Please accept the house rules and cancellation policy'),
});

const genCode = () => 'ODH-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);

/**
 * Places a time-limited hold on one bed for every night of the stay and creates a pending booking.
 * The hold is taken inside a Firestore transaction on per-night documents, so two guests can never hold the same bed-night.
 */
export const createBooking = onCall(async (req) => {
  const auth = requireAuth(req);
  if (auth.token.role !== 'customer') throw new HttpsError('permission-denied', 'Sign in with a guest account to book');
  const input = parseOrThrow(bookingInput, req.data);
  assertRange(input.checkIn, input.checkOut);
  const bookingId = 'bk_' + crypto.createHash('sha256').update(`${auth.uid}:${input.idempotencyKey}`).digest('hex').slice(0, 24);
  const bookingRef = db.collection('bookings').doc(bookingId);
  const existing = await bookingRef.get();
  if (existing.exists) return { bookingId, ...(existing.data() as BookingDoc) };

  const p = await loadProperty(input.propertyId);
  if (p.ownerId === auth.uid) throw new HttpsError('failed-precondition', 'You cannot book your own property');
  if (p.genderPolicy === 'men' && input.guestGender === 'female') throw new HttpsError('failed-precondition', 'This property accepts men only');
  if (p.genderPolicy === 'women' && input.guestGender === 'male') throw new HttpsError('failed-precondition', 'This property accepts women only');
  const roomSnap = await db.collection('properties').doc(input.propertyId).collection('rooms').doc(input.roomId).get();
  const room = roomSnap.data() as RoomDoc | undefined;
  if (!room || !room.active) throw new HttpsError('not-found', 'Room not found');
  const s = await platformSettings();
  const q = quoteOrThrow(room, p, input.checkIn, input.checkOut, s);

  const activeBeds = room.beds.filter((b) => b.active);
  let candidates = input.bedId ? activeBeds.filter((b) => b.id === input.bedId) : activeBeds;
  if (!candidates.length) throw new HttpsError('not-found', 'Bed not found');
  const occupied = await occupiedBeds(input.propertyId, input.checkIn, input.checkOut);
  candidates = candidates.filter((b) => !occupied.has(`${input.roomId}__${b.id}`));
  if (!candidates.length) throw new HttpsError('already-exists', input.bedId ? 'Sorry, this bed was just booked for those dates. Please pick another bed.' : 'No beds are available in this room for the selected dates');
  const bed = candidates[0];
  const dates = stayNights(input.checkIn, input.checkOut);
  const user = (await db.collection('users').doc(auth.uid).get()).data();

  const booking = await db.runTransaction(async (tx) => {
    const again = await tx.get(bookingRef);
    if (again.exists) return again.data() as BookingDoc;
    const now = Date.now();
    const refs = dates.map((d) => nightRef(input.propertyId, input.roomId, bed.id, d));
    const nights = await Promise.all(refs.map((r) => tx.get(r)));
    if (nights.some((n) => nightActive(n.data() as NightDoc | undefined, now))) {
      throw new HttpsError('already-exists', 'Sorry, this bed was just booked for those dates. Please pick another bed.');
    }
    const holdExpiresAt = now + s.holdMinutes * 60000;
    refs.forEach((r, i) =>
      tx.set(r, { propertyId: input.propertyId, roomId: input.roomId, bedId: bed.id, date: dates[i], bookingId, status: 'held', holdExpiresAt } satisfies NightDoc),
    );
    const doc: BookingDoc = {
      code: genCode(),
      customerId: auth.uid,
      ownerId: p.ownerId,
      propertyId: input.propertyId,
      propertyName: p.name,
      localityName: p.localityName,
      roomId: input.roomId,
      roomName: room.name,
      bedId: bed.id,
      bedLabel: bed.label,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      nights: q.nights,
      stayType: q.stayType,
      guest: { name: input.guestName, phone: input.guestPhone, email: input.guestEmail || user?.email || null, gender: input.guestGender ?? null },
      specialRequests: input.specialRequests || null,
      amounts: { base: q.baseAmount, discount: q.discount, tax: q.taxAmount, deposit: q.deposit, total: q.totalAmount, payable: q.payableNow, commission: q.commissionAmount },
      priceLines: q.lines,
      cancellationPolicy: p.cancellationPolicy,
      checkInTime: p.checkInTime,
      status: 'pending_payment',
      paymentStatus: 'unpaid',
      paidOrderId: null,
      holdExpiresAt,
      paymentAttempts: 0,
      refundedAmount: 0,
      cancelReason: null,
      cancelledBy: null,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
      cancelledAt: null,
    };
    tx.create(bookingRef, doc);
    return doc;
  });
  await audit(auth.uid, 'booking.create', 'booking', bookingId, { code: booking.code, amount: booking.amounts.payable });
  return { bookingId, ...booking };
});

/** Customer cancellation: releases inventory and refunds per the property's policy. */
export const cancelBooking = onCall({ secrets: PAYMENT_SECRETS }, async (req) => {
  const auth = requireAuth(req);
  const input = parseOrThrow(z.object({ bookingId: z.string().min(3).max(64), reason: z.string().trim().min(3, 'Tell us why you are cancelling').max(500) }), req.data);
  return cancelBookingInternal(input.bookingId, { by: 'customer', actorId: auth.uid, reason: input.reason, requireCustomer: auth.uid });
});

export async function cancelBookingInternal(
  bookingId: string,
  opts: { by: 'customer' | 'admin' | 'system'; actorId: string; reason: string; requireCustomer?: string; refundOverride?: number },
) {
  const ref = db.collection('bookings').doc(bookingId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const b = snap.data() as BookingDoc | undefined;
    if (!b || (opts.requireCustomer && b.customerId !== opts.requireCustomer)) throw new HttpsError('not-found', 'Booking not found');
    if (!['pending_payment', 'confirmed'].includes(b.status)) {
      throw new HttpsError('failed-precondition', b.status === 'checked_in' ? 'Checked-in stays cannot be cancelled online' : 'This booking can no longer be cancelled');
    }
    const release = await releaseNights(tx, bookingId, b);
    let refund: { ref: DocumentReference; amount: number } | null = null;
    let percent = 0;
    if (b.paymentStatus === 'paid' && b.paidOrderId) {
      const r = refundFor({ totalAmount: b.amounts.total, deposit: b.amounts.deposit, checkIn: b.checkIn, createdAt: b.createdAt }, b.cancellationPolicy, b.checkInTime);
      percent = r.percent;
      const amount = Math.max(0, Math.min(opts.refundOverride ?? r.amount, b.amounts.payable));
      if (amount > 0) refund = { ref: createRefundRecord(tx, { booking: b, bookingId, orderId: b.paidOrderId, amount, reason: opts.reason, kind: opts.by === 'admin' ? 'admin' : 'cancellation', initiatedBy: opts.actorId }), amount };
    }
    release();
    const now = Date.now();
    tx.update(ref, {
      status: 'cancelled',
      cancelReason: opts.reason,
      cancelledBy: opts.by,
      cancelledAt: now,
      updatedAt: now,
      holdExpiresAt: null,
      ...(refund ? { paymentStatus: 'refund_pending' } : {}),
    });
    return { refund, percent, code: b.code };
  });
  await audit(opts.actorId, 'booking.cancel', 'booking', bookingId, { by: opts.by, reason: opts.reason, refund: result.refund?.amount ?? 0 });
  if (result.refund) {
    await logPayment('refund.initiated', { bookingId, refundId: result.refund.ref.id, amount: result.refund.amount, actor: opts.actorId });
    await processRefund(result.refund.ref.id).catch((e) => console.error('refund submission failed; housekeeping will retry', e));
  }
  return { status: 'cancelled', refundAmount: result.refund?.amount ?? 0, refundPercent: result.percent };
}
