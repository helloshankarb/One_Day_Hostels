import crypto from 'node:crypto';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db, audit } from './admin.ts';
import { parseOrThrow, requireAuth } from './profile.ts';
import { nightRef, nightActive, releaseNights, cancelBookingInternal } from './bookings.ts';
import { getGateway, GatewayError, samePaise, PAYMENT_SECRETS, APP_URL, PAYMENT_NOTIFY_URL, type GatewayAttempt } from './payments/index.ts';
import type { BookingDoc, PaymentDoc, PaymentRecordStatus, RefundDoc } from '../../shared/model.ts';
import { stayNights } from '../../shared/pricing.ts';

const ORDER_TTL_MS = 20 * 60000;
const HOLD_GRACE_MS = 10 * 60000;
/** A failed or abandoned attempt does not close a Cashfree order; the customer may retry until it expires. */
const OPEN_STATUSES: PaymentRecordStatus[] = ['created', 'pending', 'failed', 'cancelled'];

/** Append-only transaction log for admin reporting and reconciliation. */
export function logPayment(event: string, details: Record<string, unknown>) {
  return db.collection('paymentLogs').add({ event, ...details, at: Date.now() });
}

function notifyUser(uid: string, title: string, body: string, link: string) {
  return db.collection('users').doc(uid).collection('notifications').add({ type: 'payment', title, body, link, readAt: null, createdAt: Date.now() });
}

export function createRefundRecord(
  tx: Transaction,
  r: { booking: BookingDoc; bookingId: string; orderId: string; amount: number; reason: string; kind: RefundDoc['kind']; initiatedBy: string },
) {
  const ref = db.collection('refunds').doc('RF' + crypto.randomBytes(10).toString('hex').toUpperCase());
  const now = Date.now();
  const doc: RefundDoc = {
    gateway: 'cashfree', bookingId: r.bookingId, bookingCode: r.booking.code, orderId: r.orderId, customerId: r.booking.customerId,
    amount: r.amount, status: 'pending', reason: r.reason, kind: r.kind, gatewayRefundId: null, gatewayStatus: null, submittedAt: null,
    initiatedBy: r.initiatedBy, createdAt: now, updatedAt: now, processedAt: null,
  };
  tx.create(ref, doc);
  return ref;
}

/** Recomputes the booking's refund state from its refund records. Duplicate-payment refunds do not affect the stay itself. */
async function syncBookingRefunds(bookingId: string) {
  const [bSnap, refunds] = await Promise.all([db.collection('bookings').doc(bookingId).get(), db.collection('refunds').where('bookingId', '==', bookingId).get()]);
  const b = bSnap.data() as BookingDoc | undefined;
  if (!b) return;
  const list = refunds.docs.map((d) => d.data() as RefundDoc).filter((r) => r.kind !== 'duplicate_payment');
  const refunded = list.filter((r) => r.status === 'processed').reduce((s, r) => s + r.amount, 0);
  const pending = list.some((r) => r.status === 'pending');
  let paymentStatus = b.paymentStatus;
  if (list.length && b.paidOrderId) {
    paymentStatus = pending ? 'refund_pending' : refunded >= b.amounts.payable ? 'refunded' : refunded > 0 ? 'partially_refunded' : list.every((r) => r.status === 'failed') ? 'paid' : b.paymentStatus;
  }
  await bSnap.ref.update({ refundedAmount: refunded, paymentStatus, updatedAt: Date.now() });
}

