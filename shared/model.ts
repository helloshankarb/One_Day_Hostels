/**
 * Firestore data model shared by the web client and Cloud Functions.
 *
 * Collections
 *  users/{uid}                         profile; role mirrors the `role` custom claim (claims are authoritative)
 *  users/{uid}/saved/{propertyId}      saved properties
 *  users/{uid}/notifications/{id}      in-app notifications (server-written)
 *  ownerProfiles/{uid}                 business/KYC details for owners
 *  localities/{slug}, amenities/{id}   reference data (admin-managed)
 *  properties/{slug}                   listing; status workflow is server-controlled
 *  properties/{slug}/rooms/{roomId}    room inventory incl. beds[]
 *  properties/{slug}/menus/{YYYY-MM-DD} dated menus (draft | published)
 *  properties/{slug}/reviews/{bookingId} verified-stay reviews (server-written)
 *  catalog/listings                    denormalised summary of all approved properties (1 read per search)
 *  bookings/{id}, bedNights/{bedId_date}, payments/{id}, refunds/{id}, payouts/{id}, auditLogs/{id}
 *                                      server-only (Cloud Functions); planned for the booking increment
 */

export type Role = 'customer' | 'owner' | 'admin';
export type GenderPolicy = 'men' | 'women' | 'coed' | 'family';
export type FoodType = 'pure_veg' | 'veg_meals' | 'veg_nonveg' | 'none';
export type RoomType = 'private' | 'shared' | 'dorm';
export type AccommodationType = 'hostel' | 'pg' | 'coliving' | 'dormitory';
export type PropertyStatus = 'draft' | 'pending_review' | 'changes_requested' | 'approved' | 'rejected' | 'suspended' | 'unpublished';
export type StayType = 'daily' | 'weekly' | 'monthly';
export type Meal = 'breakfast' | 'lunch' | 'dinner';

export interface UserDoc {
  uid: string;
  email: string;
  name: string;
  phone: string;
  role: Role;
  status: 'active' | 'suspended';
  city?: string | null;
  gender?: 'male' | 'female' | 'other' | null;
  createdAt: number;
  updatedAt?: number;
}

export interface Photo {
  url: string;
  caption?: string | null;
  path?: string | null;
}

export interface PricingSummary {
  minDaily: number | null;
  minWeekly: number | null;
  minMonthly: number | null;
  hasAc: boolean;
  roomTypes: RoomType[];
  totalBeds: number;
}

export interface PropertyDoc {
  ownerId: string;
  name: string;
  slug: string;
  localityId: string;
  localityName: string;
  address: string;
  pincode?: string | null;
  landmark?: string | null;
  description: string;
  accommodationType: AccommodationType;
  genderPolicy: GenderPolicy;
  foodType: FoodType;
  status: PropertyStatus;
  statusReason?: string | null;
  verified: boolean;
  instantBook: boolean;
  allowDaily: boolean;
  allowWeekly: boolean;
  allowMonthly: boolean;
  minStayDays: number;
  cancellationPolicy: 'flexible' | 'moderate' | 'strict';
  houseRules: string;
  checkInTime: string;
  checkOutTime: string;
  gateCloseTime?: string | null;
  mealTimes: Record<Meal, string>;
  contactPhone?: string | null;
  photos: Photo[];
  amenityIds: string[];
  ratingAvg: number;
  ratingCount: number;
  pricing: PricingSummary;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number | null;
}

export interface Bed {
  id: string;
  label: string;
  active: boolean;
}

export interface RoomDoc {
  code: string;
  name: string;
  roomType: RoomType;
  capacity: number;
  ac: boolean;
  attachedBath: boolean;
  priceDaily: number;
  priceWeekly: number | null;
  priceMonthly: number | null;
  deposit: number;
  mealsIncluded: boolean;
  features: string;
  description: string;
  active: boolean;
  beds: Bed[];
}

export interface MenuItem {
  meal: Meal;
  name: string;
  isVeg: boolean;
  included: boolean;
  extraCharge: number;
  description?: string | null;
  photoUrl?: string | null;
}

export interface MenuDoc {
  date: string;
  status: 'draft' | 'published';
  specialDish?: string | null;
  notes?: string | null;
  items: MenuItem[];
  updatedAt: number;
  publishedAt?: number | null;
}

export interface ReviewDoc {
  customerName: string;
  rating: number;
  cleanliness?: number | null;
  food?: number | null;
  location?: number | null;
  safety?: number | null;
  comment: string;
  ownerReply?: string | null;
  status: 'published' | 'hidden' | 'flagged';
  stayType: StayType;
  createdAt: number;
}

export interface Locality {
  id: string;
  name: string;
  tagline?: string | null;
  sort: number;
  active: boolean;
}

