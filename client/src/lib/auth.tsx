import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  onIdTokenChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, sendEmailVerification,
  sendPasswordResetEmail, signOut, reload, type User as FbUser,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions } from './firebase';
import type { Role, UserDoc } from '../../../shared/model';

export interface User {
  uid: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role | null;
  adminRole: string | null;
  emailVerified: boolean;
  /** False when Firebase Auth has the account but the server-side profile/role has not been created yet. */
  profileComplete: boolean;
}

export interface RegisterInput {
  name: string;
  email: string;
  phone: string;
  password: string;
  role: 'customer' | 'owner';
  businessName?: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<User>;
  register: (input: RegisterInput) => Promise<User>;
  completeProfile: (input: Omit<RegisterInput, 'email' | 'password'>) => Promise<User>;
  logout: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  refresh: () => Promise<User | null>;
}

const Ctx = createContext<AuthState | null>(null);

async function load(fb: FbUser, forceToken = false): Promise<User> {
  const token = await fb.getIdTokenResult(forceToken);
  const role = (token.claims.role as Role | undefined) ?? null;
  let profile: UserDoc | null = null;
  if (role) {
    const snap = await getDoc(doc(db, 'users', fb.uid));
    profile = snap.exists() ? (snap.data() as UserDoc) : null;
  }
  return {
    uid: fb.uid,
    email: fb.email ?? '',
    name: profile?.name ?? fb.displayName ?? '',
    phone: profile?.phone ?? null,
    role,
    adminRole: (token.claims.adminRole as string | undefined) ?? null,
    emailVerified: fb.emailVerified,
    profileComplete: !!role && !!profile,
  };
}

const completeProfileFn = httpsCallable<Omit<RegisterInput, 'email' | 'password'>, { role: Role }>(functions, 'completeProfile');

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(
    () =>
      onIdTokenChanged(auth, async (fb) => {
        try {
          setUser(fb ? await load(fb) : null);
        } catch (e) {
          console.error('Failed to load profile', e);
          setUser(null);
        } finally {
          setLoading(false);
        }
      }),
    [],
  );

  const refresh = useCallback(async () => {
    const fb = auth.currentUser;
    if (!fb) return null;
    await reload(fb);
    const u = await load(fb, true);
    setUser(u);
    return u;
  }, []);

  const completeProfile = useCallback<AuthState['completeProfile']>(async (input) => {
    const fb = auth.currentUser;
    if (!fb) throw new Error('Please sign in again');
    await completeProfileFn(input);
    const u = await load(fb, true);
    setUser(u);
    return u;
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      refresh,
      completeProfile,
      async signIn(email, password) {
        const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
        const u = await load(cred.user, true);
        setUser(u);
        return u;
      },
      async register(input) {
        const cred = await createUserWithEmailAndPassword(auth, input.email.trim(), input.password);
        await updateProfile(cred.user, { displayName: input.name });
        sendEmailVerification(cred.user, { url: `${window.location.origin}/account` }).catch((e) => console.warn('verification email failed', e));
        return completeProfile({ name: input.name, phone: input.phone, role: input.role, ...(input.businessName ? { businessName: input.businessName } : {}) });
      },
      async logout() {
        await signOut(auth);
        setUser(null);
      },
      async resetPassword(email) {
        await sendPasswordResetEmail(auth, email.trim(), { url: `${window.location.origin}/login` });
      },
      async resendVerification() {
        if (auth.currentUser) await sendEmailVerification(auth.currentUser, { url: `${window.location.origin}/account` });
      },
    }),
    [user, loading, refresh, completeProfile],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}

export const homeFor = (u: Pick<User, 'role'> | null) => (u?.role === 'owner' ? '/owner' : u?.role === 'admin' ? '/admin' : '/account');

const AUTH_ERRORS: Record<string, string> = {
  'auth/invalid-credential': 'Incorrect email or password',
  'auth/wrong-password': 'Incorrect email or password',
  'auth/user-not-found': 'Incorrect email or password',
  'auth/email-already-in-use': 'An account with this email already exists',
  'auth/weak-password': 'Choose a stronger password (at least 8 characters)',
  'auth/invalid-email': 'Enter a valid email address',
  'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
  'auth/network-request-failed': 'Network error. Check your connection and try again.',
  'auth/user-disabled': 'This account has been suspended. Contact support.',
};

/** Maps Firebase Auth / Functions errors to user-facing text and field errors. */
export function friendlyError(e: unknown): { message: string; fields?: Record<string, string> } {
  const err = e as { code?: string; message?: string; details?: { fields?: Record<string, string> } };
  if (err?.code && AUTH_ERRORS[err.code]) return { message: AUTH_ERRORS[err.code] };
  if (err?.code?.startsWith('functions/')) return { message: err.message ?? 'Request failed', fields: err.details?.fields };
  if (err?.code === 'permission-denied') return { message: 'You do not have permission to do that.' };
  if (err?.code === 'unavailable') return { message: 'Service is temporarily unavailable. Please try again.' };
  return { message: err?.message ?? 'Something went wrong. Please try again.' };
}
