import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { setGlobalOptions } from 'firebase-functions/v2';

// Imported by every function module, so this runs before any function is defined.
// Mumbai region keeps latency low for Visakhapatnam users; instance cap bounds cost.
setGlobalOptions({ region: 'asia-south1', maxInstances: 10, memory: '256MiB' });

if (!getApps().length) initializeApp();

export const db = getFirestore();
export const adminAuth = getAuth();

export function audit(actorId: string | null, action: string, entity: string, entityId: string | null, details?: unknown) {
  return db.collection('auditLogs').add({ actorId, action, entity, entityId, details: details ?? null, createdAt: Date.now() });
}
