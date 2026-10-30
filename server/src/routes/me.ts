import { Router } from 'express';
import { z } from 'zod';
import { all, get, run, tx } from '../db/index.ts';
import { parse, notFound, badRequest, forbidden, dateStr, id } from '../lib/http.ts';
import { requireAuth, requireRole } from '../lib/auth.ts';
import { createBooking, cancelBooking, recalcRating, expireHolds } from '../lib/bookings.ts';
import { refundFor, POLICY_TEXT, type CancellationPolicy } from '../lib/pricing.ts';
import { propertyCards, PROPERTY_SELECT } from '../lib/catalog.ts';
import { todayIST } from '../lib/dates.ts';
import { notify, notifyAdmins } from '../lib/services.ts';

export const meRouter = Router();
meRouter.use(requireAuth);

// ---------- Notifications (all roles) ----------
meRouter.get('/notifications', (req, res) => {
  res.json(all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user!.id));
});
meRouter.post('/notifications/read-all', (req, res) => {
  run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', new Date().toISOString(), req.user!.id);
  res.json({ ok: true });
});
meRouter.post('/notifications/:id/read', (req, res) => {
  run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?', new Date().toISOString(), Number(req.params.id), req.user!.id);
  res.json({ ok: true });
});

// ---------- Support tickets (customers & owners) ----------
meRouter.get('/tickets', (req, res) => {
  res.json(
    all(
      `SELECT t.*, p.name property_name, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) messages
       FROM support_tickets t LEFT JOIN properties p ON p.id = t.property_id WHERE t.user_id = ? ORDER BY t.updated_at DESC`,
      req.user!.id,
    ),
  );
});
meRouter.post('/tickets', (req, res) => {
  const body = parse(
    z.object({
      subject: z.string().trim().min(4, 'Add a short subject').max(140),
      category: z.enum(['booking', 'payment', 'refund', 'property', 'food', 'safety', 'account', 'general']).default('general'),
      message: z.string().trim().min(10, 'Describe the issue in at least 10 characters').max(4000),
      booking_code: z.string().max(20).optional().nullable(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    }),
    req.body,
  );
  let bookingId: number | null = null;
  let propertyId: number | null = null;
  if (body.booking_code) {
    const b = get(
      'SELECT b.id, b.property_id FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.code = ? AND (b.customer_id = ? OR p.owner_id = ?)',
      body.booking_code, req.user!.id, req.user!.id,
    );
    if (!b) throw badRequest('Booking reference not found on your account');
    bookingId = b.id;
    propertyId = b.property_id;
  }
  const ticketId = tx(() => {
    const t = run('INSERT INTO support_tickets (user_id, property_id, booking_id, subject, category, priority) VALUES (?, ?, ?, ?, ?, ?)', req.user!.id, propertyId, bookingId, body.subject, body.category, body.priority).id;
    run('INSERT INTO ticket_messages (ticket_id, user_id, body) VALUES (?, ?, ?)', t, req.user!.id, body.message);
    notifyAdmins('support', `New ticket #${t}: ${body.subject}`, body.category, `/admin/support/${t}`);
    return t;
  });
  res.status(201).json({ id: ticketId });
});
function ticketFor(ticketId: number, user: Express.Request['user']) {
  const t = get('SELECT * FROM support_tickets WHERE id = ?', ticketId);
  if (!t) throw notFound('Ticket');
  if (t.user_id !== user!.id && user!.role !== 'admin') throw forbidden();
  return t;
}
meRouter.get('/tickets/:id', (req, res) => {
  const t = ticketFor(Number(req.params.id), req.user);
  const messages = all('SELECT m.*, u.name, u.role FROM ticket_messages m JOIN users u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id', t.id);
  res.json({ ...t, messages });
});
meRouter.post('/tickets/:id/messages', (req, res) => {
  const t = ticketFor(Number(req.params.id), req.user);
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  if (t.status === 'closed') throw badRequest('This ticket is closed. Please open a new one.');
  tx(() => {
    run('INSERT INTO ticket_messages (ticket_id, user_id, body) VALUES (?, ?, ?)', t.id, req.user!.id, body);
    const reopen = req.user!.role !== 'admin' && t.status === 'resolved' ? 'open' : t.status;
    run('UPDATE support_tickets SET updated_at = ?, status = ? WHERE id = ?', new Date().toISOString(), reopen, t.id);
    if (req.user!.role === 'admin') {
      const role = get('SELECT role FROM users WHERE id = ?', t.user_id)!.role;
      notify(t.user_id, 'support', `Reply on ticket #${t.id}`, body.slice(0, 120), `${role === 'owner' ? '/owner' : '/account'}/support?ticket=${t.id}`);
    }
  });
  res.status(201).json({ ok: true });
});

// ---------- Customer-only ----------
const customer = Router();
customer.use(requireRole('customer'));

const TAB_FILTER: Record<string, string> = {
  upcoming: "b.status IN ('confirmed') AND b.check_out >= :today",
  pending: "b.status IN ('requested','pending_payment')",
  active: "b.status = 'checked_in'",
  completed: "b.status = 'completed'",
  cancelled: "b.status IN ('cancelled','expired','rejected')",
};

customer.get('/bookings', (req, res) => {
  expireHolds();
  const tab = String(req.query.tab ?? '');
  const filter = TAB_FILTER[tab] ?? '1=1';
  const rows = all(
    `SELECT b.*, p.name property_name, p.slug, l.name locality, r.name room_name, bd.label bed_label,
       (SELECT url FROM property_photos ph WHERE ph.property_id = p.id ORDER BY sort, id LIMIT 1) photo,
       (SELECT id FROM reviews rv WHERE rv.booking_id = b.id) review_id
     FROM bookings b JOIN properties p ON p.id = b.property_id JOIN localities l ON l.id = p.locality_id
     JOIN rooms r ON r.id = b.room_id JOIN beds bd ON bd.id = b.bed_id
     WHERE b.customer_id = :uid AND ${filter} ORDER BY b.check_in DESC, b.id DESC`,
    { uid: req.user!.id, today: todayIST() },
  );
  const counts = Object.fromEntries(
    Object.entries(TAB_FILTER).map(([k, f]) => [k, get<{ c: number }>(`SELECT COUNT(*) c FROM bookings b WHERE b.customer_id = :uid AND ${f}`, { uid: req.user!.id, today: todayIST() })!.c]),
  );
  res.json({ items: rows, counts });
});

function myBooking(code: string, userId: number) {
  const b = get(
    `SELECT b.*, p.name property_name, p.slug, p.address, p.contact_phone, p.check_in_time, p.check_out_time, p.cancellation_policy,
            p.house_rules, p.owner_id, l.name locality, r.name room_name, r.room_type, r.ac, bd.label bed_label,
            c.code coupon_code
     FROM bookings b JOIN properties p ON p.id = b.property_id JOIN localities l ON l.id = p.locality_id
     JOIN rooms r ON r.id = b.room_id JOIN beds bd ON bd.id = b.bed_id LEFT JOIN coupons c ON c.id = b.coupon_id
     WHERE b.code = ? AND b.customer_id = ?`,
    code, userId,
  );
  if (!b) throw notFound('Booking');
  return b;
}

customer.get('/bookings/:code', (req, res) => {
  expireHolds();
  const b = myBooking(req.params.code, req.user!.id);
  const payments = all('SELECT id, provider, provider_order_id, provider_payment_id, amount, method, status, failure_reason, created_at, paid_at FROM payments WHERE booking_id = ? ORDER BY id', b.id);
  const refunds = all('SELECT id, amount, status, provider_refund_id, reason, created_at, processed_at FROM refunds WHERE booking_id = ? ORDER BY id', b.id);
  const review = get('SELECT * FROM reviews WHERE booking_id = ?', b.id);
  const paid = payments.some((p) => p.status === 'paid');
  const cancellable = ['requested', 'pending_payment', 'confirmed'].includes(b.status);
  const preview = cancellable && paid ? refundFor(b as any, b.cancellation_policy as CancellationPolicy, b.check_in_time) : null;
  res.json({
    ...b,
    payments,
    refunds,
    review,
    cancellable,
    cancellation_text: POLICY_TEXT[b.cancellation_policy as CancellationPolicy],
    refund_preview: preview,
    can_review: b.status === 'completed' && !review,
    photo: get('SELECT url FROM property_photos WHERE property_id = ? ORDER BY sort, id LIMIT 1', b.property_id)?.url ?? null,
  });
});

customer.post('/bookings', (req, res) => {
  const body = parse(
    z.object({
      property_id: id,
      room_id: id,
      bed_id: id.optional().nullable(),
      check_in: dateStr,
      check_out: dateStr,
      guest_name: z.string().trim().min(2, 'Enter the guest name').max(80),
      guest_phone: z.string().trim().regex(/^(\+91[\s-]?)?[6-9]\d{9}$/, 'Enter a valid Indian mobile number'),
      guest_email: z.email('Enter a valid email').optional().nullable().or(z.literal('')),
      guest_gender: z.enum(['male', 'female', 'other']).optional().nullable(),
      guest_id_type: z.enum(['aadhaar', 'passport', 'driving_license', 'voter_id', 'student_id', 'employee_id']).optional().nullable(),
      special_requests: z.string().trim().max(500).optional().nullable(),
      coupon_code: z.string().trim().max(40).optional().nullable(),
      idempotency_key: z.string().max(64).optional().nullable(),
      accept_policies: z.boolean(),
    }),
    req.body,
  );
  const b = createBooking(req.user!.id, { ...body, guest_email: body.guest_email || null });
  res.status(201).json(b);
});

customer.post('/bookings/:code/cancel', async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Tell us why you are cancelling').max(500) }), req.body);
  const b = myBooking(req.params.code, req.user!.id);
  res.json(await cancelBooking(b.id, 'customer', req.user!.id, reason));
});

