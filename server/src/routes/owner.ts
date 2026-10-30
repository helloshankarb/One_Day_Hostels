import { Router } from 'express';
import { z } from 'zod';
import { all, get, run, tx, type Row } from '../db/index.ts';
import { parse, notFound, badRequest, dateStr, id, bool, HttpError } from '../lib/http.ts';
import { requireRole } from '../lib/auth.ts';
import { audit, notify, notifyAdmins } from '../lib/services.ts';
import { ownerRespond, checkIn, checkOut, cancelBooking, expireHolds, ACTIVE_BOOKING } from '../lib/bookings.ts';
import { menuWithItems, MEALS } from '../lib/catalog.ts';
import { photoUpload, docUpload, assertFileSignature, removeUpload } from '../lib/uploads.ts';
import { todayIST, addDays, isValidDate, weekStart, nowIso, diffDays } from '../lib/dates.ts';

export const ownerRouter = Router();
ownerRouter.use(requireRole('owner'));

const uid = (req: any) => req.user!.id as number;

function owned(propertyId: number, ownerId: number): Row {
  const p = get('SELECT * FROM properties WHERE id = ? AND owner_id = ?', propertyId, ownerId);
  if (!p) throw notFound('Property');
  return p;
}
function ownedRoom(roomId: number, ownerId: number) {
  const r = get('SELECT r.* FROM rooms r JOIN properties p ON p.id = r.property_id WHERE r.id = ? AND p.owner_id = ?', roomId, ownerId);
  if (!r) throw notFound('Room');
  return r;
}
function ownedBed(bedId: number, ownerId: number) {
  const b = get('SELECT bd.*, r.property_id FROM beds bd JOIN rooms r ON r.id = bd.room_id JOIN properties p ON p.id = r.property_id WHERE bd.id = ? AND p.owner_id = ?', bedId, ownerId);
  if (!b) throw notFound('Bed');
  return b;
}
const ownerPropIds = (ownerId: number) => all<{ id: number }>('SELECT id FROM properties WHERE owner_id = ?', ownerId).map((r) => r.id);
const inList = (ids: number[]) => (ids.length ? ids.join(',') : '0');

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'property';
}

// ---------- Profile & onboarding ----------
ownerRouter.get('/profile', (req, res) => {
  res.json({
    user: get('SELECT id, name, email, phone, email_verified, created_at FROM users WHERE id = ?', uid(req)),
    profile: get('SELECT * FROM owner_profiles WHERE user_id = ?', uid(req)),
  });
});

ownerRouter.patch('/profile', (req, res) => {
  const body = parse(
    z.object({
      business_name: z.string().trim().min(2).max(120).optional(),
      pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Enter a valid PAN (e.g. ABCDE1234F)').optional().or(z.literal('')),
      gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'Enter a valid GSTIN').optional().or(z.literal('')),
      bank_account_name: z.string().trim().max(120).optional(),
      bank_account_number: z.string().trim().regex(/^\d{9,18}$/, 'Account number must be 9–18 digits').optional().or(z.literal('')),
      ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC').optional().or(z.literal('')),
      upi_id: z.string().trim().regex(/^[\w.-]{2,}@[a-zA-Z]{2,}$/, 'Enter a valid UPI ID').optional().or(z.literal('')),
      address: z.string().trim().max(300).optional(),
      onboarding_step: z.number().int().min(1).max(4).optional(),
      submit_kyc: z.boolean().optional(),
    }),
    req.body,
  );
  const cur = get('SELECT * FROM owner_profiles WHERE user_id = ?', uid(req))!;
  const pick = (k: string, v: unknown) => (v === undefined ? cur[k] : v === '' ? null : v);
  run(
    `UPDATE owner_profiles SET business_name = ?, pan = ?, gstin = ?, bank_account_name = ?, bank_account_last4 = ?, ifsc = ?, upi_id = ?, address = ?,
       onboarding_step = MAX(onboarding_step, ?), kyc_status = ? WHERE user_id = ?`,
    pick('business_name', body.business_name), pick('pan', body.pan), pick('gstin', body.gstin), pick('bank_account_name', body.bank_account_name),
    body.bank_account_number ? body.bank_account_number.slice(-4) : cur.bank_account_last4,
    pick('ifsc', body.ifsc), pick('upi_id', body.upi_id), pick('address', body.address), body.onboarding_step ?? cur.onboarding_step,
    body.submit_kyc && ['pending', 'rejected'].includes(cur.kyc_status) ? 'submitted' : cur.kyc_status, uid(req),
  );
  if (body.submit_kyc && ['pending', 'rejected'].includes(cur.kyc_status)) notifyAdmins('owner', 'Owner KYC submitted', req.user!.name, '/admin/owners');
  res.json(get('SELECT * FROM owner_profiles WHERE user_id = ?', uid(req)));
});

