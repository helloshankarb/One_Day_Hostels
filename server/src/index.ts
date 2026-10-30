import { config } from './config.ts';
import { migrate, get } from './db/index.ts';
import { createApp } from './app.ts';
import { expireHolds } from './lib/bookings.ts';
import { seed } from './db/seed.ts';

migrate();
if (!config.isProd && !get('SELECT id FROM users LIMIT 1')) {
  console.log('Empty database detected – loading demo data');
  seed();
}

const app = createApp();
app.listen(config.port, () => {
  console.log(`One Day Hostels legacy API listening on http://localhost:${config.port} (online payments are handled by Firebase + Cashfree)`);
});

setInterval(() => {
  try {
    expireHolds();
  } catch (e) {
    console.error('expireHolds failed', e);
  }
}, 60_000).unref();
