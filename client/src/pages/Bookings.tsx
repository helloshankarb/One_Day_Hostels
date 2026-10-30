import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CalendarCheck, Printer, BedDouble, MapPin, Receipt } from 'lucide-react';
import { useAuth, friendlyError } from '../lib/auth';
import { listMyBookings, getMyBooking, bookingPayments, cancelBooking, type BookingWithId } from '../lib/booking';
import { refundFor, POLICY_TEXT } from '../../../shared/pricing';
import type { PaymentDoc, RefundDoc } from '../../../shared/model';
import { Alert, Badge, Button, ButtonLink, EmptyState, ErrorState, Field, Spinner, useDocumentTitle } from '../components/ui';
import { BOOKING_STATUS, PAYMENT_STATUS, fmtDate, fmtDateTime, inr, STAY_LABEL } from '../lib/format';

export function MyBookings() {
  const { user } = useAuth();
  const [items, setItems] = useState<BookingWithId[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!user) return;
    setError(null);
    listMyBookings(user.uid).then(setItems).catch((e) => setError(friendlyError(e).message));
  }, [user]);
  useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <Spinner />;
  if (!items.length) return <EmptyState icon={<CalendarCheck className="size-6" />} title="No bookings yet" action={<ButtonLink to="/search">Find a stay</ButtonLink>}>Your upcoming and past stays will appear here.</EmptyState>;
  return (
    <ul className="space-y-3">
      {items.map((b) => (
        <li key={b.id} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-bold">{b.propertyName}</p>
              <Badge tone={BOOKING_STATUS[b.status]?.tone}>{BOOKING_STATUS[b.status]?.label ?? b.status}</Badge>
              <Badge tone={PAYMENT_STATUS[b.paymentStatus]?.tone}>{PAYMENT_STATUS[b.paymentStatus]?.label ?? b.paymentStatus}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted">{fmtDate(b.checkIn)} → {fmtDate(b.checkOut)} · {b.roomName} · {b.code}</p>
          </div>
          <div className="flex items-center gap-3">
            <p className="font-extrabold">{inr(b.amounts.payable)}</p>
            <ButtonLink to={`/account/bookings/${b.id}`} variant="secondary">Details</ButtonLink>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function BookingDetail() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const [b, setB] = useState<BookingWithId | null | undefined>(undefined);
  const [money, setMoney] = useState<{ payments: PaymentDoc[]; refunds: (RefundDoc & { id: string })[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCancel, setShowCancel] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useDocumentTitle(b ? `Booking ${b.code}` : 'Booking');

  const load = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const bk = await getMyBooking(id);
      setB(bk);
      if (bk) setMoney(await bookingPayments(id, user.uid));
    } catch (e) {
      setError(friendlyError(e).message);
    }
  }, [id, user]);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="container-x py-12"><ErrorState message={error} onRetry={load} /></div>;
  if (b === undefined) return <Spinner />;
  if (!b) return <div className="container-x py-12"><ErrorState message="Booking not found" /></div>;

  const cancellable = b.status === 'pending_payment' || b.status === 'confirmed';
  const preview = b.paymentStatus === 'paid' ? refundFor({ totalAmount: b.amounts.total, deposit: b.amounts.deposit, checkIn: b.checkIn, createdAt: b.createdAt }, b.cancellationPolicy, b.checkInTime) : null;
  const paid = money?.payments.find((p) => p.status === 'paid' && !p.duplicateOf);

  const doCancel = async () => {
    if (reason.trim().length < 3) return setNotice('Tell us why you are cancelling.');
    setBusy(true);
    setNotice(null);
    try {
      const r = await cancelBooking({ bookingId: b.id, reason: reason.trim() });
      setNotice(r.refundAmount ? `Booking cancelled. A refund of ${inr(r.refundAmount)} has been initiated to your original payment method.` : 'Booking cancelled.');
      setShowCancel(false);
      await load();
    } catch (e) {
      setNotice(friendlyError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container-x max-w-4xl py-10">
      <div className="no-print flex items-center justify-between">
        <Link to="/account?tab=bookings" className="text-sm font-bold text-teal">← My bookings</Link>
        <Button variant="secondary" size="sm" onClick={() => window.print()}><Printer className="size-4" /> Print receipt</Button>
      </div>
      <div className="card mt-4 p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="eyebrow">Booking {b.code}</p>
            <h1 className="mt-1 text-2xl font-extrabold">{b.propertyName}</h1>
            <p className="mt-1 flex items-center gap-1 text-sm text-muted"><MapPin className="size-4 text-teal" /> {b.localityName}, Visakhapatnam</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={BOOKING_STATUS[b.status]?.tone}>{BOOKING_STATUS[b.status]?.label ?? b.status}</Badge>
            <Badge tone={PAYMENT_STATUS[b.paymentStatus]?.tone}>{PAYMENT_STATUS[b.paymentStatus]?.label ?? b.paymentStatus}</Badge>
          </div>
        </div>
        {notice && <div className="mt-4"><Alert tone="info">{notice}</Alert></div>}
        {b.status === 'pending_payment' && (
          <div className="no-print mt-4"><Alert tone="info">Payment pending. <Link to={`/payment/${b.id}`} className="font-bold underline">Complete or check payment</Link></Alert></div>
        )}
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl bg-mist p-4"><p className="text-xs text-muted">Check-in</p><p className="font-bold">{fmtDate(b.checkIn)}</p><p className="text-xs text-muted">from {b.checkInTime}</p></div>
          <div className="rounded-xl bg-mist p-4"><p className="text-xs text-muted">Check-out</p><p className="font-bold">{fmtDate(b.checkOut)}</p><p className="text-xs text-muted">{b.nights} night{b.nights > 1 ? 's' : ''} · {STAY_LABEL[b.stayType]}</p></div>
          <div className="rounded-xl bg-mist p-4"><p className="flex items-center gap-1 text-xs text-muted"><BedDouble className="size-3.5" /> Room / bed</p><p className="font-bold">{b.roomName}</p><p className="text-xs text-muted">Bed {b.bedLabel}</p></div>
        </div>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div>
            <h2 className="flex items-center gap-1.5 font-bold"><Receipt className="size-4 text-teal" /> Charges</h2>
            <dl className="mt-3 space-y-1.5 text-sm">
              {b.priceLines.map((l) => <div key={l.label} className="flex justify-between"><dt className="text-muted">{l.label}</dt><dd>{inr(l.amount)}</dd></div>)}
              <div className="flex justify-between"><dt className="text-muted">GST</dt><dd>{inr(b.amounts.tax)}</dd></div>
              {b.amounts.deposit > 0 && <div className="flex justify-between"><dt className="text-muted">Refundable deposit</dt><dd>{inr(b.amounts.deposit)}</dd></div>}
              <div className="flex justify-between border-t border-line pt-2 font-extrabold"><dt>Total</dt><dd>{inr(b.amounts.payable)}</dd></div>
              {b.refundedAmount > 0 && <div className="flex justify-between text-veg"><dt>Refunded</dt><dd>−{inr(b.refundedAmount)}</dd></div>}
            </dl>
          </div>
          <div>
            <h2 className="font-bold">Guest</h2>
            <p className="mt-3 text-sm">{b.guest.name}<br />{b.guest.phone}{b.guest.email && <><br />{b.guest.email}</>}</p>
            {paid && <p className="mt-4 text-xs text-muted">Paid {fmtDateTime(paid.paidAt ? new Date(paid.paidAt).toISOString() : null)} via Cashfree ({paid.method ?? 'online'}) · Ref {paid.bankReference ?? paid.gatewayPaymentId} · Order {paid.orderId}</p>}
          </div>
        </div>

        {!!money?.refunds.length && (
          <div className="mt-6">
            <h2 className="font-bold">Refunds</h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              {money.refunds.map((r) => (
                <li key={r.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-mist px-3 py-2">
                  <span>{inr(r.amount)} · {r.kind === 'duplicate_payment' ? 'Duplicate payment' : r.kind === 'inventory_unavailable' ? 'Booking unavailable' : 'Cancellation'}</span>
                  <span className="font-semibold">{r.status === 'processed' ? `Processed ${fmtDate(new Date(r.processedAt ?? r.updatedAt).toISOString())}` : r.status === 'failed' ? 'Failed – support will contact you' : 'In progress (5–7 working days)'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="no-print mt-6 border-t border-line pt-4 text-xs text-muted">
          <p><span className="font-bold text-navy">Cancellation policy:</span> {POLICY_TEXT[b.cancellationPolicy]}</p>
          {cancellable && !showCancel && <Button variant="secondary" size="sm" className="mt-3" onClick={() => setShowCancel(true)}>Cancel booking</Button>}
          {showCancel && (
            <div className="mt-3 space-y-3 rounded-xl border border-line p-4">
              <p className="text-sm text-navy">{preview ? `If you cancel now you will receive ${inr(Math.min(preview.amount, b.amounts.payable))} (${preview.percent}% of stay charges plus the deposit).` : 'No payment has been made, so nothing will be charged.'}</p>
              <Field label="Reason" htmlFor="cancel-reason"><textarea id="cancel-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
              <div className="flex gap-2">
                <Button variant="danger" size="sm" loading={busy} onClick={doCancel}>Confirm cancellation</Button>
                <Button variant="ghost" size="sm" onClick={() => setShowCancel(false)}>Keep booking</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