// ---------- Dashboard ----------
ownerRouter.get('/dashboard', (req, res) => {
  expireHolds();
  const ownerId = uid(req);
  const pid = Number(req.query.property_id) || null;
  const ids = pid ? [owned(pid, ownerId).id] : ownerPropIds(ownerId);
  const L = inList(ids);
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
  const today = todayIST();
  const start = addDays(today, -(days - 1));
  const prevStart = addDays(start, -days);

  const sumRange = (from: string, to: string) =>
    get(
      `SELECT COUNT(*) bookings,
         COALESCE(SUM(CASE WHEN payment_status IN ('paid','partially_refunded') AND status NOT IN ('cancelled') THEN total_amount ELSE 0 END),0) revenue
       FROM bookings WHERE property_id IN (${L}) AND status NOT IN ('expired','rejected') AND date(created_at) BETWEEN ? AND ?`,
      from, to,
    )!;
  const cur = sumRange(start, today);
  const prev = sumRange(prevStart, addDays(start, -1));
  const totalBeds = get<{ c: number }>(`SELECT COUNT(*) c FROM beds bd JOIN rooms r ON r.id = bd.room_id WHERE r.property_id IN (${L}) AND bd.active = 1 AND r.active = 1`)!.c;
  const series = all(
    `WITH RECURSIVE d(day) AS (SELECT ? UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < ?)
     SELECT day,
       (SELECT COUNT(*) FROM bookings b WHERE b.property_id IN (${L}) AND b.status IN ('confirmed','checked_in','completed') AND b.check_in <= day AND b.check_out > day) occupied,
       (SELECT COUNT(*) FROM bookings b WHERE b.property_id IN (${L}) AND date(b.created_at) = day AND b.status NOT IN ('expired','rejected') AND b.stay_type = 'daily') daily,
       (SELECT COUNT(*) FROM bookings b WHERE b.property_id IN (${L}) AND date(b.created_at) = day AND b.status NOT IN ('expired','rejected') AND b.stay_type != 'daily') longstay,
       (SELECT COALESCE(SUM(b.total_amount),0) FROM bookings b WHERE b.property_id IN (${L}) AND date(b.created_at) = day AND b.payment_status IN ('paid','partially_refunded') AND b.status != 'cancelled') revenue
     FROM d`,
    start, today,
  );
  const occAvg = totalBeds ? Math.round((series.reduce((s, d) => s + d.occupied, 0) / (series.length * totalBeds)) * 100) : 0;
  const prevOcc = get<{ o: number }>(
    `WITH RECURSIVE d(day) AS (SELECT ? UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < ?)
     SELECT AVG((SELECT COUNT(*) FROM bookings b WHERE b.property_id IN (${L}) AND b.status IN ('confirmed','checked_in','completed') AND b.check_in <= day AND b.check_out > day)) o FROM d`,
    prevStart, addDays(start, -1),
  )!.o;
  const occupiedToday = get<{ c: number }>(
    `SELECT COUNT(DISTINCT bed_id) c FROM bookings b WHERE b.property_id IN (${L}) AND ${ACTIVE_BOOKING} AND b.check_in <= :d AND b.check_out > :d`,
    { now: nowIso(), d: today },
  )!.c;
  const blockedToday = get<{ c: number }>(
    `SELECT COUNT(DISTINCT k.bed_id) c FROM bed_blocks k JOIN beds bd ON bd.id = k.bed_id JOIN rooms r ON r.id = bd.room_id WHERE r.property_id IN (${L}) AND k.start_date <= ? AND k.end_date > ?`,
    today, today,
  )!.c;
  const rating = get(`SELECT AVG(rating) avg, COUNT(*) n FROM reviews WHERE property_id IN (${L}) AND status = 'published'`)!;
  const ratingPrev = get(`SELECT AVG(rating) avg FROM reviews WHERE property_id IN (${L}) AND status = 'published' AND date(created_at) < ?`, start)!;
  const bookingCols = `b.id, b.code, b.guest_name, b.guest_phone, b.check_in, b.check_out, b.nights, b.stay_type, b.total_amount, b.status, b.payment_status, b.created_at,
    p.name property_name, r.name room_name, bd.label bed_label`;
  const bookingJoin = `FROM bookings b JOIN properties p ON p.id = b.property_id JOIN rooms r ON r.id = b.room_id JOIN beds bd ON bd.id = b.bed_id`;
  const roomOcc = all(
    `SELECT r.id, r.name, r.room_type, r.ac, COUNT(bd.id) beds,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM bookings b WHERE b.bed_id = bd.id AND ${ACTIVE_BOOKING} AND b.check_in <= :d AND b.check_out > :d) THEN 1 ELSE 0 END) occupied
     FROM rooms r JOIN beds bd ON bd.room_id = r.id AND bd.active = 1 WHERE r.property_id IN (${L}) AND r.active = 1 GROUP BY r.id ORDER BY r.name`,
    { now: nowIso(), d: today },
  );
  const menuToday = all(
    `SELECT p.id property_id, p.name, p.food_type, m.status, m.updated_at, m.published_at,
       (SELECT COUNT(*) FROM menu_items mi WHERE mi.menu_id = m.id) items
     FROM properties p LEFT JOIN menus m ON m.property_id = p.id AND m.menu_date = ? WHERE p.id IN (${L}) AND p.food_type != 'none'`,
    today,
  );
  const todayMenuItems = menuToday[0]?.status ? menuWithItems(get('SELECT * FROM menus WHERE property_id = ? AND menu_date = ?', menuToday[0].property_id, today)) : null;

  const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : a ? 100 : 0);
  res.json({
    range: { start, end: today, days },
    properties: all(`SELECT id, name, status FROM properties WHERE owner_id = ? ORDER BY name`, ownerId),
    kpis: {
      bookings: cur.bookings,
      bookings_change: pct(cur.bookings, prev.bookings),
      revenue: cur.revenue,
      revenue_change: pct(cur.revenue, prev.revenue),
      occupancy: occAvg,
      occupancy_change: totalBeds ? occAvg - Math.round(((prevOcc ?? 0) / totalBeds) * 100) : 0,
      rating: rating.avg ? Math.round(rating.avg * 10) / 10 : 0,
      rating_count: rating.n,
      rating_change: rating.avg && ratingPrev.avg ? Math.round((rating.avg - ratingPrev.avg) * 10) / 10 : 0,
      total_beds: totalBeds,
      occupied_beds: occupiedToday,
      available_beds: Math.max(0, totalBeds - occupiedToday - blockedToday),
      blocked_beds: blockedToday,
    },
    today: {
      date: today,
      check_ins: all(`SELECT ${bookingCols} ${bookingJoin} WHERE b.property_id IN (${L}) AND b.check_in = ? AND b.status IN ('confirmed','checked_in') ORDER BY b.status`, today),
      check_outs: all(`SELECT ${bookingCols} ${bookingJoin} WHERE b.property_id IN (${L}) AND b.check_out = ? AND b.status IN ('checked_in','completed')`, today),
      collection: get<{ s: number }>(`SELECT COALESCE(SUM(pm.amount),0) s FROM payments pm JOIN bookings b ON b.id = pm.booking_id WHERE b.property_id IN (${L}) AND pm.status = 'paid' AND date(pm.paid_at) = ?`, today)!.s,
    },
    pending_requests: all(`SELECT ${bookingCols} ${bookingJoin} WHERE b.property_id IN (${L}) AND b.status = 'requested' AND b.hold_expires_at > ? ORDER BY b.created_at`, nowIso()),
    recent_bookings: all(`SELECT ${bookingCols} ${bookingJoin} WHERE b.property_id IN (${L}) AND b.status NOT IN ('expired') ORDER BY b.created_at DESC LIMIT 6`),
    series,
    room_occupancy: roomOcc,
    recent_reviews: all(`SELECT r.id, r.rating, r.comment, r.owner_reply, r.created_at, u.name customer_name, p.name property_name FROM reviews r JOIN users u ON u.id = r.customer_id JOIN properties p ON p.id = r.property_id WHERE r.property_id IN (${L}) ORDER BY r.created_at DESC LIMIT 3`),
    menu_status: menuToday,
    today_menu: todayMenuItems,
    verification: all(`SELECT id, name, status, status_reason, verified FROM properties WHERE owner_id = ?`, ownerId),
  });
});

// ---------- Properties ----------
const propertySchema = z.object({
  name: z.string().trim().min(3, 'Name is too short').max(100),
  locality_id: id,
  address: z.string().trim().min(5, 'Enter the full address').max(300),
  pincode: z.string().trim().regex(/^5300\d{2}$|^5310\d{2}$/, 'Enter a Visakhapatnam PIN code (5300xx / 5310xx)').optional().or(z.literal('')),
  landmark: z.string().trim().max(120).optional().or(z.literal('')),
  description: z.string().trim().max(4000).default(''),
  accommodation_type: z.enum(['hostel', 'pg', 'coliving', 'dormitory']),
  gender_policy: z.enum(['men', 'women', 'coed', 'family']),
  food_type: z.enum(['pure_veg', 'veg_meals', 'veg_nonveg', 'none']),
  instant_book: bool.default(1),
  allow_daily: bool.default(1),
  allow_weekly: bool.default(1),
  allow_monthly: bool.default(1),
  min_stay_days: z.number().int().min(1).max(90).default(1),
  cancellation_policy: z.enum(['flexible', 'moderate', 'strict']).default('flexible'),
  house_rules: z.string().trim().max(3000).default(''),
  check_in_time: z.string().regex(/^\d{2}:\d{2}$/).default('12:00'),
  check_out_time: z.string().regex(/^\d{2}:\d{2}$/).default('11:00'),
  gate_close_time: z.string().regex(/^\d{2}:\d{2}$/).optional().or(z.literal('')),
  breakfast_time: z.string().max(20).default('07:30-09:30'),
  lunch_time: z.string().max(20).default('12:30-14:30'),
  dinner_time: z.string().max(20).default('19:30-21:30'),
  contact_phone: z.string().trim().max(20).optional().or(z.literal('')),
  amenity_ids: z.array(id).max(60).optional(),
});

