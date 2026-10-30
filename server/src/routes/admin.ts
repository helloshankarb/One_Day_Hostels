import { Router } from 'express';
import { z } from 'zod';
import { all, get, run, tx } from '../db/index.ts';
import { parse, notFound, badRequest, dateStr, id, bool, pageParams } from '../lib/http.ts';
import { requireRole, requirePermission as can, hashPassword } from '../lib/auth.ts';
import { audit, notify, sendEmail, emailTemplates, getSetting, setSetting } from '../lib/services.ts';
import { cancelBooking, recalcRating, syncRefundStatus, expireHolds } from '../lib/bookings.ts';
import { menuWithItems } from '../lib/catalog.ts';
import { todayIST, addDays, isValidDate, nowIso } from '../lib/dates.ts';

export const adminRouter = Router();
adminRouter.use(requireRole('admin'));

const like = (s: unknown) => `%${String(s ?? '').slice(0, 60)}%`;

// ---------- Dashboard ----------
adminRouter.get('/dashboard', (_req, res) => {
  expireHolds();
  const today = todayIST();
  const start = addDays(today, -29);
  const prevStart = addDays(start, -30);
  const commission = Number(getSetting('commission_percent', 10));
  const range = (from: string, to: string) =>
    get(
      `SELECT COUNT(*) bookings,
         COALESCE(SUM(CASE WHEN payment_status IN ('paid','partially_refunded','refund_pending','refunded') THEN total_amount END),0) gbv,
         COALESCE(SUM(CASE WHEN status IN ('confirmed','checked_in','completed') THEN commission_amount END),0) revenue
       FROM bookings WHERE status NOT IN ('expired','rejected') AND date(created_at) BETWEEN ? AND ?`,
      from, to,
    )!;
  const cur = range(start, today);
  const prev = range(prevStart, addDays(start, -1));
  const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : a ? 100 : 0);
  res.json({
    kpis: {
      properties: get(`SELECT COUNT(*) total, SUM(status = 'approved') approved, SUM(status = 'pending_review') pending, SUM(status = 'suspended') suspended, SUM(verified) verified FROM properties`),
      customers: get(`SELECT COUNT(*) total, SUM(date(created_at) >= ?) new_30d FROM users WHERE role = 'customer'`, start),
      owners: get(`SELECT COUNT(*) total, (SELECT COUNT(*) FROM owner_profiles WHERE kyc_status = 'submitted') kyc_pending FROM users WHERE role = 'owner'`),
      bookings: cur.bookings,
      bookings_change: pct(cur.bookings, prev.bookings),
      bookings_total: get<{ c: number }>("SELECT COUNT(*) c FROM bookings WHERE status NOT IN ('expired','rejected')")!.c,
      gbv: cur.gbv,
      gbv_change: pct(cur.gbv, prev.gbv),
      revenue: cur.revenue,
      revenue_change: pct(cur.revenue, prev.revenue),
      commission_percent: commission,
      refunds: get(`SELECT COALESCE(SUM(amount),0) amount, COUNT(*) n, SUM(status = 'pending') pending FROM refunds WHERE date(created_at) >= ?`, start),
      pending_payouts: get(`SELECT COALESCE(SUM(net_amount),0) amount, COUNT(*) n FROM payouts WHERE status IN ('pending','processing')`),
      open_tickets: get<{ c: number }>("SELECT COUNT(*) c FROM support_tickets WHERE status IN ('open','in_progress')")!.c,
      in_house: get<{ c: number }>("SELECT COUNT(*) c FROM bookings WHERE status = 'checked_in'")!.c,
      flagged_reviews: get<{ c: number }>("SELECT COUNT(*) c FROM review_reports WHERE status = 'open'")!.c,
    },
    series: all(
      `WITH RECURSIVE d(day) AS (SELECT ? UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < ?)
       SELECT day,
         (SELECT COUNT(*) FROM bookings b WHERE date(b.created_at) = day AND b.status NOT IN ('expired','rejected') AND b.stay_type = 'daily') daily,
         (SELECT COUNT(*) FROM bookings b WHERE date(b.created_at) = day AND b.status NOT IN ('expired','rejected') AND b.stay_type != 'daily') longstay,
         (SELECT COALESCE(SUM(total_amount),0) FROM bookings b WHERE date(b.created_at) = day AND b.payment_status IN ('paid','partially_refunded','refund_pending','refunded')) gbv,
         (SELECT COALESCE(SUM(commission_amount),0) FROM bookings b WHERE date(b.created_at) = day AND b.status IN ('confirmed','checked_in','completed')) revenue
       FROM d`,
      start, today,
    ),
    verification: all(`SELECT status, COUNT(*) c FROM properties GROUP BY status`),
    pending_properties: all(
      `SELECT p.id, p.name, p.gender_policy, p.food_type, p.submitted_at, p.status, l.name locality, u.name owner_name, op.kyc_status,
         (SELECT COUNT(*) FROM beds bd JOIN rooms r ON r.id = bd.room_id WHERE r.property_id = p.id) beds,
         (SELECT COUNT(*) FROM property_documents d WHERE d.property_id = p.id) docs
       FROM properties p JOIN localities l ON l.id = p.locality_id JOIN users u ON u.id = p.owner_id LEFT JOIN owner_profiles op ON op.user_id = u.id
       WHERE p.status = 'pending_review' ORDER BY p.submitted_at LIMIT 6`,
    ),
    recent_bookings: all(
      `SELECT b.id, b.code, b.guest_name, b.total_amount, b.status, b.payment_status, b.created_at, b.stay_type, p.name property_name
       FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.status != 'expired' ORDER BY b.created_at DESC LIMIT 8`,
    ),
    queue: {
      disputes: get<{ c: number }>("SELECT COUNT(*) c FROM disputes WHERE status = 'open'")!.c,
      menu_complaints: get<{ c: number }>("SELECT COUNT(*) c FROM support_tickets WHERE category = 'food' AND status IN ('open','in_progress')")!.c,
      kyc: get<{ c: number }>("SELECT COUNT(*) c FROM owner_profiles WHERE kyc_status = 'submitted'")!.c,
    },
    top_localities: all(
      `SELECT l.name, COUNT(b.id) bookings FROM bookings b JOIN properties p ON p.id = b.property_id JOIN localities l ON l.id = p.locality_id
       WHERE b.status IN ('confirmed','checked_in','completed') AND date(b.created_at) >= ? GROUP BY l.id ORDER BY bookings DESC LIMIT 5`,
      start,
    ),
  });
});

