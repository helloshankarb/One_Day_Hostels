import { test, before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { ref, uploadBytes, getBytes } from 'firebase/storage';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let env: RulesTestEnvironment;

const property = (over: Record<string, unknown> = {}) => ({
  ownerId: 'owner1', name: 'Test PG', slug: 'test-pg', localityId: 'siripuram', localityName: 'Siripuram', address: 'Siripuram', description: '',
  accommodationType: 'pg', genderPolicy: 'coed', foodType: 'pure_veg', status: 'draft', verified: false, instantBook: true,
  allowDaily: true, allowWeekly: true, allowMonthly: true, minStayDays: 1, cancellationPolicy: 'flexible', houseRules: '',
  checkInTime: '12:00', checkOutTime: '11:00', mealTimes: { breakfast: '', lunch: '', dinner: '' }, photos: [], amenityIds: [],
  ratingAvg: 0, ratingCount: 0, pricing: { minDaily: null, minWeekly: null, minMonthly: null, hasAc: false, roomTypes: [], totalBeds: 0 },
  createdAt: 1, updatedAt: 1, ...over,
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT ?? 'demo-odh-test',
    firestore: { rules: fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8') },
    storage: { rules: fs.readFileSync(path.join(root, 'storage.rules'), 'utf8') },
  });
});
after(async () => {
  await env?.cleanup();
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'catalog/listings'), { items: [], updatedAt: 1, version: 1 });
    await setDoc(doc(db, 'properties/live-pg'), property({ slug: 'live-pg', status: 'approved', ownerId: 'owner1' }));
    await setDoc(doc(db, 'properties/draft-pg'), property({ slug: 'draft-pg', status: 'draft', ownerId: 'owner2' }));
    await setDoc(doc(db, 'properties/live-pg/menus/2030-01-01'), { status: 'published', items: [] });
    await setDoc(doc(db, 'properties/live-pg/menus/2030-01-02'), { status: 'draft', items: [] });
    await setDoc(doc(db, 'properties/live-pg/reviews/b1'), { status: 'published', rating: 5 });
    await setDoc(doc(db, 'users/cust1'), { uid: 'cust1', name: 'Guest', phone: '9876543210', role: 'customer' });
    await setDoc(doc(db, 'bookings/bk1'), { customerId: 'cust1', ownerId: 'owner1' });
  });
});

const anon = () => env.unauthenticatedContext().firestore();
const as = (uid: string, role: string, extra: Record<string, string> = {}) => env.authenticatedContext(uid, { role, ...extra }).firestore();

test('catalog and reference data are public read-only', async () => {
  await assertSucceeds(getDoc(doc(anon(), 'catalog/listings')));
  await assertFails(setDoc(doc(as('owner1', 'owner'), 'catalog/listings'), { items: [] }));
  await assertSucceeds(getDoc(doc(anon(), 'localities/siripuram')));
  await assertFails(setDoc(doc(as('owner1', 'owner'), 'localities/x'), { name: 'X' }));
  await assertSucceeds(setDoc(doc(as('adm', 'admin'), 'localities/x'), { name: 'X' }));
});

test('property visibility: approved public, drafts only to their owner or admins', async () => {
  await assertSucceeds(getDoc(doc(anon(), 'properties/live-pg')));
  await assertFails(getDoc(doc(anon(), 'properties/draft-pg')));
  await assertFails(getDoc(doc(as('owner1', 'owner'), 'properties/draft-pg')));
  await assertSucceeds(getDoc(doc(as('owner2', 'owner'), 'properties/draft-pg')));
  await assertSucceeds(getDoc(doc(as('adm', 'admin'), 'properties/draft-pg')));
  await assertSucceeds(getDoc(doc(anon(), 'properties/does-not-exist')));
});

test('owners create drafts only, and cannot self-approve or verify', async () => {
  const o = as('owner3', 'owner');
  await assertSucceeds(setDoc(doc(o, 'properties/new-pg'), property({ ownerId: 'owner3', slug: 'new-pg' })));
  await assertFails(setDoc(doc(o, 'properties/new-pg-2'), property({ ownerId: 'owner3', slug: 'new-pg-2', status: 'approved' })));
  await assertFails(setDoc(doc(o, 'properties/new-pg-3'), property({ ownerId: 'owner3', slug: 'new-pg-3', verified: true })));
  await assertFails(setDoc(doc(o, 'properties/new-pg-4'), property({ ownerId: 'someone-else', slug: 'new-pg-4' })));
  await assertFails(setDoc(doc(as('cust1', 'customer'), 'properties/c-pg'), property({ ownerId: 'cust1', slug: 'c-pg' })));
  await assertSucceeds(updateDoc(doc(o, 'properties/new-pg'), { description: 'Updated', updatedAt: 2 }));
  await assertFails(updateDoc(doc(o, 'properties/new-pg'), { status: 'approved' }));
  await assertFails(updateDoc(doc(o, 'properties/new-pg'), { ratingAvg: 5 }));
  await assertFails(updateDoc(doc(as('owner1', 'owner'), 'properties/draft-pg'), { description: 'hijack' }));
  await assertSucceeds(updateDoc(doc(as('adm', 'admin'), 'properties/draft-pg'), { status: 'approved' }));
  await assertSucceeds(deleteDoc(doc(o, 'properties/new-pg')));
});