const PROP_COLS = ['name', 'locality_id', 'address', 'pincode', 'landmark', 'description', 'accommodation_type', 'gender_policy', 'food_type', 'instant_book', 'allow_daily', 'allow_weekly', 'allow_monthly', 'min_stay_days', 'cancellation_policy', 'house_rules', 'check_in_time', 'check_out_time', 'gate_close_time', 'breakfast_time', 'lunch_time', 'dinner_time', 'contact_phone'] as const;

ownerRouter.get('/properties', (req, res) => {
  const rows = all(
    `SELECT p.*, l.name locality,
       (SELECT url FROM property_photos ph WHERE ph.property_id = p.id ORDER BY sort, id LIMIT 1) photo,
       (SELECT COUNT(*) FROM rooms r WHERE r.property_id = p.id AND r.active = 1) rooms,
       (SELECT COUNT(*) FROM beds bd JOIN rooms r ON r.id = bd.room_id WHERE r.property_id = p.id AND bd.active = 1 AND r.active = 1) beds,
       (SELECT COUNT(*) FROM bookings b WHERE b.property_id = p.id AND b.status IN ('confirmed','checked_in')) active_bookings,
       (SELECT MIN(price_daily) FROM rooms r WHERE r.property_id = p.id AND r.active = 1) min_daily,
       (SELECT MIN(price_monthly) FROM rooms r WHERE r.property_id = p.id AND r.active = 1) min_monthly
     FROM properties p JOIN localities l ON l.id = p.locality_id WHERE p.owner_id = ? ORDER BY p.created_at DESC`,
    uid(req),
  );
  res.json(rows);
});

function readiness(p: Row) {
  const photos = get<{ c: number }>('SELECT COUNT(*) c FROM property_photos WHERE property_id = ?', p.id)!.c;
  const beds = get<{ c: number }>('SELECT COUNT(*) c FROM beds bd JOIN rooms r ON r.id = bd.room_id WHERE r.property_id = ? AND r.active = 1 AND bd.active = 1', p.id)!.c;
  const docs = get<{ c: number }>("SELECT COUNT(*) c FROM property_documents WHERE property_id = ? AND status != 'rejected'", p.id)!.c;
  const amen = get<{ c: number }>('SELECT COUNT(*) c FROM property_amenities WHERE property_id = ?', p.id)!.c;
  return [
    { key: 'details', label: 'Basic details & description (50+ characters)', done: p.description.length >= 50 && p.address.length >= 5 },
    { key: 'photos', label: 'At least 3 photographs', done: photos >= 3 },
    { key: 'amenities', label: 'Amenities selected', done: amen > 0 },
    { key: 'rooms', label: 'At least one room with beds and prices', done: beds > 0 },
    { key: 'documents', label: 'Ownership / lease and ID documents uploaded', done: docs >= 2 },
  ];
}

ownerRouter.get('/properties/:id', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  res.json({
    ...p,
    locality: get('SELECT name, slug FROM localities WHERE id = ?', p.locality_id),
    photos: all('SELECT * FROM property_photos WHERE property_id = ? ORDER BY sort, id', p.id),
    amenity_ids: all('SELECT amenity_id FROM property_amenities WHERE property_id = ?', p.id).map((r) => r.amenity_id),
    documents: all('SELECT id, doc_type, original_name, mime_type, status, note, uploaded_at FROM property_documents WHERE property_id = ? ORDER BY id DESC', p.id),
    history: all('SELECT h.*, u.name actor FROM property_status_history h LEFT JOIN users u ON u.id = h.actor_id WHERE property_id = ? ORDER BY h.id DESC', p.id),
    readiness: readiness(p),
  });
});

function setAmenities(propertyId: number, ids?: number[]) {
  if (!ids) return;
  run('DELETE FROM property_amenities WHERE property_id = ?', propertyId);
  for (const a of new Set(ids)) run('INSERT OR IGNORE INTO property_amenities (property_id, amenity_id) SELECT ?, id FROM amenities WHERE id = ?', propertyId, a);
}

ownerRouter.post('/properties', (req, res) => {
  const body = parse(propertySchema, req.body);
  if (!get('SELECT id FROM localities WHERE id = ? AND active = 1', body.locality_id)) throw badRequest('Choose a locality', { locality_id: 'Choose a locality' });
  const pid = tx(() => {
    let slug = slugify(body.name);
    if (get('SELECT id FROM properties WHERE slug = ?', slug)) slug = `${slug}-${Date.now().toString(36)}`;
    const vals = PROP_COLS.map((c) => ((body as any)[c] === '' ? null : (body as any)[c]));
    const newId = run(
      `INSERT INTO properties (owner_id, slug, ${PROP_COLS.join(', ')}) VALUES (?, ?, ${PROP_COLS.map(() => '?').join(', ')})`,
      uid(req), slug, ...vals,
    ).id;
    setAmenities(newId, body.amenity_ids);
    run("INSERT INTO property_status_history (property_id, to_status, actor_id) VALUES (?, 'draft', ?)", newId, uid(req));
    run('UPDATE owner_profiles SET onboarding_step = MAX(onboarding_step, 3) WHERE user_id = ?', uid(req));
    return newId;
  });
  audit(req, 'property.create', 'property', pid);
  res.status(201).json(get('SELECT * FROM properties WHERE id = ?', pid));
});