// ---------- Properties ----------
adminRouter.get('/properties', can('properties'), (req, res) => {
  const q = req.query as Record<string, string>;
  const where = ['1=1'];
  const params: any[] = [];
  if (q.status) {
    where.push('p.status = ?');
    params.push(q.status);
  }
  if (q.q) {
    where.push('(p.name LIKE ? OR u.name LIKE ? OR l.name LIKE ?)');
    params.push(like(q.q), like(q.q), like(q.q));
  }
  res.json(
    all(
      `SELECT p.id, p.name, p.slug, p.status, p.verified, p.gender_policy, p.food_type, p.accommodation_type, p.rating_avg, p.rating_count, p.submitted_at, p.created_at,
         l.name locality, u.name owner_name, u.email owner_email,
         (SELECT COUNT(*) FROM beds bd JOIN rooms r ON r.id = bd.room_id WHERE r.property_id = p.id AND bd.active = 1) beds,
         (SELECT COUNT(*) FROM bookings b WHERE b.property_id = p.id AND b.status IN ('confirmed','checked_in','completed')) bookings
       FROM properties p JOIN localities l ON l.id = p.locality_id JOIN users u ON u.id = p.owner_id
       WHERE ${where.join(' AND ')} ORDER BY CASE p.status WHEN 'pending_review' THEN 0 ELSE 1 END, p.updated_at DESC`,
      ...params,
    ),
  );
});

adminRouter.get('/properties/:id', can('properties'), (req, res) => {
  const p = get('SELECT p.*, l.name locality FROM properties p JOIN localities l ON l.id = p.locality_id WHERE p.id = ?', Number(req.params.id));
  if (!p) throw notFound('Property');
  res.json({
    ...p,
    owner: get(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at, op.business_name, op.pan, op.gstin, op.kyc_status, op.bank_account_last4, op.ifsc, op.upi_id
       FROM users u LEFT JOIN owner_profiles op ON op.user_id = u.id WHERE u.id = ?`,
      p.owner_id,
    ),
    photos: all('SELECT * FROM property_photos WHERE property_id = ? ORDER BY sort, id', p.id),
    amenities: all('SELECT a.name FROM property_amenities pa JOIN amenities a ON a.id = pa.amenity_id WHERE pa.property_id = ?', p.id).map((a) => a.name),
    documents: all('SELECT id, doc_type, original_name, mime_type, status, note, uploaded_at FROM property_documents WHERE property_id = ?', p.id),
    rooms: all(
      `SELECT r.*, (SELECT COUNT(*) FROM beds bd WHERE bd.room_id = r.id AND bd.active = 1) beds FROM rooms r WHERE r.property_id = ? ORDER BY r.code`,
      p.id,
    ),
    history: all('SELECT h.*, u.name actor FROM property_status_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.property_id = ? ORDER BY h.id DESC', p.id),
    recent_menus: all('SELECT menu_date, status, (SELECT COUNT(*) FROM menu_items WHERE menu_id = menus.id) items, (SELECT COUNT(*) FROM menu_items WHERE menu_id = menus.id AND is_veg = 0) nonveg FROM menus WHERE property_id = ? ORDER BY menu_date DESC LIMIT 7', p.id),
    stats: get(`SELECT COUNT(*) bookings, COALESCE(SUM(total_amount),0) gbv FROM bookings WHERE property_id = ? AND status IN ('confirmed','checked_in','completed')`, p.id),
  });
});

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  approve: { from: ['pending_review', 'changes_requested', 'rejected'], to: 'approved' },
  reject: { from: ['pending_review', 'changes_requested'], to: 'rejected' },
  request_changes: { from: ['pending_review'], to: 'changes_requested' },
  suspend: { from: ['approved', 'unpublished'], to: 'suspended' },
  reinstate: { from: ['suspended'], to: 'approved' },
};

adminRouter.post('/properties/:id/status', can('properties'), (req, res) => {
  const body = parse(z.object({ action: z.enum(['approve', 'reject', 'request_changes', 'suspend', 'reinstate']), reason: z.string().trim().max(1000).optional(), verified: z.boolean().optional() }), req.body);
  if (['reject', 'request_changes', 'suspend'].includes(body.action) && (!body.reason || body.reason.length < 5)) {
    throw badRequest('Please provide a reason for the owner', { reason: 'Reason is required' });
  }
  const p = get('SELECT * FROM properties WHERE id = ?', Number(req.params.id));
  if (!p) throw notFound('Property');
  const t = TRANSITIONS[body.action];
  if (!t.from.includes(p.status)) throw badRequest(`Cannot ${body.action.replace('_', ' ')} a listing that is ${p.status.replace('_', ' ')}`);
  tx(() => {
    run(
      `UPDATE properties SET status = ?, status_reason = ?, updated_at = ?,
         approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, ?) ELSE approved_at END,
         verified = CASE WHEN ? = 'approve' THEN ? ELSE verified END WHERE id = ?`,
      t.to, body.reason ?? null, nowIso(), t.to, nowIso(), body.action, body.verified === false ? 0 : 1, p.id,
    );
    run('INSERT INTO property_status_history (property_id, from_status, to_status, actor_id, reason) VALUES (?, ?, ?, ?, ?)', p.id, p.status, t.to, req.user!.id, body.reason ?? null);
    audit(req, `property.${body.action}`, 'property', p.id, { from: p.status, to: t.to, reason: body.reason });
    notify(p.owner_id, 'property', `${p.name}: ${t.to.replace('_', ' ')}`, body.reason ?? '', `/owner/properties/${p.id}`);
  });
  const owner = get('SELECT name, email FROM users WHERE id = ?', p.owner_id)!;
  sendEmail(owner.email, emailTemplates.propertyStatus(owner.name, p.name, t.to, body.reason));
  res.json({ status: t.to });
});

adminRouter.patch('/documents/:id', can('properties'), (req, res) => {
  const body = parse(z.object({ status: z.enum(['verified', 'rejected', 'pending']), note: z.string().trim().max(300).optional() }), req.body);
  const d = get('SELECT * FROM property_documents WHERE id = ?', Number(req.params.id));
  if (!d) throw notFound('Document');
  run('UPDATE property_documents SET status = ?, note = ? WHERE id = ?', body.status, body.note ?? null, d.id);
  audit(req, 'document.review', 'property', d.property_id, { document: d.id, status: body.status });
  res.json({ ok: true });
});

// ---------- Owners & customers ----------
adminRouter.get('/owners', can('owners'), (req, res) => {
  const q = req.query as Record<string, string>;
  res.json(
    all(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at, u.email_verified, op.business_name, op.kyc_status, op.pan, op.gstin, op.bank_account_last4, op.ifsc, op.upi_id, op.kyc_note,
         (SELECT COUNT(*) FROM properties p WHERE p.owner_id = u.id) properties,
         (SELECT COUNT(*) FROM properties p WHERE p.owner_id = u.id AND p.status = 'approved') live
       FROM users u LEFT JOIN owner_profiles op ON op.user_id = u.id WHERE u.role = 'owner' ${q.kyc ? 'AND op.kyc_status = ?' : ''} ${q.q ? 'AND (u.name LIKE ? OR u.email LIKE ? OR op.business_name LIKE ?)' : ''}
       ORDER BY CASE op.kyc_status WHEN 'submitted' THEN 0 ELSE 1 END, u.created_at DESC`,
      ...[q.kyc, ...(q.q ? [like(q.q), like(q.q), like(q.q)] : [])].filter((x) => x !== undefined && x !== ''),
    ),
  );
});

