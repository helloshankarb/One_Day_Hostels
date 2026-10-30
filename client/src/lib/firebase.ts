import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { initializeFirestore, connectFirestoreEmulator, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';

const env = import.meta.env;

// Web config is public by design; access control is enforced by Security Rules and Cloud Functions.
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID,
};

export const firebaseConfigured = Boolean(config.apiKey && config.projectId);
export const usingEmulators = env.VITE_USE_EMULATORS === 'true';

if (!firebaseConfigured) {
  console.error('Firebase is not configured. Copy client/.env.example to client/.env.production (or use .env.development with emulators).');
}

export const app = initializeApp(firebaseConfigured ? config : { apiKey: 'missing', projectId: 'demo-unconfigured', appId: 'missing' });
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
export const functions = getFunctions(app, env.VITE_FIREBASE_FUNCTIONS_REGION || 'asia-south1');

const emulatorHost = env.VITE_EMULATOR_HOST || '127.0.0.1';
if (usingEmulators) {
  connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, emulatorHost, 8085);
  connectFunctionsEmulator(functions, emulatorHost, 5001);
}

/** Cloud Storage is only needed for uploads (owner portal), so it is loaded on demand. */
export async function getStorageClient() {
  const { getStorage, connectStorageEmulator } = await import('firebase/storage');
  const storage = getStorage(app);
  if (usingEmulators && !(storage as unknown as { _odhEmu?: boolean })._odhEmu) {
    connectStorageEmulator(storage, emulatorHost, 9199);
    (storage as unknown as { _odhEmu?: boolean })._odhEmu = true;
  }
  return storage;
}

/** Analytics loads lazily, only in production builds with a measurement ID and browser support. */
export async function initAnalytics() {
  if (usingEmulators || !config.measurementId || !firebaseConfigured) return null;
  const { getAnalytics, isSupported } = await import('firebase/analytics');
  return (await isSupported()) ? getAnalytics(app) : null;
}
