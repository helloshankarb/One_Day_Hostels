import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Clock, XCircle, AlertTriangle, RotateCcw } from 'lucide-react';
import { verifyPayment, createPaymentOrder, openCashfreeCheckout, type VerifyResult } from '../lib/booking';
import { friendlyError } from '../lib/auth';
import { Button, ButtonLink, Spinner, useDocumentTitle } from '../components/ui';

const POLL_MS = 5000;
const MAX_POLLS = 24;

/** Shows the server-verified outcome. Query parameters from the payment redirect are deliberately ignored. */
export default function PaymentStatus() {
  useDocumentTitle('Payment status');
  const { bookingId = '' } = useParams();
  const [state, setState] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const polls = useRef(0);

  const check = useCallback(async () => {
    try {
      setError(null);
      setState(await verifyPayment({ bookingId }));
    } catch (e) {
      setError(friendlyError(e).message);
    }
  }, [bookingId]);

  useEffect(() => {
    check();
  }, [check]);

  const processing = state?.paymentStatus === 'pending';
  useEffect(() => {
    if (!processing || polls.current >= MAX_POLLS) return;
    const t = setTimeout(() => {
      polls.current++;
      check();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [processing, state, check]);

  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      const order = await createPaymentOrder({ bookingId });
      await openCashfreeCheckout(order.paymentSessionId, order.environment).catch(() => undefined);
      polls.current = 0;
      await check();
    } catch (e) {
      setError(friendlyError(e).message);
    } finally {
      setRetrying(false);
    }
  };

  if (!state && !error) return <Spinner label="Confirming your payment with Cashfree…" />;

  let icon = <AlertTriangle className="size-12 text-amber-500" />;
  let title = 'Payment not completed';
  let body = 'Your bed is still on hold. You can retry the payment before the hold expires.';
  let canRetry = false;
  if (state) {
    if (state.bookingStatus === 'confirmed' || state.bookingStatus === 'checked_in') {
      icon = <CheckCircle2 className="size-12 text-veg" />;
      title = 'Booking confirmed!';
      body = 'Your payment was verified and your bed is reserved. A confirmation is in your account.';
    } else if (processing) {
      icon = <Clock className="size-12 text-teal" />;
      title = 'Payment processing';
      body = polls.current >= MAX_POLLS ? 'Your bank has not confirmed yet. We will update your booking automatically as soon as it does — no need to pay again.' : 'Waiting for your bank to confirm. This page refreshes automatically.';
    } else if (state.bookingStatus === 'pending_payment') {
      const failed = state.lastPayment?.status === 'failed';
      icon = failed ? <XCircle className="size-12 text-nonveg" /> : <AlertTriangle className="size-12 text-amber-500" />;
      title = failed ? 'Payment failed' : state.lastPayment?.status === 'cancelled' ? 'Payment cancelled' : 'Payment not completed';
      body = `${state.lastPayment?.failureReason ? state.lastPayment.failureReason + '. ' : ''}No money was taken for this attempt. Your bed is held${state.holdExpiresAt ? ` until ${new Date(state.holdExpiresAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : ''}.`;
      canRetry = !!state.holdExpiresAt && state.holdExpiresAt > Date.now();
    } else if (state.bookingStatus === 'expired') {
      icon = <Clock className="size-12 text-muted" />;
      title = 'Bed hold expired';
      body = state.paymentStatus === 'refund_pending' || state.paymentStatus === 'refunded'
        ? 'Your payment arrived after the bed was released, so a full refund has been initiated automatically.'
        : 'The hold expired before payment was completed. Please start a new booking.';
    } else if (state.bookingStatus === 'cancelled') {
      icon = <XCircle className="size-12 text-muted" />;
      title = 'Booking cancelled';
      body = 'This booking was cancelled. Any refund due is shown on the booking page.';
    }
  }

  return (
    <div className="container-x flex max-w-xl flex-col items-center py-16 text-center">
      {icon}
      <h1 className="mt-4 text-2xl font-extrabold">{title}</h1>
      <p className="mt-2 text-sm text-muted">{body}</p>
      {error && <p className="mt-3 text-sm font-semibold text-nonveg" role="alert">{error}</p>}
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        {canRetry && <Button onClick={retry} loading={retrying}><RotateCcw className="size-4" /> Retry payment</Button>}
        {processing && <Button variant="secondary" onClick={() => { polls.current = 0; check(); }}>Check again</Button>}
        <ButtonLink to={`/account/bookings/${bookingId}`} variant="secondary">View booking</ButtonLink>
        {state?.bookingStatus === 'expired' && <ButtonLink to="/search">Find another stay</ButtonLink>}
      </div>
      <p className="mt-8 text-xs text-muted">Need help? <Link to="/contact" className="font-bold text-teal">Contact support</Link> with your booking reference.</p>
    </div>
  );
}
