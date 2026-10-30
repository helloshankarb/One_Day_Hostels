import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, MailCheck } from 'lucide-react';
import { useAuth, friendlyError, homeFor } from '../lib/auth';
import { Alert, Button, Field, Input, Spinner, cx, useDocumentTitle } from '../components/ui';
import { Logo } from '../components/Layout';
import { PHONE_RE } from '../../../shared/model';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-[calc(100vh-4rem)] lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-navy lg:block">
        <img src="/images/room-1.png" alt="" className="absolute inset-0 size-full object-cover opacity-40" />
        <div className="relative flex h-full flex-col justify-end p-12 text-white">
          <Logo light />
          <h2 className="mt-8 max-w-md text-3xl font-extrabold leading-tight">Verified stays and honest daily menus across Visakhapatnam.</h2>
          <p className="mt-3 max-w-md text-sm text-white/70">Book a dorm bed for a night, a PG for a month, or list your own hostel – all in one place.</p>
        </div>
      </div>
      <div className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <h1 className="text-2xl font-extrabold">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </div>
    </div>
  );
}

function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={show ? 'text' : 'password'} className="pr-10" />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute inset-y-0 right-0 px-3 text-muted" aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function Login() {
  useDocumentTitle('Sign in');
  const { signIn, user, loading } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <Spinner />;
  if (user) return <Navigate to={user.profileComplete ? from ?? homeFor(user) : '/complete-profile'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) return setError('Enter your email and password');
    setBusy(true);
    try {
      const u = await signIn(email, password);
      nav(u.profileComplete ? from ?? homeFor(u) : '/complete-profile', { replace: true });
    } catch (err) {
      setError(friendlyError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to manage your stays, saved hostels and account.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="password">
          <PasswordInput id="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-xs font-bold text-teal">Forgot password?</Link>
        </div>
        <Button type="submit" className="w-full" size="lg" loading={busy}>Sign in</Button>
        <p className="text-center text-sm text-muted">
          New to One Day Hostels? <Link to="/register" className="font-bold text-teal">Create an account</Link>
        </p>
      </form>
    </AuthShell>
  );
}

type Errors = Partial<Record<'name' | 'email' | 'phone' | 'password' | 'confirm' | 'businessName' | 'terms', string>>;

