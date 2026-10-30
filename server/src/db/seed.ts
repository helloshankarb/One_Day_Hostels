import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { migrate, get, all, run, tx, closeDb } from './index.ts';
import { hashPassword } from '../lib/auth.ts';
import { setSetting } from '../lib/services.ts';
import { quote } from '../lib/pricing.ts';
import { recalcRating } from '../lib/bookings.ts';
import { todayIST, addDays } from '../lib/dates.ts';
import { docDir } from '../lib/uploads.ts';

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const LOCALITIES: [string, string][] = [
  ['Madhurawada', 'GITAM & IT corridor'],
  ['MVP Colony', 'Sectors 1–12, family neighbourhood'],
  ['Siripuram', 'Andhra University campus hub'],
  ['Rushikonda', 'Millennium IT SEZ & beach'],
  ['Dwaraka Nagar', 'RTC complex, city centre'],
  ['Gajuwaka', 'Steel plant & industrial hub'],
  ['Seethammadhara', 'Quiet residential north'],
  ['Akkayyapalem', 'Central, close to railway station'],
  ['Beach Road', 'RK Beach promenade'],
  ['NAD Junction', 'Airport & highway access'],
];

export const AMENITIES: [string, string, string][] = [
  ['High-speed Wi-Fi', 'wifi', 'connectivity'],
  ['Air conditioning', 'snowflake', 'comfort'],
  ['24/7 power backup', 'zap', 'essentials'],
  ['Laundry machines', 'shirt', 'services'],
  ['CCTV surveillance', 'cctv', 'safety'],
  ['Biometric entry', 'fingerprint', 'safety'],
  ['RO drinking water', 'droplets', 'essentials'],
  ['Gym access', 'dumbbell', 'lifestyle'],
  ['Study room', 'book-open', 'lifestyle'],
  ['Two-wheeler parking', 'bike', 'essentials'],
  ['Attached bathroom', 'bath', 'comfort'],
  ['Hot water geyser', 'flame', 'comfort'],
  ['Resident warden', 'shield-check', 'safety'],
  ['Daily housekeeping', 'sparkles', 'services'],
  ['Common TV lounge', 'tv', 'lifestyle'],
  ['In-house mess', 'utensils', 'food'],
  ['Personal lockers', 'lock', 'safety'],
  ['Near bus stop', 'bus', 'location'],
  ['Lift', 'arrow-up-down', 'essentials'],
  ['Refrigerator', 'refrigerator', 'comfort'],
];

export type RoomDef = [code: string, name: string, type: 'private' | 'shared' | 'dorm', cap: number, ac: number, daily: number, weekly: number | null, monthly: number | null, deposit: number, features: string];

export interface PropDef {
  name: string;
  locality: string;
  owner: string;
  type: 'hostel' | 'pg' | 'coliving' | 'dormitory';
  gender: 'men' | 'women' | 'coed' | 'family';
  food: 'pure_veg' | 'veg_meals' | 'veg_nonveg' | 'none';
  status: string;
  verified: number;
  instant?: number;
  daily?: number;
  monthly?: number;
  policy: 'flexible' | 'moderate' | 'strict';
  address: string;
  pincode: string;
  landmark: string;
  description: string;
  photos: string[];
  amenities: string[];
  rooms: RoomDef[];
  gate?: string;
}

export const RULES = 'Main gate closes at 10:30 PM; late entry via pre-approved request only.\nVisitors allowed in the reception lounge until 8:00 PM. No room visits.\nStrictly no smoking, alcohol or loud music on the premises.\nQuiet hours 11:00 PM – 6:00 AM.\nValid government photo ID required at check-in.';

