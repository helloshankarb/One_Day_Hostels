import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { PROJECT, signUp, signIn, claims, call, waitFor, clearFirestore } from './helpers.ts';

if (!getApps().length) initializeApp({ projectId: PROJECT });
const db = getFirestore();

before(async () => {
  await clearFirestore();
});

test('completeProfile creates the profile, sets the role claim and locks the role', async () => {
  const email = `guest${Date.now()}@example.in`;
  const { idToken, localId } = await signUp(email);

  const unauth = await call('completeProfile', { name: 'Guest', phone: '9876543210' });
  assert.equal(unauth.error?.status, 'UNAUTHENTICATED');

  const bad = await call('completeProfile', { name: 'G', phone: '12345' }, idToken);
  assert.equal(bad.error?.status, 'INVALID_ARGUMENT');
  assert.ok(bad.error?.details?.fields?.phone);

  // The web SDK encodes omitted optional fields as null; that must be accepted.
  const ok = await call('completeProfile', { name: 'Guest User', phone: '9876543210', role: 'customer', businessName: null }, idToken);
  assert.equal(ok.result?.role, 'customer', JSON.stringify(ok));
  const profile = (await db.collection('users').doc(localId).get()).data();
  assert.equal(profile?.role, 'customer');
  assert.equal(profile?.email, email);
  assert.equal(claims(await signIn(email)).role, 'customer');

  const again = await call('completeProfile', { name: 'Guest User', phone: '9876543210', role: 'owner' }, idToken);
  assert.equal(again.result?.role, 'customer', 'role cannot be changed by re-calling');
  assert.equal((await db.collection('ownerProfiles').doc(localId).get()).exists, false);
});

test('owner registration creates an owner profile', async () => {
  const email = `owner${Date.now()}@example.in`;
  const { idToken, localId } = await signUp(email);
  const ok = await call('completeProfile', { name: 'Owner One', phone: '+91 9876543210', role: 'owner', businessName: 'Vizag Stays' }, idToken);
  assert.equal(ok.result?.role, 'owner');
  const op = (await db.collection('ownerProfiles').doc(localId).get()).data();
  assert.equal(op?.kycStatus, 'pending');
  assert.equal(claims(await signIn(email)).role, 'owner');
});

test('setUserRole is restricted to super admins', async () => {
  const { idToken } = await signUp(`plain${Date.now()}@example.in`);
  await call('completeProfile', { name: 'Plain', phone: '9876543210' }, idToken);
  const r = await call('setUserRole', { uid: 'x', role: 'admin' }, idToken);
  assert.equal(r.error?.status, 'PERMISSION_DENIED');
});

test('catalog trigger lists approved properties and pricing trigger summarises rooms', async () => {
  const ref = db.collection('properties').doc('trigger-test-pg');
  await ref.set({
    ownerId: 'o1', name: 'Trigger Test PG', slug: 'trigger-test-pg', localityId: 'siripuram', localityName: 'Siripuram', address: 'x', description: '',
    accommodationType: 'pg', genderPolicy: 'coed', foodType: 'veg_nonveg', status: 'approved', verified: true, instantBook: true,
    allowDaily: true, allowWeekly: true, allowMonthly: true, minStayDays: 1, cancellationPolicy: 'flexible', houseRules: '',
    checkInTime: '12:00', checkOutTime: '11:00', mealTimes: { breakfast: '', lunch: '', dinner: '' }, photos: [], amenityIds: [],
    ratingAvg: 0, ratingCount: 0, pricing: { minDaily: null, minWeekly: null, minMonthly: null, hasAc: false, roomTypes: [], totalBeds: 0 },
    createdAt: 1, updatedAt: 1, approvedAt: 1,
  });
  await waitFor(async () => {
    const items = ((await db.doc('catalog/listings').get()).data()?.items ?? []) as any[];
    return items.some((i) => i.id === 'trigger-test-pg') ? true : undefined;
  });

  await ref.collection('rooms').doc('D1').set({
    code: 'D1', name: 'Double', roomType: 'shared', capacity: 2, ac: true, attachedBath: true, priceDaily: 450, priceWeekly: 2800, priceMonthly: 8500,
    deposit: 2000, mealsIncluded: true, features: '', description: '', active: true, beds: [{ id: 'D1-A', label: 'D1-A', active: true }, { id: 'D1-B', label: 'D1-B', active: true }],
  });
  const listed = await waitFor(async () => {
    const items = ((await db.doc('catalog/listings').get()).data()?.items ?? []) as any[];
    const it = items.find((i) => i.id === 'trigger-test-pg');
    return it?.minDaily === 450 ? it : undefined;
  });
  assert.equal(listed.totalBeds, 2);
  assert.equal(listed.minMonthly, 8500);
  assert.equal(listed.hasAc, true);

  await ref.update({ status: 'suspended' });
  await waitFor(async () => {
    const items = ((await db.doc('catalog/listings').get()).data()?.items ?? []) as any[];
    return items.some((i) => i.id === 'trigger-test-pg') ? undefined : true;
  });
});