adminRouter.post('/owners/:id/kyc', can('owners'), (req, res) => {
  const body = parse(z.object({ status: z.enum(['verified', 'rejected']), note: z.string().trim().max(300).optional() }), req.body);
  const o = get("SELECT * FROM owner_profiles WHERE user_id = ?", Number(req.params.id));
  if (!o) throw notFound('Owner');
  run('UPDATE owner_profiles SET kyc_status = ?, kyc_note = ? WHERE user_id = ?', body.status, body.note ?? null, o.user_id);
  audit(req, `owner.kyc_${body.status}`, 'user', o.user_id, { note: body.note });
  notify(o.user_id, 'account', body.status === 'verified' ? 'Your owner KYC is verified' : 'KYC needs attention', body.note ?? '', '/owner/settings');
  res.json({ ok: true });
});

adminRouter.post('/users/:id/status', (req, res, next) => {
  const target = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!target) throw notFound('User');
  const perm = target.role === 'owner' ? 'owners' : target.role === 'customer' ? 'customers' : 'users';
  can(perm)(req, res, (err?: unknown) => {
    if (err) return next(err);
    const { status, reason } = parse(z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().max(300).optional() }), req.body);
    if (target.id === req.user!.id) throw badRequest('You cannot change your own status');
    tx(() => {
      run('UPDATE users SET status = ? WHERE id = ?', status, target.id);
      if (status === 'suspended') run('DELETE FROM sessions WHERE user_id = ?', target.id);
      audit(req, `user.${status === 'active' ? 'reactivate' : 'suspend'}`, 'user', target.id, { reason });
    });
    res.json({ ok: true });
  });
});

adminRouter.get('/customers', can('customers'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query);
  const q = req.query.q ? String(req.query.q) : null;
  const where = `u.role = 'customer' ${q ? 'AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)' : ''}`;
  const params = q ? [like(q), like(q), like(q)] : [];
  res.json({
    total: get<{ c: number }>(`SELECT COUNT(*) c FROM users u WHERE ${where}`, ...params)!.c,
    page,
    pageSize,
    items: all(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.email_verified, u.created_at, u.last_login_at,
         (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = u.id AND b.status IN ('confirmed','checked_in','completed')) bookings,
         (SELECT COALESCE(SUM(total_amount),0) FROM bookings b WHERE b.customer_id = u.id AND b.payment_status IN ('paid','partially_refunded')) spent
       FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      ...params, pageSize, offset,
    ),
  });
});