test('menus: public sees only published menus of live listings; owners cannot publish directly', async () => {
  await assertSucceeds(getDoc(doc(anon(), 'properties/live-pg/menus/2030-01-01')));
  await assertFails(getDoc(doc(anon(), 'properties/live-pg/menus/2030-01-02')));
  await assertSucceeds(getDoc(doc(as('owner1', 'owner'), 'properties/live-pg/menus/2030-01-02')));
  await assertSucceeds(setDoc(doc(as('owner1', 'owner'), 'properties/live-pg/menus/2030-01-03'), { status: 'draft', items: [] }));
  await assertFails(setDoc(doc(as('owner1', 'owner'), 'properties/live-pg/menus/2030-01-04'), { status: 'published', items: [] }));
  await assertFails(setDoc(doc(as('owner2', 'owner'), 'properties/live-pg/menus/2030-01-05'), { status: 'draft', items: [] }));
});

test('users cannot create profiles or change their role', async () => {
  const c = as('cust1', 'customer');
  await assertSucceeds(getDoc(doc(c, 'users/cust1')));
  await assertFails(getDoc(doc(c, 'users/owner1')));
  await assertFails(setDoc(doc(as('new', 'customer'), 'users/new'), { role: 'admin' }));
  await assertSucceeds(updateDoc(doc(c, 'users/cust1'), { name: 'Guest Two', phone: '9876543211', updatedAt: 2 }));
  await assertFails(updateDoc(doc(c, 'users/cust1'), { role: 'admin' }));
  await assertFails(updateDoc(doc(c, 'users/cust1'), { phone: '12345' }));
});

test('saved properties are private and limited to live listings', async () => {
  const c = as('cust1', 'customer');
  await assertSucceeds(setDoc(doc(c, 'users/cust1/saved/live-pg'), { propertyId: 'live-pg', createdAt: 1 }));
  await assertFails(setDoc(doc(c, 'users/cust1/saved/draft-pg'), { propertyId: 'draft-pg', createdAt: 1 }));
  await assertFails(setDoc(doc(c, 'users/cust1/saved/live-pg'), { propertyId: 'live-pg', createdAt: 1, extra: true }));
  await assertFails(setDoc(doc(as('cust2', 'customer'), 'users/cust1/saved/live-pg'), { propertyId: 'live-pg', createdAt: 1 }));
  await assertFails(getDoc(doc(as('cust2', 'customer'), 'users/cust1/saved/live-pg')));
});

test('server-only collections reject client writes', async () => {
  await assertSucceeds(getDoc(doc(as('cust1', 'customer'), 'bookings/bk1')));
  await assertFails(getDoc(doc(as('cust2', 'customer'), 'bookings/bk1')));
  await assertFails(setDoc(doc(as('cust1', 'customer'), 'bookings/bk2'), { customerId: 'cust1' }));
  await assertFails(setDoc(doc(as('cust1', 'customer'), 'properties/live-pg/reviews/b9'), { status: 'published', rating: 5 }));
  await assertFails(setDoc(doc(as('adm', 'admin'), 'payments/p1'), { amount: 1 }));
  await assertFails(getDoc(doc(as('cust1', 'customer'), 'auditLogs/x')));
});

test('storage: owners upload listing photos; documents stay private', async () => {
  const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const ownerSt = env.authenticatedContext('owner1', { role: 'owner' }).storage();
  const otherSt = env.authenticatedContext('owner2', { role: 'owner' }).storage();
  await assertSucceeds(uploadBytes(ref(ownerSt, 'properties/live-pg/photos/a.jpg'), img, { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(otherSt, 'properties/live-pg/photos/b.jpg'), img, { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(ownerSt, 'properties/live-pg/photos/c.exe'), img, { contentType: 'application/octet-stream' }));
  await assertSucceeds(uploadBytes(ref(ownerSt, 'properties/live-pg/documents/lease.pdf'), img, { contentType: 'application/pdf' }));
  await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), 'properties/live-pg/documents/lease.pdf')));
  await assertFails(getBytes(ref(otherSt, 'properties/live-pg/documents/lease.pdf')));
  await assertSucceeds(getBytes(ref(env.authenticatedContext('adm', { role: 'admin' }).storage(), 'properties/live-pg/documents/lease.pdf')));
});