export const PROPS: PropDef[] = [
  {
    name: 'Coastal Nest Luxury PG', locality: 'Siripuram', owner: 'ramesh', type: 'pg', gender: 'coed', food: 'veg_nonveg', status: 'approved', verified: 1, policy: 'flexible',
    address: 'Plot 14, Near Dutt Island, Siripuram, Visakhapatnam', pincode: '530003', landmark: 'Opp. Andhra University North Gate',
    description: 'A premium co-ed PG with segregated secured wings, five minutes from Andhra University and Dutt Island. Rent includes three fresh Andhra meals a day, 100 Mbps fibre Wi-Fi, daily housekeeping and round-the-clock power backup. Ideal for AU students, interns and Siripuram tech professionals.',
    photos: ['room-1', 'study-1', 'bath-1', 'dining-2', 'building-1'], gate: '22:30',
    amenities: ['High-speed Wi-Fi', 'Air conditioning', '24/7 power backup', 'Laundry machines', 'CCTV surveillance', 'Biometric entry', 'RO drinking water', 'Study room', 'Attached bathroom', 'Hot water geyser', 'Resident warden', 'Daily housekeeping', 'In-house mess', 'Two-wheeler parking'],
    rooms: [
      ['D2', 'Double Sharing Room (AC)', 'shared', 2, 1, 450, 2800, 8500, 2000, 'Balcony facing • Keypad locker • Attached western washroom'],
      ['S1', 'Single Private Room (AC)', 'private', 1, 1, 750, 4800, 12500, 3000, 'Queen bed • Workstation • Smart TV'],
      ['T3', 'Triple Sharing Room (AC)', 'shared', 3, 1, 350, 2200, 6800, 1500, 'Spacious 280 sq.ft • Triple locker wardrobe'],
      ['D4', 'Double Sharing Room (AC)', 'shared', 2, 1, 450, 2800, 8500, 2000, 'Garden facing • Attached washroom'],
    ],
  },
  {
    name: 'Vizag Comfort Stay', locality: 'MVP Colony', owner: 'ramesh', type: 'hostel', gender: 'men', food: 'veg_nonveg', status: 'approved', verified: 1, policy: 'moderate',
    address: 'Sector 4, MVP Colony, Visakhapatnam', pincode: '530017', landmark: 'Near MVP Rythu Bazaar',
    description: 'Budget-friendly men’s hostel in the heart of MVP Colony with Sunday chicken specials, RO water, washing machines and high-speed Wi-Fi. Walkable to MVP Rythu Bazaar, bus stops and coaching centres.',
    photos: ['room-2', 'room-7', 'dining-1', 'building-2'],
    amenities: ['High-speed Wi-Fi', '24/7 power backup', 'Laundry machines', 'CCTV surveillance', 'RO drinking water', 'Two-wheeler parking', 'In-house mess', 'Near bus stop', 'Gym access'],
    rooms: [
      ['A1', '2-Sharing Non-AC', 'shared', 2, 0, 300, 1900, 6900, 1500, 'Cross ventilation • Steel cots'],
      ['A2', '3-Sharing Non-AC', 'shared', 3, 0, 250, 1600, 5800, 1000, 'Large windows • Shared bath'],
      ['B1', '2-Sharing AC', 'shared', 2, 1, 400, 2500, 7800, 2000, 'Split AC • Attached bath'],
      ['DM', '6-Bed Dormitory', 'dorm', 6, 0, 199, 1200, 4500, 500, 'Bunk beds • Personal lockers'],
    ],
  },
  {
    name: 'Green Leaf Pure Veg Residence', locality: 'Dwaraka Nagar', owner: 'lakshmi', type: 'pg', gender: 'women', food: 'pure_veg', status: 'approved', verified: 1, policy: 'flexible',
    address: 'Diamond Park Road, Dwaraka Nagar, Visakhapatnam', pincode: '530016', landmark: 'Behind RTC Complex',
    description: 'A women-only residence with a dedicated pure vegetarian kitchen (Jain food on request), lift access, 24/7 lady warden and biometric turnstiles. Two minutes from the RTC complex and Diamond Park.',
    photos: ['room-5', 'room-4', 'food-3', 'building-1'],
    amenities: ['High-speed Wi-Fi', 'Air conditioning', '24/7 power backup', 'CCTV surveillance', 'Biometric entry', 'RO drinking water', 'Lift', 'Resident warden', 'In-house mess', 'Hot water geyser', 'Daily housekeeping'],
    rooms: [
      ['G1', '2-Sharing AC', 'shared', 2, 1, 320, 2100, 7200, 2000, 'Attached bath • Study tables'],
      ['G2', '3-Sharing AC', 'shared', 3, 1, 280, 1800, 6200, 1500, 'Large wardrobe • Balcony'],
      ['G3', 'Single Room (AC)', 'private', 1, 1, 650, 4000, 11000, 3000, 'Private bath • Workstation'],
    ],
  },
  {
    name: 'Seaside Executive PG', locality: 'Rushikonda', owner: 'rambabu', type: 'coliving', gender: 'coed', food: 'veg_nonveg', status: 'approved', verified: 1, policy: 'moderate',
    address: 'Beach Road, Rushikonda, Visakhapatnam', pincode: '530045', landmark: 'Near Rushikonda IT Park Gate 2',
    description: 'Sea-view co-living suites for IT professionals near the Millennium IT SEZ. 300 Mbps Wi-Fi, ergonomic workstations, EV charging and a chef’s special biryani every Sunday.',
    photos: ['room-8', 'room-3', 'study-1', 'food-4', 'building-2'],
    amenities: ['High-speed Wi-Fi', 'Air conditioning', '24/7 power backup', 'Laundry machines', 'CCTV surveillance', 'Biometric entry', 'Gym access', 'Attached bathroom', 'Daily housekeeping', 'In-house mess', 'Common TV lounge', 'Refrigerator'],
    rooms: [
      ['S1', 'Studio Single (AC, Sea View)', 'private', 1, 1, 850, 5500, 11500, 5000, 'Sea-view balcony • Workstation'],
      ['S2', 'Studio Single (AC)', 'private', 1, 1, 800, 5200, 10800, 5000, 'Workstation • Mini fridge'],
      ['T1', 'Twin Sharing (AC)', 'shared', 2, 1, 550, 3500, 9500, 3000, 'Sea-view • Attached bath'],
    ],
  },
  {
    name: 'Sri Sai Grand Girls Hostel', locality: 'Madhurawada', owner: 'lakshmi', type: 'hostel', gender: 'women', food: 'pure_veg', status: 'approved', verified: 1, policy: 'flexible',
    address: 'Near GITAM Main Gate, Madhurawada, Visakhapatnam', pincode: '530048', landmark: 'Opp. GITAM University',
    description: 'Popular girls hostel walking distance from GITAM with a pure veg mess, 150 Mbps Wi-Fi, CCTV, and a late-night study hall.',
    photos: ['room-6', 'room-9', 'food-2', 'dining-1'],
    amenities: ['High-speed Wi-Fi', 'Air conditioning', 'CCTV surveillance', 'Biometric entry', 'RO drinking water', 'Study room', 'Resident warden', 'In-house mess', 'Attached bathroom'],
    rooms: [
      ['R1', '2-Sharing AC', 'shared', 2, 1, 480, 3000, 7200, 2000, 'Attached bath'],
      ['R2', '3-Sharing Non-AC', 'shared', 3, 0, 330, 2100, 5600, 1500, 'Balcony'],
      ['R3', '4-Bed Dorm', 'dorm', 4, 0, 260, 1700, 4800, 1000, 'Lockers'],
    ],
  },
  {
    name: 'Steel City Men’s Hostel', locality: 'Gajuwaka', owner: 'rambabu', type: 'hostel', gender: 'men', food: 'veg_nonveg', status: 'approved', verified: 0, policy: 'flexible',
    address: 'Old Gajuwaka Main Road, Visakhapatnam', pincode: '530026', landmark: 'Near Gajuwaka Junction',
    description: 'Affordable hostel for steel plant contract staff, trainees and travellers. Hearty Andhra meals, laundry and two-wheeler parking.',
    photos: ['room-7', 'room-2', 'food-1'],
    amenities: ['High-speed Wi-Fi', '24/7 power backup', 'RO drinking water', 'Two-wheeler parking', 'In-house mess', 'Near bus stop', 'Laundry machines'],
    rooms: [
      ['M1', '3-Sharing Non-AC', 'shared', 3, 0, 230, 1500, 5000, 1000, 'Steel cots • Fans'],
      ['M2', '2-Sharing AC', 'shared', 2, 1, 380, 2400, 7000, 1500, 'Split AC'],
      ['MD', '8-Bed Dorm', 'dorm', 8, 0, 180, 1100, 4000, 500, 'Bunk beds'],
    ],
  },
  {
    name: 'Beach View Women’s Residence', locality: 'Beach Road', owner: 'lakshmi', type: 'pg', gender: 'women', food: 'veg_meals', status: 'approved', verified: 1, policy: 'moderate',
    address: 'RK Beach Road, Visakhapatnam', pincode: '530002', landmark: 'Near Kursura Submarine Museum',
    description: 'Safe women’s residence on Beach Road with vegetarian home-style low-oil meals cooked by a resident mother-chef team. CCTV-monitored kitchen and hot bain-marie service.',
    photos: ['room-3', 'room-5', 'food-3', 'dining-2'],
    amenities: ['High-speed Wi-Fi', 'Air conditioning', 'CCTV surveillance', 'Biometric entry', 'Resident warden', 'In-house mess', 'Hot water geyser', 'Lift'],
    rooms: [
      ['W1', '2-Sharing AC (Sea Facing)', 'shared', 2, 1, 520, 3300, 9000, 2500, 'Sea facing • Attached bath'],
      ['W2', '3-Sharing AC', 'shared', 3, 1, 420, 2700, 7500, 2000, 'Attached bath'],
    ],
  },
  {
    name: 'Urban Nest Transit Dorms', locality: 'NAD Junction', owner: 'rambabu', type: 'dormitory', gender: 'coed', food: 'none', status: 'approved', verified: 1, policy: 'flexible', monthly: 0,
    address: 'NH-16, NAD Junction, Visakhapatnam', pincode: '530009', landmark: '10 min from Vizag Airport',
    description: 'Clean, secure one-day dorm beds for travellers, interview candidates and airport transits. Separate men’s and women’s dorms, lockers, hot showers. No in-house food service – plenty of eateries nearby.',
    photos: ['room-9', 'room-1', 'building-2'],
    amenities: ['High-speed Wi-Fi', 'Air conditioning', 'CCTV surveillance', 'Personal lockers', 'Hot water geyser', 'Near bus stop', '24/7 power backup'],
    rooms: [
      ['DM1', 'Men’s 8-Bed AC Dorm', 'dorm', 8, 1, 399, 2500, null, 0, 'Privacy curtains • Reading light • Locker'],
      ['DW1', 'Women’s 6-Bed AC Dorm', 'dorm', 6, 1, 449, 2800, null, 0, 'Privacy curtains • Locker'],
      ['PR1', 'Private Room (AC)', 'private', 2, 1, 1200, null, null, 0, 'Double bed • Attached bath'],
    ],
  },
  {
    name: 'Scholars Pride Residency', locality: 'Madhurawada', owner: 'ramesh', type: 'hostel', gender: 'men', food: 'veg_meals', status: 'approved', verified: 1, policy: 'flexible',
    address: 'PM Palem Road, Madhurawada, Visakhapatnam', pincode: '530041', landmark: '5 min from GITAM',
    description: 'Student favourite near GITAM with unlimited vegetarian tiffin and lunch servings, filter coffee machine and silent study floor.',
    photos: ['room-4', 'study-1', 'food-2', 'building-1'],
    amenities: ['High-speed Wi-Fi', '24/7 power backup', 'Study room', 'RO drinking water', 'In-house mess', 'Laundry machines', 'Two-wheeler parking'],
    rooms: [
      ['P1', '2-Sharing Non-AC', 'shared', 2, 0, 320, 2000, 6200, 1500, 'Study tables'],
      ['P2', '3-Sharing Non-AC', 'shared', 3, 0, 280, 1800, 5400, 1000, 'Wardrobes'],
      ['P3', '2-Sharing AC', 'shared', 2, 1, 420, 2600, 7600, 2000, 'Attached bath'],
    ],
  },
  {
    name: 'Green Haven Family Stay', locality: 'Seethammadhara', owner: 'rambabu', type: 'coliving', gender: 'family', food: 'veg_nonveg', status: 'approved', verified: 1, policy: 'strict',
    address: 'Seethammadhara North Extension, Visakhapatnam', pincode: '530013', landmark: 'Near Seethammadhara Junction',
    description: 'Private family rooms with balconies, self-cooking kitchen access and healthy home-style meals. Bike parking and a children’s play area.',
    photos: ['room-6', 'room-8', 'food-4', 'building-2'],
    amenities: ['High-speed Wi-Fi', 'Air conditioning', 'Two-wheeler parking', 'Attached bathroom', 'Refrigerator', 'In-house mess', 'CCTV surveillance', 'Lift'],
    rooms: [
      ['F1', 'Family Room (AC, Balcony)', 'private', 3, 1, 1400, 8500, 16000, 5000, 'Queen + single bed • Balcony'],
      ['F2', 'Family Room (AC)', 'private', 3, 1, 1300, 8000, 15000, 5000, 'Queen + single bed'],
      ['C1', 'Couple Room (AC)', 'private', 2, 1, 1100, 7000, 13000, 4000, 'Queen bed • Workdesk'],
    ],
  },
  {
    name: 'Akkayyapalem Transit Hostel', locality: 'Akkayyapalem', owner: 'ramesh', type: 'hostel', gender: 'coed', food: 'veg_meals', status: 'approved', verified: 0, policy: 'flexible',
    address: 'Akkayyapalem Main Road, Visakhapatnam', pincode: '530016', landmark: '1.5 km from Visakhapatnam Railway Station',
    description: 'Short-stay hostel near the railway station for exam candidates and travellers. Daily vegetarian thali included with every bed.',
    photos: ['room-1', 'room-2', 'dining-1'],
    amenities: ['High-speed Wi-Fi', 'CCTV surveillance', 'Personal lockers', 'In-house mess', 'Near bus stop', 'Hot water geyser'],
    rooms: [
      ['H1', 'Men’s 6-Bed Dorm', 'dorm', 6, 0, 249, 1600, 4200, 500, 'Lockers'],
      ['H2', 'Women’s 4-Bed Dorm', 'dorm', 4, 0, 279, 1700, 4500, 500, 'Lockers'],
    ],
  },
  {
    name: 'Ocean View PG & Suites', locality: 'Rushikonda', owner: 'suresh', type: 'pg', gender: 'coed', food: 'veg_nonveg', status: 'pending_review', verified: 0, policy: 'moderate',
    address: 'Rushikonda IT Belt, Visakhapatnam', pincode: '530045', landmark: 'Near Rushikonda Beach',
    description: 'Newly built co-ed PG with 32 beds, AC rooms and a three-meal Andhra mess. Awaiting physical audit and document verification.',
    photos: ['room-8', 'room-3', 'building-2'],
    amenities: ['High-speed Wi-Fi', 'Air conditioning', 'CCTV surveillance', 'In-house mess', 'Attached bathroom'],
    rooms: [['O1', '2-Sharing AC', 'shared', 2, 1, 500, 3200, 9000, 2500, 'Sea glimpse'], ['O2', '3-Sharing AC', 'shared', 3, 1, 420, 2700, 7600, 2000, 'Attached bath']],
  },
  {
    name: 'Sri Lakshmi Deluxe Women’s PG', locality: 'MVP Colony', owner: 'lakshmi', type: 'pg', gender: 'women', food: 'pure_veg', status: 'pending_review', verified: 0, policy: 'flexible',
    address: 'Sector 4, MVP Colony, Visakhapatnam', pincode: '530017', landmark: 'Near Sector 4 Park',
    description: 'Women-only PG with 48 beds and a pure veg mess. KYC verified owner; awaiting site inspection.',
    photos: ['room-5', 'room-6', 'food-3'],
    amenities: ['High-speed Wi-Fi', 'CCTV surveillance', 'Biometric entry', 'In-house mess', 'Resident warden'],
    rooms: [['L1', '3-Sharing Non-AC', 'shared', 3, 0, 300, 1900, 5600, 1500, 'Balcony'], ['L2', '2-Sharing AC', 'shared', 2, 1, 420, 2600, 7400, 2000, 'Attached bath']],
  },
  {
    name: 'Comfort Stay Executive Boys Hostel', locality: 'Dwaraka Nagar', owner: 'rambabu', type: 'hostel', gender: 'men', food: 'veg_nonveg', status: 'draft', verified: 0, policy: 'flexible',
    address: 'Dwaraka Nagar 3rd Lane, Visakhapatnam', pincode: '530016', landmark: 'Near Dwaraka bus station',
    description: 'Draft listing.', photos: ['room-7'], amenities: ['High-speed Wi-Fi'],
    rooms: [['E1', '3-Sharing Non-AC', 'shared', 3, 0, 260, 1700, 5200, 1000, '']],
  },
];