/** Submits a pending refund to the gateway (idempotent by refund id) and records the gateway's answer. */
export async function processRefund(refundId: string) {
  const ref = db.collection('refunds').doc(refundId);
  const r = (await ref.get()).data() as RefundDoc | undefined;
  if (!r || r.status !== 'pending') return;
  const gw = getGateway();
  const res = r.submittedAt ? await gw.getRefund(r.orderId, refundId) : await gw.createRefund(r.orderId, refundId, r.amount, `${r.kind} ${r.bookingCode}`);
  if (!res) return;
  const now = Date.now();
  await ref.update({
    gatewayRefundId: res.gatewayRefundId, gatewayStatus: res.rawStatus, submittedAt: r.submittedAt ?? now, status: res.status,
    processedAt: res.status === 'processed' ? now : null, updatedAt: now,
  });
  await logPayment('refund.' + res.status, { refundId, orderId: r.orderId, bookingId: r.bookingId, amount: r.amount, gatewayStatus: res.rawStatus });
  await syncBookingRefunds(r.bookingId);
  if (res.status === 'processed') await notifyUser(r.customerId, `Refund of ₹${r.amount} processed`, `Booking ${r.bookingCode}`, `/account/bookings/${r.bookingId}`);
}

const ATTEMPT_TO_RECORD: Record<GatewayAttempt['status'], PaymentRecordStatus> = {
  success: 'paid', failed: 'failed', pending: 'pending', cancelled: 'cancelled', user_dropped: 'cancelled', void: 'cancelled', not_attempted: 'created',
};

/**
 * Single source of truth for payment state: always asks the gateway, never trusts redirects or client input.
 * Safe to call any number of times (webhooks, client verification, scheduled reconciliation).
 */