export interface Amenity {
  id: string;
  name: string;
  icon: string;
  category: string;
}

/** One entry of catalog/listings – everything a search result card needs. */
export interface Listing {
  id: string;
  name: string;
  localityId: string;
  localityName: string;
  address: string;
  accommodationType: AccommodationType;
  genderPolicy: GenderPolicy;
  foodType: FoodType;
  verified: boolean;
  ratingAvg: number;
  ratingCount: number;
  photos: string[];
  minDaily: number | null;
  minWeekly: number | null;
  minMonthly: number | null;
  hasAc: boolean;
  roomTypes: RoomType[];
  totalBeds: number;
  amenityIds: string[];
  allowDaily: boolean;
  allowWeekly: boolean;
  allowMonthly: boolean;
  approvedAt: number;
}

export interface CatalogDoc {
  items: Listing[];
  updatedAt: number;
  version: number;
}

export const CATALOG_VERSION = 1;

export function slugify(s: string): string {
  return s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'property';
}

export function toListing(id: string, p: PropertyDoc): Listing {
  return {
    id,
    name: p.name,
    localityId: p.localityId,
    localityName: p.localityName,
    address: p.address,
    accommodationType: p.accommodationType,
    genderPolicy: p.genderPolicy,
    foodType: p.foodType,
    verified: !!p.verified,
    ratingAvg: p.ratingAvg ?? 0,
    ratingCount: p.ratingCount ?? 0,
    photos: (p.photos ?? []).slice(0, 4).map((ph) => ph.url),
    minDaily: p.pricing?.minDaily ?? null,
    minWeekly: p.pricing?.minWeekly ?? null,
    minMonthly: p.pricing?.minMonthly ?? null,
    hasAc: !!p.pricing?.hasAc,
    roomTypes: p.pricing?.roomTypes ?? [],
    totalBeds: p.pricing?.totalBeds ?? 0,
    amenityIds: p.amenityIds ?? [],
    allowDaily: !!p.allowDaily,
    allowWeekly: !!p.allowWeekly,
    allowMonthly: !!p.allowMonthly,
    approvedAt: p.approvedAt ?? p.createdAt ?? 0,
  };
}

export function pricingSummary(rooms: Pick<RoomDoc, 'active' | 'priceDaily' | 'priceWeekly' | 'priceMonthly' | 'ac' | 'roomType' | 'beds'>[]): PricingSummary {
  const live = rooms.filter((r) => r.active);
  const min = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => typeof x === 'number' && x > 0);
    return v.length ? Math.min(...v) : null;
  };
  return {
    minDaily: min(live.map((r) => r.priceDaily)),
    minWeekly: min(live.map((r) => r.priceWeekly)),
    minMonthly: min(live.map((r) => r.priceMonthly)),
    hasAc: live.some((r) => r.ac),
    roomTypes: [...new Set(live.map((r) => r.roomType))],
    totalBeds: live.reduce((s, r) => s + r.beds.filter((b) => b.active).length, 0),
  };
}

export interface SearchFilters {
  q?: string;
  localities?: string[];
  stay?: StayType | null;
  roomTypes?: RoomType[];
  genders?: GenderPolicy[];
  foods?: FoodType[];
  diet?: 'veg' | 'pure_veg' | 'nonveg' | null;
  meals?: boolean;
  ac?: boolean | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  minRating?: number | null;
  amenities?: string[];
  verified?: boolean;
  sort?: 'recommended' | 'price_asc' | 'price_desc' | 'rating' | 'newest';
}

/** Price shown/filtered for the chosen stay mode; falls back to the daily rate. */
export function priceFor(l: Listing, stay?: StayType | null): number | null {
  if (stay === 'monthly') return l.minMonthly;
  if (stay === 'weekly') return l.minWeekly;
  return l.minDaily;
}

