import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { PROJECT, FN, call, newCustomer, signUp, signIn, clearFirestore } from './helpers.ts';
import { CashfreeStub } from './cashfree-stub.ts';
import { todayIST, addDays } from '../../../shared/model.ts';

if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();
const stub = new CashfreeStub();
const PID = 'pay-test-pg';
let guestA: Awaited<ReturnType<typeof newCustomer>>;
let guestB: Awaited<ReturnType<typeof newCustomer>>;
let financeToken = '';

const ci = addDays(todayIST(), 20);
const co = addDays(ci, 2);

before(async () => {
  await stub.start(9911);
  await clearFirestore();
  await db.doc('settings/platform').set({ gstPercent: 5, commissionPercent: 10, holdMinutes: 15 });
  await db.collection('properties').doc(PID).set({
    ownerId: 'owner-x', name: 'Payment Test PG', slug: PID, localityId: 'siripuram', localityName: 'Siripuram', address: 'x', description: '',
    accommodationType: 'pg', genderPolicy: 'coed', foodType: 'veg_nonveg', status: 'approved', verified: true, instantBook: true,
    allowDaily: true, allowWeekly: true, allowMonthly: true, minStayDays: 1, cancellationPolicy: 'flexible', houseRules: '',
    checkInTime: '12:00', checkOutTime: '11:00', mealTimes: { breakfast: '', lunch: '', dinner: '' }, photos: [], amenityIds: [],
    ratingAvg: 0, ratingCount: 0, pricing: { minDaily: 500, minWeekly: null, minMonthly: null, hasAc: true, roomTypes: ['private', 'shared'], totalBeds: 3 },
    createdAt: 1, updatedAt: 1, approvedAt: 1,
  });
  const rooms = db.collection('properties').doc(PID).collection('rooms');
  await rooms.doc('P1').set({ code: 'P1', name: 'Private Room', roomType: 'private', capacity: 1, ac: true, attachedBath: true, priceDaily: 1000, priceWeekly: null, priceMonthly: null, deposit: 0, mealsIncluded: true, features: '', description: '', active: true, beds: [{ id: 'P1', label: 'P1', active: true }] });
  await rooms.doc('S1').set({ code: 'S1', name: 'Shared Room', roomType: 'shared', capacity: 2, ac: true, attachedBath: false, priceDaily: 500, priceWeekly: null, priceMonthly: null, deposit: 0, mealsIncluded: true, features: '', description: '', active: true, beds: [{ id: 'S1-A', label: 'S1-A', active: true }, { id: 'S1-B', label: 'S1-B', active: true }] });
  guestA = await newCustomer('pa');
  guestB = await newCustomer('pb');
  const finEmail = `finance${Date.now()}@example.in`;
  const fin = await signUp(finEmail);
  await getAuth().setCustomUserClaims(fin.localId, { role: 'admin', adminRole: 'finance' });
  financeToken = await signIn(finEmail);
});
after(async () => {
  await stub.stop();
});

const book = (token: string, extra: Record<string, unknown> = {}) =>
  call('createBooking', {
    propertyId: PID, roomId: 'P1', checkIn: ci, checkOut: co, guestName: 'Test Guest', guestPhone: '+91 98765 43210', acceptPolicies: true,
    idempotencyKey: 'key' + Math.random().toString(36).slice(2, 12), ...extra,
  }, token);