adminRouter.get('/customers/:id', can('customers'), (req, res) => {
  const u = get("SELECT id, name, email, phone, status, gender, city, email_verified, created_at, last_login_at FROM users WHERE id = ? AND role = 'customer'", Number(req.params.id));
  if (!u) throw notFound('Customer');
  res.json({
    ...u,
    bookings: all('SELECT b.id, b.code, b.check_in, b.check_out, b.status, b.payment_status, b.total_amount, p.name property_name FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.customer_id = ? ORDER BY b.id DESC', u.id),
    reviews: all('SELECT r.id, r.rating, r.comment, r.status, p.name property_name FROM reviews r JOIN properties p ON p.id = r.property_id WHERE r.customer_id = ?', u.id),
    tickets: all('SELECT id, subject, status, created_at FROM support_tickets WHERE user_id = ?', u.id),
  });
});

// ---------- Bookings ----------
adminRouter.get('/bookings', can('bookings'), (req, res) => {
  expireHolds();
  const q = req.query as Record<string, string>;
  const { page, pageSize, offset } = pageParams(q);
  const where = ['1=1'];
  const params: any[] = [];
  if (q.status) {
    where.push('b.status = ?');
    params.push(q.status);
  }
  if (q.payment_status) {
    where.push('b.payment_status = ?');
    params.push(q.payment_status);
  }
  if (q.q) {
    where.push('(b.code LIKE ? OR b.guest_name LIKE ? OR p.name LIKE ?)');
    params.push(like(q.q), like(q.q), like(q.q));
  }
  if (isValidDate(q.from ?? '')) {
    where.push('b.check_in >= ?');
    params.push(q.from);
  }
  if (isValidDate(q.to ?? '')) {
    where.push('b.check_in <= ?');
    params.push(q.to);
  }
  const base = `FROM bookings b JOIN properties p ON p.id = b.property_id JOIN users u ON u.id = b.customer_id WHERE ${where.join(' AND ')}`;
  res.json({
    total: get<{ c: number }>(`SELECT COUNT(*) c ${base}`, ...params)!.c,
    page,
    pageSize,
    items: all(`SELECT b.*, p.name property_name, u.email customer_email ${base} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`, ...params, pageSize, offset),
  });
});

adminRouter.get('/bookings/:id', can('bookings'), (req, res) => {
  const b = get(
    `SELECT b.*, p.name property_name, p.cancellation_policy, r.name room_name, bd.label bed_label, u.name customer_name, u.email customer_email, o.name owner_name
     FROM bookings b JOIN properties p ON p.id = b.property_id JOIN rooms r ON r.id = b.room_id JOIN beds bd ON bd.id = b.bed_id
     JOIN users u ON u.id = b.customer_id JOIN users o ON o.id = p.owner_id WHERE b.id = ?`,
    Number(req.params.id),
  );
  if (!b) throw notFound('Booking');
  res.json({
    ...b,
    payments: all('SELECT * FROM payments WHERE booking_id = ?', b.id),
    refunds: all('SELECT * FROM refunds WHERE booking_id = ?', b.id),
    disputes: all('SELECT * FROM disputes WHERE booking_id = ?', b.id),
    audit: all("SELECT a.*, u.name actor FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE entity_type = 'booking' AND entity_id = ? ORDER BY a.id DESC", b.id),
  });
});

adminRouter.post('/bookings/:id/cancel', can('bookings'), async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().min(5).max(500), refund_amount: z.number().int().min(0).optional() }), req.body);
  if (body.refund_amount !== undefined && !(req.user!.admin_role === 'super_admin' || req.user!.admin_role === 'finance')) {
    throw badRequest('Only finance administrators can override refund amounts');
  }
  const bid = Number(req.params.id);
  const r = await cancelBooking(bid, 'admin', req.user!.id, body.reason, body.refund_amount);
  audit(req, 'booking.admin_cancel', 'booking', bid, body);
  res.json(r);
});

// ---------- Payments, refunds, disputes ----------
adminRouter.get('/payments', can('payments'), (req, res) => {
  const q = req.query as Record<string, string>;
  const { page, pageSize, offset } = pageParams(q);
  const where = q.status ? 'WHERE pm.status = ?' : '';
  const params = q.status ? [q.status] : [];
  res.json({
    summary: get(
      `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END),0) captured, SUM(status = 'paid') paid, SUM(status = 'failed') failed,
         SUM(status IN ('created','pending')) pending FROM payments`,
    ),
    total: get<{ c: number }>(`SELECT COUNT(*) c FROM payments pm ${where}`, ...params)!.c,
    page,
    pageSize,
    items: all(
      `SELECT pm.*, b.code booking_code, b.commission_amount, b.deposit, p.name property_name, u.name customer_name
       FROM payments pm JOIN bookings b ON b.id = pm.booking_id JOIN properties p ON p.id = b.property_id JOIN users u ON u.id = b.customer_id
       ${where} ORDER BY pm.id DESC LIMIT ? OFFSET ?`,
      ...params, pageSize, offset,
    ),
  });
});

adminRouter.get('/refunds', can('refunds'), (_req, res) => {
  res.json(
    all(
      `SELECT r.*, b.code booking_code, b.guest_name, p.name property_name, pm.provider_payment_id, u.name initiated_by_name
       FROM refunds r JOIN bookings b ON b.id = r.booking_id JOIN properties p ON p.id = b.property_id
       LEFT JOIN payments pm ON pm.id = r.payment_id LEFT JOIN users u ON u.id = r.initiated_by ORDER BY r.id DESC LIMIT 300`,
    ),
  );
});

