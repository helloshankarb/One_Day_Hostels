export const BRAND = 'One Day Hostels';

export const inr = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : '₹' + Math.round(n).toLocaleString('en-IN');

export const compactInr = (n: number) =>
  n >= 100000 ? `₹${(n / 100000).toFixed(n >= 1000000 ? 1 : 2)}L` : n >= 1000 ? `₹${(n / 1000).toFixed(1)}k` : inr(n);

export function fmtDate(s: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!s) return '—';
  const d = s.length === 10 ? new Date(s + 'T00:00:00') : new Date(s);
  return d.toLocaleDateString('en-IN', opts);
}
export const fmtDay = (s: string) => fmtDate(s, { weekday: 'short', day: 'numeric', month: 'short' });
export function fmtDateTime(s: string | null | undefined) {
  if (!s) return '—';
  return new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
export function timeAgo(s: string | null | undefined) {
  if (!s) return '';
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
export function addDays(date: string, n: number) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function diffDays(a: string, b: string) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
export function weekStart(date: string) {
  const dow = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

export const FOOD_LABEL: Record<string, string> = {
  pure_veg: 'Pure Veg Kitchen',
  veg_meals: 'Veg Meals Available',
  veg_nonveg: 'Veg & Non-Veg',
  none: 'No Food Service',
};
export const FOOD_HINT: Record<string, string> = {
  pure_veg: 'Dedicated vegetarian kitchen – no meat, fish or egg is cooked on the premises.',
  veg_meals: 'Only vegetarian meals are served from the mess.',
  veg_nonveg: 'Vegetarian and non-vegetarian dishes are served (veg always available).',
  none: 'Accommodation only – no meals are served.',
};
export const GENDER_LABEL: Record<string, string> = { men: 'Men only', women: 'Women only', coed: 'Co-ed', family: 'Family' };
export const ROOM_TYPE_LABEL: Record<string, string> = { private: 'Private room', shared: 'Shared room', dorm: 'Dormitory bed' };
export const ACCOM_LABEL: Record<string, string> = { hostel: 'Hostel', pg: 'PG', coliving: 'Co-living', dormitory: 'Dormitory' };
export const STAY_LABEL: Record<string, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
export const MEAL_LABEL: Record<string, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };

export const BOOKING_STATUS: Record<string, { label: string; tone: Tone }> = {
  requested: { label: 'Request pending', tone: 'amber' },
  pending_payment: { label: 'Payment pending', tone: 'amber' },
  confirmed: { label: 'Confirmed', tone: 'teal' },
  checked_in: { label: 'Checked in', tone: 'blue' },
  completed: { label: 'Completed', tone: 'slate' },
  cancelled: { label: 'Cancelled', tone: 'red' },
  expired: { label: 'Expired', tone: 'slate' },
  rejected: { label: 'Declined', tone: 'red' },
};
export const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  unpaid: { label: 'Unpaid', tone: 'slate' },
  pending: { label: 'Processing', tone: 'amber' },
  paid: { label: 'Paid', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
  refund_pending: { label: 'Refund pending', tone: 'amber' },
  refunded: { label: 'Refunded', tone: 'blue' },
  partially_refunded: { label: 'Part refunded', tone: 'blue' },
  created: { label: 'Created', tone: 'slate' },
  processed: { label: 'Processed', tone: 'green' },
};
export const PROPERTY_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'slate' },
  pending_review: { label: 'Pending review', tone: 'amber' },
  changes_requested: { label: 'Changes requested', tone: 'amber' },
  approved: { label: 'Live', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  suspended: { label: 'Suspended', tone: 'red' },
  unpublished: { label: 'Unpublished', tone: 'slate' },
};
export type Tone = 'teal' | 'green' | 'red' | 'amber' | 'blue' | 'slate' | 'navy' | 'coral';

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