export const MENU = {
  breakfast: {
    veg: ['Ghee Idli & Sambar', 'Crispy Medu Vada', 'Pesarattu with Upma', 'Ghee Roast Podi Dosa', 'Puri & Potato Kurma', 'Ven Pongal', 'Rava Upma', 'Mysore Bonda', 'Allam (Ginger) Chutney', 'Filter Coffee', 'Masala Chai'],
    nonveg: ['Egg Bhurji', 'Boiled Eggs (2 pcs)', 'Egg Dosa'],
  },
  lunch: {
    veg: ['Sona Masoori Rice', 'Tomato Pappu', 'Gongura Pachadi', 'Gutti Vankaya Koora', 'Bendakaya Fry', 'Drumstick Sambar', 'Miriyala Rasam', 'Thick Curd', 'Appalam', 'Paneer Butter Masala', 'Mudda Pappu & Avakaya', 'Beerakaya Curry'],
    nonveg: ['Guntur Chicken Curry', 'Andhra Chicken Biryani', 'Vanjaram Fish Fry', 'Chepala Pulusu', 'Natu Kodi Pulusu', 'Mutton Curry'],
  },
  dinner: {
    veg: ['Soft Phulkas', 'Mixed Veg Kurma', 'Jeera Rice', 'Dal Tadka', 'Aloo Gobi', 'Curd Rice', 'Semiya Payasam', 'Ragi Sangati', 'Chapati & Channa Masala', 'Fruit Custard'],
    nonveg: ['Egg Curry', 'Chicken 65', 'Kodi Vepudu (Chicken Fry)'],
  },
} as const;

