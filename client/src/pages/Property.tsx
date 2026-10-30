import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  MapPin, Heart, Share2, ShieldCheck, Clock, DoorClosed, Users, Snowflake, Bath, BedDouble, CheckCircle2, Info, Utensils,
} from 'lucide-react';
import { getPropertyDetail, type PropertyDetail as Detail } from '../lib/data';
import { useCatalog } from '../lib/hooks';
import { useAuth, friendlyError } from '../lib/auth';
import { useSaved } from '../lib/saved';
import { todayIST, type Meal } from '../../../shared/model';
import { PropertyCard } from '../components/PropertyCard';
import { BookingPanel } from '../components/BookingPanel';
import { Badge, Button, ErrorState, FoodBadge, Rating, Spinner, VegMark, cx, useDocumentTitle, useToast } from '../components/ui';
import { ACCOM_LABEL, FOOD_HINT, GENDER_LABEL, MEAL_LABEL, ROOM_TYPE_LABEL, fmtDate, inr } from '../lib/format';
import NotFound from './NotFound';

const POLICY: Record<string, string> = {
  flexible: 'Full refund up to 24 hours before check-in, 50% after that. Free cancellation within 24 hours of booking.',
  moderate: 'Full refund up to 3 days before check-in, 50% up to 24 hours before, no refund after. Free cancellation within 24 hours of booking.',
  strict: '50% refund up to 7 days before check-in, no refund after. Free cancellation within 24 hours of booking.',
};

