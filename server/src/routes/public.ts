import { Router } from 'express';
import { z } from 'zod';
import { all, get, run } from '../db/index.ts';
import { parse, notFound, dateStr, id } from '../lib/http.ts';
import { propertyCards, PROPERTY_SELECT, publishedMenu, menuWithItems, MEALS } from '../lib/catalog.ts';
import { availability, quoteFor, validateRange, expireHolds } from '../lib/bookings.ts';
import { POLICY_TEXT, type CancellationPolicy } from '../lib/pricing.ts';
import { todayIST, addDays, isValidDate } from '../lib/dates.ts';
import { getSetting } from '../lib/services.ts';

export const publicRouter = Router();

const list = (v: unknown) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

publicRouter.get('/meta', (_req, res) => {
  const localities = all(
    `SELECT l.id, l.name, l.slug, l.tagline,
       (SELECT COUNT(*) FROM properties p WHERE p.locality_id = l.id AND p.status = 'approved') property_count
     FROM localities l WHERE l.active = 1 ORDER BY l.sort, l.name`,
  );
  res.json({
    localities,
    amenities: all('SELECT * FROM amenities ORDER BY category, name'),
    gst_percent: getSetting('gst_percent', 5),
    support_phone: getSetting('support_phone', '1800-123-4567'),
    support_email: getSetting('support_email', 'support@onedayhostels.in'),
    policies: POLICY_TEXT,
    today: todayIST(),
  });
});

publicRouter.get('/home', (req, res) => {
  const today = todayIST();
  const featured = all(`${PROPERTY_SELECT} WHERE p.status = 'approved' ORDER BY p.verified DESC, p.rating_avg DESC, p.rating_count DESC LIMIT 4`);
  const highlights = all(
    `SELECT m.id, m.property_id, m.updated_at, m.published_at, m.special_dish, p.name property_name, p.slug, p.food_type, l.name locality
     FROM menus m JOIN properties p ON p.id = m.property_id JOIN localities l ON l.id = p.locality_id
     WHERE m.status = 'published' AND m.menu_date = ? AND p.status = 'approved' ORDER BY p.rating_avg DESC LIMIT 6`,
    today,
  ).map((m) => menuWithItems(m));
  const stats = get(
    `SELECT (SELECT COUNT(*) FROM properties WHERE status = 'approved') properties,
            (SELECT COUNT(*) FROM properties WHERE status = 'approved' AND verified = 1) verified,
            (SELECT COUNT(*) FROM menus WHERE status = 'published' AND menu_date = ?) menus_today,
            (SELECT COUNT(*) FROM beds bd JOIN rooms r ON r.id = bd.room_id JOIN properties p ON p.id = r.property_id WHERE p.status = 'approved' AND bd.active = 1) beds`,
    today,
  );
  const clusters = all(
    `SELECT gender_policy, COUNT(*) c FROM properties WHERE status = 'approved' GROUP BY gender_policy`,
  );
  res.json({ featured: propertyCards(featured, { userId: req.user?.id }), highlights, stats, clusters, today });
});