export const REVIEWS = [
  'The food here is noticeably cleaner than standard Vizag mess providers. Sunday biryani is unmatched and power never cuts during exams.',
  'Extremely safe with biometric doors. Housekeeping cleans the room and washroom every morning without reminders.',
  'Great location, quick commute and the warden is very responsive. Wi-Fi speed is consistently good for video calls.',
  'Stayed for one night before an interview. Clean bed, hot shower and very easy check-in. Will book again.',
  'Value for money monthly stay. Mess menu changes every day and the owner actually updates it on the app.',
  'Rooms are as shown in the photos. Slight noise from the road at night but overall comfortable.',
  'Loved the filter coffee and pesarattu at breakfast. Staff is polite and the place is well maintained.',
  'Good stay overall; laundry machines were sometimes busy on weekends but management added a new one.',
];

export const CUSTOMERS: [string, string, 'male' | 'female'][] = [
  ['Sai Krishna Reddy', 'sai.krishna@example.in', 'male'],
  ['Pooja Rao', 'pooja.rao@example.in', 'female'],
  ['V. Chaitanya', 'chaitanya.v@example.in', 'male'],
  ['Aditya Varma', 'aditya.varma@example.in', 'male'],
  ['Sneha Kumari', 'sneha.k@example.in', 'female'],
  ['Deepika Sen', 'deepika.sen@example.in', 'female'],
  ['Karthik Naidu', 'karthik.naidu@example.in', 'male'],
  ['Ananya Roy', 'ananya.roy@example.in', 'female'],
  ['Rohan Varma', 'rohan.varma@example.in', 'male'],
  ['Tarun Kumar', 'tarun.kumar@example.in', 'male'],
  ['Harika Devi', 'harika.devi@example.in', 'female'],
  ['Manoj Patnaik', 'manoj.p@example.in', 'male'],
];

