import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SlidersHorizontal, X, SearchX, ShieldCheck } from 'lucide-react';
import { useCatalog } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useSaved } from '../lib/saved';
import { filterListings, paginate, type SearchFilters, type StayType } from '../../../shared/model';
import { PropertyCard } from '../components/PropertyCard';
import { Button, EmptyState, ErrorState, Pagination, Select, Skeleton, VegMark, cx, useDocumentTitle, useToast } from '../components/ui';
import { GENDER_LABEL, ROOM_TYPE_LABEL, inr } from '../lib/format';

const PAGE_SIZE = 9;
const csv = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);
const num = (v: string | null) => (v && !Number.isNaN(Number(v)) ? Number(v) : null);

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-line py-4 first:border-t-0 first:pt-0">
      <legend className="mb-2.5 text-xs font-bold uppercase tracking-wider text-navy">{title}</legend>
      {children}
    </fieldset>
  );
}

function Check({ checked, onChange, children, count }: { checked: boolean; onChange: () => void; children: React.ReactNode; count?: number }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 py-1 text-sm">
      <input type="checkbox" checked={checked} onChange={onChange} className="size-4 rounded border-line accent-teal" />
      <span className="flex flex-1 items-center gap-1.5">{children}</span>
      {count !== undefined && <span className="text-xs text-muted">{count}</span>}
    </label>
  );
}

