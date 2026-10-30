import { Link } from 'react-router-dom';
import { Heart, MapPin, ShieldCheck, Snowflake, BedDouble } from 'lucide-react';
import type { Listing, StayType } from '../../../shared/model';
import { inr, GENDER_LABEL, ROOM_TYPE_LABEL } from '../lib/format';
import { FoodBadge, Rating, cx } from './ui';

export function PropertyCard({
  item, stay, saved, onToggleSave, amenityNames,
}: {
  item: Listing;
  stay?: StayType | null;
  saved?: boolean;
  onToggleSave?: (id: string) => void;
  amenityNames?: Map<string, string>;
}) {
  const monthlyFirst = stay !== 'daily' && stay !== 'weekly' && item.minMonthly;
  const amen = item.amenityIds.map((a) => amenityNames?.get(a)).filter(Boolean).slice(0, 3) as string[];
  return (
    <article className="card group relative flex flex-col overflow-hidden transition hover:-translate-y-0.5 hover:shadow-lg">
      <div className="relative aspect-[16/10] overflow-hidden bg-mist">
        {item.photos[0] ? (
          <img src={item.photos[0]} alt={item.name} loading="lazy" className="size-full object-cover transition duration-500 group-hover:scale-105" />
        ) : (
          <div className="grid size-full place-items-center text-muted">
            <BedDouble className="size-8" />
          </div>
        )}
        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          {item.verified && (
            <span className="inline-flex items-center gap-1 rounded-full bg-navy/90 px-2.5 py-1 text-[11px] font-bold text-white">
              <ShieldCheck className="size-3.5" /> Vizag Verified
            </span>
          )}
          <span className="rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-bold text-navy">{GENDER_LABEL[item.genderPolicy]}</span>
        </div>
        {onToggleSave && (
          <button
            onClick={() => onToggleSave(item.id)}
            className="absolute right-3 top-3 z-10 grid size-9 place-items-center rounded-full bg-white/95 shadow"
            aria-label={saved ? `Remove ${item.name} from saved` : `Save ${item.name}`}
            aria-pressed={saved}
          >
            <Heart className={cx('size-4', saved ? 'fill-coral text-coral' : 'text-navy')} />
          </button>
        )}
        <FoodBadge type={item.foodType} className="absolute bottom-3 left-3" />
      </div>
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-center justify-between gap-2 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3.5 text-teal" /> {item.localityName}
          </span>
          <span className="font-semibold text-teal">{item.totalBeds} beds</span>
        </div>
        <div className="mt-1.5 flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-base font-bold leading-snug">
            <Link to={`/property/${item.id}`} className="after:absolute after:inset-0 focus:outline-none">
              {item.name}
            </Link>
          </h3>
          <Rating value={item.ratingAvg} count={item.ratingCount} className="shrink-0" />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.hasAc && (
            <span className="inline-flex items-center gap-1 rounded-md bg-mist px-2 py-0.5 text-[11px] font-semibold">
              <Snowflake className="size-3" /> AC
            </span>
          )}
          {item.roomTypes.map((t) => (
            <span key={t} className="rounded-md bg-mist px-2 py-0.5 text-[11px] font-semibold">
              {ROOM_TYPE_LABEL[t]}
            </span>
          ))}
          {amen.map((a) => (
            <span key={a} className="rounded-md bg-mist px-2 py-0.5 text-[11px] font-semibold">
              {a}
            </span>
          ))}
        </div>
        <div className="mt-auto flex items-end justify-between gap-2 pt-4">
          <div>
            {monthlyFirst ? (
              <>
                <p className="text-lg font-extrabold">
                  {inr(item.minMonthly)}
                  <span className="text-xs font-semibold text-muted"> /month</span>
                </p>
                <p className="text-xs text-muted">or {inr(item.minDaily)}/day</p>
              </>
            ) : stay === 'weekly' && item.minWeekly ? (
              <>
                <p className="text-lg font-extrabold">
                  {inr(item.minWeekly)}
                  <span className="text-xs font-semibold text-muted"> /week</span>
                </p>
                <p className="text-xs text-muted">or {inr(item.minDaily)}/day</p>
              </>
            ) : (
              <p className="text-lg font-extrabold">
                {inr(item.minDaily)}
                <span className="text-xs font-semibold text-muted"> /day</span>
              </p>
            )}
          </div>
          <span className="relative z-10 rounded-xl bg-navy px-3 py-2 text-xs font-semibold text-white">View details</span>
        </div>
      </div>
    </article>
  );
}
