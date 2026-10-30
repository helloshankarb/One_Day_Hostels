import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = ':memory:';

const { createApp } = await import('../src/app.ts');
const { seed } = await import('../src/db/seed.ts');
const { get, run } = await import('../src/db/index.ts');
const { todayIST, addDays } = await import('../src/lib/dates.ts');
const { quote, refundFor } = await import('../src/lib/pricing.ts');

let server: Server;
let base = '';

class Client {
  cookie = '';
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'odh', ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const json: any = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  put = (p: string, b: unknown = {}) => this.req('PUT', p, b);
  async login(email: string, password: string, portal?: string) {
    const r = await this.post('/api/auth/login', { email, password, portal });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return this;
  }
}

before(() => {
  seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const today = () => todayIST();

test('pricing: daily, weekly and monthly quotes', () => {
  const room = { price_daily: 400, price_weekly: 2500, price_monthly: 8000, deposit: 2000 };
  const rules = { allow_daily: 1, allow_weekly: 1, allow_monthly: 1, min_stay_days: 1 };
  const opts = { gstPercent: 5, commissionPercent: 10 };
  const d = quote(room, rules, '2030-01-01', '2030-01-04', opts);
  assert.equal(d.stay_type, 'daily');
  assert.equal(d.base_amount, 1200);
  assert.equal(d.tax_amount, 60);
  assert.equal(d.deposit, 0);
  const w = quote(room, rules, '2030-01-01', '2030-01-10', opts);
  assert.equal(w.stay_type, 'weekly');
  assert.equal(w.base_amount, 2500 + 800);
  const m = quote(room, rules, '2030-01-01', '2030-02-02', opts);
  assert.equal(m.stay_type, 'monthly');
  assert.equal(m.base_amount, 8000 + 800);
  assert.equal(m.deposit, 2000);
  assert.equal(m.payable_now, m.total_amount + 2000);
  const c = quote(room, rules, '2030-01-01', '2030-01-04', { ...opts, coupon: { id: 1, discount_type: 'percent', value: 10, max_discount: 100, min_amount: 0 } });
  assert.equal(c.discount, 100);
  assert.throws(() => quote(room, { ...rules, allow_daily: 0 }, '2030-01-01', '2030-01-03', opts));
});

test('refund policy: flexible vs strict', () => {
  const b = { total_amount: 1000, deposit: 500, check_in: '2030-01-10', created_at: '2029-12-01T00:00:00Z' };
  const now = new Date('2030-01-09T20:00:00+05:30');
  assert.deepEqual(refundFor(b, 'flexible', '12:00', now), { percent: 50, amount: 1000 });
  assert.deepEqual(refundFor(b, 'strict', '12:00', now), { percent: 0, amount: 500 });
  assert.equal(refundFor(b, 'moderate', '12:00', new Date('2030-01-01T00:00:00Z')).percent, 100);
});

test('auth: register, session, CSRF header and role isolation', async () => {
  const c = new Client();
  const reg = await c.post('/api/auth/register', { name: 'Test Guest', email: 'tg@example.in', phone: '9876500001', password: 'Passw0rd!' });
  assert.equal(reg.status, 201);
  assert.ok(reg.body.dev_otp);
  assert.equal((await c.get('/api/auth/me')).body.user.email, 'tg@example.in');
  assert.equal((await c.post('/api/auth/otp/verify', { code: reg.body.dev_otp })).status, 200);
  const noCsrf = await c.req('POST', '/api/auth/logout', {}, { 'X-Requested-With': '' });
  assert.equal(noCsrf.status, 403);
  assert.equal((await c.get('/api/admin/dashboard')).status, 403);
  assert.equal((await c.get('/api/owner/dashboard')).status, 403);
  const dup = await new Client().post('/api/auth/register', { name: 'Xavier', email: 'tg@example.in', phone: '9876500001', password: 'Passw0rd!' });
  assert.equal(dup.status, 409);
  assert.equal((await new Client().post('/api/auth/login', { email: 'tg@example.in', password: 'wrong' })).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { email: 'customer@onedayhostels.in', password: 'Customer@123', portal: 'admin' })).status, 403);
});

