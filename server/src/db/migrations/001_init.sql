-- One Day Hostels initial schema
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('customer','owner','admin')),
  admin_role TEXT CHECK (admin_role IN ('super_admin','finance','moderator','support')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  gender TEXT,
  city TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);
CREATE INDEX idx_users_role ON users(role);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE otp_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset','login')),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_otp_user ON otp_codes(user_id, purpose);

CREATE TABLE owner_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT,
  pan TEXT,
  gstin TEXT,
  bank_account_name TEXT,
  bank_account_last4 TEXT,
  ifsc TEXT,
  upi_id TEXT,
  address TEXT,
  kyc_status TEXT NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending','submitted','verified','rejected')),
  kyc_note TEXT,
  onboarding_step INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE localities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  tagline TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE amenities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT 'check',
  category TEXT NOT NULL DEFAULT 'general'
);

CREATE TABLE properties (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  locality_id INTEGER NOT NULL REFERENCES localities(id),
  address TEXT NOT NULL DEFAULT '',
  pincode TEXT,
  landmark TEXT,
  description TEXT NOT NULL DEFAULT '',
  accommodation_type TEXT NOT NULL DEFAULT 'hostel' CHECK (accommodation_type IN ('hostel','pg','coliving','dormitory')),
  gender_policy TEXT NOT NULL DEFAULT 'coed' CHECK (gender_policy IN ('men','women','coed','family')),
  food_type TEXT NOT NULL DEFAULT 'none' CHECK (food_type IN ('pure_veg','veg_meals','veg_nonveg','none')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','changes_requested','approved','rejected','suspended','unpublished')),
  status_reason TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  instant_book INTEGER NOT NULL DEFAULT 1,
  allow_daily INTEGER NOT NULL DEFAULT 1,
  allow_weekly INTEGER NOT NULL DEFAULT 1,
  allow_monthly INTEGER NOT NULL DEFAULT 1,
  min_stay_days INTEGER NOT NULL DEFAULT 1,
  cancellation_policy TEXT NOT NULL DEFAULT 'flexible' CHECK (cancellation_policy IN ('flexible','moderate','strict')),
  house_rules TEXT NOT NULL DEFAULT '',
  check_in_time TEXT NOT NULL DEFAULT '12:00',
  check_out_time TEXT NOT NULL DEFAULT '11:00',
  gate_close_time TEXT,
  breakfast_time TEXT NOT NULL DEFAULT '07:30-09:30',
  lunch_time TEXT NOT NULL DEFAULT '12:30-14:30',
  dinner_time TEXT NOT NULL DEFAULT '19:30-21:30',
  contact_phone TEXT,
  latitude REAL,
  longitude REAL,
  rating_avg REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_properties_owner ON properties(owner_id);
CREATE INDEX idx_properties_status_locality ON properties(status, locality_id);

CREATE TABLE property_status_history (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_psh_property ON property_status_history(property_id);

CREATE TABLE property_photos (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  caption TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_photos_property ON property_photos(property_id, sort);

CREATE TABLE property_amenities (
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  amenity_id INTEGER NOT NULL REFERENCES amenities(id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, amenity_id)
);

CREATE TABLE property_documents (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('ownership_proof','lease_agreement','owner_id','fssai','fire_safety','gst','trade_license','other')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  note TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_docs_property ON property_documents(property_id);

CREATE TABLE rooms (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  room_type TEXT NOT NULL CHECK (room_type IN ('private','shared','dorm')),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 20),
  ac INTEGER NOT NULL DEFAULT 0,
  attached_bath INTEGER NOT NULL DEFAULT 0,
  price_daily INTEGER NOT NULL CHECK (price_daily >= 0),
  price_weekly INTEGER CHECK (price_weekly >= 0),
  price_monthly INTEGER CHECK (price_monthly >= 0),
  deposit INTEGER NOT NULL DEFAULT 0 CHECK (deposit >= 0),
  meals_included INTEGER NOT NULL DEFAULT 1,
  features TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (property_id, code)
);
CREATE INDEX idx_rooms_property ON rooms(property_id);

CREATE TABLE beds (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (room_id, label)
);

CREATE TABLE bed_blocks (
  id INTEGER PRIMARY KEY,
  bed_id INTEGER NOT NULL REFERENCES beds(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  CHECK (end_date > start_date)
);
CREATE INDEX idx_blocks_bed ON bed_blocks(bed_id, start_date, end_date);

CREATE TABLE menus (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  menu_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  special_dish TEXT,
  notes TEXT,
  breakfast_time TEXT,
  lunch_time TEXT,
  dinner_time TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at TEXT,
  UNIQUE (property_id, menu_date)
);
CREATE INDEX idx_menus_date ON menus(menu_date, status);

CREATE TABLE menu_items (
  id INTEGER PRIMARY KEY,
  menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  meal TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner')),
  name TEXT NOT NULL,
  description TEXT,
  is_veg INTEGER NOT NULL DEFAULT 1,
  included INTEGER NOT NULL DEFAULT 1,
  extra_charge INTEGER NOT NULL DEFAULT 0,
  photo_url TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_menu_items_menu ON menu_items(menu_id);

CREATE TABLE menu_alerts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, property_id)
);

CREATE TABLE coupons (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
  owner_id INTEGER REFERENCES users(id),
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','flat')),
  value INTEGER NOT NULL CHECK (value > 0),
  max_discount INTEGER,
  min_amount INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  usage_limit INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  bed_id INTEGER NOT NULL REFERENCES beds(id),
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  nights INTEGER NOT NULL CHECK (nights > 0),
  stay_type TEXT NOT NULL CHECK (stay_type IN ('daily','weekly','monthly')),
  guest_name TEXT NOT NULL,
  guest_phone TEXT NOT NULL,
  guest_email TEXT,
  guest_gender TEXT,
  guest_id_type TEXT,
  special_requests TEXT,
  base_amount INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  deposit INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL,
  commission_amount INTEGER NOT NULL DEFAULT 0,
  coupon_id INTEGER REFERENCES coupons(id),
  status TEXT NOT NULL CHECK (status IN ('requested','pending_payment','confirmed','checked_in','completed','cancelled','expired','rejected')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','pending','paid','failed','refund_pending','refunded','partially_refunded')),
  hold_expires_at TEXT,
  idempotency_key TEXT,
  cancel_reason TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT,
  checked_in_at TEXT,
  checked_out_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (check_out > check_in),
  UNIQUE (customer_id, idempotency_key)
);
CREATE INDEX idx_bookings_bed_dates ON bookings(bed_id, check_in, check_out);
CREATE INDEX idx_bookings_property ON bookings(property_id, status);
CREATE INDEX idx_bookings_customer ON bookings(customer_id);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  provider TEXT NOT NULL,
  provider_order_id TEXT NOT NULL UNIQUE,
  provider_payment_id TEXT UNIQUE,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  method TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','pending','paid','failed')),
  signature_verified INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT
);
CREATE INDEX idx_payments_booking ON payments(booking_id);

CREATE TABLE payment_events (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider, event_id)
);

CREATE TABLE refunds (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  payment_id INTEGER REFERENCES payments(id),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed')),
  provider_refund_id TEXT UNIQUE,
  reason TEXT,
  initiated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);

CREATE TABLE disputes (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  raised_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE payouts (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  gross_amount INTEGER NOT NULL,
  commission_amount INTEGER NOT NULL,
  refund_adjustment INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL,
  booking_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','paid','on_hold')),
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT,
  UNIQUE (owner_id, period_start, period_end)
);

CREATE TABLE payout_items (
  payout_id INTEGER NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
  PRIMARY KEY (payout_id, booking_id)
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  customer_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  cleanliness INTEGER CHECK (cleanliness BETWEEN 1 AND 5),
  food INTEGER CHECK (food BETWEEN 1 AND 5),
  location INTEGER CHECK (location BETWEEN 1 AND 5),
  safety INTEGER CHECK (safety BETWEEN 1 AND 5),
  title TEXT,
  comment TEXT NOT NULL,
  owner_reply TEXT,
  owner_replied_at TEXT,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','flagged','hidden')),
  moderation_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_reviews_property ON reviews(property_id, status);

CREATE TABLE review_reports (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (review_id, reporter_id)
);

CREATE TABLE saved_properties (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, property_id)
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE support_tickets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  property_id INTEGER REFERENCES properties(id),
  booking_id INTEGER REFERENCES bookings(id),
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  assigned_to INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tickets_status ON support_tickets(status);

CREATE TABLE ticket_messages (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE contact_messages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