export async function reconcileOrder(orderId: string, source: string) {
  const payRef = db.collection('payments').doc(orderId);
  const pay = (await payRef.get()).data() as PaymentDoc | undefined;
  if (!pay) throw new HttpsError('not-found', 'Payment not found');
  if (pay.status === 'paid' || pay.status === 'review') return { paymentStatus: pay.status };

  const gw = getGateway();
  const attempts = (await gw.getAttempts(orderId)).sort((a, b) => b.time - a.time);
  const success = attempts.find((a) => a.status === 'success');
  const now = Date.now();

  if (!success) {
    const latest = attempts[0];
    const orderStatus = await gw.getOrderStatus(orderId);
    let status: PaymentRecordStatus = latest ? ATTEMPT_TO_RECORD[latest.status] : 'created';
    if ((orderStatus === 'expired' || orderStatus === 'terminated') && status !== 'pending') status = 'expired';
    if (orderStatus === 'paid') status = 'pending'; // paid order without a visible attempt yet: re-check shortly
    await db.runTransaction(async (tx) => {
      const p = (await tx.get(payRef)).data() as PaymentDoc;
      if (p.status === 'paid') return;
      const bRef = db.collection('bookings').doc(p.bookingId);
      const b = (await tx.get(bRef)).data() as BookingDoc;
      tx.update(payRef, {
        status, gatewayPaymentId: latest?.paymentId ?? null, method: latest?.method ?? null,
        failureReason: status === 'failed' || status === 'cancelled' ? latest?.message ?? 'Payment was not completed' : null,
        lastReconciledAt: now, updatedAt: now,
      });
      if (['unpaid', 'pending', 'failed'].includes(b.paymentStatus) && b.paidOrderId === null) {
        tx.update(bRef, { paymentStatus: status === 'pending' ? 'pending' : status === 'failed' || status === 'cancelled' ? 'failed' : 'unpaid', updatedAt: now });
      }
    });
    if (status !== pay.status) await logPayment('payment.' + status, { orderId, bookingId: pay.bookingId, source, attemptId: latest?.paymentId ?? null, message: latest?.message ?? null });
    return { paymentStatus: status };
  }

  if (!samePaise(success.amount, pay.amount)) {
    await payRef.update({ status: 'review', gatewayPaymentId: success.paymentId, failureReason: `Amount mismatch: paid ₹${success.amount}, expected ₹${pay.amount}`, lastReconciledAt: now, updatedAt: now });
    await logPayment('payment.amount_mismatch', { orderId, bookingId: pay.bookingId, source, paid: success.amount, expected: pay.amount });
    return { paymentStatus: 'review' as const };
  }

  const outcome = await db.runTransaction(async (tx) => {
    const p = (await tx.get(payRef)).data() as PaymentDoc;
    if (p.status === 'paid') return { kind: 'already' as const };
    const bRef = db.collection('bookings').doc(p.bookingId);
    const b = (await tx.get(bRef)).data() as BookingDoc;
    const refs = stayNights(b.checkIn, b.checkOut).map((d) => nightRef(b.propertyId, b.roomId, b.bedId, d));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    const paidFields = {
      status: 'paid' as const, gatewayPaymentId: success.paymentId, method: success.method, bankReference: success.bankReference,
      failureReason: null, paidAt: success.time || now, lastReconciledAt: now, updatedAt: now,
    };

    if (b.paidOrderId && b.paidOrderId !== orderId) {
      tx.update(payRef, { ...paidFields, duplicateOf: b.paidOrderId });
      const refund = createRefundRecord(tx, { booking: b, bookingId: p.bookingId, orderId, amount: p.amount, reason: 'Duplicate payment for an already-paid booking', kind: 'duplicate_payment', initiatedBy: 'system' });
      return { kind: 'duplicate' as const, refundId: refund.id, b };
    }
    const inventoryOk = snaps.every((s) => !s.exists || s.data()!.bookingId === p.bookingId || !nightActive(s.data() as never, now));
    if (['pending_payment', 'expired'].includes(b.status) && inventoryOk) {
      refs.forEach((r, i) => tx.set(r, { propertyId: b.propertyId, roomId: b.roomId, bedId: b.bedId, date: stayNights(b.checkIn, b.checkOut)[i], bookingId: p.bookingId, status: 'booked', holdExpiresAt: null }));
      tx.update(payRef, paidFields);
      tx.update(bRef, { status: 'confirmed', paymentStatus: 'paid', paidOrderId: orderId, confirmedAt: now, holdExpiresAt: null, updatedAt: now });
      return { kind: 'confirmed' as const, b };
    }
    // Paid, but the booking was cancelled or the bed went to someone else after the hold lapsed: refund in full.
    snaps.forEach((s) => s.exists && s.data()!.bookingId === p.bookingId && tx.delete(s.ref));
    tx.update(payRef, paidFields);
    tx.update(bRef, { paymentStatus: 'refund_pending', paidOrderId: orderId, status: b.status === 'pending_payment' ? 'expired' : b.status, holdExpiresAt: null, updatedAt: now });
    const refund = createRefundRecord(tx, { booking: b, bookingId: p.bookingId, orderId, amount: p.amount, reason: 'Payment received after the booking was no longer available', kind: 'inventory_unavailable', initiatedBy: 'system' });
    return { kind: 'unavailable' as const, refundId: refund.id, b };
  });

  if (outcome.kind === 'already') return { paymentStatus: 'paid' as const };
  await logPayment('payment.' + outcome.kind, { orderId, bookingId: pay.bookingId, source, gatewayPaymentId: success.paymentId, amount: pay.amount });
  if (outcome.kind === 'confirmed') {
    await notifyUser(outcome.b.customerId, `Booking ${outcome.b.code} confirmed`, `${outcome.b.propertyName} • ${outcome.b.checkIn} → ${outcome.b.checkOut}`, `/account/bookings/${pay.bookingId}`);
    await db.collection('users').doc(outcome.b.ownerId).collection('notifications').add({
      type: 'booking', title: `New paid booking ${outcome.b.code}`, body: `${outcome.b.guest.name} • ${outcome.b.checkIn}`, link: '/owner', readAt: null, createdAt: Date.now(),
    });
  } else {
    await notifyUser(outcome.b.customerId, 'Refund initiated', outcome.kind === 'duplicate' ? `A duplicate payment for ${outcome.b.code} is being refunded.` : `Booking ${outcome.b.code} could not be completed; your payment is being refunded.`, `/account/bookings/${pay.bookingId}`);
    await processRefund(outcome.refundId).catch((e) => console.error('refund submission failed; housekeeping will retry', e));
  }
  return { paymentStatus: 'paid' as const };
}