export function filterListings(items: Listing[], f: SearchFilters): Listing[] {
  const q = f.q?.trim().toLowerCase();
  const out = items.filter((l) => {
    if (q && !`${l.name} ${l.localityName} ${l.address}`.toLowerCase().includes(q)) return false;
    if (f.localities?.length && !f.localities.includes(l.localityId)) return false;
    if (f.stay === 'daily' && !l.allowDaily) return false;
    if (f.stay === 'weekly' && !(l.allowWeekly && l.minWeekly)) return false;
    if (f.stay === 'monthly' && !(l.allowMonthly && l.minMonthly)) return false;
    if (f.roomTypes?.length && !f.roomTypes.some((t) => l.roomTypes.includes(t))) return false;
    if (f.genders?.length && !f.genders.includes(l.genderPolicy)) return false;
    if (f.foods?.length && !f.foods.includes(l.foodType)) return false;
    if (f.diet === 'veg' && l.foodType === 'none') return false;
    if (f.diet === 'pure_veg' && l.foodType !== 'pure_veg') return false;
    if (f.diet === 'nonveg' && l.foodType !== 'veg_nonveg') return false;
    if (f.meals && l.foodType === 'none') return false;
    if (f.ac === true && !l.hasAc) return false;
    if (f.verified && !l.verified) return false;
    if (f.minRating && l.ratingAvg < f.minRating) return false;
    if (f.amenities?.length && !f.amenities.every((a) => l.amenityIds.includes(a))) return false;
    const price = priceFor(l, f.stay);
    if ((f.minPrice || f.maxPrice) && price === null) return false;
    if (f.minPrice && price !== null && price < f.minPrice) return false;
    if (f.maxPrice && price !== null && price > f.maxPrice) return false;
    return true;
  });
  const p = (l: Listing) => priceFor(l, f.stay) ?? Number.MAX_SAFE_INTEGER;
  const score = (l: Listing) => (l.verified ? 1000 : 0) + l.ratingAvg * Math.log(2 + l.ratingCount);
  const sorters: Record<string, (a: Listing, b: Listing) => number> = {
    price_asc: (a, b) => p(a) - p(b),
    price_desc: (a, b) => p(b) - p(a),
    rating: (a, b) => b.ratingAvg - a.ratingAvg || b.ratingCount - a.ratingCount,
    newest: (a, b) => b.approvedAt - a.approvedAt,
    recommended: (a, b) => score(b) - score(a),
  };
  return out.sort(sorters[f.sort ?? 'recommended'] ?? sorters.recommended);
}

export function paginate<T>(items: T[], page: number, pageSize: number) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return { page: current, pages, total: items.length, items: items.slice((current - 1) * pageSize, current * pageSize) };
}

export function todayIST(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const PHONE_RE = /^(\+91[\s-]?)?[6-9]\d{9}$/;

// ---------- Bookings & payments (written only by Cloud Functions) ----------

export type BookingStatus = 'pending_payment' | 'confirmed' | 'checked_in' | 'completed' | 'cancelled' | 'expired';
export type BookingPaymentStatus = 'unpaid' | 'pending' | 'paid' | 'failed' | 'refund_pending' | 'refunded' | 'partially_refunded';

export interface BookingDoc {
  code: string;
  customerId: string;
  ownerId: string;
  propertyId: string;
  propertyName: string;
  localityName: string;
  roomId: string;
  roomName: string;
  bedId: string;
  bedLabel: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  stayType: StayType;
  guest: { name: string; phone: string; email: string | null; gender: 'male' | 'female' | 'other' | null };
  specialRequests: string | null;
  amounts: { base: number; discount: number; tax: number; deposit: number; total: number; payable: number; commission: number };
  priceLines: { label: string; amount: number }[];
  cancellationPolicy: 'flexible' | 'moderate' | 'strict';
  checkInTime: string;
  status: BookingStatus;
  paymentStatus: BookingPaymentStatus;
  paidOrderId: string | null;
  holdExpiresAt: number | null;
  paymentAttempts: number;
  refundedAmount: number;
  cancelReason: string | null;
  cancelledBy: 'customer' | 'owner' | 'admin' | 'system' | null;
  createdAt: number;
  updatedAt: number;
  confirmedAt: number | null;
  cancelledAt: number | null;
}

export type PaymentRecordStatus = 'created' | 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'review';

/** payments/{gatewayOrderId} */
export interface PaymentDoc {
  gateway: 'cashfree';
  environment: 'sandbox' | 'production';
  orderId: string;
  gatewayOrderRef: string | null;
  bookingId: string;
  bookingCode: string;
  customerId: string;
  ownerId: string;
  propertyId: string;
  amount: number;
  currency: 'INR';
  status: PaymentRecordStatus;
  paymentSessionId: string | null;
  gatewayPaymentId: string | null;
  method: string | null;
  bankReference: string | null;
  failureReason: string | null;
  duplicateOf: string | null;
  orderExpiresAt: number;
  createdAt: number;
  updatedAt: number;
  paidAt: number | null;
  lastReconciledAt: number | null;
}

export type RefundStatus = 'pending' | 'processed' | 'failed';

/** refunds/{refundId} */
export interface RefundDoc {
  gateway: 'cashfree';
  bookingId: string;
  bookingCode: string;
  orderId: string;
  customerId: string;
  amount: number;
  status: RefundStatus;
  reason: string;
  kind: 'cancellation' | 'duplicate_payment' | 'inventory_unavailable' | 'admin';
  gatewayRefundId: string | null;
  gatewayStatus: string | null;
  submittedAt: number | null;
  initiatedBy: string;
  createdAt: number;
  updatedAt: number;
  processedAt: number | null;
}