customer.post('/bookings/:code/review', (req, res) => {
  const body = parse(
    z.object({
      rating: z.number().int().min(1).max(5),
      cleanliness: z.number().int().min(1).max(5).optional(),
      food: z.number().int().min(1).max(5).optional(),
      location: z.number().int().min(1).max(5).optional(),
      safety: z.number().int().min(1).max(5).optional(),
      title: z.string().trim().max(120).optional(),
      comment: z.string().trim().min(20, 'Please write at least 20 characters').max(2000),
    }),
    req.body,
  );
  const b = myBooking(req.params.code, req.user!.id);
  // Only verified, completed stays are eligible.
  if (b.status !== 'completed') throw badRequest('You can review a property after your stay is completed');
  const reviewId = tx(() => {
    if (get('SELECT id FROM reviews WHERE booking_id = ?', b.id)) throw badRequest('You have already reviewed this stay');
    const rid = run(
      'INSERT INTO reviews (booking_id, property_id, customer_id, rating, cleanliness, food, location, safety, title, comment) VALUES (?,?,?,?,?,?,?,?,?,?)',
      b.id, b.property_id, req.user!.id, body.rating, body.cleanliness ?? null, body.food ?? null, body.location ?? null, body.safety ?? null, body.title ?? null, body.comment,
    ).id;
    recalcRating(b.property_id);
    notify(b.owner_id, 'review', `New ${body.rating}★ review`, `${b.property_name}: “${body.comment.slice(0, 80)}”`, '/owner/reviews');
    return rid;
  });
  res.status(201).json({ id: reviewId });
});

