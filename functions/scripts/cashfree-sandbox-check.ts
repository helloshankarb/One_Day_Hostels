/**
 * Verifies Cashfree SANDBOX credentials and API compatibility before enabling production.
 * Usage (PowerShell):
 *   $env:CASHFREE_APP_ID='TEST...'; $env:CASHFREE_SECRET_KEY='cfsk_ma_test_...'; npm run cashfree:sandbox-check -w functions
 */
import { cashfreeGateway } from '../src/payments/cashfree.ts';

const appId = process.env.CASHFREE_APP_ID ?? '';
const secretKey = process.env.CASHFREE_SECRET_KEY ?? '';
if (!appId || !secretKey) {
  console.error('Set CASHFREE_APP_ID and CASHFREE_SECRET_KEY (sandbox keys) in the environment first.');
  process.exit(1);
}
if (!appId.startsWith('TEST')) {
  console.error('Refusing to run: this check only uses sandbox keys (App ID should start with TEST).');
  process.exit(1);
}

const gw = cashfreeGateway({ appId, secretKey, environment: 'sandbox' });
const orderId = `ODH-SANDBOX-${Date.now()}`;
const order = await gw.createOrder({
  orderId,
  amount: 1,
  customer: { id: 'sandboxcheck', name: 'Sandbox Check', email: 'sandbox@example.in', phone: '9876543210' },
  returnUrl: 'http://localhost:5173/payment/sandbox-check?order_id={order_id}',
  notifyUrl: null,
  expiresAt: new Date(Date.now() + 20 * 60000),
  note: 'One Day Hostels sandbox connectivity check',
  tags: { purpose: 'sandbox_check' },
});
console.log('Order created:', order.orderId, 'cf_order_id', order.gatewayOrderRef);
console.log('Order status:', await gw.getOrderStatus(orderId));
console.log('Attempts:', await gw.getAttempts(orderId));
console.log('\nSandbox credentials work. Pay this order in the browser to test the full flow:');
console.log('payment_session_id =', order.paymentSessionId);
