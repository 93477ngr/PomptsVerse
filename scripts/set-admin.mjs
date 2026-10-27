import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

const uid = process.argv[2];

if (!uid) {
  console.error('Usage: node scripts/set-admin.mjs <USER_UID>');
  process.exit(1);
}

try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = JSON.parse(readFileSync('./service-account.json', 'utf8'));
  }

  initializeApp({
    credential: cert(serviceAccount)
  });

  const auth = getAuth();
  const db = getFirestore();

  await auth.setCustomUserClaims(uid, { admin: true });
  await db.collection('users').doc(uid).set({ role: 'admin', updatedAt: new Date() }, { merge: true });

  console.log(`Successfully granted admin custom claims and role to user UID: ${uid}`);
  process.exit(0);
} catch (err) {
  console.error('Failed to set admin custom claims:', err);
  process.exit(1);
}
