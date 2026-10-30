import http from 'node:http';
import crypto from 'node:crypto';

/**
 * Local stand-in for the Cashfree PG REST API (v2026-01-01 shapes) used only by the emulator tests.
 * It lets tests drive payment outcomes deterministically; it is not part of the application.
 */
export const STUB_APP_ID = 'TEST_APP_ID_STUB';
export const STUB_SECRET = 'test_secret_stub_key';

interface StubOrder {
  order_id: string;
  amount: number;
  status: 'ACTIVE' | 'PAID' | 'EXPIRED';
  payments: any[];
  refunds: Map<string, any>;
  body: any;
}

export class CashfreeStub {
  orders = new Map<string, StubOrder>();
  requests: { method: string; path: string; headers: http.IncomingHttpHeaders }[] = [];
  private server: http.Server | null = null;
  private seq = 1000;

  start(port = 9911) {
    this.server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => this.handle(req, data, res));
    });
    return new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', () => resolve()));
  }

  stop() {
    return new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private send(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private handle(req: http.IncomingMessage, raw: string, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (url.pathname.startsWith('/__stub/')) return this.control(url, res);
    this.requests.push({ method: req.method ?? '', path: url.pathname, headers: req.headers });
    if (req.headers['x-client-id'] !== STUB_APP_ID || req.headers['x-client-secret'] !== STUB_SECRET) return this.send(res, 401, { message: 'authentication Failed', code: 'request_failed', type: 'authentication_error' });
    if (req.headers['x-api-version'] !== '2026-01-01') return this.send(res, 400, { message: 'bad api version', code: 'request_failed' });
    const parts = url.pathname.replace(/^\/pg\//, '').split('/').map(decodeURIComponent);
    const body = raw ? JSON.parse(raw) : {};

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'orders') {
      if (this.orders.has(body.order_id)) return this.send(res, 409, { message: 'order with same id is already present', code: 'order_already_exists' });
      if (!/^\d{10}$/.test(body.customer_details?.customer_phone ?? '')) return this.send(res, 400, { message: 'customer_phone invalid', code: 'customer_details.customer_phone_invalid' });
      this.orders.set(body.order_id, { order_id: body.order_id, amount: body.order_amount, status: 'ACTIVE', payments: [], refunds: new Map(), body });
      return this.send(res, 200, {
        cf_order_id: String(this.seq++), order_id: body.order_id, order_amount: body.order_amount, order_currency: 'INR', order_status: 'ACTIVE',
        payment_session_id: 'session_' + body.order_id, order_expiry_time: body.order_expiry_time,
      });
    }
    const order = this.orders.get(parts[1]);
    if (parts[0] !== 'orders' || !order) return this.send(res, 404, { message: 'order not found', code: 'order_not_found' });
    if (req.method === 'GET' && parts.length === 2) return this.send(res, 200, { order_id: order.order_id, order_amount: order.amount, order_status: order.status });
    if (req.method === 'GET' && parts[2] === 'payments') return this.send(res, 200, order.payments);
    if (req.method === 'POST' && parts[2] === 'refunds' && parts.length === 3) {
      if (order.refunds.has(body.refund_id)) return this.send(res, 409, { message: 'refund already exists', code: 'refund_already_exists' });
      const r = { cf_refund_id: String(this.seq++), refund_id: body.refund_id, order_id: order.order_id, refund_amount: body.refund_amount, refund_status: 'PENDING' };
      order.refunds.set(body.refund_id, r);
      return this.send(res, 200, r);
    }
    if (req.method === 'GET' && parts[2] === 'refunds' && parts[3]) {
      const r = order.refunds.get(parts[3]);
      return r ? this.send(res, 200, r) : this.send(res, 404, { message: 'refund not found', code: 'refund_not_found' });
    }
    return this.send(res, 404, { message: 'not found' });
  }

  /** Manual-testing controls: /__stub/orders, /__stub/pay?order=ID&status=SUCCESS, /__stub/refund?order=ID&refund=ID&status=SUCCESS */
  private control(url: URL, res: http.ServerResponse) {
    try {
      const q = url.searchParams;
      if (url.pathname === '/__stub/orders') {
        return this.send(res, 200, [...this.orders.values()].map((o) => ({ order_id: o.order_id, amount: o.amount, status: o.status, payments: o.payments.length, refunds: [...o.refunds.values()] })));
      }
      if (url.pathname === '/__stub/pay') return this.send(res, 200, this.pay(q.get('order') ?? '', (q.get('status') ?? 'SUCCESS') as 'SUCCESS'));
      if (url.pathname === '/__stub/refund') return this.send(res, 200, this.setRefundStatus(q.get('order') ?? '', q.get('refund') ?? '', (q.get('status') ?? 'SUCCESS') as 'SUCCESS'));
    } catch (e) {
      return this.send(res, 400, { message: (e as Error).message });
    }
    return this.send(res, 404, { message: 'unknown control' });
  }

  /** Simulates the customer completing (or abandoning) a payment attempt on the hosted checkout. */
  pay(orderId: string, status: 'SUCCESS' | 'FAILED' | 'USER_DROPPED' | 'PENDING', amount?: number) {
    const o = this.orders.get(orderId);
    if (!o) throw new Error('unknown order ' + orderId);
    const p = {
      cf_payment_id: String(this.seq++), order_id: orderId, payment_status: status, payment_amount: amount ?? o.amount, payment_currency: 'INR',
      payment_group: 'upi', payment_message: status === 'SUCCESS' ? 'Transaction successful' : status === 'FAILED' ? 'Payment declined by bank' : 'User dropped',
      bank_reference: 'BR' + this.seq, payment_time: new Date(Date.now() - 1000).toISOString(), payment_completion_time: new Date().toISOString(),
    };
    o.payments.push(p);
    if (status === 'SUCCESS') o.status = 'PAID';
    return p;
  }

  setRefundStatus(orderId: string, refundId: string, status: 'SUCCESS' | 'CANCELLED' | 'PENDING') {
    const r = this.orders.get(orderId)?.refunds.get(refundId);
    if (!r) throw new Error('unknown refund');
    r.refund_status = status;
    return r;
  }

  /** Builds a webhook exactly as Cashfree signs it: base64(HMAC-SHA256(timestamp + rawBody)). */
  webhook(payload: unknown, secret = STUB_SECRET) {
    const raw = JSON.stringify(payload);
    const ts = String(Date.now());
    const signature = crypto.createHmac('sha256', secret).update(ts + raw).digest('base64');
    return {
      raw,
      headers: {
        'content-type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': ts,
        'x-idempotency-key': crypto.createHash('sha256').update(raw).digest('base64'), 'x-webhook-version': '2026-01-01', 'x-webhook-attempt': '1',
      },
    };
  }
}
