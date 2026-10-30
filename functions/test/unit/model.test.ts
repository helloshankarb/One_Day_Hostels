import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterListings, paginate, pricingSummary, toListing, slugify, priceFor, type Listing, type PropertyDoc } from '../../../shared/model.ts';

const base: Listing = {
  id: 'a', name: 'Alpha PG', localityId: 'siripuram', localityName: 'Siripuram', address: 'Near AU', accommodationType: 'pg', genderPolicy: 'women',
  foodType: 'pure_veg', verified: true, ratingAvg: 4.8, ratingCount: 40, photos: [], minDaily: 400, minWeekly: 2500, minMonthly: 7000, hasAc: true,
  roomTypes: ['shared'], totalBeds: 10, amenityIds: ['wifi', 'cctv'], allowDaily: true, allowWeekly: true, allowMonthly: true, approvedAt: 1,
};
const items: Listing[] = [
  base,
  { ...base, id: 'b', name: 'Beta Hostel', localityId: 'gajuwaka', localityName: 'Gajuwaka', genderPolicy: 'men', foodType: 'veg_nonveg', verified: false, ratingAvg: 4.1, minDaily: 200, minMonthly: 4500, hasAc: false, roomTypes: ['dorm'], amenityIds: ['wifi'], approvedAt: 3 },
  { ...base, id: 'c', name: 'Gamma Dorms', localityId: 'nad-junction', localityName: 'NAD Junction', genderPolicy: 'coed', foodType: 'none', ratingAvg: 0, ratingCount: 0, minDaily: 399, minMonthly: null, allowMonthly: false, roomTypes: ['dorm', 'private'], approvedAt: 2 },
];

test('filters by locality, gender, food and diet', () => {
  assert.deepEqual(filterListings(items, { localities: ['gajuwaka'] }).map((l) => l.id), ['b']);
  assert.deepEqual(filterListings(items, { genders: ['women', 'coed'] }).map((l) => l.id).sort(), ['a', 'c']);
  assert.deepEqual(filterListings(items, { diet: 'pure_veg' }).map((l) => l.id), ['a']);
  assert.deepEqual(filterListings(items, { diet: 'nonveg' }).map((l) => l.id), ['b']);
  assert.deepEqual(filterListings(items, { meals: true }).map((l) => l.id).sort(), ['a', 'b']);
  assert.deepEqual(filterListings(items, { foods: ['none'] }).map((l) => l.id), ['c']);
});

test('filters by stay mode, price range, AC, rating, amenities and room type', () => {
  assert.deepEqual(filterListings(items, { stay: 'monthly' }).map((l) => l.id).sort(), ['a', 'b']);
  assert.deepEqual(filterListings(items, { stay: 'monthly', maxPrice: 5000 }).map((l) => l.id), ['b']);
  assert.deepEqual(filterListings(items, { minPrice: 300, maxPrice: 399 }).map((l) => l.id), ['c']);
  assert.deepEqual(filterListings(items, { ac: true }).map((l) => l.id).sort(), ['a', 'c']);
  assert.deepEqual(filterListings(items, { minRating: 4.5 }).map((l) => l.id), ['a']);
  assert.deepEqual(filterListings(items, { amenities: ['wifi', 'cctv'] }).map((l) => l.id).sort(), ['a', 'c']);
  assert.deepEqual(filterListings(items, { roomTypes: ['private'] }).map((l) => l.id), ['c']);
  assert.deepEqual(filterListings(items, { verified: true }).map((l) => l.id).sort(), ['a', 'c']);
  assert.deepEqual(filterListings(items, { q: 'gajuwaka' }).map((l) => l.id), ['b']);
});

test('sorting', () => {
  assert.deepEqual(filterListings(items, { sort: 'price_asc' }).map((l) => l.id), ['b', 'c', 'a']);
  assert.deepEqual(filterListings(items, { sort: 'price_desc' }).map((l) => l.id), ['a', 'c', 'b']);
  assert.deepEqual(filterListings(items, { sort: 'rating' }).map((l) => l.id), ['a', 'b', 'c']);
  assert.deepEqual(filterListings(items, { sort: 'newest' }).map((l) => l.id), ['b', 'c', 'a']);
  assert.equal(filterListings(items, {})[0].id, 'a');
  assert.equal(priceFor(items[2], 'monthly'), null);
});

test('pagination clamps pages', () => {
  const p = paginate([1, 2, 3, 4, 5], 9, 2);
  assert.deepEqual(p, { page: 3, pages: 3, total: 5, items: [5] });
  assert.deepEqual(paginate([], 1, 9), { page: 1, pages: 1, total: 0, items: [] });
});

test('pricing summary ignores inactive rooms and beds', () => {
  const s = pricingSummary([
    { active: true, priceDaily: 500, priceWeekly: null, priceMonthly: 9000, ac: false, roomType: 'shared', beds: [{ id: '1', label: '1', active: true }, { id: '2', label: '2', active: false }] },
    { active: true, priceDaily: 300, priceWeekly: 2000, priceMonthly: null, ac: true, roomType: 'dorm', beds: [{ id: '3', label: '3', active: true }] },
    { active: false, priceDaily: 100, priceWeekly: 100, priceMonthly: 100, ac: true, roomType: 'private', beds: [{ id: '4', label: '4', active: true }] },
  ]);
  assert.deepEqual(s, { minDaily: 300, minWeekly: 2000, minMonthly: 9000, hasAc: true, roomTypes: ['shared', 'dorm'], totalBeds: 2 });
});

test('toListing and slugify', () => {
  assert.equal(slugify('Steel City Men’s Hostel'), 'steel-city-mens-hostel');
  const l = toListing('x', {
    name: 'X', localityId: 'mvp-colony', localityName: 'MVP Colony', address: 'a', accommodationType: 'pg', genderPolicy: 'men', foodType: 'none',
    verified: true, ratingAvg: 4, ratingCount: 2, photos: [{ url: '/1.png' }, { url: '/2.png' }], amenityIds: [], allowDaily: true, allowWeekly: false, allowMonthly: true,
    pricing: { minDaily: 1, minWeekly: null, minMonthly: 2, hasAc: false, roomTypes: [], totalBeds: 3 }, createdAt: 5, approvedAt: null,
  } as unknown as PropertyDoc);
  assert.equal(l.photos.length, 2);
  assert.equal(l.totalBeds, 3);
  assert.equal(l.approvedAt, 5);
});