function asHttps(e: unknown): never {
  if (e instanceof GatewayError) {
    if (e.code === 'not_configured') throw new HttpsError('failed-precondition', 'Online payments are not configured yet. Please try again later.');
    console.error('Cashfree error', e.status, e.code, e.message);
    throw new HttpsError('unavailable', 'The payment service is temporarily unavailable. Please try again.');
  }
  throw e;
}

/** Creates (or reuses) a Cashfree order for a pending booking and returns the checkout session. */
export const createPaymentOrder = onCall({ secrets: PAYMENT_SECRETS }, async (req) => {
  const auth = requireAuth(req);
  const { bookingId } = parseOrThrow(z.object({ bookingId: z.string().min(3).max(64) }), req.data);
  const bRef = db.collection('bookings').doc(bookingId);
  const b = (await bRef.get()).data() as BookingDoc | undefined;
  if (!b || b.customerId !== auth.uid) throw new HttpsError('not-found', 'Booking not found');
  if (b.paidOrderId) throw new HttpsError('failed-precondition', 'This booking is already paid');
  if (b.status !== 'pending_payment') throw new HttpsError('failed-precondition', 'This booking is no longer awaiting payment');
  const now = Date.now();
  if (!b.holdExpiresAt || b.holdExpiresAt <= now) throw new HttpsError('deadline-exceeded', 'Your bed hold has expired. Please start a new booking.');

  const open = await db.collection('payments').where('bookingId', '==', bookingId).where('status', 'in', OPEN_STATUSES).get();
  if (open.docs.some((d) => (d.data() as PaymentDoc).status === 'pending')) {
    throw new HttpsError('failed-precondition', 'A payment for this booking is still being processed. Please wait a moment before trying again.');
  }
  const reusable = open.docs.map((d) => d.data() as PaymentDoc).find((p) => p.orderExpiresAt > now + 3 * 60000 && p.amount === b.amounts.payable && p.paymentSessionId);
  const gw = getGateway();
  if (reusable) return { orderId: reusable.orderId, paymentSessionId: reusable.paymentSessionId, environment: gw.environment };

  const attempt = await db.runTransaction(async (tx) => {
    const cur = (await tx.get(bRef)).data() as BookingDoc;
    tx.update(bRef, { paymentAttempts: cur.paymentAttempts + 1, updatedAt: now });
    return cur.paymentAttempts + 1;
  });
  if (attempt > 10) throw new HttpsError('resource-exhausted', 'Too many payment attempts for this booking. Please start a new booking.');
  const orderId = `${b.code}-${attempt}`;
  const user = (await db.collection('users').doc(auth.uid).get()).data();
  const notify = PAYMENT_NOTIFY_URL.value();
  let order;
  try {
    order = await gw.createOrder({
      orderId,
      amount: b.amounts.payable,
      customer: { id: auth.uid, name: b.guest.name, email: b.guest.email ?? user?.email ?? null, phone: b.guest.phone },
      returnUrl: `${APP_URL.value()}/payment/${bookingId}?order_id={order_id}`,
      notifyUrl: notify.startsWith('https://') ? notify : null,
      expiresAt: new Date(now + ORDER_TTL_MS),
      note: `${b.propertyName} ${b.checkIn} to ${b.checkOut}`,
      tags: { bookingId, bookingCode: b.code, propertyId: b.propertyId },
    });
  } catch (e) {
    await logPayment('order.create_failed', { orderId, bookingId, error: (e as Error).message });
    asHttps(e);
  }
  const doc: PaymentDoc = {
    gateway: 'cashfree', environment: gw.environment, orderId, gatewayOrderRef: order.gatewayOrderRef, bookingId, bookingCode: b.code,
    customerId: auth.uid, ownerId: b.ownerId, propertyId: b.propertyId, amount: b.amounts.payable, currency: 'INR', status: 'created',
    paymentSessionId: order.paymentSessionId, gatewayPaymentId: null, method: null, bankReference: null, failureReason: null, duplicateOf: null,
    orderExpiresAt: order.expiresAt, createdAt: now, updatedAt: now, paidAt: null, lastReconciledAt: null,
  };
  // Keep the bed held for as long as the customer can still pay this order.
  const holdUntil = order.expiresAt + HOLD_GRACE_MS;
  await db.runTransaction(async (tx) => {
    const cur = (await tx.get(bRef)).data() as BookingDoc;
    const refs = stayNights(cur.checkIn, cur.checkOut).map((d) => nightRef(cur.propertyId, cur.roomId, cur.bedId, d));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    tx.create(db.collection('payments').doc(orderId), doc);
    if (cur.status === 'pending_payment' && (cur.holdExpiresAt ?? 0) < holdUntil) {
      snaps.forEach((s) => s.exists && s.data()!.bookingId === bookingId && s.data()!.status === 'held' && tx.update(s.ref, { holdExpiresAt: holdUntil }));
      tx.update(bRef, { holdExpiresAt: holdUntil, updatedAt: now });
    }
  });
  await logPayment('order.created', { orderId, bookingId, amount: doc.amount, environment: gw.environment });
  return { orderId, paymentSessionId: order.paymentSessionId, environment: gw.environment };
});

