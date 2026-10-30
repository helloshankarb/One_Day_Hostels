import { defineSecret, defineString } from 'firebase-functions/params';
import { cashfreeGateway } from './cashfree.ts';
import type { PaymentGateway } from './gateway.ts';

export const CASHFREE_APP_ID = defineSecret('CASHFREE_APP_ID');
export const CASHFREE_SECRET_KEY = defineSecret('CASHFREE_SECRET_KEY');
export const CASHFREE_ENV = defineString('CASHFREE_ENV', { default: 'sandbox', description: 'sandbox or production' });
export const APP_URL = defineString('APP_URL', { default: 'http://localhost:5173', description: 'Public web app origin for payment return URLs' });
export const PAYMENT_NOTIFY_URL = defineString('PAYMENT_NOTIFY_URL', { default: '', description: 'Public HTTPS URL of the cashfreeWebhook function' });

const inEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

/** Secrets each payment function must declare so they are mounted at runtime (not needed when the emulator test stub is active). */
export const PAYMENT_SECRETS = inEmulator() && process.env.CASHFREE_API_BASE_OVERRIDE ? [] : [CASHFREE_APP_ID, CASHFREE_SECRET_KEY];

/** The single payment gateway used by the platform. Swap the factory here to add another provider. */
export function getGateway(): PaymentGateway {
  const environment = CASHFREE_ENV.value() === 'production' ? 'production' : 'sandbox';
  // The emulator test suite supplies stub credentials and a local API base; never honoured in deployed functions.
  const test = inEmulator() && process.env.CASHFREE_API_BASE_OVERRIDE;
  return cashfreeGateway({
    appId: test ? process.env.CASHFREE_TEST_APP_ID ?? '' : CASHFREE_APP_ID.value(),
    secretKey: test ? process.env.CASHFREE_TEST_SECRET_KEY ?? '' : CASHFREE_SECRET_KEY.value(),
    environment,
    baseUrlOverride: test ? process.env.CASHFREE_API_BASE_OVERRIDE : undefined,
  });
}

export { GatewayError, samePaise } from './gateway.ts';
export type { PaymentGateway, GatewayAttempt } from './gateway.ts';
