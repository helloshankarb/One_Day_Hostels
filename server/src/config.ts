import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = process.env;
const isProd = env.NODE_ENV === 'production';

if (isProd && (!env.APP_SECRET || env.APP_SECRET === 'change-me')) {
  throw new Error('APP_SECRET must be set in production');
}

export const config = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT ?? 4000),
  appUrl: env.APP_URL ?? 'http://localhost:5173',
  root,
  dbFile: env.DATABASE_FILE === ':memory:' ? ':memory:' : path.resolve(root, env.DATABASE_FILE ?? 'data/one-day-hostels.db'),
  uploadsDir: path.resolve(root, 'uploads'),
  secret: env.APP_SECRET ?? 'dev-only-secret',
  sessionDays: 7,
  mail: {
    host: env.SMTP_HOST ?? '',
    from: env.MAIL_FROM ?? 'One Day Hostels <no-reply@onedayhostels.in>',
  },
  holdMinutes: 15,
};