/** Called by the client after checkout closes. Ignores any client-side status and asks the gateway. */
export const verifyPayment = onCall({ secrets: PAYMENT_SECRETS }, async (req) => {
  const auth = requireAuth(req);
  const { bookingId } = parseOrThrow(z.object({ bookingId: z.string().min(3).max(64) }), req.data);
  const bRef = db.collection('bookings').doc(bookingId);
  const b = (await bRef.get()).data() as BookingDoc | undefined;
  if (!b || (b.customerId !== auth.uid && auth.token.role !== 'admin')) throw new HttpsError('not-found', 'Booking not found');
  const pays = await db.collection('payments').where('bookingId', '==', bookingId).where('customerId', '==', b.customerId).get();
  const toCheck = pays.docs.map((d) => d.data() as PaymentDoc).filter((p) => OPEN_STATUSES.includes(p.status));
  try {
    for (const p of toCheck) await reconcileOrder(p.orderId, 'client_verify');
  } catch (e) {
    asHttps(e);
  }
  const fresh = (await bRef.get()).data() as BookingDoc;
  const latest = (await db.collection('payments').where('bookingId', '==', bookingId).where('customerId', '==', b.customerId).get()).docs
    .map((d) => d.data() as PaymentDoc)
    .sort((x, y) => y.createdAt - x.createdAt)[0];
  return {
    bookingStatus: fresh.status,
    paymentStatus: fresh.paymentStatus,
    holdExpiresAt: fresh.holdExpiresAt,
    lastPayment: latest ? { orderId: latest.orderId, status: latest.status, failureReason: latest.failureReason } : null,
  };
});

function lowerHeaders(h: Record<string, string | string[] | undefined>) {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** Cashfree webhook: signature-verified, de-duplicated, then reconciled against the Cashfree API. */
export const cashfreeWebhook = onRequest({ secrets: PAYMENT_SECRETS }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const raw: Buffer = req.rawBody ?? Buffer.from('');
  const headers = lowerHeaders(req.headers);
  const gw = getGateway();
  if (!gw.verifyWebhook(raw, headers)) {
    await logPayment('webhook.rejected', { reason: 'invalid_signature' });
    res.status(401).send('Invalid signature');
    return;
  }
  const key = crypto.createHash('sha256').update(headers['x-idempotency-key'] || raw).digest('hex');
  const evRef = db.collection('paymentEvents').doc(key);
  const prior = (await evRef.get()).data();
  if (prior?.processed) {
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }
  let event;
  try {
    event = gw.parseWebhook(raw);
  } catch {
    res.status(400).send('Malformed payload');
    return;
  }
  await evRef.set({ gateway: 'cashfree', type: event.type, kind: event.kind, receivedAt: Date.now(), processed: false, attempt: headers['x-webhook-attempt'] ?? null, payload: raw.toString('utf8').slice(0, 20000) }, { merge: true });
  try {
    let result: unknown = 'ignored';
    if (event.kind === 'payment') {
      const exists = (await db.collection('payments').doc(event.orderId).get()).exists;
      result = exists ? await reconcileOrder(event.orderId, 'webhook') : 'unknown_order';
    } else if (event.kind === 'refund') {
      await processRefund(event.refundId);
      result = 'refund_synced';
    }
    await evRef.update({ processed: true, processedAt: Date.now(), result: JSON.parse(JSON.stringify(result ?? null)) });
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('webhook processing failed', e);
    await evRef.update({ error: (e as Error).message ?? 'error' });
    res.status(500).send('Processing failed');
  }
});