test('search only lists approved properties and supports filters', async () => {
  const c = new Client();
  const all = await c.get('/api/public/properties');
  assert.equal(all.status, 200);
  assert.ok(all.body.total >= 10);
  assert.ok(!all.body.items.some((p: any) => p.name.includes('Ocean View')));
  const veg = await c.get('/api/public/properties?food=pure_veg');
  assert.ok(veg.body.items.length > 0 && veg.body.items.every((p: any) => p.food_type === 'pure_veg'));
  const women = await c.get('/api/public/properties?gender=women&locality=madhurawada');
  assert.ok(women.body.items.every((p: any) => p.gender_policy === 'women' && p.locality === 'Madhurawada'));
  const pending = get("SELECT slug FROM properties WHERE status = 'pending_review' LIMIT 1")!;
  assert.equal((await c.get(`/api/public/properties/${pending.slug}`)).status, 404);
});

/** Payments are processed by Firebase + Cashfree; the legacy API is tested with a recorded paid state. */
function markPaid(code: string) {
  const b = get('SELECT * FROM bookings WHERE code = ?', code)!;
  run("INSERT INTO payments (booking_id, provider, provider_order_id, amount, status, paid_at) VALUES (?, 'test', ?, ?, 'paid', ?)", b.id, 'order_' + code, b.total_amount + b.deposit, new Date().toISOString());
  run("UPDATE bookings SET status = 'confirmed', payment_status = 'paid', hold_expires_at = NULL WHERE id = ?", b.id);
}