export default function PropertyPage() {
  const { slug = '' } = useParams();
  const [data, setData] = useState<Detail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [photo, setPhoto] = useState(0);
  const { items, amenityNames, ref } = useCatalog();
  const { user } = useAuth();
  const saved = useSaved();
  const toast = useToast();
  const nav = useNavigate();

  const load = useCallback(async () => {
    setError(null);
    setData(undefined);
    try {
      const d = await getPropertyDetail(slug);
      setData(d);
      if (d) setRoomId(d.rooms[0]?.id ?? null);
    } catch (e) {
      setError(friendlyError(e).message);
    }
  }, [slug]);
  useEffect(() => {
    load();
  }, [load]);
  useDocumentTitle(data?.property.name ?? 'Property');

  const similar = useMemo(() => {
    if (!items || !data) return [];
    return items.filter((l) => l.id !== data.id && (l.localityId === data.property.localityId || l.genderPolicy === data.property.genderPolicy)).sort((a, b) => b.ratingAvg - a.ratingAvg).slice(0, 3);
  }, [items, data]);

  if (error) return <div className="container-x py-16"><ErrorState message={error} onRetry={load} /></div>;
  if (data === undefined) return <Spinner label="Loading property…" />;
  if (data === null) return <NotFound />;

  const p = data.property;
  const amenities = (ref?.amenities ?? []).filter((a) => p.amenityIds.includes(a.id));
  const isSaved = saved.ids.has(data.id);
  const onSave = async (id: string) => {
    if (!user) return nav('/login', { state: { from: `/property/${slug}` } });
    try {
      const r = await saved.toggle(id);
      if (r === 'login') toast.show('Sign in with a customer account to save stays', 'error');
      else toast.show(r === 'saved' ? 'Saved to your list' : 'Removed from saved');
    } catch {
      toast.show('Could not update saved stays', 'error');
    }
  };
  const share = async () => {
    const url = window.location.href;
    if (navigator.share) await navigator.share({ title: p.name, url }).catch(() => undefined);
    else {
      await navigator.clipboard.writeText(url);
      toast.show('Link copied');
    }
  };
  const meals: Meal[] = ['breakfast', 'lunch', 'dinner'];

  return (
    <div className="container-x py-8">
      {p.status !== 'approved' && (
        <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
          Preview – this listing is not public yet (status: {p.status.replace('_', ' ')}).
        </div>
      )}
      <nav className="text-xs text-muted" aria-label="Breadcrumb">
        <Link to="/search" className="hover:text-navy">Vizag</Link> / <Link to={`/search?locality=${p.localityId}`} className="hover:text-navy">{p.localityName}</Link> / <span className="font-semibold text-navy">{p.name}</span>
      </nav>

      <div className="mt-3 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            {p.verified && <Badge tone="navy"><ShieldCheck className="size-3.5" /> Vizag Verified</Badge>}
            <Badge tone="teal">{ACCOM_LABEL[p.accommodationType]}</Badge>
            <Badge tone="slate">{GENDER_LABEL[p.genderPolicy]}</Badge>
          </div>
          <h1 className="mt-2 text-2xl font-extrabold sm:text-3xl">{p.name}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span className="inline-flex items-center gap-1"><MapPin className="size-4 text-teal" /> {p.address}{p.pincode ? `, ${p.pincode}` : ''}</span>
            <Rating value={p.ratingAvg} count={p.ratingCount} className="text-navy" />
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={share}><Share2 className="size-4" /> Share</Button>
          <Button variant="secondary" size="sm" onClick={() => onSave(data.id)} aria-pressed={isSaved}>
            <Heart className={cx('size-4', isSaved && 'fill-coral text-coral')} /> {isSaved ? 'Saved' : 'Save'}
          </Button>
        </div>
      </div>

      {p.photos.length > 0 && (
        <div className="mt-6 grid gap-2 md:grid-cols-[2fr_1fr] md:grid-rows-2">
          <button className="relative overflow-hidden rounded-2xl md:row-span-2" onClick={() => setPhoto((photo + 1) % p.photos.length)} aria-label="Next photo">
            <img src={p.photos[photo].url} alt={p.photos[photo].caption ?? p.name} className="aspect-[16/10] size-full object-cover md:aspect-auto md:h-[420px]" />
            <span className="absolute bottom-3 right-3 rounded-full bg-navy/80 px-3 py-1 text-xs font-bold text-white">{photo + 1} / {p.photos.length}</span>
          </button>
          {p.photos.slice(1, 3).map((ph, i) => (
            <button key={ph.url} className="hidden overflow-hidden rounded-2xl md:block" onClick={() => setPhoto(i + 1)} aria-label={`Show photo ${i + 2}`}>
              <img src={ph.url} alt={ph.caption ?? ''} loading="lazy" className="h-[206px] w-full object-cover" />
            </button>
          ))}
        </div>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-8">
          <section className="card p-6">
            <h2 className="text-lg font-bold">Residence overview</h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted">{p.description}</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl bg-mist p-3.5"><Users className="size-4 text-teal" /><p className="mt-1.5 text-sm font-bold">{GENDER_LABEL[p.genderPolicy]}</p><p className="text-xs text-muted">Resident policy</p></div>
              <div className="rounded-xl bg-mist p-3.5"><Utensils className="size-4 text-teal" /><p className="mt-1.5 text-sm font-bold">{p.foodType === 'none' ? 'No mess' : '3-time fresh food'}</p><p className="text-xs text-muted">{FOOD_HINT[p.foodType]}</p></div>
              <div className="rounded-xl bg-mist p-3.5"><Clock className="size-4 text-teal" /><p className="mt-1.5 text-sm font-bold">Check-in {p.checkInTime}</p><p className="text-xs text-muted">Check-out {p.checkOutTime}</p></div>
            </div>
          </section>

          {p.foodType !== 'none' && (
            <section className="card p-6">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-bold">Today’s published mess menu</h2>
                  <p className="text-xs text-muted">Live kitchen menu for {fmtDate(todayIST(), { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })}</p>
                </div>
                <FoodBadge type={p.foodType} className="border border-line" />
              </div>
              {data.menu ? (
                <>
                  {data.menu.specialDish && <p className="mt-4 rounded-xl bg-coral-50 px-4 py-2.5 text-sm font-semibold text-coral">Special today: {data.menu.specialDish}</p>}
                  <div className="mt-4 grid gap-4 md:grid-cols-3">
                    {meals.map((meal) => {
                      const list = data.menu!.items.filter((i) => i.meal === meal);
                      return (
                        <div key={meal} className="rounded-xl border border-line p-4">
                          <p className="text-[11px] font-bold uppercase tracking-wider text-teal">{MEAL_LABEL[meal]}</p>
                          <p className="text-xs text-muted">{p.mealTimes[meal]}</p>
                          {list.length ? (
                            <ul className="mt-3 space-y-2">
                              {list.map((i) => (
                                <li key={i.name} className="flex items-start gap-2 text-sm">
                                  <span className="mt-0.5"><VegMark veg={i.isVeg} /></span>
                                  <span className="flex-1">{i.name}{!i.included && <span className="text-xs text-muted"> (+{inr(i.extraCharge)})</span>}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-3 text-sm text-muted">Not listed</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <p className="mt-4 rounded-xl bg-mist px-4 py-3 text-sm text-muted">The kitchen hasn’t published today’s menu yet. Menus are usually updated by 8 AM.</p>
              )}
            </section>
          )}

          <section className="card p-6">
            <h2 className="text-lg font-bold">Select room &amp; bed configuration</h2>
            <p className="text-xs text-muted">Transparent rates{p.foodType !== 'none' ? ' including daily meals' : ''}, Wi-Fi and electricity.</p>
            {data.rooms.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No rooms are listed yet.</p>
            ) : (
              <div className="mt-4 space-y-3" role="radiogroup" aria-label="Room type">
                {data.rooms.map((r) => {
                  const beds = r.beds.filter((b) => b.active).length;
                  const sel = r.id === roomId;
                  return (
                    <button key={r.id} role="radio" aria-checked={sel} onClick={() => setRoomId(r.id)} className={cx('flex w-full flex-col gap-3 rounded-2xl border p-4 text-left transition sm:flex-row sm:items-center', sel ? 'border-teal bg-teal-50/50 ring-2 ring-teal/20' : 'border-line hover:border-teal/50')}>
                      <div className="flex-1">
                        <p className="font-bold">{r.name}</p>
                        <p className="mt-0.5 text-xs text-muted">{r.features}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold">
                          <span className="rounded-md bg-white px-2 py-0.5">{ROOM_TYPE_LABEL[r.roomType]}</span>
                          <span className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-0.5"><BedDouble className="size-3" /> {r.roomType === 'private' ? `Sleeps ${r.capacity}` : `${beds} beds`}</span>
                          {r.ac && <span className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-0.5"><Snowflake className="size-3" /> AC</span>}
                          {r.attachedBath && <span className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-0.5"><Bath className="size-3" /> Attached bath</span>}
                        </div>
                      </div>
                      <div className="text-left sm:text-right">
                        {r.priceMonthly ? <p className="text-lg font-extrabold">{inr(r.priceMonthly)}<span className="text-xs font-semibold text-muted"> /month</span></p> : null}
                        <p className={cx(r.priceMonthly ? 'text-xs text-muted' : 'text-lg font-extrabold')}>{r.priceMonthly ? 'or ' : ''}{inr(r.priceDaily)}{r.priceMonthly ? ' / day' : <span className="text-xs font-semibold text-muted"> /day</span>}</p>
                        <span className={cx('mt-1 inline-block text-xs font-bold', sel ? 'text-teal' : 'text-navy')}>{sel ? 'Selected' : 'Select room'}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {amenities.length > 0 && (
            <section className="card p-6">
              <h2 className="text-lg font-bold">Comprehensive amenities</h2>
              <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {amenities.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-teal" /> {a.name}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="card p-6">
            <h2 className="text-lg font-bold">Residence standards &amp; timings</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <div><p className="flex items-center gap-1.5 text-sm font-bold"><DoorClosed className="size-4 text-teal" /> Gate timings</p><p className="mt-1 text-sm text-muted">{p.gateCloseTime ? `Main gate closes at ${p.gateCloseTime}.` : 'Open 24 hours.'}</p></div>
              <div><p className="flex items-center gap-1.5 text-sm font-bold"><Clock className="size-4 text-teal" /> Check-in / out</p><p className="mt-1 text-sm text-muted">Check-in from {p.checkInTime}, check-out by {p.checkOutTime}.</p></div>
              <div><p className="flex items-center gap-1.5 text-sm font-bold"><Info className="size-4 text-teal" /> Cancellation</p><p className="mt-1 text-sm text-muted">{POLICY[p.cancellationPolicy]}</p></div>
            </div>
            {p.houseRules && <ul className="mt-5 list-disc space-y-1 pl-5 text-sm text-muted">{p.houseRules.split('\n').filter(Boolean).map((r) => <li key={r}>{r}</li>)}</ul>}
          </section>

          <section className="card p-6">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 className="text-lg font-bold">Guest ratings &amp; real feedback</h2>
              {p.ratingCount > 0 && <p className="text-sm"><span className="text-2xl font-extrabold">{p.ratingAvg.toFixed(2)}</span> <span className="text-muted">from {p.ratingCount} verified stays</span></p>}
            </div>
            {data.reviews.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No reviews yet. Reviews can only be written by guests after a completed stay.</p>
            ) : (
              <ul className="mt-5 space-y-5">
                {data.reviews.map((r) => (
                  <li key={r.id} className="border-t border-line pt-5 first:border-0 first:pt-0">
                    <div className="flex items-center gap-3">
                      <span className="grid size-9 place-items-center rounded-full bg-navy text-xs font-bold text-white">{r.customerName.split(' ').map((w) => w[0]).join('').slice(0, 2)}</span>
                      <div className="flex-1">
                        <p className="text-sm font-bold">{r.customerName}</p>
                        <p className="text-xs text-muted">{fmtDate(new Date(r.createdAt).toISOString())} · {r.stayType} stay</p>
                      </div>
                      <Rating value={r.rating} />
                    </div>
                    <p className="mt-2 text-sm leading-relaxed">“{r.comment}”</p>
                    {r.ownerReply && <p className="mt-2 rounded-xl bg-mist px-3 py-2 text-xs"><span className="font-bold">Owner reply:</span> {r.ownerReply}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          {p.status === 'approved' ? (
            <BookingPanel propertyId={data.id} property={p} rooms={data.rooms} roomId={roomId} onRoomChange={setRoomId} />
          ) : (
            <div className="card p-5 text-sm text-muted">Booking opens once this listing is approved.</div>
          )}
        </aside>
      </div>

      {similar.length > 0 && (
        <section className="mt-14">
          <h2 className="text-xl font-extrabold">Similar stays nearby</h2>
          <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {similar.map((l) => <PropertyCard key={l.id} item={l} saved={saved.ids.has(l.id)} onToggleSave={onSave} amenityNames={amenityNames} />)}
          </div>
        </section>
      )}
      {toast.node}
    </div>
  );
}