customer.get('/reviews', (req, res) => {
  res.json(
    all(
      `SELECT r.*, p.name property_name, p.slug, b.code booking_code FROM reviews r JOIN properties p ON p.id = r.property_id JOIN bookings b ON b.id = r.booking_id
       WHERE r.customer_id = ? ORDER BY r.id DESC`,
      req.user!.id,
    ),
  );
});

customer.get('/saved', (req, res) => {
  const rows = all(`${PROPERTY_SELECT} JOIN saved_properties s ON s.property_id = p.id WHERE s.user_id = ? AND p.status = 'approved' ORDER BY s.created_at DESC`, req.user!.id);
  res.json(propertyCards(rows, { userId: req.user!.id }));
});
customer.post('/saved/:propertyId', (req, res) => {
  const pid = Number(req.params.propertyId);
  if (!get("SELECT id FROM properties WHERE id = ? AND status = 'approved'", pid)) throw notFound('Property');
  run('INSERT OR IGNORE INTO saved_properties (user_id, property_id) VALUES (?, ?)', req.user!.id, pid);
  res.json({ saved: true });
});
customer.delete('/saved/:propertyId', (req, res) => {
  run('DELETE FROM saved_properties WHERE user_id = ? AND property_id = ?', req.user!.id, Number(req.params.propertyId));
  res.json({ saved: false });
});