async function postWebhook(payload: unknown, secret?: string) {
  const w = stub.webhook(payload, secret);
  const r = await fetch(`${FN}/cashfreeWebhook`, { method: 'POST', headers: w.headers, body: w.raw });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const paymentWebhook = (orderId: string, status: string, type = 'PAYMENT_SUCCESS_WEBHOOK') => ({
  data: { order: { order_id: orderId, order_amount: 0, order_currency: 'INR' }, payment: { payment_status: status } }, event_time: new Date().toISOString(), type,
});
const booking = async (id: string) => (await db.collection('bookings').doc(id).get()).data()!;
const payment = async (id: string) => (await db.collection('payments').doc(id).get()).data()!;

let confirmedId = '';
let confirmedOrder = '';

test('booking holds a bed atomically, rejects overlaps and is idempotent', async () => {
  const unauth = await call('createBooking', { propertyId: PID });
  assert.equal(unauth.error?.status, 'UNAUTHENTICATED');
  const bad = await book(guestA.token, { acceptPolicies: false });
  assert.equal(bad.error?.status, 'INVALID_ARGUMENT');
  const past = await book(guestA.token, { checkIn: addDays(todayIST(), -2), checkOut: addDays(todayIST(), -1) });
  assert.equal(past.error?.status, 'INVALID_ARGUMENT');

  const key = 'idem' + Date.now();
  const a = await book(guestA.token, { idempotencyKey: key });
  assert.equal(a.result?.status, 'pending_payment', JSON.stringify(a));
  assert.equal(a.result.amounts.payable, 2 * 1000 + 100); // 2 nights + 5% GST
  const again = await book(guestA.token, { idempotencyKey: key });
  assert.equal(again.result?.bookingId, a.result.bookingId);
  const clash = await book(guestB.token, { checkIn: addDays(ci, 1), checkOut: addDays(co, 1) });
  assert.equal(clash.error?.status, 'ALREADY_EXISTS');

  // Concurrent attempts for the last bed: exactly one wins.
  const both = await Promise.all([book(guestA.token, { checkIn: addDays(ci, 30), checkOut: addDays(ci, 31) }), book(guestB.token, { checkIn: addDays(ci, 30), checkOut: addDays(ci, 31) })]);
  assert.equal(both.filter((r) => r.result).length, 1, JSON.stringify(both.map((r) => r.error?.status ?? 'ok')));

  const avail = await call('getAvailability', { propertyId: PID, checkIn: ci, checkOut: co });
  const p1 = avail.result.rooms.find((r: any) => r.id === 'P1');
  assert.equal(p1.availableBeds, 0);
  confirmedId = a.result.bookingId;
});

test('payment order is created server-side, stored, and reused', async () => {
  const other = await call('createPaymentOrder', { bookingId: confirmedId }, guestB.token);
  assert.equal(other.error?.status, 'NOT_FOUND');
  const o = await call('createPaymentOrder', { bookingId: confirmedId }, guestA.token);
  assert.ok(o.result?.paymentSessionId, JSON.stringify(o));
  assert.equal(o.result.environment, 'sandbox');
  confirmedOrder = o.result.orderId;
  const p = await payment(confirmedOrder);
  assert.equal(p.status, 'created');
  assert.equal(p.amount, 2100);
  assert.equal(stub.orders.get(confirmedOrder)!.body.order_amount, 2100);
  assert.equal(stub.orders.get(confirmedOrder)!.body.customer_details.customer_phone, '9876543210');
  const reuse = await call('createPaymentOrder', { bookingId: confirmedId }, guestA.token);
  assert.equal(reuse.result.orderId, confirmedOrder);
  assert.equal(stub.requests.filter((r) => r.method === 'POST' && r.path === '/pg/orders').length, 1);
});

test('abandoned and failed attempts never confirm the booking', async () => {
  const v0 = await call('verifyPayment', { bookingId: confirmedId }, guestA.token);
  assert.equal(v0.result.bookingStatus, 'pending_payment');
  stub.pay(confirmedOrder, 'USER_DROPPED');
  const v1 = await call('verifyPayment', { bookingId: confirmedId }, guestA.token);
  assert.equal(v1.result.bookingStatus, 'pending_payment');
  assert.equal(v1.result.paymentStatus, 'failed');
  assert.equal(v1.result.lastPayment.status, 'cancelled');
  stub.pay(confirmedOrder, 'FAILED');
  const v2 = await call('verifyPayment', { bookingId: confirmedId }, guestA.token);
  assert.equal(v2.result.lastPayment.status, 'failed');
  assert.equal((await booking(confirmedId)).status, 'pending_payment');
});

test('webhook: signature verified, success confirmed via API, duplicates ignored', async () => {
  // A forged "success" webhook without a gateway-side payment changes nothing.
  const forged = await postWebhook(paymentWebhook(confirmedOrder, 'SUCCESS'), 'wrong-secret');
  assert.equal(forged.status, 401);
  const unpaid = await postWebhook(paymentWebhook(confirmedOrder, 'SUCCESS'));
  assert.equal(unpaid.status, 200);
  assert.equal((await booking(confirmedId)).status, 'pending_payment', 'webhook payload alone must not confirm');

  stub.pay(confirmedOrder, 'SUCCESS');
  const ok = await postWebhook({ ...paymentWebhook(confirmedOrder, 'SUCCESS'), event_time: 'later' });
  assert.equal(ok.status, 200);
  const b = await booking(confirmedId);
  assert.equal(b.status, 'confirmed');
  assert.equal(b.paymentStatus, 'paid');
  assert.equal(b.paidOrderId, confirmedOrder);
  const p = await payment(confirmedOrder);
  assert.equal(p.status, 'paid');
  assert.ok(p.gatewayPaymentId);
  const night = (await db.collection('bedNights').doc(`${PID}__P1__P1__${ci}`).get()).data()!;
  assert.equal(night.status, 'booked');

  const dup = await postWebhook({ ...paymentWebhook(confirmedOrder, 'SUCCESS'), event_time: 'later' });
  assert.equal(dup.body.duplicate, true);
  const v = await call('verifyPayment', { bookingId: confirmedId }, guestA.token);
  assert.equal(v.result.bookingStatus, 'confirmed');
  const again = await call('createPaymentOrder', { bookingId: confirmedId }, guestA.token);
  assert.equal(again.error?.status, 'FAILED_PRECONDITION');
  const logs = await db.collection('paymentLogs').where('orderId', '==', confirmedOrder).get();
  assert.ok(logs.docs.some((d) => d.data().event === 'payment.confirmed'));
  assert.equal(logs.docs.filter((d) => d.data().event === 'payment.confirmed').length, 1);
});

test('a second successful payment for the same booking is refunded automatically', async () => {
  const b = await book(guestB.token, { roomId: 'S1', bedId: 'S1-A' });
  const id = b.result.bookingId;
  const o1 = (await call('createPaymentOrder', { bookingId: id }, guestB.token)).result.orderId;
  await db.collection('payments').doc(o1).update({ orderExpiresAt: Date.now() }); // force a second order (e.g. user retried in another tab)
  const o2 = (await call('createPaymentOrder', { bookingId: id }, guestB.token)).result.orderId;
  assert.notEqual(o1, o2);
  stub.pay(o1, 'SUCCESS');
  stub.pay(o2, 'SUCCESS');
  const v = await call('verifyPayment', { bookingId: id }, guestB.token);
  assert.equal(v.result.bookingStatus, 'confirmed');
  const p2 = await payment(o2);
  const p1 = await payment(o1);
  const dupOrder = p1.duplicateOf ? o1 : o2;
  assert.ok((await payment(dupOrder)).duplicateOf);
  const refunds = await db.collection('refunds').where('bookingId', '==', id).get();
  assert.equal(refunds.size, 1);
  const r = refunds.docs[0].data();
  assert.equal(r.kind, 'duplicate_payment');
  assert.equal(r.orderId, dupOrder);
  assert.ok(r.submittedAt);
  assert.equal((await booking(id)).paymentStatus, 'paid');
  assert.ok(p2.status === 'paid' && p1.status === 'paid');
});

test('amount mismatch is flagged for review instead of confirming', async () => {
  const b = await book(guestB.token, { roomId: 'S1', bedId: 'S1-B' });
  const o = (await call('createPaymentOrder', { bookingId: b.result.bookingId }, guestB.token)).result.orderId;
  stub.pay(o, 'SUCCESS', 1);
  await call('verifyPayment', { bookingId: b.result.bookingId }, guestB.token);
  assert.equal((await payment(o)).status, 'review');
  assert.equal((await booking(b.result.bookingId)).status, 'pending_payment');
});

test('cancellation refunds via Cashfree, refund webhook settles it, and the bed is released', async () => {
  const c = await call('cancelBooking', { bookingId: confirmedId, reason: 'Plans changed' }, guestA.token);
  assert.equal(c.result?.status, 'cancelled', JSON.stringify(c));
  assert.equal(c.result.refundAmount, 2100);
  const refunds = await db.collection('refunds').where('bookingId', '==', confirmedId).get();
  const refundId = refunds.docs[0].id;
  assert.equal(refunds.docs[0].data().status, 'pending');
  assert.equal((await booking(confirmedId)).paymentStatus, 'refund_pending');

  stub.setRefundStatus(confirmedOrder, refundId, 'SUCCESS');
  const w = await postWebhook({ data: { refund: { refund_id: refundId, order_id: confirmedOrder, refund_status: 'SUCCESS' } }, type: 'REFUND_STATUS_WEBHOOK' });
  assert.equal(w.status, 200);
  const r = (await db.collection('refunds').doc(refundId).get()).data()!;
  assert.equal(r.status, 'processed');
  const b = await booking(confirmedId);
  assert.equal(b.paymentStatus, 'refunded');
  assert.equal(b.refundedAmount, 2100);

  const rebook = await book(guestB.token);
  assert.equal(rebook.result?.status, 'pending_payment', JSON.stringify(rebook));
});

test('lapsed holds expire; a late payment for a resold bed is refunded', async () => {
  const late = await book(guestA.token, { checkIn: addDays(ci, 60), checkOut: addDays(ci, 61) });
  const id = late.result.bookingId;
  const o = (await call('createPaymentOrder', { bookingId: id }, guestA.token)).result.orderId;
  await db.collection('bookings').doc(id).update({ holdExpiresAt: Date.now() - 1000 });
  const nights = await db.collection('bedNights').where('bookingId', '==', id).get();
  await Promise.all(nights.docs.map((d) => d.ref.update({ holdExpiresAt: Date.now() - 1000 })));

  const denied = await call('adminRunHousekeeping', {}, guestA.token);
  assert.equal(denied.error?.status, 'PERMISSION_DENIED');
  const hk = await call('adminRunHousekeeping', {}, financeToken);
  assert.ok(hk.result?.expired >= 1, JSON.stringify(hk));
  assert.equal((await booking(id)).status, 'expired');

  const taken = await book(guestB.token, { checkIn: addDays(ci, 60), checkOut: addDays(ci, 61) });
  assert.equal(taken.result?.status, 'pending_payment');

  stub.pay(o, 'SUCCESS');
  await postWebhook({ ...paymentWebhook(o, 'SUCCESS'), event_time: 'late' });
  const b = await booking(id);
  assert.equal(b.status, 'expired');
  assert.equal(b.paymentStatus, 'refund_pending');
  const refunds = await db.collection('refunds').where('bookingId', '==', id).get();
  assert.equal(refunds.docs[0].data().kind, 'inventory_unavailable');
  const winner = await booking(taken.result.bookingId);
  assert.equal(winner.status, 'pending_payment', 'the new guest keeps the bed');
});

test('clients cannot read other customers’ payments or write payment data', async () => {
  const { initializeApp: initClient } = await import('firebase/app');
  const { getFirestore: clientDb, connectFirestoreEmulator, doc, getDoc, setDoc } = await import('firebase/firestore');
  const { getAuth: clientAuth, connectAuthEmulator, signInWithCustomToken } = await import('firebase/auth');
  const app = initClient({ projectId: PROJECT, apiKey: 'fake' }, 'client-check');
  const auth = clientAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'}`, { disableWarnings: true });
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085').split(':');
  const cdb = clientDb(app);
  connectFirestoreEmulator(cdb, host, Number(port));
  await signInWithCustomToken(auth, await getAuth().createCustomToken(guestB.uid, { role: 'customer' }));
  await assert.rejects(getDoc(doc(cdb, 'payments', confirmedOrder)));
  await assert.rejects(setDoc(doc(cdb, 'bookings', confirmedId), { status: 'confirmed' }));
  await assert.rejects(setDoc(doc(cdb, 'payments', 'fake-order'), { status: 'paid', customerId: guestB.uid }));
  const { deleteApp } = await import('firebase/app');
  await deleteApp(app);
});