publicRouter.get('/properties', (req, res) => {
  expireHolds();
  const q = req.query as Record<string, string>;
  const where: string[] = ["p.status = 'approved'"];
  const params: any[] = [];
  if (q.q) {
    where.push('(p.name LIKE ? OR l.name LIKE ? OR p.address LIKE ?)');
    const like = `%${q.q.slice(0, 80)}%`;
    params.push(like, like, like);
  }
  const loc = list(q.locality);
  if (loc.length) {
    where.push(`l.slug IN (${loc.map(() => '?').join(',')})`);
    params.push(...loc);
  }
  const gender = list(q.gender).filter((g) => ['men', 'women', 'coed', 'family'].includes(g));
  if (gender.length) {
    where.push(`p.gender_policy IN (${gender.map(() => '?').join(',')})`);
    params.push(...gender);
  }
  const food = list(q.food).filter((f) => ['pure_veg', 'veg_meals', 'veg_nonveg', 'none'].includes(f));
  if (food.length) {
    where.push(`p.food_type IN (${food.map(() => '?').join(',')})`);
    params.push(...food);
  }
  if (q.diet === 'veg') where.push("p.food_type IN ('pure_veg','veg_meals','veg_nonveg')");
  if (q.diet === 'pure_veg') where.push("p.food_type = 'pure_veg'");
  if (q.diet === 'nonveg') where.push("p.food_type = 'veg_nonveg'");
  if (q.meals === '1') where.push("p.food_type != 'none'");
  if (q.verified === '1') where.push('p.verified = 1');
  if (q.min_rating) {
    where.push('p.rating_avg >= ?');
    params.push(Number(q.min_rating) || 0);
  }
  const stay = ['daily', 'weekly', 'monthly'].includes(q.stay) ? q.stay : null;
  if (stay) where.push(`p.allow_${stay} = 1`);
  for (const a of list(q.amenities).map(Number).filter(Number.isInteger)) {
    where.push('EXISTS (SELECT 1 FROM property_amenities pa WHERE pa.property_id = p.id AND pa.amenity_id = ?)');
    params.push(a);
  }
  const roomTypes = list(q.room_type).filter((t) => ['private', 'shared', 'dorm'].includes(t));
  const roomConds: string[] = ['r.active = 1'];
  const roomParams: any[] = [];
  if (roomTypes.length) {
    roomConds.push(`r.room_type IN (${roomTypes.map(() => '?').join(',')})`);
    roomParams.push(...roomTypes);
  }
  if (q.ac === '1' || q.ac === '0') {
    roomConds.push('r.ac = ?');
    roomParams.push(Number(q.ac));
  }
  const priceCol = stay === 'monthly' ? 'r.price_monthly' : stay === 'weekly' ? 'r.price_weekly' : 'r.price_daily';
  if (q.min_price) {
    roomConds.push(`${priceCol} >= ?`);
    roomParams.push(Number(q.min_price) || 0);
  }
  if (q.max_price) {
    roomConds.push(`${priceCol} <= ?`);
    roomParams.push(Number(q.max_price) || 0);
  }
  where.push(`EXISTS (SELECT 1 FROM rooms r WHERE r.property_id = p.id AND ${roomConds.join(' AND ')})`);
  params.push(...roomParams);

  let checkIn = isValidDate(q.check_in ?? '') ? q.check_in : undefined;
  let checkOut = isValidDate(q.check_out ?? '') ? q.check_out : undefined;
  if (checkIn && (!checkOut || checkOut <= checkIn)) checkOut = addDays(checkIn, 1);
  if (checkIn && checkIn < todayIST()) checkIn = checkOut = undefined;

  const rows = all(`${PROPERTY_SELECT} WHERE ${where.join(' AND ')}`, ...params);
  let cards = propertyCards(rows, { checkIn, checkOut, userId: req.user?.id });
  const minBeds = Number(q.beds) || 0;
  if (checkIn || minBeds) cards = cards.filter((c) => c.available_beds >= Math.max(1, minBeds));

  const priceOf = (c: (typeof cards)[number]) => (stay === 'monthly' ? c.min_monthly ?? c.min_daily * 30 : c.min_daily) ?? 0;
  const sort = q.sort ?? 'recommended';
  cards.sort((a, b) => {
    if (sort === 'price_asc') return priceOf(a) - priceOf(b);
    if (sort === 'price_desc') return priceOf(b) - priceOf(a);
    if (sort === 'rating') return b.rating_avg - a.rating_avg || b.rating_count - a.rating_count;
    if (sort === 'beds') return b.available_beds - a.available_beds;
    return Number(b.verified) - Number(a.verified) || b.rating_avg * Math.log(2 + b.rating_count) - a.rating_avg * Math.log(2 + a.rating_count);
  });
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = 9;
  const localityCounts = all(
    `SELECT l.slug, l.name, COUNT(p.id) c FROM localities l LEFT JOIN properties p ON p.locality_id = l.id AND p.status = 'approved' WHERE l.active = 1 GROUP BY l.id ORDER BY l.sort`,
  );
  res.json({ total: cards.length, page, pageSize, items: cards.slice((page - 1) * pageSize, page * pageSize), localityCounts });
});

