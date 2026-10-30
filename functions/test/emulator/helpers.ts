import assert from 'node:assert/strict';

export const PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-odh-test';
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'}`;
export const FN = `http://127.0.0.1:5001/${PROJECT}/asia-south1`;

export async function signUp(email: string, password = 'Passw0rd!') {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const j: any = await r.json();
  assert.ok(j.idToken, JSON.stringify(j));
  return j as { idToken: string; localId: string };
}

export async function signIn(email: string, password = 'Passw0rd!') {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  return ((await r.json()) as any).idToken as string;
}

export const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

export async function call(name: string, data: unknown, token?: string) {
  const r = await fetch(`${FN}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return (await r.json()) as { result?: any; error?: { status: string; message: string; details?: any } };
}

/** Registers a customer through the real completeProfile function and returns a token carrying the role claim. */
export async function newCustomer(tag: string, gender?: string) {
  const email = `${tag}${Date.now()}${Math.floor(Math.random() * 1000)}@example.in`;
  const { idToken, localId } = await signUp(email);
  const r = await call('completeProfile', { name: `Guest ${tag}`, phone: '9876543210', role: 'customer' }, idToken);
  assert.equal(r.result?.role, 'customer', JSON.stringify(r));
  return { uid: localId, email, token: await signIn(email), gender };
}

export async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Timed out waiting for condition');
}

export async function clearFirestore() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085'}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
}
