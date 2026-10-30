import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './auth';
import { getSavedIds, setSaved } from './data';

interface SavedState {
  ids: Set<string>;
  toggle: (propertyId: string) => Promise<'saved' | 'removed' | 'login'>;
}

const Ctx = createContext<SavedState | null>(null);

export function SavedProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [ids, setIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user?.profileComplete || user.role !== 'customer') {
      setIds(new Set());
      return;
    }
    getSavedIds(user.uid).then((x) => setIds(new Set(x))).catch(() => setIds(new Set()));
  }, [user?.uid, user?.profileComplete, user?.role]);

  const toggle = useCallback<SavedState['toggle']>(
    async (pid) => {
      if (!user || user.role !== 'customer') return 'login';
      const on = !ids.has(pid);
      setIds((s) => {
        const n = new Set(s);
        if (on) n.add(pid);
        else n.delete(pid);
        return n;
      });
      try {
        await setSaved(user.uid, pid, on);
      } catch (e) {
        setIds((s) => {
          const n = new Set(s);
          if (on) n.delete(pid);
          else n.add(pid);
          return n;
        });
        throw e;
      }
      return on ? 'saved' : 'removed';
    },
    [user, ids],
  );

  const value = useMemo(() => ({ ids, toggle }), [ids, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSaved() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSaved outside provider');
  return c;
}
