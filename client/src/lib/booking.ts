import { httpsCallable } from 'firebase/functions';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { db, functions } from './firebase';
import type { BookingDoc, PaymentDoc, RefundDoc } from '../../../shared/model';
import type { Quote } from '../../../shared/pricing';

export interface RoomAvailability {
  id: string;
  name: string;
  roomType: string;
  beds: { id: string; label: string; available: boolean }[];
  availableBeds: number;
  quote: Quote | null;
  quoteError: string | null;
}

export interface CreateBookingInput {
  propertyId: string;
  roomId: string;
  bedId?: string | null;
  checkIn: string;
  checkOut: string;
  guestName: string;
  guestPhone: string;
  guestEmail?: string | null;
  guestGender?: 'male' | 'female' | 'other' | null;
  specialRequests?: string | null;
  idempotencyKey: string;
  acceptPolicies: true;
}

export interface VerifyResult {
  bookingStatus: BookingDoc['status'];
  paymentStatus: BookingDoc['paymentStatus'];
  holdExpiresAt: number | null;
  lastPayment: { orderId: string; status: PaymentDoc['status']; failureReason: string | null } | null;
}

const fn = <I, O>(name: string) => {
  const c = httpsCallable<I, O>(functions, name);
  return async (input: I) => (await c(input)).data;
};

export const getAvailability = fn<{ propertyId: string; checkIn: string; checkOut: string }, { rooms: RoomAvailability[] }>('getAvailability');
export const createBooking = fn<CreateBookingInput, BookingDoc & { bookingId: string }>('createBooking');
export const createPaymentOrder = fn<{ bookingId: string }, { orderId: string; paymentSessionId: string; environment: 'sandbox' | 'production' }>('createPaymentOrder');
export const verifyPayment = fn<{ bookingId: string }, VerifyResult>('verifyPayment');
export const cancelBooking = fn<{ bookingId: string; reason: string }, { status: string; refundAmount: number; refundPercent: number }>('cancelBooking');

export type BookingWithId = BookingDoc & { id: string };

export async function listMyBookings(uid: string): Promise<BookingWithId[]> {
  const snap = await getDocs(query(collection(db, 'bookings'), where('customerId', '==', uid), orderBy('createdAt', 'desc'), limit(100)));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as BookingDoc) }));
}

export async function getMyBooking(id: string): Promise<BookingWithId | null> {
  const snap = await getDoc(doc(db, 'bookings', id)).catch(() => null);
  return snap?.exists() ? { id: snap.id, ...(snap.data() as BookingDoc) } : null;
}

export async function bookingPayments(bookingId: string, uid: string) {
  const [p, r] = await Promise.all([
    getDocs(query(collection(db, 'payments'), where('bookingId', '==', bookingId), where('customerId', '==', uid))),
    getDocs(query(collection(db, 'refunds'), where('bookingId', '==', bookingId), where('customerId', '==', uid))),
  ]);
  return {
    payments: p.docs.map((d) => d.data() as PaymentDoc).sort((a, b) => b.createdAt - a.createdAt),
    refunds: r.docs.map((d) => ({ id: d.id, ...(d.data() as RefundDoc) })).sort((a, b) => b.createdAt - a.createdAt),
  };
}

/** Opens Cashfree's hosted checkout in a modal. The result is only a UI hint; the server verifies the payment. */
export async function openCashfreeCheckout(paymentSessionId: string, environment: 'sandbox' | 'production') {
  const { load } = await import('@cashfreepayments/cashfree-js');
  const cashfree = await load({ mode: environment });
  if (!cashfree) throw new Error('Could not load the payment window. Check your connection and try again.');
  return cashfree.checkout({ paymentSessionId, redirectTarget: '_modal' });
}
