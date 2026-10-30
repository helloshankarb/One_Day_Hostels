import type { Request } from 'express';
import { all, get, run } from '../db/index.ts';
import { config } from '../config.ts';

export function audit(req: Request | null, action: string, entityType: string, entityId: number | null, details?: unknown) {
  run(
    'INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details, ip) VALUES (?, ?, ?, ?, ?, ?)',
    req?.user?.id ?? null,
    action,
    entityType,
    entityId,
    details === undefined ? null : JSON.stringify(details),
    req?.ip ?? null,
  );
}

export function notify(userId: number, type: string, title: string, body = '', link: string | null = null) {
  run('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)', userId, type, title, body, link);
}

export function notifyAdmins(type: string, title: string, body = '', link: string | null = null) {
  for (const a of all<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND status = 'active'")) {
    notify(a.id, type, title, body, link);
  }
}

const BRAND = 'One Day Hostels';

/** Email templates. Without SMTP configured, messages are logged (development only). */
export const emailTemplates = {
  otp: (name: string, code: string, purpose: string) => ({
    subject: `${BRAND}: your verification code`,
    text: `Hi ${name},\n\nYour ${BRAND} ${purpose} code is ${code}. It expires in 10 minutes.\nIf you did not request this, ignore this email.\n\n— ${BRAND}, Visakhapatnam`,
  }),
  bookingConfirmed: (name: string, code: string, property: string, checkIn: string, checkOut: string) => ({
    subject: `${BRAND}: booking ${code} confirmed`,
    text: `Hi ${name},\n\nYour stay at ${property} from ${checkIn} to ${checkOut} is confirmed.\nBooking reference: ${code}\nView details: ${config.appUrl}/account/bookings/${code}\n\n— ${BRAND}`,
  }),
  bookingCancelled: (name: string, code: string, refund: number) => ({
    subject: `${BRAND}: booking ${code} cancelled`,
    text: `Hi ${name},\n\nYour booking ${code} has been cancelled. Refund due: ₹${refund}.\n\n— ${BRAND}`,
  }),
  propertyStatus: (name: string, property: string, status: string, reason?: string | null) => ({
    subject: `${BRAND}: ${property} is now ${status.replace('_', ' ')}`,
    text: `Hi ${name},\n\nYour listing "${property}" status changed to ${status}.${reason ? `\nNote from our team: ${reason}` : ''}\n\n— ${BRAND} Partner Team`,
  }),
};

export function sendEmail(to: string, msg: { subject: string; text: string }) {
  if (!config.mail.host) {
    if (!config.isTest) console.log(`[email] to=${to} subject="${msg.subject}"\n${msg.text}\n`);
    return;
  }
  // SMTP transport is intentionally not bundled; plug in a provider (e.g. nodemailer/SES) here.
  console.warn('[email] SMTP_HOST configured but no transport installed; message not sent to', to);
}

export function getSetting<T = string>(key: string, fallback: T): T {
  const r = get<{ value: string }>('SELECT value FROM platform_settings WHERE key = ?', key);
  if (!r) return fallback;
  try {
    return JSON.parse(r.value) as T;
  } catch {
    return r.value as unknown as T;
  }
}

export function setSetting(key: string, value: unknown) {
  run(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    new Date().toISOString(),
  );
}
