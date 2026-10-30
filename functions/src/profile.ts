import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db, adminAuth, audit } from './admin.ts';
import { PHONE_RE, type Role, type UserDoc } from '../../shared/model.ts';

const profileInput = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(80),
  phone: z.string().trim().regex(PHONE_RE, 'Enter a valid Indian mobile number'),
  role: z.enum(['customer', 'owner']).default('customer'),
  businessName: z.string().trim().max(120).nullish(),
});

export function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] ??= i.message;
    throw new HttpsError('invalid-argument', 'Please correct the highlighted fields', { fields });
  }
  return r.data;
}

export function requireAuth(req: CallableRequest) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in to continue');
  return req.auth;
}

/**
 * Creates the user profile after Firebase Auth sign-up and assigns the role claim.
 * Idempotent; the role can only be chosen once (customers/owners). Admin roles are granted by `setUserRole`.
 */
export const completeProfile = onCall(async (req) => {
  const auth = requireAuth(req);
  const input = parseOrThrow(profileInput, req.data);
  const ref = db.collection('users').doc(auth.uid);
  const role = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return (snap.data() as UserDoc).role;
    const now = Date.now();
    const user: UserDoc = {
      uid: auth.uid,
      email: auth.token.email ?? '',
      name: input.name,
      phone: input.phone,
      role: input.role,
      status: 'active',
      createdAt: now,
    };
    tx.create(ref, user);
    if (input.role === 'owner') {
      tx.create(db.collection('ownerProfiles').doc(auth.uid), {
        businessName: input.businessName ?? null,
        kycStatus: 'pending',
        onboardingStep: 1,
        createdAt: now,
      });
    }
    return input.role;
  });
  const current = (await adminAuth.getUser(auth.uid)).customClaims ?? {};
  if (current.role !== role) await adminAuth.setCustomUserClaims(auth.uid, { ...current, role });
  if (role === input.role && !current.role) await audit(auth.uid, 'user.register', 'user', auth.uid, { role });
  return { role };
});

/** Admin-only role management. */
export const setUserRole = onCall(async (req) => {
  const auth = requireAuth(req);
  if (auth.token.role !== 'admin' || auth.token.adminRole !== 'super_admin') {
    throw new HttpsError('permission-denied', 'Only super administrators can change roles');
  }
  const input = parseOrThrow(
    z.object({ uid: z.string().min(1), role: z.enum(['customer', 'owner', 'admin']), adminRole: z.enum(['super_admin', 'finance', 'moderator', 'support']).optional() }),
    req.data,
  );
  if (input.uid === auth.uid) throw new HttpsError('failed-precondition', 'You cannot change your own role');
  const ref = db.collection('users').doc(input.uid);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'User not found');
  const claims: { role: Role; adminRole?: string } = { role: input.role };
  if (input.role === 'admin') claims.adminRole = input.adminRole ?? 'support';
  await adminAuth.setCustomUserClaims(input.uid, claims);
  await ref.update({ role: input.role, updatedAt: Date.now() });
  await adminAuth.revokeRefreshTokens(input.uid);
  await audit(auth.uid, 'user.set_role', 'user', input.uid, claims);
  return { ok: true };
});
