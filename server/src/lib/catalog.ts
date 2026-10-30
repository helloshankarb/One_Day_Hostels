import { all, get, type Row } from '../db/index.ts';
import { ACTIVE_BOOKING } from './bookings.ts';
import { addDays, todayIST, nowIso } from './dates.ts';

export const MEALS = ['breakfast', 'lunch', 'dinner'] as const;

export function photosFor(ids: number[]) {
  if (!ids.length) return new Map<number, string[]>();
  const rows = all(`SELECT property_id, url FROM property_photos WHERE property_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort, id`, ...ids);
  const m = new Map<number, string[]>();
  for (const r of rows) m.set(r.property_id, [...(m.get(r.property_id) ?? []), r.url]);
  return m;
}

/** Enriches property rows with listing-card data: photos, prices, beds free for the stay window, amenities and today's menu. */
export function propertyCards(props: Row[], opts: { checkIn?: string; checkOut?: string; userId?: number } = {}) {
  if (!props.length) return [];
  const ids = props.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');
  const checkIn = opts.checkIn ?? todayIST();
  const checkOut = opts.checkOut ?? addDays(checkIn, 1);
  const photos = photosFor(ids);
  const prices = all(
    `SELECT property_id, MIN(price_daily) min_daily, MIN(price_weekly) min_weekly, MIN(price_monthly) min_monthly, MAX(ac) has_ac,
            GROUP_CONCAT(DISTINCT room_type) room_types
     FROM rooms WHERE active = 1 AND property_id IN (${ph}) GROUP BY property_id`,
    ...ids,
  );
  const free = all(
    `SELECT r.property_id, COUNT(*) total,
       SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM bookings b WHERE b.bed_id = bd.id AND ${ACTIVE_BOOKING} AND b.check_in < :out AND b.check_out > :in)
                 AND NOT EXISTS (SELECT 1 FROM bed_blocks k WHERE k.bed_id = bd.id AND k.start_date < :out AND k.end_date > :in) THEN 1 ELSE 0 END) free
     FROM beds bd JOIN rooms r ON r.id = bd.room_id
     WHERE bd.active = 1 AND r.active = 1 AND r.property_id IN (${ids.join(',')}) GROUP BY r.property_id`,
    { now: nowIso(), in: checkIn, out: checkOut },
  );
  const amen = all(
    `SELECT pa.property_id, a.name, a.icon FROM property_amenities pa JOIN amenities a ON a.id = pa.amenity_id WHERE pa.property_id IN (${ph}) ORDER BY a.id`,
    ...ids,
  );
  const today = todayIST();
  const menus = all(
    `SELECT m.property_id, mi.meal, mi.name, mi.is_veg FROM menus m JOIN menu_items mi ON mi.menu_id = m.id
     WHERE m.status = 'published' AND m.menu_date = ? AND m.property_id IN (${ph}) ORDER BY mi.sort, mi.id`,
    today,
    ...ids,
  );
  const saved = opts.userId
    ? new Set(all<{ property_id: number }>(`SELECT property_id FROM saved_properties WHERE user_id = ?`, opts.userId).map((r) => r.property_id))
    : new Set<number>();

  return props.map((p) => {
    const pr = prices.find((x) => x.property_id === p.id) ?? {};
    const fr = free.find((x) => x.property_id === p.id) ?? { total: 0, free: 0 };
    const items = menus.filter((m) => m.property_id === p.id);
    const meal = MEALS.find((m) => items.some((i) => i.meal === m));
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      locality: p.locality_name,
      locality_slug: p.locality_slug,
      address: p.address,
      accommodation_type: p.accommodation_type,
      gender_policy: p.gender_policy,
      food_type: p.food_type,
      verified: !!p.verified,
      rating_avg: p.rating_avg,
      rating_count: p.rating_count,
      photos: (photos.get(p.id) ?? []).slice(0, 5),
      min_daily: pr.min_daily ?? null,
      min_weekly: pr.min_weekly ?? null,
      min_monthly: pr.min_monthly ?? null,
      has_ac: !!pr.has_ac,
      room_types: pr.room_types ? String(pr.room_types).split(',') : [],
      total_beds: fr.total,
      available_beds: fr.free ?? 0,
      amenities: amen.filter((a) => a.property_id === p.id).map((a) => ({ name: a.name, icon: a.icon })),
      today_menu: meal ? { meal, items: items.filter((i) => i.meal === meal).map((i) => ({ name: i.name, is_veg: !!i.is_veg })) } : null,
      saved: saved.has(p.id),
    };
  });
}

export const PROPERTY_SELECT = `SELECT p.*, l.name locality_name, l.slug locality_slug FROM properties p JOIN localities l ON l.id = p.locality_id`;

export function menuWithItems(menu: Row | undefined): (Row & { items: Row[] }) | null {
  if (!menu) return null;
  const items = all('SELECT * FROM menu_items WHERE menu_id = ? ORDER BY meal, sort, id', menu.id);
  return {
    ...menu,
    items: items.map((i) => ({ ...i, is_veg: !!i.is_veg, included: !!i.included })),
  };
}

export function publishedMenu(propertyId: number, date: string) {
  return menuWithItems(get("SELECT * FROM menus WHERE property_id = ? AND menu_date = ? AND status = 'published'", propertyId, date));
}
