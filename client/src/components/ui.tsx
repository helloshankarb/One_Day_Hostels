import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2, Star, CheckCircle2, X, Info } from 'lucide-react';
import { FOOD_LABEL, type Tone } from '../lib/format';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'teal' | 'coral';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-navy text-white hover:bg-navy-700',
  teal: 'bg-teal text-white hover:bg-teal-700',
  coral: 'bg-coral text-white hover:brightness-95',
  secondary: 'border border-line bg-white text-navy hover:border-navy/40',
  ghost: 'text-navy hover:bg-mist',
  danger: 'bg-nonveg text-white hover:brightness-95',
};

export function Button({
  variant = 'primary', size = 'md', loading, className, children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'px-3 py-1.5 text-xs' : size === 'lg' ? 'px-6 py-3.5 text-sm' : 'px-4 py-2.5 text-sm',
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function ButtonLink({ to, variant = 'primary', className, children }: { to: string; variant?: Variant; className?: string; children: ReactNode }) {
  return (
    <Link to={to} className={cx('inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition', VARIANTS[variant], className)}>
      {children}
    </Link>
  );
}

const TONES: Record<Tone, string> = {
  teal: 'bg-teal-50 text-teal',
  green: 'bg-green-50 text-veg',
  red: 'bg-red-50 text-nonveg',
  amber: 'bg-amber-50 text-amber-700',
  blue: 'bg-blue-50 text-blue-700',
  slate: 'bg-slate-100 text-slate-600',
  navy: 'bg-navy text-white',
  coral: 'bg-coral-50 text-coral',
};
export function Badge({ tone = 'slate', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold', TONES[tone], className)}>{children}</span>;
}

/** Indian food-labelling style mark: square outline with a dot (green = veg, red = non-veg). */
export function VegMark({ veg, size = 14 }: { veg: boolean; size?: number }) {
  return (
    <span
      role="img"
      aria-label={veg ? 'Vegetarian' : 'Non-vegetarian'}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-[3px] border-[1.5px]', veg ? 'border-veg' : 'border-nonveg')}
      style={{ width: size, height: size }}
    >
      <span className={cx('rounded-full', veg ? 'bg-veg' : 'bg-nonveg')} style={{ width: size / 2.2, height: size / 2.2 }} />
    </span>
  );
}

export function FoodBadge({ type, className }: { type: string; className?: string }) {
  if (type === 'none') return <Badge className={className}>No food service</Badge>;
  const veg = type !== 'veg_nonveg';
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-bold', veg ? 'text-veg' : 'text-navy', className)}>
      <VegMark veg />
      {type === 'veg_nonveg' && <VegMark veg={false} />}
      {FOOD_LABEL[type]}
    </span>
  );
}

export function Rating({ value, count, className }: { value: number; count?: number; className?: string }) {
  if (!value) return <span className={cx('text-xs font-semibold text-muted', className)}>New</span>;
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs font-bold', className)}>
      <Star className="size-3.5 fill-amber-400 text-amber-400" aria-hidden />
      {value.toFixed(1)}
      {count !== undefined && <span className="font-medium text-muted">({count})</span>}
    </span>
  );
}

export function Spinner({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cx('flex items-center justify-center gap-2 py-16 text-sm text-muted', className)}>
      <Loader2 className="size-5 animate-spin text-teal" aria-hidden />
      {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-xl bg-mist', className)} aria-hidden />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-mist text-teal">{icon}</div>}
      <h3 className="text-base font-bold">{title}</h3>
      {children && <p className="mt-1 max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="card flex flex-col items-center px-6 py-12 text-center">
      <AlertTriangle className="mb-2 size-8 text-coral" aria-hidden />
      <p className="text-sm font-semibold">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'flex items-start gap-2 rounded-xl px-3.5 py-3 text-sm',
        tone === 'error' ? 'bg-red-50 text-nonveg' : tone === 'success' ? 'bg-green-50 text-veg' : 'bg-teal-50 text-teal',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="mt-1 text-xs font-medium text-nonveg">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ invalid, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${rest.id}-error` : undefined} className={cx('input', invalid && 'border-nonveg', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx('input pr-8', className)}>
      {children}
    </select>
  );
}

export function Pagination({ page, pages, onChange }: { page: number; pages: number; onChange: (p: number) => void }) {
  if (pages <= 1) return null;
  const nums = Array.from({ length: pages }, (_, i) => i + 1).filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 1);
  return (
    <nav className="flex items-center justify-center gap-1.5" aria-label="Pagination">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous
      </Button>
      {nums.map((n, i) => (
        <span key={n} className="flex items-center gap-1.5">
          {i > 0 && n - nums[i - 1] > 1 && <span className="px-1 text-muted">…</span>}
          <button
            onClick={() => onChange(n)}
            aria-current={n === page ? 'page' : undefined}
            className={cx('size-8 rounded-lg text-xs font-bold', n === page ? 'bg-navy text-white' : 'bg-white text-navy hover:bg-mist')}
          >
            {n}
          </button>
        </span>
      ))}
      <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        Next
      </Button>
    </nav>
  );
}

/** Lightweight toast used for saved/removed feedback. */
export function useToast() {
  const [msg, setMsg] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  const node = msg ? (
    <div role="status" className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-navy px-4 py-3 text-sm font-semibold text-white shadow-lg">
      {msg.tone === 'success' ? <CheckCircle2 className="size-4 text-emerald-300" /> : <AlertTriangle className="size-4 text-coral" />}
      {msg.text}
      <button onClick={() => setMsg(null)} aria-label="Dismiss">
        <X className="size-4" />
      </button>
    </div>
  ) : null;
  return { show: (text: string, tone: 'success' | 'error' = 'success') => setMsg({ text, tone }), node };
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · One Day Hostels` : 'One Day Hostels – Hostels & PGs in Visakhapatnam';
  }, [title]);
}