function loadApproved(slug: string, userId?: number) {
  const p = get(`${PROPERTY_SELECT} WHERE p.slug = ?`, slug);
  // Owners may preview their own non-approved listings.
  if (!p || (p.status !== 'approved' && p.owner_id !== userId)) throw notFound('Property');
  return p;
}

publicRouter.get('/properties/:slug', (req, res) => {
  expireHolds();
  const p = loadApproved(req.params.slug, req.user?.id);
  const q = req.query as Record<string, string>;
  const checkIn = isValidDate(q.check_in ?? '') && q.check_in >= todayIST() ? q.check_in : todayIST();
  const checkOut = isValidDate(q.check_out ?? '') && q.check_out > checkIn ? q.check_out : addDays(checkIn, 1);
  const menuDate = isValidDate(q.menu_date ?? '') ? q.menu_date : todayIST();
  const [card] = propertyCards([p], { checkIn, checkOut, userId: req.user?.id });
  const owner = get('SELECT u.name, op.business_name FROM users u LEFT JOIN owner_profiles op ON op.user_id = u.id WHERE u.id = ?', p.owner_id);
  const breakdown = get(
    `SELECT AVG(cleanliness) cleanliness, AVG(food) food, AVG(location) location, AVG(safety) safety FROM reviews WHERE property_id = ? AND status = 'published'`,
    p.id,
  );
  const reviews = all(
    `SELECT r.id, r.rating, r.title, r.comment, r.owner_reply, r.owner_replied_at, r.created_at, u.name customer_name,
            b.stay_type, b.nights FROM reviews r JOIN users u ON u.id = r.customer_id JOIN bookings b ON b.id = r.booking_id
     WHERE r.property_id = ? AND r.status = 'published' ORDER BY r.created_at DESC LIMIT 10`,
    p.id,
  );
  const similar = propertyCards(
    all(`${PROPERTY_SELECT} WHERE p.status = 'approved' AND p.id != ? AND (p.locality_id = ? OR p.gender_policy = ?) ORDER BY p.rating_avg DESC LIMIT 3`, p.id, p.locality_id, p.gender_policy),
    { userId: req.user?.id },
  );
  res.json({
    ...card,
    description: p.description,
    landmark: p.landmark,
    pincode: p.pincode,
    status: p.status,
    instant_book: !!p.instant_book,
    allow_daily: !!p.allow_daily,
    allow_weekly: !!p.allow_weekly,
    allow_monthly: !!p.allow_monthly,
    min_stay_days: p.min_stay_days,
    cancellation_policy: p.cancellation_policy,
    cancellation_text: POLICY_TEXT[p.cancellation_policy as CancellationPolicy],
    house_rules: p.house_rules,
    check_in_time: p.check_in_time,
    check_out_time: p.check_out_time,
    gate_close_time: p.gate_close_time,
    meal_times: { breakfast: p.breakfast_time, lunch: p.lunch_time, dinner: p.dinner_time },
    contact_phone: p.contact_phone,
    latitude: p.latitude,
    longitude: p.longitude,
    photos: all('SELECT id, url, caption FROM property_photos WHERE property_id = ? ORDER BY sort, id', p.id),
    amenities: all('SELECT a.* FROM property_amenities pa JOIN amenities a ON a.id = pa.amenity_id WHERE pa.property_id = ? ORDER BY a.category, a.name', p.id),
    rooms: availability(p.id, checkIn, checkOut),
    stay: { check_in: checkIn, check_out: checkOut },
    menu: publishedMenu(p.id, menuDate),
    menu_date: menuDate,
    owner,
    rating_breakdown: breakdown,
    reviews,
    similar,
  });
});

publicRouter.get('/properties/:slug/availability', (req, res) => {
  expireHolds();
  const p = loadApproved(req.params.slug, req.user?.id);
  const q = parse(z.object({ check_in: dateStr, check_out: dateStr }), req.query);
  validateRange(q.check_in, q.check_out);
  res.json({ rooms: availability(p.id, q.check_in, q.check_out) });
});

