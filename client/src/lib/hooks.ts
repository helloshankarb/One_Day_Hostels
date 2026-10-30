import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCatalog, getReference, type Reference } from './data';
import { friendlyError } from './auth';
import type { Listing } from '../../../shared/model';

export function useCatalog() {
  const [items, setItems] = useState<Listing[] | null>(null);
  const [ref, setRef] = useState<Reference | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    setError(null);
    try {
      const [c, r] = await Promise.all([getCatalog(force), getReference()]);
      setItems(c);
      setRef(r);
    } catch (e) {
      setError(friendlyError(e).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const amenityNames = useMemo(() => new Map((ref?.amenities ?? []).map((a) => [a.id, a.name])), [ref]);
  return { items, ref, error, loading: !items && !error, reload: () => load(true), amenityNames };
}
