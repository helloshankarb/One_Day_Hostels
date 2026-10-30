/** Gateway-neutral payment contract. Booking logic depends only on this interface. */

export type GatewayAttemptStatus = 'success' | 'failed' | 'pending' | 'cancelled' | 'user_dropped' | 'not_attempted' | 'void';
export type GatewayOrderStatus = 'active' | 'paid' | 'expired' | 'terminated';
export type GatewayRefundStatus = 'processed' | 'pending' | 'failed';

export interface CreateOrderInput {
  orderId: string;
  amount: number;
  customer: { id: string; name: string; email: string | null; phone: string };
  returnUrl: string;
  notifyUrl: string | null;
  expiresAt: Date;
  note: string;
  tags: Record<string, string>;
}

export interface GatewayAttempt {
  paymentId: string;
  status: GatewayAttemptStatus;
  amount: number;
  method: string | null;
  bankReference: string | null;
  message: string | null;
  time: number;
}

export interface GatewayRefund {
  refundId: string;
  gatewayRefundId: string | null;
  status: GatewayRefundStatus;
  rawStatus: string;
  amount: number;
}

export type WebhookEvent =
  | { kind: 'payment'; orderId: string; type: string }
  | { kind: 'refund'; orderId: string; refundId: string; type: string }
  | { kind: 'ignored'; type: string };

export interface PaymentGateway {
  readonly name: 'cashfree';
  readonly environment: 'sandbox' | 'production';
  createOrder(input: CreateOrderInput): Promise<{ orderId: string; gatewayOrderRef: string; paymentSessionId: string; expiresAt: number }>;
  getOrderStatus(orderId: string): Promise<GatewayOrderStatus>;
  getAttempts(orderId: string): Promise<GatewayAttempt[]>;
  createRefund(orderId: string, refundId: string, amount: number, note: string): Promise<GatewayRefund>;
  getRefund(orderId: string, refundId: string): Promise<GatewayRefund | null>;
  /** Verifies authenticity of a webhook using the raw request body and headers. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
  parseWebhook(rawBody: Buffer): WebhookEvent;
}

export class GatewayError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Compare rupee amounts in paise to avoid floating point issues. */
export const samePaise = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);
