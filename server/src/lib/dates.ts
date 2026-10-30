const TZ = 'Asia/Kolkata';

/** Today's date in Visakhapatnam (IST) as YYYY-MM-DD. */
export function todayIST(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

export function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
}

/** Monday of the week containing date. */
export function weekStart(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

export const nowIso = () => new Date().toISOString();

/** Hours from now until the check-in moment (IST) of a given date and HH:MM time. */
export function hoursUntil(date: string, time = '12:00', now = new Date()): number {
  const target = Date.parse(`${date}T${time}:00+05:30`);
  return (target - now.getTime()) / 3600000;
}