const MINIMAL_PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 300 144]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 60>>stream\nBT /F1 14 Tf 20 70 Td (One Day Hostels - sample document) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

export function seed() {
  migrate();
  if (get('SELECT id FROM users LIMIT 1')) {
    console.log('Database already has data – skipping seed.');
    return;
  }
  const r = rng(20261029);
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)];
  const today = todayIST();
  const now = Date.now();
  const iso = (date: string, hour = 10) => new Date(`${date}T${String(hour).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00+05:30`).toISOString();
  const clampPast = (s: string) => (Date.parse(s) > now ? new Date(now - 3600000).toISOString() : s);

  tx(() => {
    setSetting('commission_percent', 10);
    setSetting('gst_percent', 5);
    setSetting('support_phone', '1800-123-4567');
    setSetting('support_email', 'support@onedayhostels.in');
    setSetting('booking_hold_minutes', 15);

    LOCALITIES.forEach(([n, t], i) => run('INSERT INTO localities (name, slug, tagline, sort) VALUES (?, ?, ?, ?)', n, n.toLowerCase().replace(/[^a-z0-9]+/g, '-'), t, i));
    AMENITIES.forEach(([n, ic, c]) => run('INSERT INTO amenities (name, icon, category) VALUES (?, ?, ?)', n, ic, c));
    const loc = new Map(all('SELECT id, name FROM localities').map((l) => [l.name, l.id]));
    const amen = new Map(all('SELECT id, name FROM amenities').map((a) => [a.name, a.id]));

    const adminPw = hashPassword(process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345');
    run("INSERT INTO users (role, admin_role, name, email, phone, password_hash, email_verified) VALUES ('admin','super_admin','Platform Admin',?, '9000000001', ?, 1)", process.env.SEED_ADMIN_EMAIL ?? 'admin@onedayhostels.in', adminPw);
    run("INSERT INTO users (role, admin_role, name, email, phone, password_hash, email_verified) VALUES ('admin','finance','Finance Desk','finance@onedayhostels.in','9000000002', ?, 1)", adminPw);
    run("INSERT INTO users (role, admin_role, name, email, phone, password_hash, email_verified) VALUES ('admin','moderator','Listing Moderator','moderator@onedayhostels.in','9000000003', ?, 1)", adminPw);
    const adminId = 1;

    const ownerPw = hashPassword('Owner@12345');
    const owners: Record<string, number> = {};
    const ownerDefs: [string, string, string, string, string][] = [
      ['ramesh', 'Ramesh Varma', 'owner@onedayhostels.in', 'Varma Hospitality', 'verified'],
      ['lakshmi', 'Lakshmi Devi', 'lakshmi@example.in', 'Sri Lakshmi Residences', 'verified'],
      ['rambabu', 'M. Rambabu', 'rambabu@example.in', 'Rambabu Stays', 'verified'],
      ['suresh', 'Suresh Varma', 'suresh@example.in', 'Ocean View Living', 'submitted'],
    ];
    for (const [key, name, email, biz, kyc] of ownerDefs) {
      const oid = run("INSERT INTO users (role, name, email, phone, password_hash, email_verified, created_at) VALUES ('owner', ?, ?, ?, ?, 1, ?)", name, email, '98' + Math.floor(10000000 + r() * 89999999), ownerPw, iso(addDays(today, -200 + Math.floor(r() * 60)))).id;
      run(
        "INSERT INTO owner_profiles (user_id, business_name, pan, bank_account_name, bank_account_last4, ifsc, upi_id, kyc_status, onboarding_step) VALUES (?, ?, ?, ?, ?, 'SBIN0001234', ?, ?, 4)",
        oid, biz, 'ABCDE' + (1000 + oid) + 'F', name, String(1000 + Math.floor(r() * 8999)), `${key}@ybl`, kyc,
      );
      owners[key] = oid;
    }

    const custPw = hashPassword('Customer@123');
    const customers: { id: number; gender: string; name: string; phone: string; email: string }[] = [];
    const demo = run("INSERT INTO users (role, name, email, phone, password_hash, email_verified, gender, city, created_at) VALUES ('customer','Demo Guest','customer@onedayhostels.in','9876543210',?,1,'male','Visakhapatnam',?)", custPw, iso(addDays(today, -120))).id;
    customers.push({ id: demo, gender: 'male', name: 'Demo Guest', phone: '9876543210', email: 'customer@onedayhostels.in' });
    for (const [name, email, gender] of CUSTOMERS) {
      const phone = pick(['98480', '94401', '79934', '88862', '91234', '70135']) + String(10000 + Math.floor(r() * 89999));
      const cid = run("INSERT INTO users (role, name, email, phone, password_hash, email_verified, gender, created_at) VALUES ('customer', ?, ?, ?, ?, 1, ?, ?)", name, email, phone, custPw, gender, iso(addDays(today, -Math.floor(30 + r() * 150)))).id;
      customers.push({ id: cid, gender, name, phone, email });
    }

    for (const pd of PROPS) {
      const created = addDays(today, -Math.floor(90 + r() * 60));
      const pid = run(
        `INSERT INTO properties (owner_id, name, slug, locality_id, address, pincode, landmark, description, accommodation_type, gender_policy, food_type, status, verified,
           instant_book, allow_daily, allow_weekly, allow_monthly, cancellation_policy, house_rules, gate_close_time, contact_phone, submitted_at, approved_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        owners[pd.owner], pd.name, pd.name.toLowerCase().replace(/’/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), loc.get(pd.locality)!, pd.address, pd.pincode, pd.landmark, pd.description,
        pd.type, pd.gender, pd.food, pd.status, pd.verified, pd.instant ?? 1, pd.daily ?? 1, 1, pd.monthly ?? 1, pd.policy, RULES, pd.gate ?? '22:30', '+91 891 278 ' + (4000 + Math.floor(r() * 999)),
        pd.status !== 'draft' ? iso(addDays(created, 2)) : null, pd.status === 'approved' ? iso(addDays(created, 5)) : null, iso(created), iso(created),
      ).id;
      run("INSERT INTO property_status_history (property_id, to_status, actor_id, created_at) VALUES (?, 'draft', ?, ?)", pid, owners[pd.owner], iso(created));
      if (pd.status !== 'draft') run("INSERT INTO property_status_history (property_id, from_status, to_status, actor_id, created_at) VALUES (?, 'draft', 'pending_review', ?, ?)", pid, owners[pd.owner], iso(addDays(created, 2)));
      if (pd.status === 'approved') {
        run("INSERT INTO property_status_history (property_id, from_status, to_status, actor_id, reason, created_at) VALUES (?, 'pending_review', 'approved', ?, 'Physical audit completed', ?)", pid, adminId, iso(addDays(created, 5)));
        run("INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, 'property.approve', 'property', ?, ?, ?)", adminId, pid, JSON.stringify({ from: 'pending_review', to: 'approved' }), iso(addDays(created, 5)));
      }
      pd.photos.forEach((ph, i) => run('INSERT INTO property_photos (property_id, url, sort) VALUES (?, ?, ?)', pid, `/images/${ph}.png`, i));
      pd.amenities.forEach((a) => amen.has(a) && run('INSERT INTO property_amenities (property_id, amenity_id) VALUES (?, ?)', pid, amen.get(a)!));
      for (const [doc, st] of [['ownership_proof', pd.status === 'approved' ? 'verified' : 'pending'], ['owner_id', pd.status === 'approved' ? 'verified' : 'pending'], ['fssai', pd.food === 'none' ? null : pd.status === 'approved' ? 'verified' : 'pending']] as const) {
        if (!st || pd.status === 'draft') continue;
        const stored = crypto.randomBytes(16).toString('hex') + '.pdf';
        fs.mkdirSync(docDir, { recursive: true });
        fs.writeFileSync(path.join(docDir, stored), MINIMAL_PDF);
        run('INSERT INTO property_documents (property_id, doc_type, original_name, stored_name, mime_type, status) VALUES (?, ?, ?, ?, ?, ?)', pid, doc, `${doc}.pdf`, stored, 'application/pdf', st);
      }
      for (const [code, name, type, cap, ac, daily, weekly, monthly, deposit, features] of pd.rooms) {
        const rid = run(
          'INSERT INTO rooms (property_id, code, name, room_type, capacity, ac, attached_bath, price_daily, price_weekly, price_monthly, deposit, meals_included, features) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          pid, code, name, type, cap, ac, features.includes('ttached') ? 1 : 0, daily, weekly, monthly, deposit, pd.food === 'none' ? 0 : 1, features,
        ).id;
        const beds = type === 'private' ? 1 : cap;
        for (let i = 0; i < beds; i++) run('INSERT INTO beds (room_id, label) VALUES (?, ?)', rid, type === 'private' ? code : `${code}-${String.fromCharCode(65 + i)}`);
      }

      // Dated menus: published for the past week through tomorrow, drafts afterwards, with a gap to surface warnings.
      if (pd.food !== 'none' && pd.status === 'approved') {
        const allowNonVeg = pd.food === 'veg_nonveg';
        for (let d = -7; d <= 6; d++) {
          if (d === 4) continue;
          const date = addDays(today, d);
          const dow = new Date(date + 'T00:00:00Z').getUTCDay();
          const nonVegDay = allowNonVeg && (dow === 0 || dow === 3 || dow === 5);
          const status = d <= 1 ? 'published' : 'draft';
          const updated = clampPast(iso(date, 6));
          const mid = run(
            'INSERT INTO menus (property_id, menu_date, status, special_dish, updated_by, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            pid, date, status, nonVegDay ? (dow === 0 ? 'Sunday Andhra Chicken Dum Biryani' : 'Guntur Chicken Curry') : pick(['Gutti Vankaya Koora', 'Ghee Roast Podi Dosa', 'Semiya Payasam', 'Pesarattu Upma']), owners[pd.owner], updated, status === 'published' ? updated : null,
          ).id;
          let sort = 0;
          for (const meal of ['breakfast', 'lunch', 'dinner'] as const) {
            const veg = [...MENU[meal].veg].sort(() => r() - 0.5).slice(0, meal === 'lunch' ? 5 : 3);
            for (const dish of veg) run('INSERT INTO menu_items (menu_id, meal, name, is_veg, sort) VALUES (?, ?, ?, 1, ?)', mid, meal, dish, sort++);
            if (nonVegDay && meal !== 'breakfast') {
              run('INSERT INTO menu_items (menu_id, meal, name, is_veg, sort) VALUES (?, ?, ?, 0, ?)', mid, meal, pick(MENU[meal].nonveg), sort++);
            }
            if (allowNonVeg && meal === 'breakfast' && r() < 0.3) {
              run('INSERT INTO menu_items (menu_id, meal, name, is_veg, included, extra_charge, sort) VALUES (?, ?, ?, 0, 0, 30, ?)', mid, meal, 'Egg Bhurji (add-on)', sort++);
            }
          }
        }
      }
    }

    // Bookings timeline per bed without overlaps.
    const gst = 5;
    const commission = 10;
    const beds = all(
      `SELECT bd.id bed_id, r.id room_id, r.price_daily, r.price_weekly, r.price_monthly, r.deposit, p.id property_id, p.gender_policy, p.allow_daily, p.allow_weekly, p.allow_monthly, p.min_stay_days, p.owner_id
       FROM beds bd JOIN rooms r ON r.id = bd.room_id JOIN properties p ON p.id = r.property_id WHERE p.status = 'approved'`,
    );
    let seq = 1000;
    for (const bed of beds) {
      let cursor = addDays(today, -75 + Math.floor(r() * 10));
      while (cursor < addDays(today, 25)) {
        cursor = addDays(cursor, Math.floor(r() * 6));
        const roll = r();
        const nights = !bed.price_monthly ? (roll < 0.7 ? 1 + Math.floor(r() * 3) : 7) : roll < 0.45 ? 1 + Math.floor(r() * 3) : roll < 0.6 ? 7 : 30;
        const checkIn = cursor;
        const checkOut = addDays(checkIn, nights);
        cursor = checkOut;
        if (checkIn > addDays(today, 25)) break;
        const eligible = customers.filter((c) => (bed.gender_policy === 'men' ? c.gender === 'male' : bed.gender_policy === 'women' ? c.gender === 'female' : true));
        const cust = pick(eligible);
        const q = quote(bed as any, bed as any, checkIn, checkOut, { gstPercent: gst, commissionPercent: commission });
        let status: string;
        let payment: string;
        if (checkOut <= today) status = r() < 0.92 ? 'completed' : 'cancelled';
        else if (checkIn <= today) status = checkIn === today && r() < 0.5 ? 'confirmed' : 'checked_in';
        else status = r() < 0.08 ? 'cancelled' : 'confirmed';
        if (status === 'confirmed' && checkIn > addDays(today, 3) && r() < 0.12) status = 'requested';
        payment = status === 'requested' ? 'unpaid' : status === 'cancelled' ? 'refunded' : 'paid';
        const lead = q.stay_type === 'monthly' ? 3 + Math.floor(r() * 15) : Math.floor(r() * 5);
        const createdAt = clampPast(iso(addDays(checkIn, -lead), 9 + Math.floor(r() * 10)));
        const code = 'ODH-' + (seq++).toString(36).toUpperCase().padStart(6, '0');
        const bid = run(
          `INSERT INTO bookings (code, customer_id, property_id, room_id, bed_id, check_in, check_out, nights, stay_type, guest_name, guest_phone, guest_email, guest_gender,
             base_amount, discount, tax_amount, deposit, total_amount, commission_amount, status, payment_status, hold_expires_at, created_at, confirmed_at,
             checked_in_at, checked_out_at, cancelled_at, cancelled_by, cancel_reason)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          code, cust.id, bed.property_id, bed.room_id, bed.bed_id, checkIn, checkOut, q.nights, q.stay_type, cust.name, cust.phone, cust.email, cust.gender,
          q.base_amount, 0, q.tax_amount, q.deposit, q.total_amount, q.commission_amount, status, payment,
          status === 'requested' ? new Date(now + 20 * 3600000).toISOString() : null, createdAt,
          ['confirmed', 'checked_in', 'completed', 'cancelled'].includes(status) ? createdAt : null,
          ['checked_in', 'completed'].includes(status) ? iso(checkIn, 13) : null,
          status === 'completed' ? iso(checkOut, 10) : null,
          status === 'cancelled' ? createdAt : null, status === 'cancelled' ? 'customer' : null, status === 'cancelled' ? 'Change of plans' : null,
        ).id;
        if (payment !== 'unpaid') {
          const amount = q.total_amount + q.deposit;
          const payId = run(
            "INSERT INTO payments (booking_id, provider, provider_order_id, provider_payment_id, amount, method, status, signature_verified, created_at, paid_at) VALUES (?, 'seed', ?, ?, ?, ?, 'paid', 1, ?, ?)",
            bid, 'order_seed_' + code, 'pay_seed_' + code, amount, pick(['upi', 'upi', 'card', 'netbanking']), createdAt, createdAt,
          ).id;
          if (status === 'cancelled') {
            run("INSERT INTO refunds (booking_id, payment_id, amount, status, provider_refund_id, reason, created_at, processed_at) VALUES (?, ?, ?, 'processed', ?, 'Change of plans', ?, ?)", bid, payId, amount, 'rfnd_seed_' + code, createdAt, createdAt);
          }
        }
        if (status === 'completed' && r() < 0.55) {
          const rating = r() < 0.75 ? 5 : r() < 0.7 ? 4 : 3;
          const sub = () => Math.max(3, Math.min(5, rating + (r() < 0.3 ? -1 : 0)));
          const rv = run(
            'INSERT INTO reviews (booking_id, property_id, customer_id, rating, cleanliness, food, location, safety, comment, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            bid, bed.property_id, cust.id, rating, sub(), sub(), sub(), sub(), pick(REVIEWS), clampPast(iso(checkOut, 18)),
          ).id;
          if (r() < 0.35) run("UPDATE reviews SET owner_reply = 'Thank you for staying with us! We look forward to hosting you again.', owner_replied_at = ? WHERE id = ?", clampPast(iso(addDays(checkOut, 1), 11)), rv);
        }
      }
    }
    for (const p of all("SELECT id FROM properties WHERE status = 'approved'")) recalcRating(p.id);

    // Owner payouts: settled for stays that ended 30+ days ago, pending for the last fortnight window.
    for (const oid of Object.values(owners)) {
      for (const [from, to, st] of [[addDays(today, -90), addDays(today, -31), 'paid'], [addDays(today, -30), addDays(today, -15), 'pending']] as const) {
        const rows = all(
          `SELECT b.id, b.total_amount, b.commission_amount FROM bookings b JOIN properties p ON p.id = b.property_id
           WHERE p.owner_id = ? AND b.status = 'completed' AND b.check_out BETWEEN ? AND ?`,
          oid, from, to,
        );
        if (!rows.length) continue;
        const gross = rows.reduce((s, x) => s + x.total_amount, 0);
        const comm = rows.reduce((s, x) => s + x.commission_amount, 0);
        const poid = run(
          'INSERT INTO payouts (owner_id, period_start, period_end, gross_amount, commission_amount, net_amount, booking_count, status, reference, created_at, paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          oid, from, to, gross, comm, gross - comm, rows.length, st, st === 'paid' ? 'UTR' + Math.floor(1e9 + r() * 9e9) : null, iso(addDays(to, 2)), st === 'paid' ? iso(addDays(to, 4)) : null,
        ).id;
        rows.forEach((x) => run('INSERT INTO payout_items (payout_id, booking_id) VALUES (?, ?)', poid, x.id));
      }
    }

    // Coupons
    run("INSERT INTO coupons (code, description, discount_type, value, max_discount, min_amount, valid_from, valid_to, usage_limit, created_by) VALUES ('VIZAG10', '10% off your first stay', 'percent', 10, 500, 500, ?, ?, 1000, 1)", addDays(today, -30), addDays(today, 60));
    run("INSERT INTO coupons (code, description, property_id, owner_id, discount_type, value, min_amount, valid_from, valid_to, created_by) VALUES ('COASTAL300', '₹300 off monthly stays at Coastal Nest', 1, ?, 'flat', 300, 5000, ?, ?, ?)", owners.ramesh, addDays(today, -10), addDays(today, 45), owners.ramesh);

    // Support tickets & notifications
    const t1 = run("INSERT INTO support_tickets (user_id, subject, category, priority, status) VALUES (?, 'Caution deposit refund not received', 'refund', 'high', 'open')", customers[1].id).id;
    run('INSERT INTO ticket_messages (ticket_id, user_id, body) VALUES (?, ?, ?)', t1, customers[1].id, 'I checked out last week but my ₹2,000 deposit has not been refunded yet. Please help.');
    const t2 = run("INSERT INTO support_tickets (user_id, subject, category, priority, status) VALUES (?, 'Food quality complaint – dinner was cold', 'food', 'normal', 'in_progress')", customers[3].id).id;
    run('INSERT INTO ticket_messages (ticket_id, user_id, body) VALUES (?, ?, ?)', t2, customers[3].id, 'Dinner on Tuesday was served cold. Requesting a kitchen hygiene check.');
    const t3 = run("INSERT INTO support_tickets (user_id, subject, category, priority, status) VALUES (?, 'Payout schedule question', 'payment', 'low', 'open')", owners.lakshmi).id;
    run('INSERT INTO ticket_messages (ticket_id, user_id, body) VALUES (?, ?, ?)', t3, owners.lakshmi, 'When will this fortnight’s payout be released?');
    run("INSERT INTO disputes (booking_id, raised_by, reason) SELECT id, customer_id, 'Room did not match photos at check-in' FROM bookings WHERE status = 'cancelled' LIMIT 1");
    run("INSERT INTO review_reports (review_id, reporter_id, reason) SELECT id, ?, 'Review mentions a different property' FROM reviews WHERE rating <= 3 LIMIT 1", owners.ramesh);
    run("INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'menu', 'Publish tomorrow''s menu', 'Guests check menus before booking.', '/owner/menu/today')", owners.ramesh);
    run("INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'promo', 'Use VIZAG10 for 10% off', 'Valid on your first One Day Hostels stay.', '/search')", demo);
  });
  console.log('Seed complete. Logins: admin@onedayhostels.in / Admin@12345, owner@onedayhostels.in / Owner@12345, customer@onedayhostels.in / Customer@123');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed();
  closeDb();
}
