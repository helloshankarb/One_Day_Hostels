import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Heart, UserRound, MailWarning, Building2, CalendarCheck } from 'lucide-react';
import { useAuth, friendlyError } from '../lib/auth';
import { useSaved } from '../lib/saved';
import { useCatalog } from '../lib/hooks';
import { getMyProfile, updateMyProfile } from '../lib/data';
import { PHONE_RE } from '../../../shared/model';
import { PropertyCard } from '../components/PropertyCard';
import { MyBookings } from './Bookings';
import { Alert, Button, ButtonLink, EmptyState, Field, Input, Select, Spinner, cx, useDocumentTitle, useToast } from '../components/ui';

function Profile() {
  const { user, refresh } = useAuth();
  const [form, setForm] = useState({ name: '', phone: '', city: '', gender: '' });
  const [loaded, setLoaded] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    getMyProfile(user.uid)
      .then((p) => setForm({ name: p?.name ?? '', phone: p?.phone ?? '', city: p?.city ?? '', gender: p?.gender ?? '' }))
      .finally(() => setLoaded(true));
  }, [user]);

  if (!user) return null;
  if (!loaded) return <Spinner />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (form.name.trim().length < 2) er.name = 'Enter your full name';
    if (!PHONE_RE.test(form.phone.trim())) er.phone = 'Enter a valid Indian mobile number';
    setErrors(er);
    setStatus(null);
    if (Object.keys(er).length) return;
    setBusy(true);
    try {
      await updateMyProfile(user.uid, { name: form.name.trim(), phone: form.phone.trim(), city: form.city.trim() || null, gender: form.gender || null });
      await refresh();
      setStatus({ tone: 'success', text: 'Profile updated' });
    } catch (err) {
      setStatus({ tone: 'error', text: friendlyError(err).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card max-w-2xl space-y-4 p-6" noValidate>
      <h2 className="text-lg font-bold">Profile &amp; account settings</h2>
      {status && <Alert tone={status.tone}>{status.text}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" htmlFor="p-name" error={errors.name}>
          <Input id="p-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} invalid={!!errors.name} />
        </Field>
        <Field label="Email" htmlFor="p-email" hint={user.emailVerified ? 'Verified' : 'Not verified yet'}>
          <Input id="p-email" value={user.email} disabled />
        </Field>
        <Field label="Mobile number" htmlFor="p-phone" error={errors.phone}>
          <Input id="p-phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} invalid={!!errors.phone} />
        </Field>
        <Field label="Home city" htmlFor="p-city">
          <Input id="p-city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </Field>
        <Field label="Gender" htmlFor="p-gender" hint="Helps match men-only / women-only hostels.">
          <Select id="p-gender" value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
            <option value="">Prefer not to say</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other</option>
          </Select>
        </Field>
      </div>
      <Button type="submit" loading={busy}>Save changes</Button>
    </form>
  );
}

function Saved() {
  const { items, amenityNames } = useCatalog();
  const saved = useSaved();
  const toast = useToast();
  if (!items) return <Spinner />;
  const list = items.filter((l) => saved.ids.has(l.id));
  if (!list.length)
    return (
      <EmptyState icon={<Heart className="size-6" />} title="No saved stays yet" action={<ButtonLink to="/search">Explore stays</ButtonLink>}>
        Tap the heart on any hostel to shortlist it here.
      </EmptyState>
    );
  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((l) => (
          <PropertyCard
            key={l.id}
            item={l}
            saved
            amenityNames={amenityNames}
            onToggleSave={async (id) => {
              try {
                await saved.toggle(id);
                toast.show('Removed from saved');
              } catch {
                toast.show('Could not update saved stays', 'error');
              }
            }}
          />
        ))}
      </div>
      {toast.node}
    </>
  );
}

export default function Account() {
  useDocumentTitle('My account');
  const { user, resendVerification, refresh } = useAuth();
  const [params, setParams] = useSearchParams();
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  if (!user) return null;
  const tabParam = params.get('tab');
  const tab = user.role === 'customer' && (tabParam === 'saved' || tabParam === 'bookings') ? tabParam : 'profile';
  const welcome = params.get('welcome');

  return (
    <div className="container-x py-10">
      <div className="flex flex-col gap-1">
        <p className="eyebrow">{user.role === 'owner' ? 'Owner account' : user.role === 'admin' ? 'Administrator' : 'Guest account'}</p>
        <h1 className="text-2xl font-extrabold">Hi {user.name.split(' ')[0] || 'there'} 👋</h1>
      </div>

      <div className="mt-6 space-y-3">
        {welcome && <Alert tone="success">Your account is ready. {user.emailVerified ? '' : 'We’ve sent a verification link to your email.'}</Alert>}
        {!user.emailVerified && (
          <div className="flex flex-col gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-center gap-2"><MailWarning className="size-4" /> Please verify {user.email} to secure your account and receive booking updates.</span>
            <span className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={async () => { try { await resendVerification(); setVerifyMsg('Verification email sent'); } catch (e) { setVerifyMsg(friendlyError(e).message); } }}>Resend link</Button>
              <Button size="sm" variant="secondary" onClick={() => refresh()}>I’ve verified</Button>
            </span>
          </div>
        )}
        {verifyMsg && <Alert tone="info">{verifyMsg}</Alert>}
        {user.role !== 'customer' && (
          <Alert tone="info">
            <span className="flex items-center gap-2"><Building2 className="size-4" />
              The {user.role === 'owner' ? 'owner portal (properties, rooms, menus and bookings)' : 'admin console'} is being migrated to Firebase and will be enabled in the next release.
            </span>
          </Alert>
        )}
      </div>

      <div className="mt-6 flex gap-2 border-b border-line" role="tablist">
        {[
          { id: 'profile', label: 'Profile', icon: UserRound },
          ...(user.role === 'customer' ? [{ id: 'bookings', label: 'My bookings', icon: CalendarCheck }, { id: 'saved', label: 'Saved stays', icon: Heart }] : []),
        ].map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams(t.id === 'profile' ? {} : { tab: t.id })} className={cx('-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-bold', tab === t.id ? 'border-teal text-teal' : 'border-transparent text-muted hover:text-navy')}>
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </div>
      <div className="mt-6">{tab === 'saved' ? <Saved /> : tab === 'bookings' ? <MyBookings /> : <Profile />}</div>
      <p className="mt-10 text-xs text-muted">
        Looking for a place? <Link to="/search" className="font-bold text-teal">Browse all stays</Link>
      </p>
    </div>
  );
}
