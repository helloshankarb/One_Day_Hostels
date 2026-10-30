import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config.ts';
import { get } from './db/index.ts';
import { errorHandler, notFound, forbidden } from './lib/http.ts';
import { loadUser, csrfGuard, requireAuth, hasPermission } from './lib/auth.ts';
import { photoDir, docDir } from './lib/uploads.ts';
import { authRouter } from './routes/auth.ts';
import { publicRouter } from './routes/public.ts';
import { meRouter } from './routes/me.ts';
import { ownerRouter } from './routes/owner.ts';
import { adminRouter } from './routes/admin.ts';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          frameSrc: ["'self'", 'https://www.openstreetmap.org'],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/uploads/photos', express.static(photoDir, { maxAge: '7d', fallthrough: false }));

  const api = express.Router();
  api.use(loadUser, csrfGuard);
  api.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'One Day Hostels API' });
  });
  api.use('/auth', authRouter);
  api.use('/public', publicRouter);
  api.use('/me', meRouter);
  api.use('/owner', ownerRouter);
  api.use('/admin', adminRouter);

  // Verification documents are private: only the listing owner or an admin with property permissions may download.
  api.get('/documents/:id', requireAuth, (req, res) => {
    const d = get('SELECT d.*, p.owner_id FROM property_documents d JOIN properties p ON p.id = d.property_id WHERE d.id = ?', Number(req.params.id));
    if (!d) throw notFound('Document');
    const allowed = d.owner_id === req.user!.id || (req.user!.role === 'admin' && hasPermission(req.user, 'properties'));
    if (!allowed) throw forbidden();
    const file = path.join(docDir, path.basename(d.stored_name));
    if (!fs.existsSync(file)) throw notFound('File');
    res.setHeader('Content-Type', d.mime_type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(d.original_name)}"`);
    res.sendFile(file);
  });
  api.use((_req, _res, next) => next(notFound('Endpoint')));
  app.use('/api', api);

  // Serve the built web app in production.
  const dist = path.resolve(config.root, '../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api|\/uploads).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