/** Reconciles open payments, pushes pending refunds and releases lapsed holds. */
export async function runHousekeeping() {
  const now = Date.now();
  const report = { reconciled: 0, refunds: 0, expired: 0, errors: 0 };
  const open = await db.collection('payments').where('status', 'in', OPEN_STATUSES).where('createdAt', '<=', now - 60000).limit(100).get();
  for (const d of open.docs) {
    try {
      await reconcileOrder(d.id, 'housekeeping');
      report.reconciled++;
    } catch (e) {
      report.errors++;
      console.error('reconcile failed', d.id, e);
    }
  }
  const refunds = await db.collection('refunds').where('status', '==', 'pending').limit(100).get();
  for (const d of refunds.docs) {
    try {
      await processRefund(d.id);
      report.refunds++;
    } catch (e) {
      report.errors++;
      console.error('refund sync failed', d.id, e);
    }
  }
  const lapsed = await db.collection('bookings').where('status', '==', 'pending_payment').where('holdExpiresAt', '<', now).limit(100).get();
  for (const d of lapsed.docs) {
    const done = await db.runTransaction(async (tx) => {
      const b = (await tx.get(d.ref)).data() as BookingDoc;
      if (b.status !== 'pending_payment' || (b.holdExpiresAt ?? 0) >= now || b.paymentStatus === 'pending') return false;
      const release = await releaseNights(tx, d.id, b);
      release();
      tx.update(d.ref, { status: 'expired', holdExpiresAt: null, updatedAt: now });
      return true;
    });
    if (done) report.expired++;
  }
  await logPayment('housekeeping.run', report);
  return report;
}

export const paymentsHousekeeping = onSchedule({ schedule: 'every 10 minutes', timeZone: 'Asia/Kolkata', secrets: PAYMENT_SECRETS }, async () => {
  await runHousekeeping();
});

function requireFinance(token: Record<string, unknown> | undefined) {
  if (token?.role !== 'admin' || !['super_admin', 'finance'].includes(String(token.adminRole))) {
    throw new HttpsError('permission-denied', 'Finance administrators only');
  }
}

export const adminReconcilePayment = onCall({ secrets: PAYMENT_SECRETS }, async (req) => {
  const auth = requireAuth(req);
  requireFinance(auth.token);
  const { orderId } = parseOrThrow(z.object({ orderId: z.string().min(3).max(64) }), req.data);
  try {
    const r = await reconcileOrder(orderId, `admin:${auth.uid}`);
    await audit(auth.uid, 'payment.reconcile', 'payment', orderId, r);
    return r;
  } catch (e) {
    asHttps(e);
  }
});

export const adminRunHousekeeping = onCall({ secrets: PAYMENT_SECRETS }, async (req) => {
  const auth = requireAuth(req);
  requireFinance(auth.token);
  try {
    return await runHousekeeping();
  } catch (e) {
    asHttps(e);
  }
});

export const adminCancelBooking = onCall({ secrets: PAYMENT_SECRETS }, async (req) => {
  const auth = requireAuth(req);
  requireFinance(auth.token);
  const input = parseOrThrow(z.object({ bookingId: z.string().min(3).max(64), reason: z.string().trim().min(5).max(500), refundAmount: z.number().int().min(0).optional() }), req.data);
  return cancelBookingInternal(input.bookingId, { by: 'admin', actorId: auth.uid, reason: input.reason, refundOverride: input.refundAmount });
});
