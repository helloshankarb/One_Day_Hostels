declare module '@cashfreepayments/cashfree-js' {
  export interface CheckoutResult {
    error?: { message?: string; code?: string };
    redirect?: boolean;
    paymentDetails?: { paymentMessage?: string };
  }
  export interface CashfreeInstance {
    checkout(options: { paymentSessionId: string; redirectTarget?: '_self' | '_blank' | '_top' | '_modal' | HTMLElement }): Promise<CheckoutResult>;
  }
  export function load(options: { mode: 'sandbox' | 'production' }): Promise<CashfreeInstance | null>;
}