ownerRouter.patch('/properties/:id', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const body = parse(propertySchema.partial(), req.body);
  if (p.status === 'suspended') throw badRequest('Suspended listings cannot be edited. Contact support.');
  if (body.food_type && body.food_type !== p.food_type && ['pure_veg', 'veg_meals'].includes(body.food_type)) {
    const nonveg = get(`SELECT 1 FROM menus m JOIN menu_items mi ON mi.menu_id = m.id WHERE m.property_id = ? AND m.menu_date >= ? AND mi.is_veg = 0 LIMIT 1`, p.id, todayIST());
    if (nonveg) throw badRequest('Remove non-vegetarian dishes from upcoming menus before switching to a vegetarian-only classification');
  }
  tx(() => {
    const sets = PROP_COLS.filter((c) => (body as any)[c] !== undefined);
    if (sets.length) {
      run(
        `UPDATE properties SET ${sets.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...sets.map((c) => ((body as any)[c] === '' ? null : (body as any)[c])), nowIso(), p.id,
      );
    }
    setAmenities(p.id, body.amenity_ids);
  });
  audit(req, 'property.update', 'property', p.id, Object.keys(body));
  res.json(get('SELECT * FROM properties WHERE id = ?', p.id));
});

function changeStatus(p: Row, to: string, actorId: number, reason: string | null = null) {
  run('UPDATE properties SET status = ?, status_reason = ?, updated_at = ?, submitted_at = CASE WHEN ? = \'pending_review\' THEN ? ELSE submitted_at END WHERE id = ?', to, reason, nowIso(), to, nowIso(), p.id);
  run('INSERT INTO property_status_history (property_id, from_status, to_status, actor_id, reason) VALUES (?, ?, ?, ?, ?)', p.id, p.status, to, actorId, reason);
}

ownerRouter.post('/properties/:id/submit', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  if (!['draft', 'rejected', 'changes_requested'].includes(p.status)) throw badRequest('This listing is not in an editable state');
  const missing = readiness(p).filter((r) => !r.done);
  if (missing.length) throw new HttpError(400, 'Complete the checklist before submitting', { checklist: missing.map((m) => m.label).join('; ') });
  tx(() => changeStatus(p, 'pending_review', uid(req)));
  notifyAdmins('property', `Listing submitted for review: ${p.name}`, req.user!.name, `/admin/properties/${p.id}`);
  audit(req, 'property.submit', 'property', p.id);
  res.json({ status: 'pending_review' });
});

ownerRouter.post('/properties/:id/unpublish', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  if (p.status !== 'approved') throw badRequest('Only live listings can be unpublished');
  tx(() => changeStatus(p, 'unpublished', uid(req), 'Unpublished by owner'));
  audit(req, 'property.unpublish', 'property', p.id);
  res.json({ status: 'unpublished' });
});

ownerRouter.post('/properties/:id/publish', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  if (p.status !== 'unpublished' || !p.approved_at) throw badRequest('Only previously approved listings can be re-published');
  tx(() => changeStatus(p, 'approved', uid(req), 'Re-published by owner'));
  audit(req, 'property.publish', 'property', p.id);
  res.json({ status: 'approved' });
});

ownerRouter.delete('/properties/:id', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  if (p.status !== 'draft') throw badRequest('Only draft listings can be deleted. Unpublish live listings instead.');
  if (get('SELECT 1 FROM bookings WHERE property_id = ? LIMIT 1', p.id)) throw badRequest('Listings with bookings cannot be deleted');
  const photos = all('SELECT url FROM property_photos WHERE property_id = ?', p.id);
  run('DELETE FROM properties WHERE id = ?', p.id);
  photos.forEach((ph) => removeUpload(ph.url));
  audit(req, 'property.delete', 'property', p.id);
  res.json({ ok: true });
});

// Photos
ownerRouter.post('/properties/:id/photos', photoUpload.array('photos', 10), (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw badRequest('Choose at least one photo');
  files.forEach((f) => assertFileSignature(f.path, f.mimetype));
  const max = get<{ m: number | null }>('SELECT MAX(sort) m FROM property_photos WHERE property_id = ?', p.id)!.m ?? 0;
  files.forEach((f, i) => run('INSERT INTO property_photos (property_id, url, sort) VALUES (?, ?, ?)', p.id, `/uploads/photos/${f.filename}`, max + i + 1));
  res.status(201).json(all('SELECT * FROM property_photos WHERE property_id = ? ORDER BY sort, id', p.id));
});
ownerRouter.patch('/properties/:id/photos/:photoId', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const body = parse(z.object({ caption: z.string().max(120).optional(), make_cover: z.boolean().optional() }), req.body);
  const ph = get('SELECT * FROM property_photos WHERE id = ? AND property_id = ?', Number(req.params.photoId), p.id);
  if (!ph) throw notFound('Photo');
  if (body.caption !== undefined) run('UPDATE property_photos SET caption = ? WHERE id = ?', body.caption, ph.id);
  if (body.make_cover) run('UPDATE property_photos SET sort = (SELECT MIN(sort) - 1 FROM property_photos WHERE property_id = ?) WHERE id = ?', p.id, ph.id);
  res.json(all('SELECT * FROM property_photos WHERE property_id = ? ORDER BY sort, id', p.id));
});
ownerRouter.delete('/properties/:id/photos/:photoId', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const ph = get('SELECT * FROM property_photos WHERE id = ? AND property_id = ?', Number(req.params.photoId), p.id);
  if (!ph) throw notFound('Photo');
  run('DELETE FROM property_photos WHERE id = ?', ph.id);
  removeUpload(ph.url);
  res.json({ ok: true });
});

// Documents
ownerRouter.post('/properties/:id/documents', docUpload.single('file'), (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const f = req.file;
  if (!f) throw badRequest('Choose a file to upload');
  assertFileSignature(f.path, f.mimetype);
  const { doc_type } = parse(z.object({ doc_type: z.enum(['ownership_proof', 'lease_agreement', 'owner_id', 'fssai', 'fire_safety', 'gst', 'trade_license', 'other']) }), req.body);
  const docId = run('INSERT INTO property_documents (property_id, doc_type, original_name, stored_name, mime_type) VALUES (?, ?, ?, ?, ?)', p.id, doc_type, f.originalname.slice(0, 200), f.filename, f.mimetype).id;
  audit(req, 'document.upload', 'property', p.id, { doc_type });
  res.status(201).json(get('SELECT id, doc_type, original_name, mime_type, status, uploaded_at FROM property_documents WHERE id = ?', docId));
});
ownerRouter.delete('/properties/:id/documents/:docId', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const d = get("SELECT * FROM property_documents WHERE id = ? AND property_id = ?", Number(req.params.docId), p.id);
  if (!d) throw notFound('Document');
  if (d.status === 'verified') throw badRequest('Verified documents cannot be removed');
  run('DELETE FROM property_documents WHERE id = ?', d.id);
  res.json({ ok: true });
});

// ---------- Rooms & beds ----------
const roomSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(2).max(80),
  room_type: z.enum(['private', 'shared', 'dorm']),
  capacity: z.number().int().min(1).max(20),
  ac: bool.default(0),
  attached_bath: bool.default(0),
  price_daily: z.number().int().min(100, 'Daily price must be at least ₹100').max(50000),
  price_weekly: z.number().int().min(0).max(300000).nullable().optional(),
  price_monthly: z.number().int().min(0).max(1000000).nullable().optional(),
  deposit: z.number().int().min(0).max(200000).default(0),
  meals_included: bool.default(1),
  features: z.string().trim().max(300).default(''),
  description: z.string().trim().max(1000).default(''),
  active: bool.optional(),
});

ownerRouter.get('/properties/:id/rooms', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const today = todayIST();
  const rooms = all('SELECT * FROM rooms WHERE property_id = ? ORDER BY active DESC, code', p.id);
  const beds = all(
    `SELECT bd.*,
       (SELECT b.code || '|' || b.guest_name || '|' || b.check_out FROM bookings b WHERE b.bed_id = bd.id AND ${ACTIVE_BOOKING} AND b.check_in <= :d AND b.check_out > :d LIMIT 1) occupant,
       (SELECT k.reason || '|' || k.end_date FROM bed_blocks k WHERE k.bed_id = bd.id AND k.start_date <= :d AND k.end_date > :d LIMIT 1) block
     FROM beds bd JOIN rooms r ON r.id = bd.room_id WHERE r.property_id = :pid ORDER BY bd.label`,
    { now: nowIso(), d: today, pid: p.id },
  );
  const blocks = all(`SELECT k.* FROM bed_blocks k JOIN beds bd ON bd.id = k.bed_id JOIN rooms r ON r.id = bd.room_id WHERE r.property_id = ? AND k.end_date > ? ORDER BY k.start_date`, p.id, today);
  res.json(
    rooms.map((r) => ({
      ...r,
      beds: beds.filter((b) => b.room_id === r.id).map((b) => {
        const [code, guest, until] = b.occupant ? String(b.occupant).split('|') : [];
        const [reason, blockedUntil] = b.block ? String(b.block).split('|') : [];
        return { ...b, occupant: b.occupant ? { code, guest, until } : null, block: b.block ? { reason, until: blockedUntil } : null, blocks: blocks.filter((k) => k.bed_id === b.id) };
      }),
    })),
  );
});

ownerRouter.post('/properties/:id/rooms', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const body = parse(roomSchema, req.body);
  if (body.room_type === 'private' && body.capacity > 4) throw badRequest('Private rooms can have at most 4 guests');
  const roomId = tx(() => {
    const rid = run(
      `INSERT INTO rooms (property_id, code, name, room_type, capacity, ac, attached_bath, price_daily, price_weekly, price_monthly, deposit, meals_included, features, description)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.id, body.code, body.name, body.room_type, body.capacity, body.ac, body.attached_bath, body.price_daily, body.price_weekly ?? null, body.price_monthly ?? null, body.deposit, body.meals_included, body.features, body.description,
    ).id;
    // Private rooms are sold as one unit; shared rooms and dorms are sold per bed.
    const bedCount = body.room_type === 'private' ? 1 : body.capacity;
    for (let i = 0; i < bedCount; i++) run('INSERT INTO beds (room_id, label) VALUES (?, ?)', rid, body.room_type === 'private' ? `${body.code}` : `${body.code}-${String.fromCharCode(65 + i)}`);
    return rid;
  });
  audit(req, 'room.create', 'room', roomId);
  res.status(201).json(get('SELECT * FROM rooms WHERE id = ?', roomId));
});