test('booking: hold, double-booking prevention, idempotency and cancellation', async () => {
  const guest = await new Client().login('customer@onedayhostels.in', 'Customer@123');
  const other = await new Client().login('pooja.rao@example.in', 'Customer@123');
  const prop = get("SELECT * FROM properties WHERE slug = 'urban-nest-transit-dorms'")!;
  const checkIn = addDays(today(), 40);
  const checkOut = addDays(checkIn, 2);
  const detail = await guest.get(`/api/public/properties/${prop.slug}?check_in=${checkIn}&check_out=${checkOut}`);
  const room = detail.body.rooms.find((r: any) => r.room_type === 'private');
  const bed = room.beds[0];
  assert.equal(bed.available, true);
  const payload = { property_id: prop.id, room_id: room.id, bed_id: bed.id, check_in: checkIn, check_out: checkOut, guest_name: 'Demo Guest', guest_phone: '9876543210', guest_gender: 'male', accept_policies: true, idempotency_key: 'k1' };
  const b1 = await guest.post('/api/me/bookings', payload);
  assert.equal(b1.status, 201, JSON.stringify(b1.body));
  assert.equal(b1.body.status, 'pending_payment');
  const again = await guest.post('/api/me/bookings', payload);
  assert.equal(again.body.code, b1.body.code, 'idempotent create');
  const clash = await other.post('/api/me/bookings', { ...payload, guest_name: 'Pooja Rao', guest_gender: 'female', idempotency_key: 'k2' });
  assert.equal(clash.status, 409);

  markPaid(b1.body.code);
  // Another customer cannot view this booking.
  assert.equal((await other.get(`/api/me/bookings/${b1.body.code}`)).status, 404);

  const cancel = await guest.post(`/api/me/bookings/${b1.body.code}/cancel`, { reason: 'Plans changed' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.booking.status, 'cancelled');
  assert.equal(cancel.body.refund_amount, b1.body.total_amount + b1.body.deposit);
  assert.equal(get('SELECT payment_status FROM bookings WHERE code = ?', b1.body.code)!.payment_status, 'refund_pending');
  // Bed is free again.
  const rebook = await other.post('/api/me/bookings', { ...payload, guest_name: 'Pooja Rao', guest_gender: 'female', idempotency_key: 'k3' });
  assert.equal(rebook.status, 201);
});

test('booking: gender policy enforcement', async () => {
  const guest = await new Client().login('customer@onedayhostels.in', 'Customer@123');
  const women = get("SELECT * FROM properties WHERE gender_policy = 'women' AND status = 'approved' LIMIT 1")!;
  const room = get('SELECT * FROM rooms WHERE property_id = ? LIMIT 1', women.id)!;
  const ci = addDays(today(), 50);
  const r = await guest.post('/api/me/bookings', { property_id: women.id, room_id: room.id, check_in: ci, check_out: addDays(ci, 1), guest_name: 'Demo', guest_phone: '9876543210', guest_gender: 'male', accept_policies: true });
  assert.equal(r.status, 400);

  const coed = get("SELECT * FROM properties WHERE slug = 'coastal-nest-luxury-pg'")!;
  const croom = get("SELECT * FROM rooms WHERE property_id = ? AND room_type = 'shared' LIMIT 1", coed.id)!;
  const b = await guest.post('/api/me/bookings', { property_id: coed.id, room_id: croom.id, check_in: ci, check_out: addDays(ci, 1), guest_name: 'Demo', guest_phone: '9876543210', accept_policies: true });
  assert.equal(b.status, 201);
  assert.equal(b.body.status, 'pending_payment');
});

test('owner: menus publish to property page, veg rules and copy without overwrite', async () => {
  const owner = await new Client().login('owner@onedayhostels.in', 'Owner@12345');
  const coastal = get("SELECT * FROM properties WHERE slug = 'coastal-nest-luxury-pg'")!;
  const scholars = get("SELECT * FROM properties WHERE slug = 'scholars-pride-residency'")!;
  const d = today();
  const save = await owner.put(`/api/owner/properties/${coastal.id}/menus/${d}`, {
    special_dish: 'Test Biryani Special',
    items: [
      { meal: 'breakfast', name: 'Idli', is_veg: true },
      { meal: 'lunch', name: 'Chicken Curry', is_veg: false },
      { meal: 'dinner', name: 'Phulka', is_veg: true },
    ],
    publish: true,
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  const pub = await new Client().get(`/api/public/properties/${coastal.slug}`);
  assert.equal(pub.body.menu.special_dish, 'Test Biryani Special');
  assert.equal(pub.body.menu.items.length, 3);

  const veg = await owner.put(`/api/owner/properties/${scholars.id}/menus/${d}`, { items: [{ meal: 'lunch', name: 'Fish Fry', is_veg: false }], publish: true });
  assert.equal(veg.status, 400);

  const target = addDays(d, 10);
  const other = addDays(d, 11);
  await owner.put(`/api/owner/properties/${coastal.id}/menus/${other}`, { items: [{ meal: 'lunch', name: 'Keep Me', is_veg: true }] });
  const copy = await owner.post(`/api/owner/properties/${coastal.id}/menus/copy`, { from_date: d, to_dates: [target, other] });
  assert.deepEqual(copy.body.results.map((r: any) => r.result), ['copied', 'skipped']);
  const kept = await owner.get(`/api/owner/properties/${coastal.id}/menus/${other}`);
  assert.equal(kept.body.items[0].name, 'Keep Me');
  const copied = await owner.get(`/api/owner/properties/${coastal.id}/menus/${target}`);
  assert.equal(copied.body.status, 'draft');

  // Owners cannot touch another owner's property.
  const foreign = get("SELECT id FROM properties WHERE owner_id != ? LIMIT 1", coastal.owner_id)!;
  assert.equal((await owner.get(`/api/owner/properties/${foreign.id}`)).status, 404);
  assert.equal((await owner.put(`/api/owner/properties/${foreign.id}/menus/${d}`, { items: [] })).status, 404);
});

test('owner: dashboard metrics come from data and check-in/out lifecycle enables reviews', async () => {
  const owner = await new Client().login('owner@onedayhostels.in', 'Owner@12345');
  const dash = await owner.get('/api/owner/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(dash.body.kpis.total_beds > 0);
  assert.equal(dash.body.series.length, 30);

  const guest = await new Client().login('customer@onedayhostels.in', 'Customer@123');
  const coastal = get("SELECT * FROM properties WHERE slug = 'coastal-nest-luxury-pg'")!;
  const room = get("SELECT * FROM rooms WHERE property_id = ? AND code = 'S1'", coastal.id)!;
  const bed = get('SELECT id FROM beds WHERE room_id = ?', room.id)!;
  // Free the bed today so the test is deterministic.
  run("UPDATE bookings SET status = 'cancelled' WHERE bed_id = ? AND check_out > ?", bed.id, today());
  const b = await guest.post('/api/me/bookings', { property_id: coastal.id, room_id: room.id, check_in: today(), check_out: addDays(today(), 1), guest_name: 'Demo', guest_phone: '9876543210', accept_policies: true });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const early = await guest.post(`/api/me/bookings/${b.body.code}/review`, { rating: 5, comment: 'Wonderful stay, very clean and safe place.' });
  assert.equal(early.status, 400);
  markPaid(b.body.code);
  assert.equal((await owner.post(`/api/owner/bookings/${b.body.id}/check-in`)).body.status, 'checked_in');
  assert.equal((await guest.post(`/api/me/bookings/${b.body.code}/cancel`, { reason: 'test' })).status, 400);
  assert.equal((await owner.post(`/api/owner/bookings/${b.body.id}/check-out`)).body.status, 'completed');
  const rv = await guest.post(`/api/me/bookings/${b.body.code}/review`, { rating: 5, comment: 'Wonderful stay, very clean and safe place.' });
  assert.equal(rv.status, 201);
  assert.equal((await guest.post(`/api/me/bookings/${b.body.code}/review`, { rating: 4, comment: 'Second review should be rejected here.' })).status, 400);
  const reply = await owner.post(`/api/owner/reviews/${rv.body.id}/reply`, { reply: 'Thanks!' });
  assert.equal(reply.status, 200);
});

test('admin: property approval workflow, permissions and audit log', async () => {
  const admin = await new Client().login('admin@onedayhostels.in', 'Admin@12345', 'admin');
  const finance = await new Client().login('finance@onedayhostels.in', 'Admin@12345', 'admin');
  const moderator = await new Client().login('moderator@onedayhostels.in', 'Admin@12345', 'admin');
  const p = get("SELECT * FROM properties WHERE status = 'pending_review' LIMIT 1")!;
  assert.equal((await admin.post(`/api/admin/properties/${p.id}/status`, { action: 'reject' })).status, 400, 'reason required');
  assert.equal((await finance.post(`/api/admin/properties/${p.id}/status`, { action: 'approve' })).status, 403);
  const ok = await moderator.post(`/api/admin/properties/${p.id}/status`, { action: 'approve' });
  assert.equal(ok.body.status, 'approved');
  assert.equal((await moderator.post(`/api/admin/properties/${p.id}/status`, { action: 'approve' })).status, 400);
  assert.equal((await new Client().get(`/api/public/properties/${p.slug}`)).status, 200);
  assert.equal((await moderator.get('/api/admin/payouts')).status, 403);
  assert.equal((await finance.get('/api/admin/payouts')).status, 200);
  const logs = await admin.get('/api/admin/audit?entity=property');
  assert.ok(logs.body.items.some((l: any) => l.action === 'property.approve' && l.entity_id === p.id));
  const dash = await admin.get('/api/admin/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(dash.body.kpis.properties.total >= 14);
});

test('documents are private to the owner and admins', async () => {
  const doc = get('SELECT d.id, p.owner_id FROM property_documents d JOIN properties p ON p.id = d.property_id LIMIT 1')!;
  const guest = await new Client().login('customer@onedayhostels.in', 'Customer@123');
  assert.equal((await guest.get(`/api/documents/${doc.id}`)).status, 403);
  assert.equal((await new Client().get(`/api/documents/${doc.id}`)).status, 401);
  const admin = await new Client().login('admin@onedayhostels.in', 'Admin@12345', 'admin');
  const res = await fetch(`${base}/api/documents/${doc.id}`, { headers: { Cookie: admin.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
});
