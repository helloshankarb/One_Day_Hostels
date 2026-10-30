import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu, X, Heart, UserRound, LogOut, MapPin, ChevronDown, ShieldCheck, Utensils, Phone } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { getReference, type Reference } from '../lib/data';
import { cx } from './ui';
import { BRAND } from '../lib/format';

export function Logo({ light = false }: { light?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5" aria-label={`${BRAND} home`}>
      <span className="grid size-9 place-items-center rounded-xl bg-teal text-sm font-extrabold text-white">1D</span>
      <span className="leading-none">
        <span className={cx('block text-[15px] font-extrabold', light ? 'text-white' : 'text-navy')}>{BRAND}</span>
        <span className={cx('block text-[9px] font-bold tracking-[0.16em]', light ? 'text-white/60' : 'text-muted')}>VIZAG STAYS &amp; FOOD</span>
      </span>
    </Link>
  );
}

function useLocalities() {
  const [ref, setRef] = useState<Reference | null>(null);
  useEffect(() => {
    getReference().then(setRef).catch(() => setRef(null));
  }, []);
  return ref?.localities ?? [];
}

function SiteHeader() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [hubOpen, setHubOpen] = useState(false);
  const localities = useLocalities();
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => {
    setOpen(false);
    setHubOpen(false);
  }, [loc.pathname, loc.search]);

  const link = ({ isActive }: { isActive: boolean }) => cx('rounded-lg px-3 py-2 text-sm font-semibold transition', isActive ? 'text-teal' : 'text-navy hover:text-teal');

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-white/95 backdrop-blur no-print">
      <div className="container-x flex h-16 items-center gap-4">
        <Logo />
        <nav className="ml-6 hidden items-center gap-1 lg:flex" aria-label="Main">
          <div className="relative">
            <button
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-left text-sm font-semibold hover:text-teal"
              aria-expanded={hubOpen}
              aria-haspopup="true"
              onClick={() => setHubOpen((v) => !v)}
            >
              <MapPin className="size-4 text-teal" aria-hidden />
              <span>
                <span className="block text-[10px] font-bold uppercase tracking-wider text-muted">City hub</span>
                All Vizag localities
              </span>
              <ChevronDown className="size-4" aria-hidden />
            </button>
            {hubOpen && (
              <div className="card absolute left-0 top-full mt-2 grid w-80 grid-cols-2 gap-1 p-2">
                {localities.map((l) => (
                  <Link key={l.id} to={`/search?locality=${l.id}`} className="rounded-lg px-3 py-2 text-sm hover:bg-mist">
                    {l.name}
                  </Link>
                ))}
              </div>
            )}
          </div>
          <NavLink to="/search" className={link}>
            Find Stays
          </NavLink>
          {user?.role === 'customer' && (
            <NavLink to="/account?tab=saved" className={link}>
              Saved
            </NavLink>
          )}
        </nav>
        <div className="ml-auto hidden items-center gap-2 lg:flex">
          <span className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-bold text-muted" title="Prices in Indian Rupees">
            INR ₹
          </span>
          {user ? (
            <>
              <Link to="/account" className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold hover:bg-mist">
                <span className="grid size-8 place-items-center rounded-full bg-navy text-xs font-bold text-white">{(user.name || user.email).slice(0, 1).toUpperCase()}</span>
                {user.name.split(' ')[0] || 'Account'}
              </Link>
              <button
                className="rounded-xl p-2 text-muted hover:bg-mist hover:text-navy"
                onClick={async () => {
                  await logout();
                  nav('/');
                }}
                aria-label="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="rounded-xl px-3 py-2 text-sm font-semibold hover:bg-mist">
                Sign in
              </Link>
              <Link to="/register?role=owner" className="rounded-xl bg-navy px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-700">
                List Your Property
              </Link>
            </>
          )}
        </div>
        <button className="ml-auto rounded-xl p-2 lg:hidden" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open}>
          {open ? <X className="size-6" /> : <Menu className="size-6" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-line bg-white lg:hidden">
          <nav className="container-x flex flex-col gap-1 py-3" aria-label="Mobile">
            <Link to="/search" className="rounded-lg px-3 py-2.5 font-semibold hover:bg-mist">
              Find Stays
            </Link>
            {user ? (
              <>
                <Link to="/account" className="flex items-center gap-2 rounded-lg px-3 py-2.5 font-semibold hover:bg-mist">
                  <UserRound className="size-4" /> My account
                </Link>
                {user.role === 'customer' && (
                  <Link to="/account?tab=saved" className="flex items-center gap-2 rounded-lg px-3 py-2.5 font-semibold hover:bg-mist">
                    <Heart className="size-4" /> Saved
                  </Link>
                )}
                <button
                  className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-left font-semibold hover:bg-mist"
                  onClick={async () => {
                    await logout();
                    nav('/');
                  }}
                >
                  <LogOut className="size-4" /> Sign out
                </button>
              </>
            ) : (
              <>
                <Link to="/login" className="rounded-lg px-3 py-2.5 font-semibold hover:bg-mist">
                  Sign in
                </Link>
                <Link to="/register" className="rounded-lg px-3 py-2.5 font-semibold hover:bg-mist">
                  Create account
                </Link>
                <Link to="/register?role=owner" className="rounded-lg bg-navy px-3 py-2.5 font-semibold text-white">
                  List Your Property
                </Link>
              </>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}

function SiteFooter() {
  const localities = useLocalities();
  return (
    <footer className="mt-20 bg-navy-900 text-white/80 no-print">
      <div className="container-x grid gap-10 py-14 md:grid-cols-2 lg:grid-cols-4">
        <div>
          <Logo light />
          <p className="mt-4 text-sm leading-relaxed text-white/60">
            The verified PG, hostel and dormitory booking platform for Visakhapatnam – stay for a day, a week or a month, with transparent daily food menus.
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-bold">
            <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1">
              <ShieldCheck className="size-3.5" /> Vizag Verified Audit
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1">
              <Utensils className="size-3.5" /> FSSAI Compliant Mess
            </span>
          </div>
        </div>
        <div>
          <h3 className="text-sm font-bold text-white">Vizag Locality Hubs</h3>
          <ul className="mt-4 space-y-2 text-sm">
            {localities.slice(0, 6).map((l) => (
              <li key={l.id}>
                <Link to={`/search?locality=${l.id}`} className="hover:text-white">
                  {l.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-bold text-white">Food &amp; Stays</h3>
          <ul className="mt-4 space-y-2 text-sm">
            <li><Link to="/search?diet=pure_veg" className="hover:text-white">Pure Veg Dedicated PGs</Link></li>
            <li><Link to="/search?diet=nonveg" className="hover:text-white">Veg &amp; Non-Veg Mess</Link></li>
            <li><Link to="/search?gender=women" className="hover:text-white">Women-only Hostels</Link></li>
            <li><Link to="/search?stay=daily" className="hover:text-white">One-day Dorm Beds</Link></li>
            <li><Link to="/search?stay=monthly" className="hover:text-white">Monthly PG Stays</Link></li>
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-bold text-white">Support &amp; Policies</h3>
          <ul className="mt-4 space-y-2 text-sm">
            <li><Link to="/about" className="hover:text-white">About us</Link></li>
            <li><Link to="/faqs" className="hover:text-white">FAQs</Link></li>
            <li><Link to="/contact" className="hover:text-white">Contact</Link></li>
            <li><Link to="/cancellation-policy" className="hover:text-white">Cancellation &amp; refunds</Link></li>
            <li className="flex items-center gap-1.5"><Phone className="size-3.5" /> Vizag Care: 1800-123-4567</li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="container-x flex flex-col gap-2 py-5 text-xs text-white/50 sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} {BRAND} (Visakhapatnam, AP). All rights reserved.</span>
          <span className="flex gap-4">
            <Link to="/privacy" className="hover:text-white">Privacy Policy</Link>
            <Link to="/terms" className="hover:text-white">Terms of Service</Link>
            <Link to="/cancellation-policy" className="hover:text-white">Cancellation Policy</Link>
          </span>
        </div>
      </div>
    </footer>
  );
}

export function SiteLayout() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