customer.get('/menu-alerts', (req, res) => {
  res.json(all('SELECT property_id FROM menu_alerts WHERE user_id = ?', req.user!.id).map((r) => r.property_id));
});
customer.post('/menu-alerts/:propertyId', (req, res) => {
  const pid = Number(req.params.propertyId);
  if (!get("SELECT id FROM properties WHERE id = ? AND status = 'approved'", pid)) throw notFound('Property');
  run('INSERT OR IGNORE INTO menu_alerts (user_id, property_id) VALUES (?, ?)', req.user!.id, pid);
  res.json({ subscribed: true });
});
customer.delete('/menu-alerts/:propertyId', (req, res) => {
  run('DELETE FROM menu_alerts WHERE user_id = ? AND property_id = ?', req.user!.id, Number(req.params.propertyId));
  res.json({ subscribed: false });
});

customer.post('/reviews/:id/report', (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
  const r = get("SELECT id FROM reviews WHERE id = ? AND status = 'published'", Number(req.params.id));
  if (!r) throw notFound('Review');
  run('INSERT OR IGNORE INTO review_reports (review_id, reporter_id, reason) VALUES (?, ?, ?)', r.id, req.user!.id, reason);
  res.json({ ok: true });
});

customer.get('/dashboard', (req, res) => {
  const uid = req.user!.id;
  const today = todayIST();
  res.json({
    upcoming: all(
      `SELECT b.code, b.check_in, b.check_out, b.status, b.total_amount, p.name property_name, p.slug, l.name locality,
         (SELECT url FROM property_photos ph WHERE ph.property_id = p.id ORDER BY sort, id LIMIT 1) photo
       FROM bookings b JOIN properties p ON p.id = b.property_id JOIN localities l ON l.id = p.locality_id
       WHERE b.customer_id = ? AND b.status IN ('confirmed','checked_in','pending_payment','requested') AND b.check_out >= ? ORDER BY b.check_in LIMIT 3`,
      uid, today,
    ),
    stats: get(
      `SELECT COUNT(*) total, SUM(CASE WHEN status = 'completed' THEN nights ELSE 0 END) nights,
         SUM(CASE WHEN payment_status IN ('paid','partially_refunded') THEN total_amount ELSE 0 END) spent
       FROM bookings WHERE customer_id = ?`,
      uid,
    ),
    saved: get<{ c: number }>('SELECT COUNT(*) c FROM saved_properties WHERE user_id = ?', uid)!.c,
    to_review: all(
      `SELECT b.code, p.name property_name FROM bookings b JOIN properties p ON p.id = b.property_id
       WHERE b.customer_id = ? AND b.status = 'completed' AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id) LIMIT 3`,
      uid,
    ),
  });
});

meRouter.use(customer);
