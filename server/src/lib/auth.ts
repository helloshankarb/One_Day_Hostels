import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { get, run } from '../db/index.ts';
import { config } from '../config.ts';
import { HttpError, forbidden } from './http.ts';

export type Role = 'customer' | 'owner' | 'admin';
export type AdminRole = 'super_admin' | 'finance' | 'moderator' | 'support';
export interface AuthUser {
  id: number;
  role: Role;
  admin_role: AdminRole | null;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  email_verified: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const SESSION_COOKIE = 'odh_session';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (s: string, key = config.secret) => crypto.createHmac('sha256', key).update(s).digest('hex');

export function createSession(res: Response, userId: number) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86400000);
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires.toISOString());
  run('UPDATE users SET last_login_at = ? WHERE id = ?', new Date().toISOString(), userId);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    expires,
    path: '/',
  });
}

export function destroySession(req: Request, res: Response) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const u = get<AuthUser & { expires_at: string }>(
      `SELECT u.id, u.role, u.admin_role, u.name, u.email, u.phone, u.status, u.email_verified, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      sha256(token),
    );
    if (u && u.expires_at > new Date().toISOString() && u.status === 'active') {
      const { expires_at: _e, ...user } = u;
      req.user = user;
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Please sign in to continue'));
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in to continue'));
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

export type Permission =
  | 'properties' | 'owners' | 'customers' | 'bookings' | 'payments' | 'refunds' | 'payouts'
  | 'reviews' | 'menus' | 'promotions' | 'support' | 'settings' | 'users' | 'audit' | 'analytics';

const ADMIN_PERMISSIONS: Record<AdminRole, Permission[] | '*'> = {
  super_admin: '*',
  finance: ['payments', 'refunds', 'payouts', 'bookings', 'analytics', 'customers', 'owners'],
  moderator: ['properties', 'owners', 'reviews', 'menus', 'bookings', 'support', 'analytics', 'promotions'],
  support: ['support', 'customers', 'bookings', 'owners'],
};

export function permissionsFor(user: Pick<AuthUser, 'role' | 'admin_role'>): Permission[] | '*' {
  if (user.role !== 'admin' || !user.admin_role) return [];
  return ADMIN_PERMISSIONS[user.admin_role];
}

export function hasPermission(user: AuthUser | undefined, p: Permission) {
  if (!user) return false;
  const perms = permissionsFor(user);
  return perms === '*' || perms.includes(p);
}

export function requirePermission(p: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in to continue'));
    if (req.user.role !== 'admin' || !hasPermission(req.user, p)) return next(forbidden());
    next();
  };
}

/** Basic CSRF defence: state-changing API calls must carry a custom header, which browsers will not send cross-site without CORS approval. */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'odh') return next(forbidden('Missing request header'));
  next();
}

export function generateOtp(): string {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
