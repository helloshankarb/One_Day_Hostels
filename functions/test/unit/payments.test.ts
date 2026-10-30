import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { quote, refundFor, stayNights, PricingError } from '../../../shared/pricing.ts';
import { cashfreeGateway, cashfreePhone } from '../../src/payments/cashfree.ts';
import { samePaise } from '../../src/payments/gateway.ts';

const room = { priceDaily: 400, priceWeekly: 2500, priceMonthly: 8000, deposit: 2000 };
const rules = { allowDaily: true, allowWeekly: true, allowMonthly: true, minStayDays: 1 };
const opts = { gstPercent: 5, commissionPercent: 10 };

test('quote: daily, weekly, monthly and rule violations', () => {
  const d = quote(room, rules, '2030-01-01', '2030-01-04', opts);
  assert.deepEqual([d.stayType, d.baseAmount, d.taxAmount, d.deposit, d.payableNow], ['daily', 1200, 60, 0, 1260]);
  const w = quote(room, rules, '2030-01-01', '2030-01-10', opts);
  assert.deepEqual([w.stayType, w.baseAmount], ['weekly', 3300]);
  const m = quote(room, rules, '2030-01-01', '2030-02-02', opts);
  assert.deepEqual([m.stayType, m.baseAmount, m.deposit, m.payableNow], ['monthly', 8800, 2000, 8800 + 440 + 2000]);
  assert.throws(() => quote(room, { ...rules, allowDaily: false }, '2030-01-01', '2030-01-03', opts), PricingError);
  assert.throws(() => quote(room, { ...rules, minStayDays: 3 }, '2030-01-01', '2030-01-02', opts), PricingError);
  assert.throws(() => quote(room, rules, '2030-01-01', '2030-09-01', opts), PricingError);
  assert.throws(() => quote(room, rules, '2030-02-30', '2030-03-02', opts), PricingError);
});

test('refund policy and stay nights', () => {
  const b = { totalAmount: 1000, deposit: 500, checkIn: '2030-01-10', createdAt: Date.parse('2029-12-01T00:00:00Z') };
  const now = new Date('2030-01-09T20:00:00+05:30');
  assert.deepEqual(refundFor(b, 'flexible', '12:00', now), { percent: 50, amount: 1000 });
  assert.deepEqual(refundFor(b, 'strict', '12:00', now), { percent: 0, amount: 500 });
  assert.equal(refundFor({ ...b, createdAt: now.getTime() - 3600000 }, 'strict', '12:00', now).percent, 100);
  assert.deepEqual(stayNights('2030-12-30', '2031-01-02'), ['2030-12-30', '2030-12-31', '2031-01-01']);
});

test('cashfree webhook signature: base64(HMAC-SHA256(timestamp + raw body))', () => {
  const gw = cashfreeGateway({ appId: 'a', secretKey: 'secret123', environment: 'sandbox' });
  const raw = Buffer.from('{"data":{"order":{"order_id":"ODH-1"},"payment":{"payment_amount":170.00}},"type":"PAYMENT_SUCCESS_WEBHOOK"}');
  const ts = '1785401067911';
  const sig = crypto.createHmac('sha256', 'secret123').update(ts + raw.toString()).digest('base64');
  assert.equal(gw.verifyWebhook(raw, { 'x-webhook-signature': sig, 'x-webhook-timestamp': ts }), true);
  assert.equal(gw.verifyWebhook(raw, { 'x-webhook-signature': sig, 'x-webhook-timestamp': '1785401067912' }), false);
  assert.equal(gw.verifyWebhook(Buffer.from(raw.toString().replace('170.00', '170')), { 'x-webhook-signature': sig, 'x-webhook-timestamp': ts }), false);
  assert.equal(gw.verifyWebhook(raw, {}), false);
  assert.deepEqual(gw.parseWebhook(raw), { kind: 'payment', orderId: 'ODH-1', type: 'PAYMENT_SUCCESS_WEBHOOK' });
  assert.deepEqual(gw.parseWebhook(Buffer.from('{"data":{"refund":{"refund_id":"RF1","order_id":"ODH-1"}},"type":"REFUND_STATUS_WEBHOOK"}')), { kind: 'refund', orderId: 'ODH-1', refundId: 'RF1', type: 'REFUND_STATUS_WEBHOOK' });
  assert.equal(gw.parseWebhook(Buffer.from('{"type":"PAYMENT_CHARGES_WEBHOOK","data":{}}')).kind, 'ignored');
});

test('helpers: phone normalisation and paise comparison', () => {
  assert.equal(cashfreePhone('+91 98765-43210'), '9876543210');
  assert.equal(cashfreePhone('9876543210'), '9876543210');
  assert.equal(samePaise(2100, 2100.0), true);
  assert.equal(samePaise(0.1 + 0.2, 0.3), true);
  assert.equal(samePaise(2100, 2100.01), false);
});

test('unconfigured gateway refuses to call Cashfree', async () => {
  const gw = cashfreeGateway({ appId: '', secretKey: '', environment: 'sandbox' });
  await assert.rejects(gw.getOrderStatus('x'), /not configured/);
});