export default function SearchPage() {
  useDocumentTitle('Hostels & PGs in Visakhapatnam');
  const [params, setParams] = useSearchParams();
  const { items, ref, error, reload, amenityNames } = useCatalog();
  const { user } = useAuth();
  const saved = useSaved();
  const toast = useToast();
  const nav = useNavigate();
  const [showFilters, setShowFilters] = useState(false);

  const filters: SearchFilters = useMemo(
    () => ({
      q: params.get('q') ?? undefined,
      localities: csv(params.get('locality')),
      stay: (params.get('stay') as StayType) || null,
      roomTypes: csv(params.get('room_type')) as SearchFilters['roomTypes'],
      genders: csv(params.get('gender')) as SearchFilters['genders'],
      foods: csv(params.get('food')) as SearchFilters['foods'],
      diet: (params.get('diet') as SearchFilters['diet']) || null,
      ac: params.get('ac') === '1' ? true : null,
      minPrice: num(params.get('min_price')),
      maxPrice: num(params.get('max_price')),
      minRating: num(params.get('min_rating')),
      amenities: csv(params.get('amenities')),
      verified: params.get('verified') === '1',
      sort: (params.get('sort') as SearchFilters['sort']) || 'recommended',
    }),
    [params],
  );
  const page = Number(params.get('page')) || 1;

  const update = (patch: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      const val = Array.isArray(v) ? v.join(',') : v;
      if (!val) next.delete(k);
      else next.set(k, val);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: false });
  };
  const toggleIn = (key: string, value: string) => {
    const cur = csv(params.get(key));
    update({ [key]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value] });
  };

  const results = useMemo(() => (items ? filterListings(items, filters) : null), [items, filters]);
  const paged = results ? paginate(results, page, PAGE_SIZE) : null;
  const locCounts = useMemo(() => {
    const m = new Map<string, number>();
    items?.forEach((l) => m.set(l.localityId, (m.get(l.localityId) ?? 0) + 1));
    return m;
  }, [items]);

  const stayPriceLabel = filters.stay === 'monthly' ? '/month' : filters.stay === 'weekly' ? '/week' : '/day';
  const applied: { label: string; clear: () => void }[] = [
    ...filters.localities!.map((l) => ({ label: ref?.localities.find((x) => x.id === l)?.name ?? l, clear: () => toggleIn('locality', l) })),
    ...filters.genders!.map((g) => ({ label: GENDER_LABEL[g], clear: () => toggleIn('gender', g) })),
    ...filters.roomTypes!.map((t) => ({ label: ROOM_TYPE_LABEL[t], clear: () => toggleIn('room_type', t) })),
    ...(filters.diet ? [{ label: filters.diet === 'pure_veg' ? 'Pure veg kitchen' : filters.diet === 'nonveg' ? 'Non-veg available' : 'Meals included', clear: () => update({ diet: null }) }] : []),
    ...(filters.ac ? [{ label: 'AC', clear: () => update({ ac: null }) }] : []),
    ...(filters.verified ? [{ label: 'Verified only', clear: () => update({ verified: null }) }] : []),
    ...(filters.maxPrice ? [{ label: `Under ${inr(filters.maxPrice)}${stayPriceLabel}`, clear: () => update({ max_price: null }) }] : []),
    ...(filters.minRating ? [{ label: `${filters.minRating}+ rating`, clear: () => update({ min_rating: null }) }] : []),
    ...filters.amenities!.map((a) => ({ label: amenityNames.get(a) ?? a, clear: () => toggleIn('amenities', a) })),
    ...(filters.q ? [{ label: `“${filters.q}”`, clear: () => update({ q: null }) }] : []),
  ];

  const onSave = async (id: string) => {
    if (!user) return nav('/login', { state: { from: `/search?${params}` } });
    try {
      const r = await saved.toggle(id);
      if (r === 'login') toast.show('Sign in with a customer account to save stays', 'error');
      else toast.show(r === 'saved' ? 'Saved to your list' : 'Removed from saved');
    } catch {
      toast.show('Could not update saved stays', 'error');
    }
  };

  const budgetMax = filters.stay === 'monthly' ? 25000 : filters.stay === 'weekly' ? 10000 : 2000;
  const budgetStep = filters.stay === 'monthly' ? 500 : filters.stay === 'weekly' ? 250 : 50;

  const filterPanel = (
    <div className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold">
          <SlidersHorizontal className="size-4" /> Filters
        </h2>
        <button className="text-xs font-bold text-coral" onClick={() => setParams(new URLSearchParams())}>
          Clear all
        </button>
      </div>
      <Group title="Stay duration mode">
        <div className="grid grid-cols-3 gap-1.5">
          {(['daily', 'weekly', 'monthly'] as const).map((s) => (
            <button key={s} onClick={() => update({ stay: filters.stay === s ? null : s, min_price: null, max_price: null })} className={cx('chip justify-center', filters.stay === s && 'chip-active')} aria-pressed={filters.stay === s}>
              {s === 'daily' ? 'Daily' : s === 'weekly' ? 'Weekly' : 'Monthly'}
            </button>
          ))}
        </div>
      </Group>
      <Group title="Audit verified">
        <Check checked={!!filters.verified} onChange={() => update({ verified: filters.verified ? null : '1' })}>
          <ShieldCheck className="size-4 text-teal" /> Verified properties only
        </Check>
      </Group>
      <Group title="Resident demographic">
        {(['women', 'men', 'coed', 'family'] as const).map((g) => (
          <Check key={g} checked={filters.genders!.includes(g)} onChange={() => toggleIn('gender', g)}>
            {GENDER_LABEL[g]}
          </Check>
        ))}
      </Group>
      <Group title="Food & mess">
        {[
          { id: 'pure_veg', label: 'Pure veg kitchen', mark: <VegMark veg /> },
          { id: 'veg', label: 'Meals included (any)', mark: <VegMark veg /> },
          { id: 'nonveg', label: 'Non-veg available', mark: <VegMark veg={false} /> },
        ].map((d) => (
          <Check key={d.id} checked={filters.diet === d.id} onChange={() => update({ diet: filters.diet === d.id ? null : d.id })}>
            {d.mark} {d.label}
          </Check>
        ))}
        <Check checked={filters.foods!.includes('none')} onChange={() => toggleIn('food', 'none')}>
          Accommodation only (no food)
        </Check>
      </Group>
      <Group title={`Budget (${stayPriceLabel.slice(1)})`}>
        <input
          type="range"
          min={0}
          max={budgetMax}
          step={budgetStep}
          value={filters.maxPrice ?? budgetMax}
          onChange={(e) => update({ max_price: Number(e.target.value) >= budgetMax ? null : e.target.value })}
          className="w-full accent-teal"
          aria-label="Maximum price"
        />
        <div className="mt-1 flex justify-between text-xs text-muted">
          <span>₹0</span>
          <span className="font-bold text-navy">{filters.maxPrice ? `Up to ${inr(filters.maxPrice)}` : 'Any price'}</span>
          <span>{inr(budgetMax)}+</span>
        </div>
      </Group>
      <Group title="Room configuration">
        {(['private', 'shared', 'dorm'] as const).map((t) => (
          <Check key={t} checked={filters.roomTypes!.includes(t)} onChange={() => toggleIn('room_type', t)}>
            {ROOM_TYPE_LABEL[t]}
          </Check>
        ))}
        <Check checked={!!filters.ac} onChange={() => update({ ac: filters.ac ? null : '1' })}>
          Air-conditioned rooms
        </Check>
      </Group>
      <Group title="Vizag localities">
        {ref?.localities.map((l) => (
          <Check key={l.id} checked={filters.localities!.includes(l.id)} onChange={() => toggleIn('locality', l.id)} count={locCounts.get(l.id) ?? 0}>
            {l.name}
          </Check>
        ))}
      </Group>
      <Group title="Guest rating">
        <div className="flex gap-1.5">
          {[3, 4, 4.5].map((r) => (
            <button key={r} onClick={() => update({ min_rating: filters.minRating === r ? null : String(r) })} className={cx('chip', filters.minRating === r && 'chip-active')} aria-pressed={filters.minRating === r}>
              {r}+ ★
            </button>
          ))}
        </div>
      </Group>
      <Group title="Facilities & comfort">
        {ref?.amenities.slice(0, 12).map((a) => (
          <Check key={a.id} checked={filters.amenities!.includes(a.id)} onChange={() => toggleIn('amenities', a.id)}>
            {a.name}
          </Check>
        ))}
      </Group>
    </div>
  );

  return (
    <div className="container-x py-8">
      <nav className="text-xs text-muted" aria-label="Breadcrumb">
        Vizag / <span className="font-semibold text-navy">Hostels &amp; PGs in Visakhapatnam</span>
      </nav>
      <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold sm:text-3xl">Hostels &amp; PGs in Visakhapatnam</h1>
          <p className="mt-1 text-sm text-muted">Daily, weekly and monthly stays with live mess menus and physically audited listings.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" className="lg:hidden" onClick={() => setShowFilters(true)}>
            <SlidersHorizontal className="size-4" /> Filters {applied.length > 0 && `(${applied.length})`}
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <span className="hidden font-semibold text-muted sm:inline">Sort by</span>
            <Select value={filters.sort} onChange={(e) => update({ sort: e.target.value === 'recommended' ? null : e.target.value })} className="w-48">
              <option value="recommended">Recommended</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
              <option value="rating">Top rated</option>
              <option value="newest">Newest</option>
            </Select>
          </label>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[290px_1fr]">
        <aside className="hidden lg:block">{filterPanel}</aside>
        {showFilters && (
          <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Filters">
            <div className="absolute inset-0 bg-navy/40" onClick={() => setShowFilters(false)} />
            <div className="relative ml-auto h-full w-[88%] max-w-sm overflow-y-auto bg-canvas p-4">
              <div className="mb-3 flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => setShowFilters(false)}>
                  <X className="size-4" /> Close
                </Button>
              </div>
              {filterPanel}
              <Button className="mt-4 w-full" onClick={() => setShowFilters(false)}>
                Show {results?.length ?? 0} stays
              </Button>
            </div>
          </div>
        )}

        <section aria-live="polite">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold">{results ? `${results.length} properties` : 'Loading…'}</span>
            {applied.map((a) => (
              <button key={a.label} onClick={a.clear} className="chip">
                {a.label} <X className="size-3" aria-label="Remove filter" />
              </button>
            ))}
          </div>
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : !paged ? (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-80" />
              ))}
            </div>
          ) : paged.total === 0 ? (
            <EmptyState icon={<SearchX className="size-6" />} title="No stays match these filters" action={<Button variant="secondary" onClick={() => setParams(new URLSearchParams())}>Reset filters</Button>}>
              Try widening your budget, removing a locality or switching the stay duration.
            </EmptyState>
          ) : (
            <>
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {paged.items.map((l) => (
                  <PropertyCard key={l.id} item={l} stay={filters.stay} saved={saved.ids.has(l.id)} onToggleSave={onSave} amenityNames={amenityNames} />
                ))}
              </div>
              <p className="mt-6 text-center text-xs text-muted">
                Showing {(paged.page - 1) * PAGE_SIZE + 1}–{Math.min(paged.page * PAGE_SIZE, paged.total)} of {paged.total} properties in Vizag
              </p>
              <div className="mt-3">
                <Pagination page={paged.page} pages={paged.pages} onChange={(p) => update({ page: String(p) })} />
              </div>
            </>
          )}
        </section>
      </div>
      {toast.node}
    </div>
  );
}
