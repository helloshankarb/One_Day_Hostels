import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MapPin, CalendarDays, Users, Search, ShieldCheck, Utensils, BadgeIndianRupee, RotateCcw, GraduationCap, Laptop, ShieldPlus, Dumbbell, ArrowRight } from 'lucide-react';
import { useCatalog } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useSaved } from '../lib/saved';
import { filterListings, todayIST, addDays } from '../../../shared/model';
import { PropertyCard } from '../components/PropertyCard';
import { Skeleton, ErrorState, cx, useToast, useDocumentTitle } from '../components/ui';

const DURATIONS = [
  { id: 'monthly', label: 'Monthly Stay' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'multi', label: 'Multi-day' },
  { id: 'daily', label: 'Daily Pass' },
] as const;
const FOODS = [
  { id: '', label: 'All Menus' },
  { id: 'pure_veg', label: 'Pure Veg' },
  { id: 'nonveg', label: 'Non-Veg Included' },
] as const;

export default function Home() {
  useDocumentTitle('');
  const { items, ref, error, reload, amenityNames } = useCatalog();
  const { user } = useAuth();
  const saved = useSaved();
  const toast = useToast();
  const nav = useNavigate();
  const [duration, setDuration] = useState<(typeof DURATIONS)[number]['id']>('monthly');
  const [diet, setDiet] = useState('');
  const [locality, setLocality] = useState('');
  const [checkIn, setCheckIn] = useState(todayIST());
  const [gender, setGender] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = new URLSearchParams();
    if (locality) p.set('locality', locality);
    p.set('stay', duration === 'multi' ? 'daily' : duration);
    if (diet) p.set('diet', diet);
    if (gender) p.set('gender', gender);
    if (checkIn) p.set('check_in', checkIn);
    nav(`/search?${p}`);
  };

  const count = (f: Parameters<typeof filterListings>[1]) => (items ? filterListings(items, f).length : null);
  const clusters = [
    { title: 'GITAM & AU Student Hubs', body: 'Walking distance to campus, late-night tea messes and study rooms.', icon: GraduationCap, tag: 'Campus hub', to: '/search?locality=madhurawada,siripuram', n: count({ localities: ['madhurawada', 'siripuram'] }), img: '/images/study-1.png' },
    { title: 'Rushikonda IT Corridor', body: 'High-speed Wi-Fi, 100% power backup and quiet night work zones.', icon: Laptop, tag: 'Tech corridor', to: '/search?locality=rushikonda', n: count({ localities: ['rushikonda'] }), img: '/images/room-8.png' },
    { title: 'Women-Only Hostels', body: '24/7 resident wardens, biometric entry and CCTV security.', icon: ShieldPlus, tag: 'Biometric safe', to: '/search?gender=women', n: count({ genders: ['women'] }), img: '/images/room-5.png' },
    { title: 'Men-Only PG & Hostels', body: 'Flexible 1/2/3 sharing, gym access and hearty Andhra mess.', icon: Dumbbell, tag: "Men's living", to: '/search?gender=men', n: count({ genders: ['men'] }), img: '/images/room-7.png' },
  ];
  const featured = items ? filterListings(items, { sort: 'recommended' }).slice(0, 4) : null;
  const trending = (ref?.localities ?? []).slice(0, 5);

  const onSave = async (id: string) => {
    if (!user) return nav('/login', { state: { from: '/' } });
    try {
      const r = await saved.toggle(id);
      if (r === 'login') toast.show('Sign in with a customer account to save stays', 'error');
      else toast.show(r === 'saved' ? 'Saved to your list' : 'Removed from saved');
    } catch {
      toast.show('Could not update saved stays', 'error');
    }
  };

  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-b from-mist to-canvas">
        <div className="container-x pb-16 pt-14 text-center sm:pt-20">
          <p className="eyebrow">Visakhapatnam real-time living &amp; dining network</p>
          <h1 className="mx-auto mt-4 max-w-3xl text-4xl font-extrabold leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl">
            Find Your Stay. Enjoy Verified Home Meals in <span className="text-teal">Vizag.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-muted">
            Audited student dorms, executive IT suites and authentic daily Andhra mess menus across MVP Colony, GITAM Road, Rushikonda and Siripuram – book for a day, a week or a month.
          </p>
          {trending.length > 0 && (
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-sm">
              <span className="font-semibold text-muted">Trending neighbourhoods:</span>
              {trending.map((l) => (
                <Link key={l.id} to={`/search?locality=${l.id}`} className="chip">
                  {l.name}
                </Link>
              ))}
            </div>
          )}

          <form onSubmit={submit} className="card mx-auto mt-10 max-w-5xl p-4 text-left sm:p-5" aria-label="Search stays">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Duration">
                <span className="text-[11px] font-bold uppercase tracking-wider text-muted">Duration:</span>
                {DURATIONS.map((d) => (
                  <button type="button" key={d.id} role="radio" aria-checked={duration === d.id} onClick={() => setDuration(d.id)} className={cx('chip', duration === d.id && 'chip-active')}>
                    {d.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Food preference">
                {FOODS.map((f) => (
                  <button type="button" key={f.id} role="radio" aria-checked={diet === f.id} onClick={() => setDiet(f.id)} className={cx('chip', diet === f.id && 'chip-active')}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-[1.3fr_1fr_1fr_auto]">
              <label className="rounded-xl border border-line px-3.5 py-2.5">
                <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
                  <MapPin className="size-3.5 text-teal" /> Vizag locality / hub
                </span>
                <select value={locality} onChange={(e) => setLocality(e.target.value)} className="mt-0.5 w-full bg-transparent text-sm font-semibold focus:outline-none">
                  <option value="">All of Visakhapatnam</option>
                  {ref?.localities.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="rounded-xl border border-line px-3.5 py-2.5">
                <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
                  <CalendarDays className="size-3.5 text-teal" /> Stay timeline
                </span>
                <input type="date" value={checkIn} min={todayIST()} max={addDays(todayIST(), 365)} onChange={(e) => setCheckIn(e.target.value)} className="mt-0.5 w-full bg-transparent text-sm font-semibold focus:outline-none" />
              </label>
              <label className="rounded-xl border border-line px-3.5 py-2.5">
                <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
                  <Users className="size-3.5 text-teal" /> Type &amp; guest
                </span>
                <select value={gender} onChange={(e) => setGender(e.target.value)} className="mt-0.5 w-full bg-transparent text-sm font-semibold focus:outline-none">
                  <option value="">Any hostel / PG</option>
                  <option value="men">Boys PG / Hostel</option>
                  <option value="women">Girls PG / Hostel</option>
                  <option value="coed">Co-ed / Co-living</option>
                  <option value="family">Family stay</option>
                </select>
              </label>
              <button type="submit" className="flex items-center justify-center gap-2 rounded-xl bg-navy px-6 py-3 text-sm font-semibold text-white hover:bg-navy-700">
                <Search className="size-4" /> Explore Stays
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="container-x mt-16">
        <p className="eyebrow">Curated student &amp; executive clusters</p>
        <h2 className="mt-2 text-2xl font-extrabold sm:text-3xl">Tailored for your Vizag lifestyle</h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {clusters.map((c) => (
            <Link key={c.title} to={c.to} className="card group overflow-hidden">
              <div className="relative h-36 overflow-hidden">
                <img src={c.img} alt="" loading="lazy" className="size-full object-cover transition duration-500 group-hover:scale-105" />
                <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-white/95 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider">
                  <c.icon className="size-3.5 text-teal" /> {c.tag}
                </span>
              </div>
              <div className="p-4">
                <h3 className="font-bold">{c.title}</h3>
                <p className="mt-1 text-sm text-muted">{c.body}</p>
                <p className="mt-3 inline-flex items-center gap-1 text-sm font-bold text-teal">
                  {c.n === null ? 'Browse stays' : `Browse ${c.n} verified stays`} <ArrowRight className="size-4" />
                </p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="container-x mt-20">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="eyebrow">Physically inspected &amp; FSSAI audited</p>
            <h2 className="mt-2 text-2xl font-extrabold sm:text-3xl">Featured top-tier stays in Vizag</h2>
            <p className="mt-1 text-sm text-muted">Direct property bookings with transparent daily menus and zero brokerage.</p>
          </div>
          <Link to="/search?sort=rating" className="text-sm font-bold text-teal">
            View all stays →
          </Link>
        </div>
        <div className="mt-8">
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : !featured ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-80" />
              ))}
            </div>
          ) : featured.length === 0 ? (
            <p className="card p-8 text-center text-sm text-muted">No properties are live yet. Check back soon.</p>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {featured.map((l) => (
                <PropertyCard key={l.id} item={l} saved={saved.ids.has(l.id)} onToggleSave={onSave} amenityNames={amenityNames} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="container-x mt-20 text-center">
        <p className="eyebrow">The standard in Visakhapatnam</p>
        <h2 className="mt-2 text-2xl font-extrabold sm:text-3xl">Why Vizag chooses One Day Hostels</h2>
        <p className="mx-auto mt-2 max-w-2xl text-sm text-muted">No brokers, no hidden electricity charges and no unpredictable mess meals.</p>
        <div className="mt-10 grid gap-5 text-left sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: ShieldCheck, t: 'Physically verified rooms', b: 'Our Vizag field team audits rooms, beds, bathrooms and Wi-Fi speeds before a listing goes live.' },
            { icon: Utensils, t: 'Daily meal transparency', b: 'Hostel messes publish breakfast, lunch and dinner every day – with clear veg and non-veg marks.' },
            { icon: BadgeIndianRupee, t: 'Zero brokerage', b: 'Book directly with the property. No middlemen, entry fees or surprise maintenance charges.' },
            { icon: RotateCcw, t: 'Clear refund policies', b: 'Every listing shows its cancellation policy up front, and refunds are tracked in your account.' },
          ].map((f) => (
            <div key={f.t} className="card p-5">
              <span className="grid size-11 place-items-center rounded-xl bg-teal-50 text-teal">
                <f.icon className="size-5" />
              </span>
              <h3 className="mt-4 font-bold">{f.t}</h3>
              <p className="mt-1.5 text-sm text-muted">{f.b}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container-x mt-20">
        <div className="overflow-hidden rounded-3xl bg-navy p-8 text-white sm:p-12 lg:flex lg:items-center lg:justify-between lg:gap-10">
          <div className="max-w-2xl">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-50/80">For Visakhapatnam property owners</p>
            <h2 className="mt-3 text-2xl font-extrabold sm:text-3xl">Are you a PG or hostel owner in Vizag? List your property and manage daily food menus effortlessly.</h2>
            <p className="mt-3 text-sm text-white/70">Fill vacant beds with verified students and IT professionals, streamline rent collection and publish daily menus to hundreds of local guests.</p>
          </div>
          <div className="mt-6 flex shrink-0 flex-wrap gap-3 lg:mt-0">
            <Link to="/register?role=owner" className="rounded-xl bg-white px-5 py-3 text-sm font-bold text-navy hover:bg-mist">
              List your PG today
            </Link>
            <Link to="/login" className="rounded-xl border border-white/30 px-5 py-3 text-sm font-bold text-white hover:bg-white/10">
              Owner sign in
            </Link>
          </div>
        </div>
      </section>
      {toast.node}
    </>
  );
}
