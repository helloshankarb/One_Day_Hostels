import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc, query, where, orderBy, limit,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  todayIST, type Amenity, type CatalogDoc, type Listing, type Locality, type MenuDoc, type PropertyDoc, type ReviewDoc, type RoomDoc,
} from '../../../shared/model';

const CATALOG_KEY = 'odh:catalog:v1';
const REF_KEY = 'odh:reference:v1';
const CATALOG_TTL = 10 * 60 * 1000;
const REF_TTL = 24 * 60 * 60 * 1000;

function readCache<T>(key: string, ttl: number): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw) as { at: number; data: T };
    return Date.now() - at < ttl ? data : null;
  } catch {
    return null;
  }
}
function writeCache(key: string, data: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Storage full or disabled: caching is best-effort.
  }
}

let catalogPromise: Promise<Listing[]> | null = null;

/** All approved listings in one document read, cached in memory and localStorage for 10 minutes. */
export function getCatalog(force = false): Promise<Listing[]> {
  if (!force) {
    const cached = readCache<Listing[]>(CATALOG_KEY, CATALOG_TTL);
    if (cached) return Promise.resolve(cached);
    if (catalogPromise) return catalogPromise;
  }
  catalogPromise = getDoc(doc(db, 'catalog', 'listings'))
    .then((snap) => {
      const items = snap.exists() ? (snap.data() as CatalogDoc).items : [];
      writeCache(CATALOG_KEY, items);
      return items;
    })
    .finally(() => {
      catalogPromise = null;
    });
  return catalogPromise;
}

export interface Reference {
  localities: Locality[];
  amenities: Amenity[];
}

export async function getReference(): Promise<Reference> {
  const cached = readCache<Reference>(REF_KEY, REF_TTL);
  if (cached) return cached;
  const [l, a] = await Promise.all([getDocs(collection(db, 'localities')), getDocs(collection(db, 'amenities'))]);
  const ref: Reference = {
    localities: l.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Locality, 'id'>) })).filter((x) => x.active).sort((x, y) => x.sort - y.sort),
    amenities: a.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Amenity, 'id'>) })).sort((x, y) => x.name.localeCompare(y.name)),
  };
  writeCache(REF_KEY, ref);
  return ref;
}

export interface PropertyDetail {
  id: string;
  property: PropertyDoc;
  rooms: (RoomDoc & { id: string })[];
  menu: MenuDoc | null;
  reviews: (ReviewDoc & { id: string })[];
}

/** Returns null when the property does not exist or is not visible to the current user. */
export async function getPropertyDetail(slug: string, menuDate = todayIST()): Promise<PropertyDetail | null> {
  const ref = doc(db, 'properties', slug);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const property = snap.data() as PropertyDoc;
  const [rooms, menu, reviews] = await Promise.all([
    getDocs(collection(ref, 'rooms')),
    getDoc(doc(ref, 'menus', menuDate)).catch(() => null),
    getDocs(query(collection(ref, 'reviews'), where('status', '==', 'published'), orderBy('createdAt', 'desc'), limit(10))).catch(() => null),
  ]);
  const m = menu?.exists() ? (menu.data() as MenuDoc) : null;
  return {
    id: snap.id,
    property,
    rooms: rooms.docs
      .map((d) => ({ id: d.id, ...(d.data() as RoomDoc) }))
      .filter((r) => r.active)
      .sort((a, b) => a.priceDaily - b.priceDaily),
    menu: m && m.status === 'published' ? m : null,
    reviews: reviews?.docs.map((d) => ({ id: d.id, ...(d.data() as ReviewDoc) })) ?? [],
  };
}

export async function getSavedIds(uid: string): Promise<string[]> {
  const snap = await getDocs(collection(db, 'users', uid, 'saved'));
  return snap.docs.map((d) => d.id);
}

export async function setSaved(uid: string, propertyId: string, saved: boolean) {
  const ref = doc(db, 'users', uid, 'saved', propertyId);
  if (saved) await setDoc(ref, { propertyId, createdAt: Date.now() });
  else await deleteDoc(ref);
}

export async function updateMyProfile(uid: string, data: { name: string; phone: string; city?: string | null; gender?: string | null }) {
  await updateDoc(doc(db, 'users', uid), { ...data, updatedAt: Date.now() });
}

export async function getMyProfile(uid: string) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}