export function Register({ completeOnly = false }: { completeOnly?: boolean }) {
  useDocumentTitle(completeOnly ? 'Complete your profile' : 'Create account');
  const { register, completeProfile, user, loading } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [role, setRole] = useState<'customer' | 'owner'>(params.get('role') === 'owner' ? 'owner' : 'customer');
  const [form, setForm] = useState({ name: user?.name ?? '', email: '', phone: '', password: '', confirm: '', businessName: '' });
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <Spinner />;
  // While submitting, auth state changes mid-flow; let the submit handler navigate.
  if (!busy && !completeOnly && user) return <Navigate to={user.profileComplete ? homeFor(user) : '/complete-profile'} replace />;
  if (completeOnly && !user) return <Navigate to="/login" replace />;
  if (!busy && completeOnly && user?.profileComplete) return <Navigate to={homeFor(user)} replace />;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const validate = (): Errors => {
    const er: Errors = {};
    if (form.name.trim().length < 2) er.name = 'Enter your full name';
    if (!PHONE_RE.test(form.phone.trim())) er.phone = 'Enter a valid 10-digit Indian mobile number';
    if (role === 'owner' && form.businessName.trim().length < 2) er.businessName = 'Enter your hostel or business name';
    if (!completeOnly) {
      if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) er.email = 'Enter a valid email address';
      if (form.password.length < 8 || !/[A-Za-z]/.test(form.password) || !/\d/.test(form.password)) er.password = 'At least 8 characters with a letter and a number';
      if (form.confirm !== form.password) er.confirm = 'Passwords do not match';
      if (!terms) er.terms = 'Please accept the terms to continue';
    }
    return er;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const er = validate();
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    try {
      const input = { name: form.name.trim(), phone: form.phone.trim(), role, ...(role === 'owner' ? { businessName: form.businessName.trim() } : {}) };
      const u = completeOnly ? await completeProfile(input) : await register({ ...input, email: form.email, password: form.password });
      nav(u.role === 'owner' ? '/account?welcome=owner' : '/account?welcome=1', { replace: true });
    } catch (err) {
      const f = friendlyError(err);
      setError(f.message);
      if (f.fields) setErrors(f.fields as Errors);
      // Only reset on failure; on success the redirect guard must not race the navigation above.
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={completeOnly ? 'Complete your profile' : role === 'owner' ? 'List your property' : 'Create your account'}
      subtitle={completeOnly ? 'Just a few details so hostels can reach you.' : role === 'owner' ? 'Register as a hostel / PG owner in Visakhapatnam.' : 'Book verified hostels and PGs across Vizag.'}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-mist p-1" role="radiogroup" aria-label="Account type">
          {(['customer', 'owner'] as const).map((r) => (
            <button type="button" key={r} role="radio" aria-checked={role === r} onClick={() => setRole(r)} className={cx('rounded-lg py-2 text-sm font-bold', role === r ? 'bg-white shadow' : 'text-muted')}>
              {r === 'customer' ? 'I’m a guest' : 'I own a hostel / PG'}
            </button>
          ))}
        </div>
        {error && <Alert>{error}</Alert>}
        <Field label="Full name" htmlFor="name" error={errors.name}>
          <Input id="name" autoComplete="name" value={form.name} onChange={set('name')} invalid={!!errors.name} />
        </Field>
        {role === 'owner' && (
          <Field label="Hostel / business name" htmlFor="businessName" error={errors.businessName}>
            <Input id="businessName" value={form.businessName} onChange={set('businessName')} invalid={!!errors.businessName} />
          </Field>
        )}
        {!completeOnly && (
          <Field label="Email" htmlFor="email" error={errors.email}>
            <Input id="email" type="email" autoComplete="email" value={form.email} onChange={set('email')} invalid={!!errors.email} />
          </Field>
        )}
        <Field label="Mobile number" htmlFor="phone" error={errors.phone} hint="Used by the property to contact you about your stay.">
          <Input id="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="98XXXXXXXX" value={form.phone} onChange={set('phone')} invalid={!!errors.phone} />
        </Field>
        {!completeOnly && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Password" htmlFor="password" error={errors.password}>
              <PasswordInput id="password" autoComplete="new-password" value={form.password} onChange={set('password')} invalid={!!errors.password} />
            </Field>
            <Field label="Confirm password" htmlFor="confirm" error={errors.confirm}>
              <PasswordInput id="confirm" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} invalid={!!errors.confirm} />
            </Field>
          </div>
        )}
        {!completeOnly && (
          <div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-0.5 size-4 accent-teal" />
              <span>I agree to the <Link to="/terms" className="font-bold text-teal">Terms</Link> and <Link to="/privacy" className="font-bold text-teal">Privacy Policy</Link>.</span>
            </label>
            {errors.terms && <p className="mt-1 text-xs font-medium text-nonveg">{errors.terms}</p>}
          </div>
        )}
        <Button type="submit" className="w-full" size="lg" loading={busy}>
          {completeOnly ? 'Save and continue' : 'Create account'}
        </Button>
        {!completeOnly && (
          <p className="text-center text-sm text-muted">
            Already have an account? <Link to="/login" className="font-bold text-teal">Sign in</Link>
          </p>
        )}
      </form>
    </AuthShell>
  );
}

export function ForgotPassword() {
  useDocumentTitle('Reset password');
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError('Enter a valid email address');
    setBusy(true);
    try {
      await resetPassword(email);
      setSent(true);
    } catch (err) {
      const f = friendlyError(err);
      // Do not reveal whether an account exists.
      if ((err as { code?: string }).code === 'auth/user-not-found') setSent(true);
      else setError(f.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Forgot your password?" subtitle="We’ll email you a secure link to set a new password.">
      {sent ? (
        <div className="card p-6 text-center">
          <MailCheck className="mx-auto size-10 text-teal" />
          <p className="mt-3 font-bold">Check your inbox</p>
          <p className="mt-1 text-sm text-muted">If an account exists for {email}, a reset link is on its way. The link expires in 1 hour.</p>
          <Link to="/login" className="mt-5 inline-block text-sm font-bold text-teal">Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error && <Alert>{error}</Alert>}
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" size="lg" loading={busy}>Send reset link</Button>
          <p className="text-center text-sm"><Link to="/login" className="font-bold text-teal">Back to sign in</Link></p>
        </form>
      )}
    </AuthShell>
  );
}