ownerRouter.patch('/rooms/:roomId', (req, res) => {
  const r = ownedRoom(Number(req.params.roomId), uid(req));
  const body = parse(roomSchema.partial(), req.body);
  const cols = Object.keys(body).filter((k) => k !== 'capacity' || body.capacity === r.capacity);
  if (body.capacity !== undefined && body.capacity !== r.capacity) {
    throw badRequest('To change capacity, add or remove beds individually');
  }
  if (cols.length) run(`UPDATE rooms SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => (body as any)[c] ?? null), r.id);
  audit(req, 'room.update', 'room', r.id, body);
  res.json(get('SELECT * FROM rooms WHERE id = ?', r.id));
});

ownerRouter.delete('/rooms/:roomId', (req, res) => {
  const r = ownedRoom(Number(req.params.roomId), uid(req));
  const future = get(`SELECT 1 FROM bookings b WHERE b.room_id = :r AND ${ACTIVE_BOOKING} AND b.check_out > :d LIMIT 1`, { r: r.id, now: nowIso(), d: todayIST() });
  if (future) throw badRequest('This room has upcoming bookings. Deactivate it after they complete.');
  if (get('SELECT 1 FROM bookings WHERE room_id = ? LIMIT 1', r.id)) run('UPDATE rooms SET active = 0 WHERE id = ?', r.id);
  else run('DELETE FROM rooms WHERE id = ?', r.id);
  audit(req, 'room.delete', 'room', r.id);
  res.json({ ok: true });
});

ownerRouter.post('/rooms/:roomId/beds', (req, res) => {
  const r = ownedRoom(Number(req.params.roomId), uid(req));
  const { label } = parse(z.object({ label: z.string().trim().min(1).max(20) }), req.body);
  if (r.room_type === 'private') throw badRequest('Private rooms are booked as a single unit');
  const n = get<{ c: number }>('SELECT COUNT(*) c FROM beds WHERE room_id = ? AND active = 1', r.id)!.c;
  tx(() => {
    run('INSERT INTO beds (room_id, label) VALUES (?, ?)', r.id, label);
    run('UPDATE rooms SET capacity = ? WHERE id = ?', Math.min(20, n + 1), r.id);
  });
  res.status(201).json({ ok: true });
});

ownerRouter.patch('/beds/:bedId', (req, res) => {
  const b = ownedBed(Number(req.params.bedId), uid(req));
  const body = parse(z.object({ label: z.string().trim().min(1).max(20).optional(), note: z.string().max(200).optional(), active: bool.optional() }), req.body);
  if (body.active === 0) {
    const future = get(`SELECT 1 FROM bookings b WHERE b.bed_id = :b AND ${ACTIVE_BOOKING} AND b.check_out > :d LIMIT 1`, { b: b.id, now: nowIso(), d: todayIST() });
    if (future) throw badRequest('This bed has upcoming bookings');
  }
  run('UPDATE beds SET label = ?, note = ?, active = ? WHERE id = ?', body.label ?? b.label, body.note ?? b.note, body.active ?? b.active, b.id);
  run('UPDATE rooms SET capacity = MAX(1, (SELECT COUNT(*) FROM beds WHERE room_id = ? AND active = 1)) WHERE id = ? AND room_type != \'private\'', b.room_id, b.room_id);
  res.json({ ok: true });
});

ownerRouter.post('/beds/:bedId/blocks', (req, res) => {
  const b = ownedBed(Number(req.params.bedId), uid(req));
  const body = parse(z.object({ start_date: dateStr, end_date: dateStr, reason: z.string().trim().max(120).default('Maintenance') }), req.body);
  if (body.end_date <= body.start_date) throw badRequest('End date must be after start date');
  tx(() => {
    const clash = get(`SELECT code FROM bookings b WHERE b.bed_id = :b AND ${ACTIVE_BOOKING} AND b.check_in < :out AND b.check_out > :in`, { b: b.id, now: nowIso(), in: body.start_date, out: body.end_date });
    if (clash) throw badRequest(`Bed is booked (${clash.code}) during these dates`);
    run('INSERT INTO bed_blocks (bed_id, start_date, end_date, reason, created_by) VALUES (?, ?, ?, ?, ?)', b.id, body.start_date, body.end_date, body.reason, uid(req));
  });
  res.status(201).json({ ok: true });
});

ownerRouter.delete('/blocks/:blockId', (req, res) => {
  const k = get('SELECT k.* FROM bed_blocks k JOIN beds bd ON bd.id = k.bed_id JOIN rooms r ON r.id = bd.room_id JOIN properties p ON p.id = r.property_id WHERE k.id = ? AND p.owner_id = ?', Number(req.params.blockId), uid(req));
  if (!k) throw notFound('Block');
  run('DELETE FROM bed_blocks WHERE id = ?', k.id);
  res.json({ ok: true });
});

// Availability calendar
ownerRouter.get('/properties/:id/calendar', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const start = isValidDate(String(req.query.start ?? '')) ? String(req.query.start) : todayIST();
  const days = Math.min(31, Math.max(7, Number(req.query.days) || 14));
  const end = addDays(start, days);
  const beds = all(
    'SELECT bd.id, bd.label, r.id room_id, r.name room_name, r.code room_code, r.room_type FROM beds bd JOIN rooms r ON r.id = bd.room_id WHERE r.property_id = ? AND r.active = 1 AND bd.active = 1 ORDER BY r.code, bd.label',
    p.id,
  );
  const bookings = all(
    `SELECT b.id, b.code, b.bed_id, b.guest_name, b.check_in, b.check_out, b.status FROM bookings b
     WHERE b.property_id = :pid AND ${ACTIVE_BOOKING.replace(/b\.status IN \('confirmed','checked_in'\)/, "b.status IN ('confirmed','checked_in','completed')")} AND b.check_in < :end AND b.check_out > :start`,
    { pid: p.id, now: nowIso(), start, end },
  );
  const blocks = all('SELECT k.* FROM bed_blocks k JOIN beds bd ON bd.id = k.bed_id JOIN rooms r ON r.id = bd.room_id WHERE r.property_id = ? AND k.start_date < ? AND k.end_date > ?', p.id, end, start);
  res.json({ start, days, beds, bookings, blocks });
});

// ---------- Bookings ----------
ownerRouter.get('/bookings', (req, res) => {
  expireHolds();
  const q = req.query as Record<string, string>;
  const where = ['p.owner_id = ?'];
  const params: any[] = [uid(req)];
  if (q.property_id) {
    where.push('b.property_id = ?');
    params.push(Number(q.property_id));
  }
  const today = todayIST();
  const tabs: Record<string, string> = {
    requests: "b.status = 'requested'",
    upcoming: "b.status IN ('confirmed','pending_payment')",
    arrivals: `b.status = 'confirmed' AND b.check_in <= '${today}'`,
    in_house: "b.status = 'checked_in'",
    departures: `b.status = 'checked_in' AND b.check_out <= '${today}'`,
    completed: "b.status = 'completed'",
    cancelled: "b.status IN ('cancelled','rejected','expired')",
  };
  if (q.tab && tabs[q.tab]) where.push(tabs[q.tab]);
  if (q.q) {
    where.push('(b.code LIKE ? OR b.guest_name LIKE ? OR b.guest_phone LIKE ?)');
    const like = `%${q.q.slice(0, 40)}%`;
    params.push(like, like, like);
  }
  const rows = all(
    `SELECT b.*, p.name property_name, r.name room_name, r.room_type, bd.label bed_label, u.email customer_email
     FROM bookings b JOIN properties p ON p.id = b.property_id JOIN rooms r ON r.id = b.room_id JOIN beds bd ON bd.id = b.bed_id JOIN users u ON u.id = b.customer_id
     WHERE ${where.join(' AND ')} ORDER BY CASE b.status WHEN 'requested' THEN 0 WHEN 'checked_in' THEN 1 WHEN 'confirmed' THEN 2 ELSE 3 END, b.check_in DESC LIMIT 300`,
    ...params,
  );
  const counts = Object.fromEntries(
    Object.entries(tabs).map(([k, f]) => [k, get<{ c: number }>(`SELECT COUNT(*) c FROM bookings b JOIN properties p ON p.id = b.property_id WHERE p.owner_id = ? AND ${f}`, uid(req))!.c]),
  );
  res.json({ items: rows, counts });
});

const ownerBooking = (bid: number, ownerId: number) => {
  const b = get('SELECT b.* FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.id = ? AND p.owner_id = ?', bid, ownerId);
  if (!b) throw notFound('Booking');
  return b;
};

ownerRouter.get('/bookings/:id', (req, res) => {
  const b = ownerBooking(Number(req.params.id), uid(req));
  res.json({
    ...b,
    property: get('SELECT id, name FROM properties WHERE id = ?', b.property_id),
    room: get('SELECT id, name, code, room_type FROM rooms WHERE id = ?', b.room_id),
    bed: get('SELECT id, label FROM beds WHERE id = ?', b.bed_id),
    payments: all('SELECT id, amount, status, method, provider_payment_id, paid_at FROM payments WHERE booking_id = ?', b.id),
    refunds: all('SELECT id, amount, status, created_at FROM refunds WHERE booking_id = ?', b.id),
  });
});
ownerRouter.post('/bookings/:id/accept', (req, res) => {
  res.json(ownerRespond(uid(req), Number(req.params.id), true));
});
ownerRouter.post('/bookings/:id/decline', (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body ?? {});
  res.json(ownerRespond(uid(req), Number(req.params.id), false, reason));
});
ownerRouter.post('/bookings/:id/check-in', (req, res) => {
  res.json(checkIn(Number(req.params.id), uid(req)));
});
ownerRouter.post('/bookings/:id/check-out', (req, res) => {
  res.json(checkOut(Number(req.params.id), uid(req)));
});
ownerRouter.post('/bookings/:id/cancel', async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(5, 'Give the guest a reason').max(300) }), req.body);
  const b = ownerBooking(Number(req.params.id), uid(req));
  audit(req, 'booking.owner_cancel', 'booking', b.id, { reason });
  res.json(await cancelBooking(b.id, 'owner', uid(req), reason));
});

// ---------- Menus ----------
const itemSchema = z.object({
  meal: z.enum(MEALS),
  name: z.string().trim().min(2, 'Dish name is required').max(80),
  description: z.string().trim().max(200).optional().nullable(),
  is_veg: z.boolean(),
  included: z.boolean().default(true),
  extra_charge: z.number().int().min(0).max(2000).default(0),
  photo_url: z.string().regex(/^\/(uploads\/photos|images)\/[\w.-]+$/).optional().nullable(),
});
const menuSchema = z.object({
  special_dish: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  breakfast_time: z.string().max(20).optional().nullable(),
  lunch_time: z.string().max(20).optional().nullable(),
  dinner_time: z.string().max(20).optional().nullable(),
  items: z.array(itemSchema).max(60),
  publish: z.boolean().default(false),
});

function assertFoodRules(p: Row, items: { is_veg: boolean }[]) {
  if (p.food_type === 'none') throw badRequest('This property is set to “No food service”. Change the food classification to publish menus.');
  if (['pure_veg', 'veg_meals'].includes(p.food_type) && items.some((i) => !i.is_veg)) {
    throw badRequest('This property is classified as vegetarian-only. Non-vegetarian dishes are not allowed.');
  }
}

function saveMenu(p: Row, date: string, body: z.infer<typeof menuSchema>, userId: number) {
  assertFoodRules(p, body.items);
  if (body.publish && !body.items.length) throw badRequest('Add at least one dish before publishing');
  return tx(() => {
    const existing = get('SELECT * FROM menus WHERE property_id = ? AND menu_date = ?', p.id, date);
    const now = nowIso();
    const status = body.publish ? 'published' : 'draft';
    let menuId: number;
    if (existing) {
      menuId = existing.id;
      run(
        'UPDATE menus SET status = ?, special_dish = ?, notes = ?, breakfast_time = ?, lunch_time = ?, dinner_time = ?, updated_by = ?, updated_at = ?, published_at = ? WHERE id = ?',
        status, body.special_dish ?? null, body.notes ?? null, body.breakfast_time ?? null, body.lunch_time ?? null, body.dinner_time ?? null, userId, now, body.publish ? now : existing.published_at, menuId,
      );
      run('DELETE FROM menu_items WHERE menu_id = ?', menuId);
    } else {
      menuId = run(
        'INSERT INTO menus (property_id, menu_date, status, special_dish, notes, breakfast_time, lunch_time, dinner_time, updated_by, updated_at, published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        p.id, date, status, body.special_dish ?? null, body.notes ?? null, body.breakfast_time ?? null, body.lunch_time ?? null, body.dinner_time ?? null, userId, now, body.publish ? now : null,
      ).id;
    }
    body.items.forEach((i, idx) =>
      run(
        'INSERT INTO menu_items (menu_id, meal, name, description, is_veg, included, extra_charge, photo_url, sort) VALUES (?,?,?,?,?,?,?,?,?)',
        menuId, i.meal, i.name, i.description ?? null, i.is_veg ? 1 : 0, i.included ? 1 : 0, i.included ? 0 : i.extra_charge, i.photo_url ?? null, idx,
      ),
    );
    if (body.publish && date === todayIST()) {
      for (const a of all('SELECT user_id FROM menu_alerts WHERE property_id = ?', p.id)) {
        notify(a.user_id, 'menu', `Today's menu is live at ${p.name}`, body.special_dish ?? `${body.items.length} dishes published`, `/property/${p.slug}`);
      }
    }
    return menuWithItems(get('SELECT * FROM menus WHERE id = ?', menuId));
  });
}

