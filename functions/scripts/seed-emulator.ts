/**
 * Seeds the Firebase emulators with Visakhapatnam demo data (reusing the legacy server fixtures).
 * Usage: start emulators, then `npm run seed -w functions`.
 * Refuses to run against a real project.
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { LOCALITIES, AMENITIES, PROPS, MENU, REVIEWS, CUSTOMERS, RULES } from '../../server/src/db/seed.ts';
import {
  slugify, pricingSummary, toListing, todayIST, addDays, CATALOG_VERSION,
  type PropertyDoc, type RoomDoc, type MenuDoc, type MenuItem, type Meal, type ReviewDoc,
} from '../../shared/model.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8085';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
}
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-one-day-hostels';
if (!projectId.startsWith('demo-')) {
  console.error('Refusing to seed a non-demo project. Use the emulators (project id must start with "demo-").');
  process.exit(1);
}

initializeApp({ projectId });
const db = getFirestore();
const auth = getAuth();

let seed = 20261029;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

async function ensureUser(email: string, password: string, name: string, role: 'customer' | 'owner' | 'admin', adminRole?: string) {
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    user = await auth.createUser({ email, password, displayName: name, emailVerified: true });
  }
  await auth.setCustomUserClaims(user.uid, adminRole ? { role, adminRole } : { role });
  await db.collection('users').doc(user.uid).set({
    uid: user.uid, email, name, phone: '98' + String(10000000 + Math.floor(rand() * 89999999)), role, status: 'active', createdAt: Date.now(),
  });
  if (role === 'owner') {
    await db.collection('ownerProfiles').doc(user.uid).set({ businessName: `${name} Stays`, kycStatus: 'verified', onboardingStep: 4, createdAt: Date.now() });
  }
  return user.uid;
}

async function main() {
  if ((await db.collection('localities').limit(1).get()).size && !process.argv.includes('--force')) {
    console.log('Emulator already seeded (use --force to re-seed).');
    return;
  }
  const today = todayIST();

  const batch = db.batch();
  LOCALITIES.forEach(([name, tagline], i) => batch.set(db.collection('localities').doc(slugify(name)), { name, tagline, sort: i, active: true }));
  AMENITIES.forEach(([name, icon, category]) => batch.set(db.collection('amenities').doc(slugify(name)), { name, icon, category }));
  batch.set(db.collection('settings').doc('platform'), { commissionPercent: 10, gstPercent: 5, supportPhone: '1800-123-4567', supportEmail: 'support@onedayhostels.in' });
  await batch.commit();

  await ensureUser('admin@onedayhostels.in', 'Admin@12345', 'Platform Admin', 'admin', 'super_admin');
  const owners: Record<string, string> = {
    ramesh: await ensureUser('owner@onedayhostels.in', 'Owner@12345', 'Ramesh Varma', 'owner'),
    lakshmi: await ensureUser('lakshmi@example.in', 'Owner@12345', 'Lakshmi Devi', 'owner'),
    rambabu: await ensureUser('rambabu@example.in', 'Owner@12345', 'M. Rambabu', 'owner'),
    suresh: await ensureUser('suresh@example.in', 'Owner@12345', 'Suresh Varma', 'owner'),
  };
  await ensureUser('customer@onedayhostels.in', 'Customer@123', 'Demo Guest', 'customer');

  const listings = [];
  for (const pd of PROPS) {
    const id = slugify(pd.name);
    const created = Date.now() - Math.floor(90 + rand() * 60) * 86400000;
    const rooms: RoomDoc[] = pd.rooms.map(([code, name, roomType, capacity, ac, daily, weekly, monthly, deposit, features]) => ({
      code, name, roomType, capacity, ac: !!ac, attachedBath: features.includes('ttached'), priceDaily: daily, priceWeekly: weekly, priceMonthly: monthly,
      deposit, mealsIncluded: pd.food !== 'none', features, description: '', active: true,
      beds: Array.from({ length: roomType === 'private' ? 1 : capacity }, (_, i) => ({
        id: roomType === 'private' ? code : `${code}-${String.fromCharCode(65 + i)}`,
        label: roomType === 'private' ? code : `${code}-${String.fromCharCode(65 + i)}`,
        active: true,
      })),
    }));

    const reviews: ReviewDoc[] = [];
    if (pd.status === 'approved') {
      const n = 3 + Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        const [cname, , gender] = pick(CUSTOMERS);
        if ((pd.gender === 'women' && gender !== 'female') || (pd.gender === 'men' && gender !== 'male')) continue;
        const rating = rand() < 0.7 ? 5 : 4;
        reviews.push({
          customerName: cname, rating, cleanliness: rating, food: pd.food === 'none' ? null : rating, location: 5, safety: rating,
          comment: pick(REVIEWS), ownerReply: rand() < 0.3 ? 'Thank you for staying with us!' : null, status: 'published',
          stayType: pick(['daily', 'weekly', 'monthly'] as const), createdAt: Date.now() - Math.floor(rand() * 60) * 86400000,
        });
      }
    }
    const ratingAvg = reviews.length ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 100) / 100 : 0;

    const property: PropertyDoc = {
      ownerId: owners[pd.owner], name: pd.name, slug: id, localityId: slugify(pd.locality), localityName: pd.locality,
      address: pd.address, pincode: pd.pincode, landmark: pd.landmark, description: pd.description,
      accommodationType: pd.type, genderPolicy: pd.gender, foodType: pd.food, status: pd.status as PropertyDoc['status'], statusReason: null,
      verified: !!pd.verified, instantBook: pd.instant !== 0, allowDaily: pd.daily !== 0, allowWeekly: true, allowMonthly: pd.monthly !== 0,
      minStayDays: 1, cancellationPolicy: pd.policy, houseRules: RULES, checkInTime: '12:00', checkOutTime: '11:00', gateCloseTime: pd.gate ?? '22:30',
      mealTimes: { breakfast: '07:30-09:30', lunch: '12:30-14:30', dinner: '19:30-21:30' }, contactPhone: '+91 891 278 4490',
      photos: pd.photos.map((p) => ({ url: `/images/${p}.png`, caption: null, path: null })), amenityIds: pd.amenities.map(slugify),
      ratingAvg, ratingCount: reviews.length, pricing: pricingSummary(rooms), createdAt: created, updatedAt: created,
      approvedAt: pd.status === 'approved' ? created + 5 * 86400000 : null,
    };
    const ref = db.collection('properties').doc(id);
    const b = db.batch();
    b.set(ref, property);
    rooms.forEach((r) => b.set(ref.collection('rooms').doc(r.code), r));
    reviews.forEach((r, i) => b.set(ref.collection('reviews').doc(`seed-${i}`), { ...r, seeded: true }));

    if (pd.food !== 'none' && pd.status === 'approved') {
      const nonVegAllowed = pd.food === 'veg_nonveg';
      for (let d = -1; d <= 6; d++) {
        if (d === 4) continue; // leave a gap so owners see a missing-menu warning
        const date = addDays(today, d);
        const dow = new Date(date + 'T00:00:00Z').getUTCDay();
        const nonVegDay = nonVegAllowed && [0, 3, 5].includes(dow);
        const items: MenuItem[] = [];
        for (const meal of ['breakfast', 'lunch', 'dinner'] as Meal[]) {
          [...MENU[meal].veg].sort(() => rand() - 0.5).slice(0, meal === 'lunch' ? 5 : 3)
            .forEach((name) => items.push({ meal, name, isVeg: true, included: true, extraCharge: 0 }));
          if (nonVegDay && meal !== 'breakfast') items.push({ meal, name: pick(MENU[meal].nonveg), isVeg: false, included: true, extraCharge: 0 });
        }
        const menu: MenuDoc = {
          date, status: d <= 1 ? 'published' : 'draft',
          specialDish: nonVegDay ? (dow === 0 ? 'Sunday Andhra Chicken Dum Biryani' : 'Guntur Chicken Curry') : pick(['Gutti Vankaya Koora', 'Ghee Roast Podi Dosa', 'Semiya Payasam']),
          notes: null, items, updatedAt: Date.now(), publishedAt: d <= 1 ? Date.now() : null,
        };
        b.set(ref.collection('menus').doc(date), menu);
      }
    }
    await b.commit();
    if (pd.status === 'approved') listings.push(toListing(id, property));
  }

  await db.collection('catalog').doc('listings').set({ items: listings, updatedAt: Date.now(), version: CATALOG_VERSION });
  console.log(`Seeded ${PROPS.length} properties (${listings.length} approved).`);
  console.log('Logins: customer@onedayhostels.in / Customer@123 · owner@onedayhostels.in / Owner@12345 · admin@onedayhostels.in / Admin@12345');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