publicRouter.get('/properties/:slug/menu', (req, res) => {
  const p = loadApproved(req.params.slug, req.user?.id);
  const start = isValidDate(String(req.query.start ?? '')) ? String(req.query.start) : todayIST();
  const days = Math.min(14, Math.max(1, Number(req.query.days) || 7));
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    out.push({ date: d, menu: publishedMenu(p.id, d) });
  }
  res.json({ meal_times: { breakfast: p.breakfast_time, lunch: p.lunch_time, dinner: p.dinner_time }, days: out });
});

publicRouter.post('/quote', (req, res) => {
  const body = parse(
    z.object({ property_id: id, room_id: id, check_in: dateStr, check_out: dateStr, coupon_code: z.string().max(40).optional().nullable() }),
    req.body,
  );
  validateRange(body.check_in, body.check_out);
  const { quote, coupon } = quoteFor(body.property_id, body.room_id, body.check_in, body.check_out, body.coupon_code);
  res.json({ ...quote, coupon: coupon ? { code: coupon.code, description: coupon.description } : null });
});

publicRouter.get('/menus', (req, res) => {
  const q = req.query as Record<string, string>;
  const date = isValidDate(q.date ?? '') ? q.date : todayIST();
  const where = ["m.status = 'published'", 'm.menu_date = ?', "p.status = 'approved'"];
  const params: any[] = [date];
  const loc = list(q.locality);
  if (loc.length) {
    where.push(`l.slug IN (${loc.map(() => '?').join(',')})`);
    params.push(...loc);
  }
  if (q.food === 'pure_veg') where.push("p.food_type = 'pure_veg'");
  if (q.food === 'nonveg') where.push("EXISTS (SELECT 1 FROM menu_items x WHERE x.menu_id = m.id AND x.is_veg = 0)");
  if (q.q) {
    where.push('(p.name LIKE ? OR EXISTS (SELECT 1 FROM menu_items x WHERE x.menu_id = m.id AND x.name LIKE ?))');
    const like = `%${q.q.slice(0, 80)}%`;
    params.push(like, like);
  }
  const meal = MEALS.includes(q.meal as any) ? q.meal : null;
  if (meal) {
    where.push('EXISTS (SELECT 1 FROM menu_items x WHERE x.menu_id = m.id AND x.meal = ?)');
    params.push(meal);
  }
  const rows = all(
    `SELECT m.*, p.name property_name, p.slug, p.food_type, p.rating_avg, p.rating_count, p.gender_policy, p.verified,
            p.breakfast_time p_breakfast, p.lunch_time p_lunch, p.dinner_time p_dinner, l.name locality, l.slug locality_slug
     FROM menus m JOIN properties p ON p.id = m.property_id JOIN localities l ON l.id = p.locality_id
     WHERE ${where.join(' AND ')} ORDER BY p.rating_avg DESC`,
    ...params,
  );
  const photos = all(`SELECT property_id, MIN(url) url FROM property_photos GROUP BY property_id`);
  const items = rows.map((r) => ({ ...menuWithItems(r), photo: photos.find((p) => p.property_id === r.property_id)?.url ?? null }));
  const counts = all(
    `SELECT l.slug, l.name, COUNT(m.id) c FROM localities l
     LEFT JOIN properties p ON p.locality_id = l.id AND p.status = 'approved'
     LEFT JOIN menus m ON m.property_id = p.id AND m.menu_date = ? AND m.status = 'published'
     WHERE l.active = 1 GROUP BY l.id HAVING c > 0 ORDER BY c DESC`,
    date,
  );
  res.json({ date, total: items.length, items, counts });
});

publicRouter.post('/contact', (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(80),
      email: z.email().trim(),
      phone: z.string().trim().max(20).optional(),
      message: z.string().trim().min(10, 'Please write at least 10 characters').max(2000),
    }),
    req.body,
  );
  run('INSERT INTO contact_messages (name, email, phone, message) VALUES (?, ?, ?, ?)', body.name, body.email, body.phone ?? null, body.message);
  res.status(201).json({ ok: true });
});
