import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { get, run, tx } from '../db/index.ts';
import { config } from '../config.ts';
import { parse, HttpError, badRequest } from '../lib/http.ts';
import {
  hashPassword, verifyPassword, createSession, destroySession, requireAuth, permissionsFor, sha256, hmac, generateOtp,
  type AuthUser,
} from '../lib/auth.ts';
import { sendEmail, emailTemplates, audit, notifyAdmins } from '../lib/services.ts';

export const authRouter = Router();

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isTest ? 1000 : 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many attempts. Please wait a few minutes and try again.' } });

const password = z.string().min(8, 'Use at least 8 characters').max(128).regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number');
const phone = z.string().trim().regex(/^(\+91[\s-]?)?[6-9]\d{9}$/, 'Enter a valid Indian mobile number');

function publicUser(u: AuthUser) {
  const owner = u.role === 'owner' ? get('SELECT business_name, kyc_status, onboarding_step FROM owner_profiles WHERE user_id = ?', u.id) : null;
  const unread = get<{ c: number }>('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL', u.id)!.c;
  return {
    id: u.id, role: u.role, admin_role: u.admin_role, name: u.name, email: u.email, phone: u.phone,
    email_verified: !!u.email_verified, permissions: permissionsFor(u), owner, unread_notifications: unread,
  };
}

function issueOtp(userId: number, purpose: 'verify' | 'reset') {
  const code = generateOtp();
  run("UPDATE otp_codes SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL", new Date().toISOString(), userId, purpose);
  run('INSERT INTO otp_codes (user_id, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?)', userId, purpose, hmac(`${userId}:${code}`), new Date(Date.now() + 10 * 60000).toISOString());
  const u = get('SELECT name, email FROM users WHERE id = ?', userId)!;
  sendEmail(u.email, emailTemplates.otp(u.name, code, purpose === 'verify' ? 'verification' : 'password reset'));
  return config.isProd ? undefined : code;
}

function consumeOtp(userId: number, purpose: 'verify' | 'reset', code: string) {
  const row = get("SELECT * FROM otp_codes WHERE user_id = ? AND purpose = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1", userId, purpose);
  if (!row || row.expires_at < new Date().toISOString() || row.attempts >= 5) throw badRequest('This code has expired. Request a new one.');
  if (row.code_hash !== hmac(`${userId}:${code}`)) {
    run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    throw badRequest('Incorrect code. Please check and try again.');
  }
  run('UPDATE otp_codes SET used_at = ? WHERE id = ?', new Date().toISOString(), row.id);
}

authRouter.post('/register', limiter, (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2, 'Enter your full name').max(80),
      email: z.email('Enter a valid email').trim().toLowerCase(),
      phone,
      password,
      role: z.enum(['customer', 'owner']).default('customer'),
      business_name: z.string().trim().max(120).optional(),
    }),
    req.body,
  );
  if (get('SELECT id FROM users WHERE email = ?', body.email)) throw new HttpError(409, 'An account with this email already exists', { email: 'Email already registered' });
  const userId = tx(() => {
    const id = run('INSERT INTO users (role, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)', body.role, body.name, body.email, body.phone, hashPassword(body.password)).id;
    if (body.role === 'owner') {
      run('INSERT INTO owner_profiles (user_id, business_name) VALUES (?, ?)', id, body.business_name ?? null);
      notifyAdmins('owner', 'New owner registered', `${body.name} (${body.email})`, '/admin/owners');
    }
    return id;
  });
  const devOtp = issueOtp(userId, 'verify');
  createSession(res, userId);
  const u = get<AuthUser>('SELECT * FROM users WHERE id = ?', userId)!;
  res.status(201).json({ user: publicUser(u), dev_otp: devOtp });
});

authRouter.post('/login', limiter, (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(1), portal: z.enum(['customer', 'owner', 'admin']).optional() }), req.body);
  const u = get<AuthUser & { password_hash: string }>('SELECT * FROM users WHERE email = ?', body.email);
  if (!u || !verifyPassword(body.password, u.password_hash)) throw new HttpError(401, 'Incorrect email or password');
  if (u.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact support@onedayhostels.in');
  if (body.portal === 'admin' && u.role !== 'admin') throw new HttpError(403, 'This sign-in is for platform administrators only');
  createSession(res, u.id);
  if (u.role === 'admin') {
    req.user = u;
    audit(req, 'admin.login', 'user', u.id);
  }
  res.json({ user: publicUser(u) });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

authRouter.post('/otp/send', limiter, requireAuth, (req, res) => {
  if (req.user!.email_verified) return res.json({ ok: true, already_verified: true });
  res.json({ ok: true, dev_otp: issueOtp(req.user!.id, 'verify') });
});

authRouter.post('/otp/verify', limiter, requireAuth, (req, res) => {
  const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }), req.body);
  consumeOtp(req.user!.id, 'verify', code);
  run('UPDATE users SET email_verified = 1 WHERE id = ?', req.user!.id);
  res.json({ ok: true });
});

authRouter.post('/forgot', limiter, (req, res) => {
  const { email } = parse(z.object({ email: z.email('Enter a valid email').trim().toLowerCase() }), req.body);
  const u = get('SELECT id FROM users WHERE email = ?', email);
  const devOtp = u ? issueOtp(u.id, 'reset') : undefined;
  // Same response whether or not the account exists, to avoid account enumeration.
  res.json({ ok: true, message: 'If an account exists for this email, a reset code has been sent.', dev_otp: devOtp });
});

authRouter.post('/reset', limiter, (req, res) => {
  const body = parse(z.object({ email: z.email().trim().toLowerCase(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'), password }), req.body);
  const u = get('SELECT id FROM users WHERE email = ?', body.email);
  if (!u) throw badRequest('This code has expired. Request a new one.');
  consumeOtp(u.id, 'reset', body.code);
  tx(() => {
    run('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?', hashPassword(body.password), u.id);
    run('DELETE FROM sessions WHERE user_id = ?', u.id);
  });
  res.json({ ok: true });
});

authRouter.patch('/me', requireAuth, (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(80).optional(),
      phone: phone.optional(),
      gender: z.enum(['male', 'female', 'other']).nullable().optional(),
      city: z.string().trim().max(60).nullable().optional(),
    }),
    req.body,
  );
  const cur = get('SELECT * FROM users WHERE id = ?', req.user!.id)!;
  run('UPDATE users SET name = ?, phone = ?, gender = ?, city = ? WHERE id = ?', body.name ?? cur.name, body.phone ?? cur.phone, body.gender === undefined ? cur.gender : body.gender, body.city === undefined ? cur.city : body.city, cur.id);
  res.json({ user: publicUser(get<AuthUser>('SELECT * FROM users WHERE id = ?', cur.id)!) });
});

authRouter.get('/me/profile', requireAuth, (req, res) => {
  res.json(get('SELECT id, name, email, phone, gender, city, created_at, email_verified FROM users WHERE id = ?', req.user!.id));
});

authRouter.post('/me/password', limiter, requireAuth, (req, res) => {
  const body = parse(z.object({ current: z.string().min(1), next: password }), req.body);
  const u = get('SELECT password_hash FROM users WHERE id = ?', req.user!.id)!;
  if (!verifyPassword(body.current, u.password_hash)) throw new HttpError(400, 'Current password is incorrect', { current: 'Incorrect password' });
  tx(() => {
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(body.next), req.user!.id);
    run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', req.user!.id, sha256(req.cookies.odh_session));
  });
  res.json({ ok: true });
});