ownerRouter.get('/properties/:id/menus', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const start = isValidDate(String(req.query.start ?? '')) ? String(req.query.start) : weekStart(todayIST());
  const days = Math.min(31, Math.max(1, Number(req.query.days) || 7));
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    const m = menuWithItems(get('SELECT * FROM menus WHERE property_id = ? AND menu_date = ?', p.id, d));
    const missing = m ? MEALS.filter((meal) => !m.items.some((it: Row) => it.meal === meal)) : [...MEALS];
    out.push({ date: d, menu: m, missing_meals: missing, warning: !m ? 'No menu' : m.status !== 'published' ? 'Draft – not visible to guests' : missing.length ? `Missing ${missing.join(', ')}` : null });
  }
  res.json({
    property: { id: p.id, name: p.name, food_type: p.food_type, breakfast_time: p.breakfast_time, lunch_time: p.lunch_time, dinner_time: p.dinner_time, slug: p.slug },
    start,
    days: out,
  });
});

ownerRouter.get('/properties/:id/menus/:date', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  if (!isValidDate(req.params.date)) throw badRequest('Invalid date');
  res.json(menuWithItems(get('SELECT * FROM menus WHERE property_id = ? AND menu_date = ?', p.id, req.params.date)));
});

ownerRouter.put('/properties/:id/menus/:date', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  if (!isValidDate(req.params.date)) throw badRequest('Invalid date');
  if (req.params.date < addDays(todayIST(), -1)) throw badRequest('Past menus cannot be changed');
  const body = parse(menuSchema, req.body);
  const m = saveMenu(p, req.params.date, body, uid(req));
  audit(req, body.publish ? 'menu.publish' : 'menu.save_draft', 'property', p.id, { date: req.params.date });
  res.json(m);
});

