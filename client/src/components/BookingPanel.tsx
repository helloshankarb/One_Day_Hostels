import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ShieldCheck, Phone, BedDouble } from 'lucide-react';
import { getAvailability, type RoomAvailability } from '../lib/booking';
import { friendlyError, useAuth } from '../lib/auth';
import { addDays, todayIST, type PropertyDoc, type RoomDoc } from '../../../shared/model';
import { diffDays } from '../../../shared/pricing';
import { Alert, Badge, Button, cx } from './ui';
import { inr } from '../lib/format';

interface Props {
  propertyId: string;
  property: PropertyDoc;
  rooms: (RoomDoc & { id: string })[];
  roomId: string | null;
  onRoomChange: (id: string) => void;
}

export function BookingPanel({ propertyId, property: p, rooms, roomId, onRoomChange }: Props) {
  const { user } = useAuth();
  const nav = useNavigate();
  const today = todayIST();
  const defaultMonthly = p.allowMonthly && rooms.some((r) => r.priceMonthly);
  const [checkIn, setCheckIn] = useState(today);
  const [checkOut, setCheckOut] = useState(addDays(today, defaultMonthly ? 30 : Math.max(1, p.minStayDays)));
  const [avail, setAvail] = useState<RoomAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [bedId, setBedId] = useState<string | null>(null);

  const nights = diffDays(checkIn, checkOut);
  const datesValid = checkIn >= today && nights > 0;

  useEffect(() => {
    if (!datesValid) return;
    let alive = true;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      getAvailability({ propertyId, checkIn, checkOut })
        .then((r) => alive && setAvail(r.rooms))
        .catch((e) => alive && setError(friendlyError(e).message))
        .finally(() => alive && setLoading(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [propertyId, checkIn, checkOut, datesValid]);

  const room = useMemo(() => avail?.find((r) => r.id === roomId) ?? null, [avail, roomId]);
  const roomDoc = rooms.find((r) => r.id === roomId);
  useEffect(() => setBedId(null), [roomId, checkIn, checkOut]);

  const reserve = () => {
    if (!room?.quote) return;
    const params = new URLSearchParams({ room: room.id, in: checkIn, out: checkOut, ...(bedId ? { bed: bedId } : {}) });
    const target = `/book/${propertyId}?${params}`;
    if (!user) nav('/login', { state: { from: target } });
    else nav(target);
  };

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-2">
        <div>
          {room?.quote ? (
            <>
              <p className="text-2xl font-extrabold">{inr(room.quote.payableNow)}</p>
              <p className="text-xs text-muted">for {nights} night{nights > 1 ? 's' : ''} incl. GST{room.quote.deposit ? ' & refundable deposit' : ''}</p>
            </>
          ) : (
            <p className="text-sm font-semibold text-muted">Choose dates to see the price</p>
          )}
          <p className="mt-1 text-xs font-semibold text-teal">Zero brokerage</p>
        </div>
        {p.verified && <Badge tone="teal"><ShieldCheck className="size-3.5" /> Verified</Badge>}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <label className="rounded-xl border border-line px-3 py-2">
          <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted"><CalendarDays className="size-3" /> Check-in</span>
          <input type="date" value={checkIn} min={today} max={addDays(today, 365)} onChange={(e) => {
            setCheckIn(e.target.value);
            if (e.target.value >= checkOut) setCheckOut(addDays(e.target.value, 1));
          }} className="w-full bg-transparent text-sm font-semibold focus:outline-none" />
        </label>
        <label className="rounded-xl border border-line px-3 py-2">
          <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted"><CalendarDays className="size-3" /> Check-out</span>
          <input type="date" value={checkOut} min={addDays(checkIn, 1)} max={addDays(checkIn, 180)} onChange={(e) => setCheckOut(e.target.value)} className="w-full bg-transparent text-sm font-semibold focus:outline-none" />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {[{ n: 1, l: '1 night' }, { n: 7, l: '1 week' }, { n: 30, l: '1 month' }].filter((o) => (o.n === 30 ? p.allowMonthly : o.n === 7 ? p.allowWeekly : p.allowDaily)).map((o) => (
          <button key={o.n} type="button" onClick={() => setCheckOut(addDays(checkIn, o.n))} className={cx('chip', nights === o.n && 'chip-active')}>{o.l}</button>
        ))}
      </div>

      <div className="mt-4">
        <label className="label" htmlFor="room-select">Room</label>
        <select id="room-select" className="input" value={roomId ?? ''} onChange={(e) => onRoomChange(e.target.value)}>
          {rooms.map((r) => {
            const a = avail?.find((x) => x.id === r.id);
            return <option key={r.id} value={r.id}>{r.name}{a ? ` – ${a.availableBeds ? `${a.availableBeds} available` : 'full'}` : ''}</option>;
          })}
        </select>
      </div>

      {room && roomDoc && roomDoc.roomType !== 'private' && room.availableBeds > 0 && (
        <div className="mt-3">
          <p className="label">Bed (optional)</p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setBedId(null)} className={cx('chip', !bedId && 'chip-active')}>Any free bed</button>
            {room.beds.map((b) => (
              <button key={b.id} type="button" disabled={!b.available} onClick={() => setBedId(b.id)} className={cx('chip disabled:cursor-not-allowed disabled:opacity-40', bedId === b.id && 'chip-active')}>
                <BedDouble className="size-3" /> {b.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {room?.quote && (
        <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
          {room.quote.lines.map((l) => <div key={l.label} className="flex justify-between"><dt className="text-muted">{l.label}</dt><dd>{inr(l.amount)}</dd></div>)}
          <div className="flex justify-between"><dt className="text-muted">GST</dt><dd>{inr(room.quote.taxAmount)}</dd></div>
          {room.quote.deposit > 0 && <div className="flex justify-between"><dt className="text-muted">Security deposit (refundable)</dt><dd>{inr(room.quote.deposit)}</dd></div>}
          <div className="flex justify-between font-bold"><dt>Pay now</dt><dd>{inr(room.quote.payableNow)}</dd></div>
        </dl>
      )}

      <div className="mt-4 space-y-2">
        {!datesValid && <Alert>Choose a check-out date after check-in.</Alert>}
        {error && <Alert>{error}</Alert>}
        {room?.quoteError && <Alert>{room.quoteError}</Alert>}
        {room && !room.availableBeds && <Alert tone="info">This room is full for these dates. Try another room or dates.</Alert>}
      </div>
      <Button className="mt-4 w-full" size="lg" loading={loading} disabled={!room?.quote || !room.availableBeds || user?.role === 'owner' || user?.role === 'admin'} onClick={reserve}>
        Reserve &amp; pay securely
      </Button>
      <p className="mt-2 text-center text-xs text-muted">
        {user && user.role !== 'customer' ? 'Sign in with a guest account to book.' : 'Your bed is held for 15 minutes while you pay. Payments are processed by Cashfree.'}
      </p>
      {p.contactPhone && (
        <a href={`tel:${p.contactPhone.replace(/\s/g, '')}`} className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-line py-2.5 text-sm font-semibold hover:border-teal">
          <Phone className="size-4 text-teal" /> {p.contactPhone}
        </a>
      )}
    </div>
  );
}
