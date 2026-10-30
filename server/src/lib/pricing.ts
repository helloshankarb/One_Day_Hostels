import { diffDays, hoursUntil } from './dates.ts';
import { HttpError } from './http.ts';

export interface RoomPricing {
  price_daily: number;
  price_weekly: number | null;
  price_monthly: number | null;
  deposit: number;
}
export interface PropertyRules {
  allow_daily: number;
  allow_weekly: number;
  allow_monthly: number;
  min_stay_days: number;
}
export interface Coupon {
  id: number;
  discount_type: 'percent' | 'flat';
  value: number;
  max_discount: number | null;
  min_amount: number;
}

export interface Quote {
  nights: number;
  stay_type: 'daily' | 'weekly' | 'monthly';
  lines: { label: string; amount: number }[];
  base_amount: number;
  discount: number;
  tax_amount: number;
  deposit: number;
  total_amount: number;
  payable_now: number;
  commission_amount: number;
}

/**
 * Stay pricing:
 *  - 30+ nights at a monthly-enabled property: full months at the monthly rate, leftover nights at the daily rate (capped at one month).
 *  - 7+ nights at a weekly-enabled property: full weeks at the weekly rate, leftover nights at daily rate (capped at one week).
 *  - Otherwise each night at the daily rate.
 * Deposit is charged only for monthly stays. GST applies to accommodation after discount.
 */
export function quote(
  room: RoomPricing,
  rules: PropertyRules,
  checkIn: string,
  checkOut: string,
  opts: { gstPercent: number; commissionPercent: number; coupon?: Coupon | null },
): Quote {
  const nights = diffDays(checkIn, checkOut);
  if (nights <= 0) throw new HttpError(400, 'Check-out must be after check-in');
  if (nights < rules.min_stay_days) throw new HttpError(400, `This property requires a minimum stay of ${rules.min_stay_days} night(s)`);
  if (nights > 365) throw new HttpError(400, 'Stays longer than 12 months must be arranged with the property directly');

  const lines: Quote['lines'] = [];
  let stay_type: Quote['stay_type'];
  let base = 0;

  if (nights >= 30 && rules.allow_monthly && room.price_monthly) {
    stay_type = 'monthly';
    const months = Math.floor(nights / 30);
    const rest = nights % 30;
    base += months * room.price_monthly;
    lines.push({ label: `${months} month${months > 1 ? 's' : ''} × ₹${room.price_monthly}`, amount: months * room.price_monthly });
    if (rest) {
      const extra = Math.min(rest * room.price_daily, room.price_monthly);
      base += extra;
      lines.push({ label: `${rest} extra night${rest > 1 ? 's' : ''}`, amount: extra });
    }
  } else if (nights >= 7 && rules.allow_weekly && room.price_weekly) {
    stay_type = 'weekly';
    const weeks = Math.floor(nights / 7);
    const rest = nights % 7;
    base += weeks * room.price_weekly;
    lines.push({ label: `${weeks} week${weeks > 1 ? 's' : ''} × ₹${room.price_weekly}`, amount: weeks * room.price_weekly });
    if (rest) {
      const extra = Math.min(rest * room.price_daily, room.price_weekly);
      base += extra;
      lines.push({ label: `${rest} extra night${rest > 1 ? 's' : ''}`, amount: extra });
    }
  } else {
    if (!rules.allow_daily) {
      throw new HttpError(400, 'This property does not accept short daily stays. Choose a weekly or monthly duration.');
    }
    stay_type = 'daily';
    base = nights * room.price_daily;
    lines.push({ label: `${nights} night${nights > 1 ? 's' : ''} × ₹${room.price_daily}`, amount: base });
  }

  let discount = 0;
  const c = opts.coupon;
  if (c) {
    if (base < c.min_amount) throw new HttpError(400, `Coupon requires a minimum booking of ₹${c.min_amount}`);
    discount = c.discount_type === 'percent' ? Math.floor((base * c.value) / 100) : c.value;
    if (c.max_discount) discount = Math.min(discount, c.max_discount);
    discount = Math.min(discount, base);
  }
  const taxable = base - discount;
  const tax_amount = Math.round((taxable * opts.gstPercent) / 100);
  const deposit = stay_type === 'monthly' ? room.deposit : 0;
  const total_amount = taxable + tax_amount;
  return {
    nights,
    stay_type,
    lines,
    base_amount: base,
    discount,
    tax_amount,
    deposit,
    total_amount,
    payable_now: total_amount + deposit,
    commission_amount: Math.round((taxable * opts.commissionPercent) / 100),
  };
}

export type CancellationPolicy = 'flexible' | 'moderate' | 'strict';

export const POLICY_TEXT: Record<CancellationPolicy, string> = {
  flexible: 'Full refund up to 24 hours before check-in, 50% after that. Free cancellation within 24 hours of booking.',
  moderate: 'Full refund up to 3 days before check-in, 50% up to 24 hours before, no refund after. Free cancellation within 24 hours of booking.',
  strict: '50% refund up to 7 days before check-in, no refund after. Free cancellation within 24 hours of booking.',
};

/** Refund for a paid booking. The security deposit is always returned in full; checked-in stays are not cancellable. */
export function refundFor(
  b: { total_amount: number; deposit: number; check_in: string; created_at: string },
  policy: CancellationPolicy,
  checkInTime: string,
  now = new Date(),
): { percent: number; amount: number } {
  const hours = hoursUntil(b.check_in, checkInTime, now);
  const sinceBooking = (now.getTime() - Date.parse(b.created_at)) / 3600000;
  let percent: number;
  if (sinceBooking <= 24 && hours > 0) percent = 100;
  else if (policy === 'flexible') percent = hours >= 24 ? 100 : 50;
  else if (policy === 'moderate') percent = hours >= 72 ? 100 : hours >= 24 ? 50 : 0;
  else percent = hours >= 168 ? 50 : 0;
  return { percent, amount: Math.round((b.total_amount * percent) / 100) + b.deposit };
}