ownerRouter.post('/properties/:id/menus/:date/unpublish', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  run("UPDATE menus SET status = 'draft', updated_at = ? WHERE property_id = ? AND menu_date = ?", nowIso(), p.id, req.params.date);
  res.json({ ok: true });
});

ownerRouter.delete('/properties/:id/menus/:date', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  run('DELETE FROM menus WHERE property_id = ? AND menu_date = ?', p.id, req.params.date);
  res.json({ ok: true });
});

function copyMenu(p: Row, from: string, to: string, overwrite: boolean, userId: number): 'copied' | 'skipped' | 'empty' {
  const src = menuWithItems(get('SELECT * FROM menus WHERE property_id = ? AND menu_date = ?', p.id, from));
  if (!src) return 'empty';
  if (!overwrite && get('SELECT 1 FROM menus WHERE property_id = ? AND menu_date = ?', p.id, to)) return 'skipped';
  saveMenu(
    p,
    to,
    {
      special_dish: src.special_dish, notes: src.notes, breakfast_time: src.breakfast_time, lunch_time: src.lunch_time, dinner_time: src.dinner_time,
      items: src.items.map((i: Row) => ({ meal: i.meal, name: i.name, description: i.description, is_veg: !!i.is_veg, included: !!i.included, extra_charge: i.extra_charge, photo_url: i.photo_url })),
      publish: false,
    },
    userId,
  );
  return 'copied';
}

ownerRouter.post('/properties/:id/menus/copy', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const body = parse(z.object({ from_date: dateStr, to_dates: z.array(dateStr).min(1).max(31), overwrite: z.boolean().default(false) }), req.body);
  const today = todayIST();
  const result = tx(() =>
    body.to_dates.filter((d) => d !== body.from_date).map((d) => ({ date: d, result: d < today ? 'skipped' : copyMenu(p, body.from_date, d, body.overwrite, uid(req)) })),
  );
  res.json({ results: result });
});

ownerRouter.post('/properties/:id/menus/copy-week', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const body = parse(z.object({ from_start: dateStr, to_start: dateStr, overwrite: z.boolean().default(false) }), req.body);
  if (Math.abs(diffDays(body.from_start, body.to_start)) < 7) throw badRequest('Target week must not overlap the source week');
  const today = todayIST();
  const result = tx(() =>
    Array.from({ length: 7 }, (_, i) => {
      const to = addDays(body.to_start, i);
      return { date: to, result: to < today ? 'skipped' : copyMenu(p, addDays(body.from_start, i), to, body.overwrite, uid(req)) };
    }),
  );
  res.json({ results: result });
});

ownerRouter.post('/properties/:id/menus/publish-range', (req, res) => {
  const p = owned(Number(req.params.id), uid(req));
  const body = parse(z.object({ dates: z.array(dateStr).min(1).max(31) }), req.body);
  const now = nowIso();
  const n = tx(() => {
    let count = 0;
    for (const d of body.dates) {
      const m = get('SELECT id FROM menus WHERE property_id = ? AND menu_date = ? AND EXISTS (SELECT 1 FROM menu_items WHERE menu_id = menus.id)', p.id, d);
      if (m) count += run("UPDATE menus SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?", now, now, m.id).changes;
    }
    return count;
  });
  res.json({ published: n });
});

ownerRouter.post('/menu-photo', photoUpload.single('photo'), (req, res) => {
  const f = req.file;
  if (!f) throw badRequest('Choose a photo');
  assertFileSignature(f.path, f.mimetype);
  res.status(201).json({ url: `/uploads/photos/${f.filename}` });
});

// ---------- Coupons ----------
const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4,20}$/, '4–20 letters or digits'),
  description: z.string().trim().max(200).optional(),
  property_id: id,
  discount_type: z.enum(['percent', 'flat']),
  value: z.number().int().min(1),
  max_discount: z.number().int().min(1).nullable().optional(),
  min_amount: z.number().int().min(0).default(0),
  valid_from: dateStr,
  valid_to: dateStr,
  usage_limit: z.number().int().min(1).nullable().optional(),
  active: bool.default(1),
});

ownerRouter.get('/coupons', (req, res) => {
  res.json(all('SELECT c.*, p.name property_name FROM coupons c JOIN properties p ON p.id = c.property_id WHERE p.owner_id = ? ORDER BY c.id DESC', uid(req)));
});
ownerRouter.post('/coupons', (req, res) => {
  const body = parse(couponSchema, req.body);
  owned(body.property_id, uid(req));
  if (body.discount_type === 'percent' && body.value > 50) throw badRequest('Percentage discounts are capped at 50%');
  if (body.valid_to < body.valid_from) throw badRequest('End date must be after start date');
  const cid = run(
    'INSERT INTO coupons (code, description, property_id, owner_id, discount_type, value, max_discount, min_amount, valid_from, valid_to, usage_limit, active, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    body.code, body.description ?? null, body.property_id, uid(req), body.discount_type, body.value, body.max_discount ?? null, body.min_amount, body.valid_from, body.valid_to, body.usage_limit ?? null, body.active, uid(req),
  ).id;
  res.status(201).json(get('SELECT * FROM coupons WHERE id = ?', cid));
});
ownerRouter.patch('/coupons/:id', (req, res) => {
  const c = get('SELECT c.* FROM coupons c JOIN properties p ON p.id = c.property_id WHERE c.id = ? AND p.owner_id = ?', Number(req.params.id), uid(req));
  if (!c) throw notFound('Coupon');
  const body = parse(z.object({ active: bool.optional(), valid_to: dateStr.optional(), usage_limit: z.number().int().min(1).nullable().optional() }), req.body);
  run('UPDATE coupons SET active = ?, valid_to = ?, usage_limit = ? WHERE id = ?', body.active ?? c.active, body.valid_to ?? c.valid_to, body.usage_limit === undefined ? c.usage_limit : body.usage_limit, c.id);
  res.json(get('SELECT * FROM coupons WHERE id = ?', c.id));
});