adminRouter.post('/refunds/:id/mark-processed', can('refunds'), (req, res) => {
  const { reference } = parse(z.object({ reference: z.string().trim().min(3).max(80) }), req.body);
  const r = get('SELECT * FROM refunds WHERE id = ?', Number(req.params.id));
  if (!r) throw notFound('Refund');
  tx(() => {
    run("UPDATE refunds SET status = 'processed', provider_refund_id = COALESCE(provider_refund_id, ?), processed_at = ? WHERE id = ?", reference, nowIso(), r.id);
    syncRefundStatus(r.booking_id);
    audit(req, 'refund.manual_processed', 'booking', r.booking_id, { refund: r.id, reference });
  });
  res.json({ ok: true });
});

adminRouter.get('/disputes', can('payments'), (_req, res) => {
  res.json(all('SELECT d.*, b.code booking_code, u.name raised_by_name FROM disputes d JOIN bookings b ON b.id = d.booking_id JOIN users u ON u.id = d.raised_by ORDER BY d.id DESC'));
});
adminRouter.post('/disputes/:id', can('payments'), (req, res) => {
  const body = parse(z.object({ status: z.enum(['resolved', 'rejected']), resolution: z.string().trim().min(3).max(1000) }), req.body);
  run('UPDATE disputes SET status = ?, resolution = ? WHERE id = ?', body.status, body.resolution, Number(req.params.id));
  audit(req, 'dispute.' + body.status, 'dispute', Number(req.params.id), body);
  res.json({ ok: true });
});

// ---------- Payouts & commissions ----------
adminRouter.get('/payouts', can('payouts'), (_req, res) => {
  res.json({
    items: all('SELECT po.*, u.name owner_name, op.business_name, op.bank_account_last4, op.ifsc, op.upi_id FROM payouts po JOIN users u ON u.id = po.owner_id LEFT JOIN owner_profiles op ON op.user_id = u.id ORDER BY po.id DESC'),
    unsettled: all(
      `SELECT u.id owner_id, u.name owner_name, COUNT(b.id) bookings, SUM(b.total_amount) gross, SUM(b.commission_amount) commission
       FROM bookings b JOIN properties p ON p.id = b.property_id JOIN users u ON u.id = p.owner_id
       WHERE b.status = 'completed' AND b.payment_status IN ('paid','partially_refunded') AND NOT EXISTS (SELECT 1 FROM payout_items pi WHERE pi.booking_id = b.id)
       GROUP BY u.id`,
    ),
  });
});

/** Settles completed, paid stays that are not yet part of a payout. Net = stay charges − commission − refunds (deposits are returned to guests, not settled). */
adminRouter.post('/payouts/generate', can('payouts'), (req, res) => {
  const body = parse(z.object({ period_start: dateStr, period_end: dateStr }), req.body);
  if (body.period_end < body.period_start) throw badRequest('Invalid period');
  const created = tx(() => {
    const rows = all(
      `SELECT b.id, b.total_amount, b.commission_amount, p.owner_id,
         (SELECT COALESCE(SUM(amount),0) FROM refunds r WHERE r.booking_id = b.id AND r.status != 'failed') - b.deposit refunded
       FROM bookings b JOIN properties p ON p.id = b.property_id
       WHERE b.status = 'completed' AND b.payment_status IN ('paid','partially_refunded') AND b.check_out BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM payout_items pi WHERE pi.booking_id = b.id)`,
      body.period_start, body.period_end,
    );
    const byOwner = new Map<number, typeof rows>();
    rows.forEach((r) => byOwner.set(r.owner_id, [...(byOwner.get(r.owner_id) ?? []), r]));
    const ids: number[] = [];
    for (const [ownerId, list] of byOwner) {
      const gross = list.reduce((s, r) => s + r.total_amount, 0);
      const commission = list.reduce((s, r) => s + r.commission_amount, 0);
      const refunds = list.reduce((s, r) => s + Math.max(0, r.refunded), 0);
      const pid = run(
        'INSERT INTO payouts (owner_id, period_start, period_end, gross_amount, commission_amount, refund_adjustment, net_amount, booking_count) VALUES (?,?,?,?,?,?,?,?)',
        ownerId, body.period_start, body.period_end, gross, commission, refunds, gross - commission - refunds, list.length,
      ).id;
      list.forEach((r) => run('INSERT INTO payout_items (payout_id, booking_id) VALUES (?, ?)', pid, r.id));
      notify(ownerId, 'payout', 'New payout scheduled', `₹${gross - commission - refunds} for ${list.length} stays`, '/owner/earnings');
      ids.push(pid);
    }
    audit(req, 'payout.generate', 'payout', null, { ...body, payouts: ids });
    return ids.length;
  });
  res.json({ created });
});

adminRouter.post('/payouts/:id/status', can('payouts'), (req, res) => {
  const body = parse(z.object({ status: z.enum(['processing', 'paid', 'on_hold', 'pending']), reference: z.string().trim().max(80).optional() }), req.body);
  if (body.status === 'paid' && !body.reference) throw badRequest('Enter the bank/UTR reference', { reference: 'Required' });
  const po = get('SELECT * FROM payouts WHERE id = ?', Number(req.params.id));
  if (!po) throw notFound('Payout');
  if (po.status === 'paid') throw badRequest('Paid payouts cannot be changed');
  run('UPDATE payouts SET status = ?, reference = COALESCE(?, reference), paid_at = CASE WHEN ? = \'paid\' THEN ? ELSE paid_at END WHERE id = ?', body.status, body.reference ?? null, body.status, nowIso(), po.id);
  audit(req, `payout.${body.status}`, 'payout', po.id, body);
  if (body.status === 'paid') notify(po.owner_id, 'payout', 'Payout sent', `₹${po.net_amount} • Ref ${body.reference}`, '/owner/earnings');
  res.json({ ok: true });
});

