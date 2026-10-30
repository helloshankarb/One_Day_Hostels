import type { RoomDoc, PropertyDoc, StayType } from './model.ts';

export class PricingError extends Error {}

export const MAX_STAY_NIGHTS = 180;

export function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

export function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
}

/** Each night of a stay as YYYY-MM-DD (check-out day excluded). */
export function stayNights(checkIn: string, checkOut: string): string[] {
  const n = diffDays(checkIn, checkOut);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(checkIn + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export interface Quote {
  nights: number;
  stayType: StayType;
  lines: { label: string; amount: number }[];
  baseAmount: number;
  discount: number;
  taxAmount: number;
  deposit: number;
  totalAmount: number;
  payableNow: number;
  commissionAmount: number;
}

type RoomPricing = Pick<RoomDoc, 'priceDaily' | 'priceWeekly' | 'priceMonthly' | 'deposit'>;
type Rules = Pick<PropertyDoc, 'allowDaily' | 'allowWeekly' | 'allowMonthly' | 'minStayDays'>;

/**
 * 30+ nights at a monthly-enabled property: whole months at the monthly rate plus leftover nights (capped at one month).
 * 7+ nights at a weekly-enabled property: whole weeks plus leftover nights (capped at one week). Otherwise nightly.
 * Deposit applies to monthly stays only; GST applies to accommodation after discount. All amounts are whole rupees.
 */
export function quote(room: RoomPricing, rules: Rules, checkIn: string, checkOut: string, opts: { gstPercent: number; commissionPercent: number }): Quote {
  if (!isValidDate(checkIn) || !isValidDate(checkOut)) throw new PricingError('Choose valid check-in and check-out dates');
  const nights = diffDays(checkIn, checkOut);
  if (nights <= 0) throw new PricingError('Check-out must be after check-in');
  if (nights < (rules.minStayDays || 1)) throw new PricingError(`This property requires a minimum stay of ${rules.minStayDays} night(s)`);
  if (nights > MAX_STAY_NIGHTS) throw new PricingError('Stays longer than 6 months must be arranged with the property directly');

  const lines: Quote['lines'] = [];
  let stayType: StayType;
  let base = 0;
  if (nights >= 30 && rules.allowMonthly && room.priceMonthly) {
    stayType = 'monthly';
    const months = Math.floor(nights / 30);
    const rest = nights % 30;
    base = months * room.priceMonthly;
    lines.push({ label: `${months} month${months > 1 ? 's' : ''} × ₹${room.priceMonthly}`, amount: base });
    if (rest) {
      const extra = Math.min(rest * room.priceDaily, room.priceMonthly);
      base += extra;
      lines.push({ label: `${rest} extra night${rest > 1 ? 's' : ''}`, amount: extra });
    }
  } else if (nights >= 7 && rules.allowWeekly && room.priceWeekly) {
    stayType = 'weekly';
    const weeks = Math.floor(nights / 7);
    const rest = nights % 7;
    base = weeks * room.priceWeekly;
    lines.push({ label: `${weeks} week${weeks > 1 ? 's' : ''} × ₹${room.priceWeekly}`, amount: base });
    if (rest) {
      const extra = Math.min(rest * room.priceDaily, room.priceWeekly);
      base += extra;
      lines.push({ label: `${rest} extra night${rest > 1 ? 's' : ''}`, amount: extra });
    }
  } else {
    if (!rules.allowDaily) throw new PricingError('This property does not accept short daily stays. Choose a weekly or monthly duration.');
    stayType = 'daily';
    base = nights * room.priceDaily;
    lines.push({ label: `${nights} night${nights > 1 ? 's' : ''} × ₹${room.priceDaily}`, amount: base });
  }
  const discount = 0;
  const taxable = base - discount;
  const taxAmount = Math.round((taxable * opts.gstPercent) / 100);
  const deposit = stayType === 'monthly' ? room.deposit : 0;
  const totalAmount = taxable + taxAmount;
  return {
    nights, stayType, lines, baseAmount: base, discount, taxAmount, deposit, totalAmount,
    payableNow: totalAmount + deposit,
    commissionAmount: Math.round((taxable * opts.commissionPercent) / 100),
  };
}

export type CancellationPolicy = 'flexible' | 'moderate' | 'strict';

export const POLICY_TEXT: Record<CancellationPolicy, string> = {
  flexible: 'Full refund up to 24 hours before check-in, 50% after that. Free cancellation within 24 hours of booking.',
  moderate: 'Full refund up to 3 days before check-in, 50% up to 24 hours before, no refund after. Free cancellation within 24 hours of booking.',
  strict: '50% refund up to 7 days before check-in, no refund after. Free cancellation within 24 hours of booking.',
};

export function hoursUntil(date: string, time = '12:00', now = new Date()): number {
  return (Date.parse(`${date}T${time}:00+05:30`) - now.getTime()) / 3600000;
}

/** Refund for a paid booking: stay charges per policy plus the full security deposit. */
export function refundFor(
  b: { totalAmount: number; deposit: number; checkIn: string; createdAt: number },
  policy: CancellationPolicy,
  checkInTime: string,
  now = new Date(),
): { percent: number; amount: number } {
  const hours = hoursUntil(b.checkIn, checkInTime, now);
  const sinceBooking = (now.getTime() - b.createdAt) / 3600000;
  let percent: number;
  if (sinceBooking <= 24 && hours > 0) percent = 100;
  else if (policy === 'flexible') percent = hours >= 24 ? 100 : 50;
  else if (policy === 'moderate') percent = hours >= 72 ? 100 : hours >= 24 ? 50 : 0;
  else percent = hours >= 168 ? 50 : 0;
  return { percent, amount: Math.round((b.totalAmount * percent) / 100) + b.deposit };
}
