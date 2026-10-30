import crypto from 'node:crypto';
import {
  GatewayError, type CreateOrderInput, type GatewayAttempt, type GatewayAttemptStatus, type GatewayOrderStatus, type GatewayRefund,
  type PaymentGateway, type WebhookEvent,
} from './gateway.ts';

export const CASHFREE_API_VERSION = '2026-01-01';
const BASE: Record<'sandbox' | 'production', string> = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  production: 'https://api.cashfree.com/pg',
};

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  environment: 'sandbox' | 'production';
  /** Only used by the emulator test suite to point at a local stub of the Cashfree API. */
  baseUrlOverride?: string;
}

const ATTEMPT_STATUS: Record<string, GatewayAttemptStatus> = {
  SUCCESS: 'success',
  FAILED: 'failed',
  PENDING: 'pending',
  CANCELLED: 'cancelled',
  USER_DROPPED: 'user_dropped',
  NOT_ATTEMPTED: 'not_attempted',
  VOID: 'void',
};

function refundStatus(raw: string): GatewayRefund['status'] {
  if (raw === 'SUCCESS') return 'processed';
  if (raw === 'CANCELLED' || raw === 'REJECTED') return 'failed';
  return 'pending';
}

function methodOf(pm: Record<string, unknown> | undefined, group: string | undefined): string | null {
  if (group) return group;
  const k = pm ? Object.keys(pm)[0] : null;
  return k ?? null;
}

/** Cashfree's 10-digit phone requirement; strips +91 / spaces. */
export function cashfreePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function cashfreeGateway(cfg: CashfreeConfig): PaymentGateway {
  const base = cfg.baseUrlOverride || BASE[cfg.environment];

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    if (!cfg.appId || !cfg.secretKey) throw new GatewayError('Online payments are not configured yet', 503, 'not_configured');
    const res = await fetch(base + path, {
      method,
      headers: {
        'x-client-id': cfg.appId,
        'x-client-secret': cfg.secretKey,
        'x-api-version': CASHFREE_API_VERSION,
        'x-request-id': crypto.randomUUID(),
        ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new GatewayError(json?.message ?? `Cashfree error ${res.status}`, res.status, json?.code ?? null);
    return json as T;
  }

  return {
    name: 'cashfree',
    environment: cfg.environment,

    async createOrder(input: CreateOrderInput) {
      const o = await call<{ order_id: string; cf_order_id: string | number; payment_session_id: string; order_expiry_time: string }>(
        'POST',
        '/orders',
        {
          order_id: input.orderId,
          order_amount: input.amount,
          order_currency: 'INR',
          customer_details: {
            customer_id: input.customer.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 50),
            customer_name: input.customer.name.slice(0, 100),
            customer_email: input.customer.email ?? undefined,
            customer_phone: cashfreePhone(input.customer.phone),
          },
          order_meta: {
            return_url: input.returnUrl,
            ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
          },
          order_expiry_time: input.expiresAt.toISOString(),
          order_note: input.note.slice(0, 200),
          order_tags: input.tags,
        },
        input.orderId,
      );
      return { orderId: o.order_id, gatewayOrderRef: String(o.cf_order_id), paymentSessionId: o.payment_session_id, expiresAt: Date.parse(o.order_expiry_time) || input.expiresAt.getTime() };
    },

    async getOrderStatus(orderId): Promise<GatewayOrderStatus> {
      const o = await call<{ order_status: string }>('GET', `/orders/${encodeURIComponent(orderId)}`);
      const s = o.order_status;
      return s === 'PAID' ? 'paid' : s === 'EXPIRED' ? 'expired' : s === 'TERMINATED' || s === 'TERMINATION_REQUESTED' ? 'terminated' : 'active';
    },

    async getAttempts(orderId): Promise<GatewayAttempt[]> {
      const list = await call<any[]>('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
      return (list ?? []).map((p) => ({
        paymentId: String(p.cf_payment_id),
        status: ATTEMPT_STATUS[p.payment_status] ?? 'pending',
        amount: Number(p.payment_amount ?? p.order_amount ?? 0),
        method: methodOf(p.payment_method, p.payment_group),
        bankReference: p.bank_reference ?? null,
        message: p.payment_message ?? p.error_details?.error_description ?? null,
        time: Date.parse(p.payment_completion_time ?? p.payment_time ?? '') || 0,
      }));
    },

    async createRefund(orderId, refundId, amount, note) {
      try {
        const r = await call<any>('POST', `/orders/${encodeURIComponent(orderId)}/refunds`, { refund_amount: amount, refund_id: refundId, refund_note: note.slice(0, 100) }, refundId);
        return { refundId, gatewayRefundId: r.cf_refund_id ? String(r.cf_refund_id) : null, status: refundStatus(r.refund_status), rawStatus: r.refund_status, amount: Number(r.refund_amount) };
      } catch (e) {
        // A retry of an already-accepted refund: read back its state instead of failing.
        if (e instanceof GatewayError && e.status === 409) {
          const existing = await this.getRefund(orderId, refundId);
          if (existing) return existing;
        }
        throw e;
      }
    },

    async getRefund(orderId, refundId) {
      try {
        const r = await call<any>('GET', `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`);
        return { refundId, gatewayRefundId: r.cf_refund_id ? String(r.cf_refund_id) : null, status: refundStatus(r.refund_status), rawStatus: r.refund_status, amount: Number(r.refund_amount) };
      } catch (e) {
        if (e instanceof GatewayError && e.status === 404) return null;
        throw e;
      }
    },

    verifyWebhook(rawBody, headers) {
      const signature = headers['x-webhook-signature'];
      const timestamp = headers['x-webhook-timestamp'];
      if (!signature || !timestamp || !cfg.secretKey) return false;
      const expected = crypto.createHmac('sha256', cfg.secretKey).update(timestamp + rawBody.toString('utf8')).digest('base64');
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    parseWebhook(rawBody): WebhookEvent {
      const body = JSON.parse(rawBody.toString('utf8'));
      const type = String(body?.type ?? '');
      if (type.startsWith('PAYMENT_') && body?.data?.order?.order_id) return { kind: 'payment', orderId: String(body.data.order.order_id), type };
      if (type.startsWith('REFUND_') && body?.data?.refund?.refund_id) {
        return { kind: 'refund', orderId: String(body.data.refund.order_id), refundId: String(body.data.refund.refund_id), type };
      }
      return { kind: 'ignored', type };
    },
  };
}