// ---------- Earnings & payouts ----------
ownerRouter.get('/earnings', (req, res) => {
  const L = inList(ownerPropIds(uid(req)));
  const summary = get(
    `SELECT
       COALESCE(SUM(CASE WHEN pm.status = 'paid' THEN pm.amount END),0) collected,
       COALESCE(SUM(CASE WHEN pm.status = 'paid' THEN b.deposit END),0) deposits,
       COALESCE(SUM(CASE WHEN pm.status = 'paid' AND b.status != 'cancelled' THEN b.commission_amount END),0) commission
     FROM payments pm JOIN bookings b ON b.id = pm.booking_id WHERE b.property_id IN (${L})`,
  )!;
  const refunds = get<{ s: number }>(`SELECT COALESCE(SUM(r.amount),0) s FROM refunds r JOIN bookings b ON b.id = r.booking_id WHERE b.property_id IN (${L}) AND r.status != 'failed'`)!.s;
  const paidOut = get<{ s: number }>("SELECT COALESCE(SUM(net_amount),0) s FROM payouts WHERE owner_id = ? AND status = 'paid'", uid(req))!.s;
  const pendingPayout = get<{ s: number }>("SELECT COALESCE(SUM(net_amount),0) s FROM payouts WHERE owner_id = ? AND status IN ('pending','processing')", uid(req))!.s;
  const net = summary.collected - refunds - summary.commission;
  res.json({
    summary: { ...summary, refunds, net, paid_out: paidOut, pending_payout: pendingPayout, unsettled: Math.max(0, net - paidOut - pendingPayout) },
    monthly: all(
      `SELECT strftime('%Y-%m', pm.paid_at) month, SUM(pm.amount) collected, SUM(b.commission_amount) commission, COUNT(*) payments
       FROM payments pm JOIN bookings b ON b.id = pm.booking_id WHERE b.property_id IN (${L}) AND pm.status = 'paid' GROUP BY month ORDER BY month DESC LIMIT 12`,
    ),
    transactions: all(
      `SELECT pm.id, pm.amount, pm.status, pm.method, pm.provider_payment_id, pm.paid_at, pm.created_at, b.code, b.guest_name, b.commission_amount, b.deposit, p.name property_name
       FROM payments pm JOIN bookings b ON b.id = pm.booking_id JOIN properties p ON p.id = b.property_id WHERE b.property_id IN (${L}) ORDER BY pm.id DESC LIMIT 100`,
    ),
    payouts: all('SELECT * FROM payouts WHERE owner_id = ? ORDER BY period_end DESC', uid(req)),
    bank: get('SELECT bank_account_name, bank_account_last4, ifsc, upi_id FROM owner_profiles WHERE user_id = ?', uid(req)),
  });
});

// ---------- Reviews ----------
ownerRouter.get('/reviews', (req, res) => {
  const L = inList(ownerPropIds(uid(req)));
  res.json({
    items: all(
      `SELECT r.*, u.name customer_name, p.name property_name, b.code booking_code, b.stay_type FROM reviews r JOIN users u ON u.id = r.customer_id
       JOIN properties p ON p.id = r.property_id JOIN bookings b ON b.id = r.booking_id WHERE r.property_id IN (${L}) ORDER BY r.created_at DESC`,
    ),
    summary: get(
      `SELECT AVG(rating) avg, COUNT(*) n, AVG(cleanliness) cleanliness, AVG(food) food, AVG(location) location, AVG(safety) safety,
         SUM(CASE WHEN owner_reply IS NULL THEN 1 ELSE 0 END) unanswered FROM reviews WHERE property_id IN (${L}) AND status = 'published'`,
    ),
    distribution: all(`SELECT rating, COUNT(*) c FROM reviews WHERE property_id IN (${L}) AND status = 'published' GROUP BY rating`),
  });
});
ownerRouter.post('/reviews/:id/reply', (req, res) => {
  const { reply } = parse(z.object({ reply: z.string().trim().min(2).max(1000) }), req.body);
  const r = get('SELECT r.* FROM reviews r JOIN properties p ON p.id = r.property_id WHERE r.id = ? AND p.owner_id = ?', Number(req.params.id), uid(req));
  if (!r) throw notFound('Review');
  run('UPDATE reviews SET owner_reply = ?, owner_replied_at = ? WHERE id = ?', reply, nowIso(), r.id);
  notify(r.customer_id, 'review', 'The property replied to your review', reply.slice(0, 100), '/account/reviews');
  res.json({ ok: true });
});
ownerRouter.post('/reviews/:id/report', (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
  const r = get('SELECT r.* FROM reviews r JOIN properties p ON p.id = r.property_id WHERE r.id = ? AND p.owner_id = ?', Number(req.params.id), uid(req));
  if (!r) throw notFound('Review');
  run('INSERT OR IGNORE INTO review_reports (review_id, reporter_id, reason) VALUES (?, ?, ?)', r.id, uid(req), reason);
  notifyAdmins('review', 'Review reported by owner', reason.slice(0, 100), '/admin/reviews');
  res.json({ ok: true });
});

// ---------- Guests ----------
ownerRouter.get('/guests', (req, res) => {
  const L = inList(ownerPropIds(uid(req)));
  res.json(
    all(
      `SELECT u.id, u.name, u.email, u.phone, COUNT(b.id) stays, SUM(b.nights) nights, MAX(b.check_out) last_stay,
         SUM(CASE WHEN b.payment_status IN ('paid','partially_refunded') THEN b.total_amount ELSE 0 END) spent,
         MAX(CASE WHEN b.status = 'checked_in' THEN 1 ELSE 0 END) in_house,
         (SELECT b2.code FROM bookings b2 WHERE b2.customer_id = u.id AND b2.property_id IN (${L}) ORDER BY b2.check_in DESC LIMIT 1) latest_code
       FROM bookings b JOIN users u ON u.id = b.customer_id
       WHERE b.property_id IN (${L}) AND b.status IN ('confirmed','checked_in','completed') GROUP BY u.id ORDER BY in_house DESC, last_stay DESC`,
    ),
  );
});

// ---------- Analytics ----------
ownerRouter.get('/analytics', (req, res) => {
  const L = inList(ownerPropIds(uid(req)));
  const ok = "b.status IN ('confirmed','checked_in','completed')";
  res.json({
    monthly: all(
      `SELECT strftime('%Y-%m', b.check_in) month, COUNT(*) bookings, SUM(b.total_amount) revenue, SUM(b.nights) nights
       FROM bookings b WHERE b.property_id IN (${L}) AND ${ok} GROUP BY month ORDER BY month DESC LIMIT 12`,
    ).reverse(),
    by_stay_type: all(`SELECT stay_type label, COUNT(*) c, SUM(total_amount) revenue FROM bookings b WHERE property_id IN (${L}) AND ${ok} GROUP BY stay_type`),
    by_room_type: all(`SELECT r.room_type label, COUNT(*) c, SUM(b.total_amount) revenue FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE b.property_id IN (${L}) AND ${ok} GROUP BY r.room_type`),
    by_property: all(
      `SELECT p.name label, COUNT(b.id) c, COALESCE(SUM(b.total_amount),0) revenue, p.rating_avg FROM properties p LEFT JOIN bookings b ON b.property_id = p.id AND ${ok} WHERE p.id IN (${L}) GROUP BY p.id`,
    ),
    stats: get(
      `SELECT AVG(CASE WHEN ${ok} THEN nights END) avg_nights,
         100.0 * SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) / MAX(1, SUM(CASE WHEN status NOT IN ('expired','rejected') THEN 1 ELSE 0 END)) cancel_rate,
         AVG(CASE WHEN ${ok} THEN total_amount END) avg_value,
         COUNT(DISTINCT CASE WHEN ${ok} THEN customer_id END) unique_guests
       FROM bookings b WHERE property_id IN (${L})`,
    ),
    lead_time: all(
      `SELECT CASE WHEN d < 1 THEN 'Same day' WHEN d < 3 THEN '1–2 days' WHEN d < 8 THEN '3–7 days' ELSE '8+ days' END label, COUNT(*) c
       FROM (SELECT julianday(check_in) - julianday(date(created_at)) d FROM bookings b WHERE property_id IN (${L}) AND ${ok}) GROUP BY label`,
    ),
  });
});
