import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { db } from './admin.ts';
import { CATALOG_VERSION, pricingSummary, toListing, type CatalogDoc, type PropertyDoc, type RoomDoc } from '../../shared/model.ts';

/** Rebuilds catalog/listings from all approved properties (≈150 docs, well under the 1 MiB document limit). */
export async function rebuildCatalog() {
  const snap = await db.collection('properties').where('status', '==', 'approved').get();
  const doc: CatalogDoc = {
    items: snap.docs.map((d) => toListing(d.id, d.data() as PropertyDoc)),
    updatedAt: Date.now(),
    version: CATALOG_VERSION,
  };
  await db.collection('catalog').doc('listings').set(doc);
  return doc.items.length;
}

/** Recomputes the denormalised pricing summary on the property from its rooms. */
export async function refreshPricing(propertyId: string) {
  const rooms = await db.collection('properties').doc(propertyId).collection('rooms').get();
  const pricing = pricingSummary(rooms.docs.map((r) => r.data() as RoomDoc));
  const ref = db.collection('properties').doc(propertyId);
  if ((await ref.get()).exists) await ref.update({ pricing });
}

const LISTING_FIELDS: (keyof PropertyDoc)[] = [
  'name', 'status', 'localityId', 'localityName', 'address', 'accommodationType', 'genderPolicy', 'foodType', 'verified',
  'ratingAvg', 'ratingCount', 'photos', 'pricing', 'amenityIds', 'allowDaily', 'allowWeekly', 'allowMonthly', 'approvedAt',
];

export const onPropertyWritten = onDocumentWritten('properties/{propertyId}', async (event) => {
  const before = event.data?.before.data() as PropertyDoc | undefined;
  const after = event.data?.after.data() as PropertyDoc | undefined;
  const wasListed = before?.status === 'approved';
  const isListed = after?.status === 'approved';
  if (!wasListed && !isListed) return;
  // Skip rebuilds for edits that do not affect search cards (e.g. house rules).
  if (before && after && wasListed && isListed && LISTING_FIELDS.every((k) => JSON.stringify(before[k]) === JSON.stringify(after[k]))) return;
  await rebuildCatalog();
});

export const onRoomWritten = onDocumentWritten('properties/{propertyId}/rooms/{roomId}', async (event) => {
  await refreshPricing(event.params.propertyId);
});