adminRouter.get('/commissions', can('payments'), (_req, res) => {
  res.json({
    commission_percent: getSetting('commission_percent', 10),
    gst_percent: getSetting('gst_percent', 5),
    monthly: all(
      `SELECT strftime('%Y-%m', created_at) month, COUNT(*) bookings, SUM(total_amount) gbv, SUM(commission_amount) commission
       FROM bookings WHERE status IN ('confirmed','checked_in','completed') GROUP BY month ORDER BY month DESC LIMIT 12`,
    ),
    by_owner: all(
      `SELECT u.name owner_name, COUNT(b.id) bookings, SUM(b.total_amount) gbv, SUM(b.commission_amount) commission
       FROM bookings b JOIN properties p ON p.id = b.property_id JOIN users u ON u.id = p.owner_id
       WHERE b.status IN ('confirmed','checked_in','completed') GROUP BY u.id ORDER BY commission DESC`,
    ),
  });
});

// ---------- Reviews ----------
adminRouter.get('/reviews', can('reviews'), (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  res.json({
    items: all(
      `SELECT r.*, u.name customer_name, p.name property_name, (SELECT COUNT(*) FROM review_reports rr WHERE rr.review_id = r.id AND rr.status = 'open') open_reports
       FROM reviews r JOIN users u ON u.id = r.customer_id JOIN properties p ON p.id = r.property_id
       ${status ? 'WHERE r.status = ?' : ''} ORDER BY open_reports DESC, r.id DESC LIMIT 300`,
      ...(status ? [status] : []),
    ),
    reports: all(
      `SELECT rr.*, u.name reporter_name, u.role reporter_role, r.comment, r.rating, p.name property_name FROM review_reports rr
       JOIN users u ON u.id = rr.reporter_id JOIN reviews r ON r.id = rr.review_id JOIN properties p ON p.id = r.property_id
       WHERE rr.status = 'open' ORDER BY rr.id DESC`,
    ),
  });
});
adminRouter.post('/reviews/:id/moderate', can('reviews'), (req, res) => {
  const body = parse(z.object({ status: z.enum(['published', 'hidden', 'flagged']), note: z.string().trim().max(300).optional() }), req.body);
  const r = get('SELECT * FROM reviews WHERE id = ?', Number(req.params.id));
  if (!r) throw notFound('Review');
  tx(() => {
    run('UPDATE reviews SET status = ?, moderation_note = ? WHERE id = ?', body.status, body.note ?? null, r.id);
    run(`UPDATE review_reports SET status = ? WHERE review_id = ? AND status = 'open'`, body.status === 'hidden' ? 'actioned' : 'dismissed', r.id);
    recalcRating(r.property_id);
    audit(req, `review.${body.status}`, 'review', r.id, body);
  });
  res.json({ ok: true });
});

// ---------- Menu compliance ----------
adminRouter.get('/menu-compliance', can('menus'), (req, res) => {
  const date = isValidDate(String(req.query.date ?? '')) ? String(req.query.date) : todayIST();
  const rows = all(
    `SELECT p.id, p.name, p.food_type, l.name locality, u.name owner_name, m.id menu_id, m.status, m.updated_at, m.published_at,
       (SELECT COUNT(*) FROM menu_items mi WHERE mi.menu_id = m.id) items,
       (SELECT COUNT(*) FROM menu_items mi WHERE mi.menu_id = m.id AND mi.is_veg = 0) nonveg_items,
       (SELECT COUNT(DISTINCT meal) FROM menu_items mi WHERE mi.menu_id = m.id) meals
     FROM properties p JOIN localities l ON l.id = p.locality_id JOIN users u ON u.id = p.owner_id
     LEFT JOIN menus m ON m.property_id = p.id AND m.menu_date = ?
     WHERE p.status = 'approved' AND p.food_type != 'none' ORDER BY p.name`,
    date,
  );
  const items = rows.map((r) => {
    const issues: string[] = [];
    if (!r.menu_id) issues.push('No menu for this date');
    else if (r.status !== 'published') issues.push('Menu not published');
    else if (r.meals < 3) issues.push(`Only ${r.meals} of 3 meals listed`);
    if (['pure_veg', 'veg_meals'].includes(r.food_type) && r.nonveg_items > 0) issues.push('Non-veg dish on a vegetarian-only property');
    return { ...r, issues, compliant: issues.length === 0 };
  });
  res.json({ date, items, summary: { total: items.length, compliant: items.filter((i) => i.compliant).length } });
});
adminRouter.get('/menus/:id', can('menus'), (req, res) => {
  res.json(menuWithItems(get('SELECT * FROM menus WHERE id = ?', Number(req.params.id))));
});
adminRouter.post('/menu-compliance/:propertyId/remind', can('menus'), (req, res) => {
  const p = get('SELECT * FROM properties WHERE id = ?', Number(req.params.propertyId));
  if (!p) throw notFound('Property');
  notify(p.owner_id, 'menu', `Please publish today's menu for ${p.name}`, 'Guests check menus before booking.', '/owner/menu/today');
  audit(req, 'menu.remind', 'property', p.id);
  res.json({ ok: true });
});

