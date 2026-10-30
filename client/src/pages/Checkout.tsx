import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Lock, CalendarDays, BedDouble, ShieldCheck } from 'lucide-react';
import { useAuth, friendlyError } from '../lib/auth';
import { getPropertyDetail, getMyProfile, type PropertyDetail } from '../lib/data';
import { createBooking, createPaymentOrder, getAvailability, openCashfreeCheckout, type RoomAvailability } from '../lib/booking';
import { PHONE_RE } from '../../../shared/model';
import { POLICY_TEXT, isValidDate } from '../../../shared/pricing';
import { Alert, Button, ErrorState, Field, Input, Select, Spinner, useDocumentTitle } from '../components/ui';
import { fmtDate, inr, GENDER_LABEL } from '../lib/format';

type Stage = 'idle' | 'booking' | 'order' | 'paying';

/** Stable per-checkout key so retries and double-clicks never create a second booking. */
function idempotencyKey(scope: string) {
  const k = `odh:idem:${scope}`;
  let v = sessionStorage.getItem(k);
  if (!v) {
    v = crypto.randomUUID().replace(/-/g, '');
    sessionStorage.setItem(k, v);
  }
  return v;
}

export default function Checkout() {
  useDocumentTitle('Checkout');
  const { propertyId = '' } = useParams();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const roomId = params.get('room') ?? '';
  const bedId = params.get('bed');
  const checkIn = params.get('in') ?? '';
  const checkOut = params.get('out') ?? '';
  const [detail, setDetail] = useState<PropertyDetail | null | undefined>(undefined);
  const [room, setRoom] = useState<RoomAvailability | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: user?.name ?? '', phone: user?.phone ?? '', email: user?.email ?? '', gender: '', requests: '' });
  const [accept, setAccept] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const scope = useMemo(() => `${propertyId}:${roomId}:${bedId ?? ''}:${checkIn}:${checkOut}`, [propertyId, roomId, bedId, checkIn, checkOut]);

  useEffect(() => {
    if (!isValidDate(checkIn) || !isValidDate(checkOut) || !roomId) {
      setLoadError('This booking link is incomplete. Please choose your dates again.');
      return;
    }
    Promise.all([getPropertyDetail(propertyId), getAvailability({ propertyId, checkIn, checkOut })])
      .then(([d, a]) => {
        setDetail(d);
        setRoom(a.rooms.find((r) => r.id === roomId) ?? null);
      })
      .catch((e) => setLoadError(friendlyError(e).message));
    if (user) getMyProfile(user.uid).then((p) => p && setForm((f) => ({ ...f, phone: f.phone || p.phone || '', gender: p.gender ?? '' })));
  }, [propertyId, roomId, checkIn, checkOut, user]);

  if (loadError) return <div className="container-x py-16"><ErrorState message={loadError} /></div>;
  if (detail === undefined) return <Spinner label="Preparing your booking…" />;
  if (!detail || !room) return <div className="container-x py-16"><ErrorState message="This room is no longer available." /></div>;
  const p = detail.property;
  const q = room.quote;
  const bed = bedId ? room.beds.find((b) => b.id === bedId) : null;
  const needsGender = p.genderPolicy === 'men' || p.genderPolicy === 'women';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const er: Record<string, string> = {};
    if (form.name.trim().length < 2) er.name = 'Enter the guest name';
    if (!PHONE_RE.test(form.phone.replace(/[\s-]/g, ''))) er.phone = 'Enter a valid 10-digit Indian mobile number';
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) er.email = 'Enter a valid email';
    if (needsGender && !form.gender) er.gender = `This is a ${GENDER_LABEL[p.genderPolicy].toLowerCase()} property`;
    if (!accept) er.accept = 'Please accept the house rules and cancellation policy';
    setErrors(er);
    if (Object.keys(er).length) return;
    try {
      setStage('booking');
      const b = await createBooking({
        propertyId, roomId, bedId, checkIn, checkOut, guestName: form.name.trim(), guestPhone: form.phone.trim(), guestEmail: form.email.trim() || null,
        guestGender: (form.gender || null) as 'male' | 'female' | 'other' | null, specialRequests: form.requests.trim() || null,
        idempotencyKey: idempotencyKey(scope), acceptPolicies: true,
      });
      setStage('order');
      const order = await createPaymentOrder({ bookingId: b.bookingId });
      setStage('paying');
      // The checkout result is never trusted; the status page asks the server to verify with Cashfree.
      await openCashfreeCheckout(order.paymentSessionId, order.environment).catch(() => undefined);
      sessionStorage.removeItem(`odh:idem:${scope}`);
      nav(`/payment/${b.bookingId}`, { replace: true });
    } catch (err) {
      const f = friendlyError(err);
      setError(f.message);
      if (f.fields) setErrors(f.fields);
      setStage('idle');
    }
  };

  const busyLabel = stage === 'booking' ? 'Holding your bed…' : stage === 'order' ? 'Creating secure payment…' : stage === 'paying' ? 'Waiting for payment…' : '';

  return (
    <div className="container-x max-w-5xl py-10">
      <nav className="text-xs text-muted"><Link to={`/property/${propertyId}`} className="hover:text-navy">{p.name}</Link> / <span className="font-semibold text-navy">Checkout</span></nav>
      <h1 className="mt-2 text-2xl font-extrabold">Confirm and pay</h1>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        <form onSubmit={submit} className="card space-y-4 p-6" noValidate>
          <h2 className="text-lg font-bold">Guest details</h2>
          {error && <Alert>{error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Guest full name" htmlFor="g-name" error={errors.name ?? errors.guestName}>
              <Input id="g-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} invalid={!!(errors.name ?? errors.guestName)} autoComplete="name" />
            </Field>
            <Field label="Mobile number" htmlFor="g-phone" error={errors.phone ?? errors.guestPhone} hint="The property will contact you on this number.">
              <Input id="g-phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} invalid={!!(errors.phone ?? errors.guestPhone)} autoComplete="tel" />
            </Field>
            <Field label="Email for receipt" htmlFor="g-email" error={errors.email ?? errors.guestEmail}>
              <Input id="g-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} invalid={!!(errors.email ?? errors.guestEmail)} autoComplete="email" />
            </Field>
            <Field label={needsGender ? 'Gender (required)' : 'Gender'} htmlFor="g-gender" error={errors.gender}>
              <Select id="g-gender" value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
                <option value="">Select</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
              </Select>
            </Field>
          </div>
          <Field label="Special requests (optional)" htmlFor="g-req">
            <textarea id="g-req" className="input min-h-20" maxLength={500} value={form.requests} onChange={(e) => setForm({ ...form, requests: e.target.value })} />
          </Field>
          <div className="rounded-xl bg-mist p-4 text-xs text-muted">
            <p className="font-bold text-navy">Cancellation policy ({p.cancellationPolicy})</p>
            <p className="mt-1">{POLICY_TEXT[p.cancellationPolicy]} Security deposits are always refunded in full.</p>
            {p.houseRules && <p className="mt-2 whitespace-pre-line">{p.houseRules}</p>}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-0.5 size-4 accent-teal" />
            <span>I agree to the house rules and the cancellation policy, and will carry a valid photo ID at check-in.</span>
          </label>
          {errors.accept && <p className="text-xs font-medium text-nonveg">{errors.accept}</p>}
          <Button type="submit" size="lg" className="w-full" loading={stage !== 'idle'} disabled={!q || !room.availableBeds}>
            <Lock className="size-4" /> {stage !== 'idle' ? busyLabel : q ? `Pay ${inr(q.payableNow)} securely` : 'Unavailable'}
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted">
            <ShieldCheck className="size-3.5 text-teal" /> UPI, cards and net banking via Cashfree Payments. Your booking is confirmed only after the payment is verified.
          </p>
        </form>

        <aside className="card h-fit p-5">
          {p.photos[0] && <img src={p.photos[0].url} alt="" className="mb-4 h-36 w-full rounded-xl object-cover" />}
          <p className="font-bold">{p.name}</p>
          <p className="text-xs text-muted">{p.localityName}, Visakhapatnam</p>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex items-center justify-between"><dt className="flex items-center gap-1.5 text-muted"><CalendarDays className="size-4" /> Dates</dt><dd className="font-semibold">{fmtDate(checkIn)} → {fmtDate(checkOut)}</dd></div>
            <div className="flex items-center justify-between"><dt className="flex items-center gap-1.5 text-muted"><BedDouble className="size-4" /> Room</dt><dd className="text-right font-semibold">{room.name}{bed ? ` · ${bed.label}` : ''}</dd></div>
          </dl>
          {q ? (
            <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
              {q.lines.map((l) => <div key={l.label} className="flex justify-between"><dt className="text-muted">{l.label}</dt><dd>{inr(l.amount)}</dd></div>)}
              <div className="flex justify-between"><dt className="text-muted">GST</dt><dd>{inr(q.taxAmount)}</dd></div>
              {q.deposit > 0 && <div className="flex justify-between"><dt className="text-muted">Refundable deposit</dt><dd>{inr(q.deposit)}</dd></div>}
              <div className="flex justify-between border-t border-line pt-2 text-base font-extrabold"><dt>Total payable</dt><dd>{inr(q.payableNow)}</dd></div>
            </dl>
          ) : (
            <Alert>{room.quoteError ?? 'This room cannot be booked for these dates.'}</Alert>
          )}
          {!room.availableBeds && <div className="mt-3"><Alert>This room just sold out for these dates.</Alert></div>}
        </aside>
      </div>
    </div>
  );
}