// ---------- Analytics ----------
adminRouter.get('/analytics', can('analytics'), (_req, res) => {
  const ok = "b.status IN ('confirmed','checked_in','completed')";
  res.json({
    monthly: all(`SELECT strftime('%Y-%m', b.created_at) month, COUNT(*) bookings, SUM(b.total_amount) gbv, SUM(b.commission_amount) commission FROM bookings b WHERE ${ok} GROUP BY month ORDER BY month DESC LIMIT 12`).reverse(),
    by_locality: all(`SELECT l.name label, COUNT(b.id) c, COALESCE(SUM(b.total_amount),0) gbv FROM localities l LEFT JOIN properties p ON p.locality_id = l.id LEFT JOIN bookings b ON b.property_id = p.id AND ${ok} GROUP BY l.id ORDER BY c DESC`),
    by_stay_type: all(`SELECT stay_type label, COUNT(*) c FROM bookings b WHERE ${ok} GROUP BY stay_type`),
    by_gender: all(`SELECT p.gender_policy label, COUNT(b.id) c FROM bookings b JOIN properties p ON p.id = b.property_id WHERE ${ok} GROUP BY p.gender_policy`),
    by_food: all(`SELECT p.food_type label, COUNT(b.id) c FROM bookings b JOIN properties p ON p.id = b.property_id WHERE ${ok} GROUP BY p.food_type`),
    signups: all(`SELECT strftime('%Y-%m', created_at) month, SUM(role = 'customer') customers, SUM(role = 'owner') owners FROM users GROUP BY month ORDER BY month DESC LIMIT 12`).reverse(),
    funnel: get(
      `SELECT COUNT(*) started, SUM(status IN ('confirmed','checked_in','completed','cancelled')) paid, SUM(status = 'completed') completed, SUM(status = 'cancelled') cancelled, SUM(status = 'expired') abandoned FROM bookings`,
    ),
  });
});

// ---------- Promotions ----------
adminRouter.get('/coupons', can('promotions'), (_req, res) => {
  res.json(all('SELECT c.*, p.name property_name FROM coupons c LEFT JOIN properties p ON p.id = c.property_id ORDER BY c.id DESC'));
});
adminRouter.post('/coupons', can('promotions'), (req, res) => {
  const body = parse(
    z.object({
      code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4,20}$/, '4–20 letters or digits'),
      description: z.string().trim().max(200).optional(),
      discount_type: z.enum(['percent', 'flat']),
      value: z.number().int().min(1),
      max_discount: z.number().int().min(1).nullable().optional(),
      min_amount: z.number().int().min(0).default(0),
      valid_from: dateStr,
      valid_to: dateStr,
      usage_limit: z.number().int().min(1).nullable().optional(),
    }),
    req.body,
  );
  if (body.discount_type === 'percent' && body.value > 75) throw badRequest('Percentage discounts are capped at 75%');
  const cid = run(
    'INSERT INTO coupons (code, description, discount_type, value, max_discount, min_amount, valid_from, valid_to, usage_limit, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
    body.code, body.description ?? null, body.discount_type, body.value, body.max_discount ?? null, body.min_amount, body.valid_from, body.valid_to, body.usage_limit ?? null, req.user!.id,
  ).id;
  audit(req, 'coupon.create', 'coupon', cid, body);
  res.status(201).json(get('SELECT * FROM coupons WHERE id = ?', cid));
});
adminRouter.patch('/coupons/:id', can('promotions'), (req, res) => {
  const body = parse(z.object({ active: bool }), req.body);
  run('UPDATE coupons SET active = ? WHERE id = ?', body.active, Number(req.params.id));
  audit(req, 'coupon.update', 'coupon', Number(req.params.id), body);
  res.json({ ok: true });
});

// ---------- Support ----------
adminRouter.get('/tickets', can('support'), (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  res.json(
    all(
      `SELECT t.*, u.name user_name, u.role user_role, a.name assignee, p.name property_name, b.code booking_code,
         (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) messages
       FROM support_tickets t JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.assigned_to
       LEFT JOIN properties p ON p.id = t.property_id LEFT JOIN bookings b ON b.id = t.booking_id
       ${status ? 'WHERE t.status = ?' : ''} ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
         CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC`,
      ...(status ? [status] : []),
    ),
  );
});
adminRouter.post('/tickets/:id', can('support'), (req, res) => {
  const body = parse(z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), assign_to_me: z.boolean().optional() }), req.body);
  const t = get('SELECT * FROM support_tickets WHERE id = ?', Number(req.params.id));
  if (!t) throw notFound('Ticket');
  run('UPDATE support_tickets SET status = ?, priority = ?, assigned_to = ?, updated_at = ? WHERE id = ?', body.status ?? t.status, body.priority ?? t.priority, body.assign_to_me ? req.user!.id : t.assigned_to, nowIso(), t.id);
  if (body.status && body.status !== t.status) {
    const role = get('SELECT role FROM users WHERE id = ?', t.user_id)!.role;
    notify(t.user_id, 'support', `Ticket #${t.id} is ${body.status.replace('_', ' ')}`, t.subject, `${role === 'owner' ? '/owner' : '/account'}/support?ticket=${t.id}`);
  }
  audit(req, 'ticket.update', 'ticket', t.id, body);
  res.json({ ok: true });
});

// ---------- Localities & amenities ----------
adminRouter.get('/localities', (_req, res) => {
  res.json(all('SELECT l.*, (SELECT COUNT(*) FROM properties p WHERE p.locality_id = l.id) properties FROM localities l ORDER BY l.sort, l.name'));
});
adminRouter.post('/localities', can('settings'), (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(60), tagline: z.string().trim().max(120).optional(), sort: z.number().int().default(0) }), req.body);
  const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const lid = run('INSERT INTO localities (name, slug, tagline, sort) VALUES (?, ?, ?, ?)', body.name, slug, body.tagline ?? null, body.sort).id;
  audit(req, 'locality.create', 'locality', lid, body);
  res.status(201).json({ id: lid });
});
adminRouter.patch('/localities/:id', can('settings'), (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(60).optional(), tagline: z.string().trim().max(120).optional(), active: bool.optional(), sort: z.number().int().optional() }), req.body);
  const l = get('SELECT * FROM localities WHERE id = ?', Number(req.params.id));
  if (!l) throw notFound('Locality');
  run('UPDATE localities SET name = ?, tagline = ?, active = ?, sort = ? WHERE id = ?', body.name ?? l.name, body.tagline ?? l.tagline, body.active ?? l.active, body.sort ?? l.sort, l.id);
  audit(req, 'locality.update', 'locality', l.id, body);
  res.json({ ok: true });
});
adminRouter.post('/amenities', can('settings'), (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(60), icon: z.string().trim().max(40).default('check'), category: z.string().trim().max(40).default('general') }), req.body);
  const aid = run('INSERT INTO amenities (name, icon, category) VALUES (?, ?, ?)', body.name, body.icon, body.category).id;
  audit(req, 'amenity.create', 'amenity', aid, body);
  res.status(201).json({ id: aid });
});

// ---------- Settings ----------
const SETTINGS = {
  commission_percent: z.number().min(0).max(40),
  gst_percent: z.number().min(0).max(28),
  support_phone: z.string().max(20),
  support_email: z.email(),
  booking_hold_minutes: z.number().int().min(5).max(60),
  maintenance_banner: z.string().max(200),
};
adminRouter.get('/settings', can('settings'), (_req, res) => {
  res.json({
    commission_percent: getSetting('commission_percent', 10),
    gst_percent: getSetting('gst_percent', 5),
    support_phone: getSetting('support_phone', '1800-123-4567'),
    support_email: getSetting('support_email', 'support@onedayhostels.in'),
    booking_hold_minutes: getSetting('booking_hold_minutes', 15),
    maintenance_banner: getSetting('maintenance_banner', ''),
  });
});
adminRouter.put('/settings', can('settings'), (req, res) => {
  const body = parse(z.object(SETTINGS).partial(), req.body);
  tx(() => {
    for (const [k, v] of Object.entries(body)) setSetting(k, v);
    audit(req, 'settings.update', 'settings', null, body);
  });
  res.json({ ok: true });
});

// ---------- Admin users & roles ----------
adminRouter.get('/admins', can('users'), (_req, res) => {
  res.json(all("SELECT id, name, email, admin_role, status, created_at, last_login_at FROM users WHERE role = 'admin' ORDER BY id"));
});
adminRouter.post('/admins', can('users'), (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(80),
      email: z.email().trim().toLowerCase(),
      admin_role: z.enum(['super_admin', 'finance', 'moderator', 'support']),
      password: z.string().min(10, 'Use at least 10 characters').max(128),
    }),
    req.body,
  );
  const aid = run("INSERT INTO users (role, admin_role, name, email, password_hash, email_verified) VALUES ('admin', ?, ?, ?, ?, 1)", body.admin_role, body.name, body.email, hashPassword(body.password)).id;
  audit(req, 'admin.create', 'user', aid, { email: body.email, admin_role: body.admin_role });
  res.status(201).json({ id: aid });
});
adminRouter.patch('/admins/:id', can('users'), (req, res) => {
  const body = parse(z.object({ admin_role: z.enum(['super_admin', 'finance', 'moderator', 'support']).optional(), status: z.enum(['active', 'suspended']).optional() }), req.body);
  const a = get("SELECT * FROM users WHERE id = ? AND role = 'admin'", Number(req.params.id));
  if (!a) throw notFound('Admin');
  if (a.id === req.user!.id) throw badRequest('You cannot change your own role or status');
  if (a.admin_role === 'super_admin' && (body.admin_role && body.admin_role !== 'super_admin' || body.status === 'suspended')) {
    const supers = get<{ c: number }>("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND admin_role = 'super_admin' AND status = 'active'")!.c;
    if (supers <= 1) throw badRequest('At least one active super admin is required');
  }
  tx(() => {
    run('UPDATE users SET admin_role = ?, status = ? WHERE id = ?', body.admin_role ?? a.admin_role, body.status ?? a.status, a.id);
    if (body.status === 'suspended') run('DELETE FROM sessions WHERE user_id = ?', a.id);
    audit(req, 'admin.update', 'user', a.id, body);
  });
  res.json({ ok: true });
});

// ---------- Audit log ----------
adminRouter.get('/audit', can('audit'), (req, res) => {
  const q = req.query as Record<string, string>;
  const { page, pageSize, offset } = pageParams({ ...q, pageSize: q.pageSize ?? 50 });
  const where: string[] = ['1=1'];
  const params: any[] = [];
  if (q.entity) {
    where.push('a.entity_type = ?');
    params.push(q.entity);
  }
  if (q.action) {
    where.push('a.action LIKE ?');
    params.push(like(q.action));
  }
  res.json({
    total: get<{ c: number }>(`SELECT COUNT(*) c FROM audit_logs a WHERE ${where.join(' AND ')}`, ...params)!.c,
    page,
    pageSize,
    items: all(`SELECT a.*, u.name actor, u.role actor_role FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, offset),
  });
});

adminRouter.get('/contact-messages', can('support'), (_req, res) => {
  res.json(all('SELECT * FROM contact_messages ORDER BY id DESC LIMIT 200'));
});

export { id };
