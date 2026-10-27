import { initializeApp, getApps } from "firebase/app";
import { 
  getAuth, 
  GoogleAuthProvider, 
  User,
  setPersistence,
  browserLocalPersistence
} from "firebase/auth";
import { 
  getFirestore, 
  doc, 
  getDoc, 
  setDoc, 
  addDoc, 
  collection,
  serverTimestamp,
  getDocFromServer
} from "firebase/firestore";
import { getAnalytics, isSupported } from "firebase/analytics";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyBlG12KHQmiAw28sgULgkvyd1G829EU0rg",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "promptsverse-ai.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "promptsverse-ai",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "promptsverse-ai.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "643305778874",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:643305778874:web:44e92dc6109479f04c9c83",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-L1YHXNBH4T"
};

// Initialize Firebase once
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

// Enable browserLocalPersistence
setPersistence(auth, browserLocalPersistence).catch(() => {
  /* ignore persistence error in constrained contexts */
});

// Lazy Analytics initialization wrapped in isSupported() and try/catch
export let analytics: any = null;
if (typeof window !== "undefined") {
  isSupported().then((supported) => {
    if (supported) {
      try {
        analytics = getAnalytics(app);
      } catch (err) {
        console.warn("[Analytics] Initialization notice:", err);
      }
    }
  }).catch(() => {
    /* Analytics blocked by ad-blocker or unsupported environment */
  });
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified || false,
      isAnonymous: auth.currentUser?.isAnonymous || false,
      tenantId: auth.currentUser?.tenantId || null,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.warn('[Firestore Operation Notice]', JSON.stringify(errInfo));
}

// Connection test
export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'siteConfigs', 'stats')).catch(() => {});
  } catch (error) {
    console.warn("[Firestore] Connection check offline mode or pending");
  }
}

// User role check — verifies custom claims first, falls back to users doc
export async function getUserRole(user: User | null): Promise<'admin' | 'user'> {
  if (!user) return 'user';
  try {
    // Check custom claims token first
    const tokenResult = await user.getIdTokenResult(true).catch(() => null);
    if (tokenResult && tokenResult.claims && tokenResult.claims.admin === true) {
      return 'admin';
    }

    // Fallback: check Firestore users collection
    const userSnap = await getDoc(doc(db, 'users', user.uid));
    if (userSnap.exists() && userSnap.data()?.role === 'admin') {
      return 'admin';
    }
  } catch (err) {
    console.warn("[Auth] Could not fetch user role:", err);
  }
  return 'user';
}

// Sync user document upon authentication
export async function syncUserDoc(user: User) {
  if (!user) return;
  const userRef = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(userRef);
    const existingRole = snap.exists() ? snap.data()?.role || 'user' : 'user';
    
    await setDoc(userRef, {
      uid: user.uid,
      email: user.email || '',
      displayName: user.displayName || user.email?.split('@')[0] || 'PromptVerse Creator',
      photoURL: user.photoURL || '',
      role: existingRole,
      updatedAt: serverTimestamp(),
      ...(snap.exists() ? {} : { createdAt: serverTimestamp() })
    }, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`);
  }
}

// Cloudinary unsigned upload helper
export async function uploadToCloudinary(file: File): Promise<string> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || 'o2pfmu7m';
  const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || 'promptverse_unsigned';

  // Check file type
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
  if (!allowedTypes.includes(file.type)) {
    throw new Error('Invalid file type. Allowed: JPG, PNG, WEBP, GIF, AVIF');
  }
  // Max 10MB
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('File size exceeds 10MB limit');
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', uploadPreset);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `Cloudinary upload failed: ${res.statusText}`);
  }

  const data = await res.json();
  if (!data.secure_url) {
    throw new Error('Cloudinary response missing secure_url');
  }
  
  const rawUrl = data.secure_url;

  // Log to Firestore mediaLibrary
  try {
    if (auth.currentUser) {
      await addDoc(collection(db, 'mediaLibrary'), {
        url: rawUrl,
        filename: file.name,
        bytes: file.size,
        format: file.type.split('/')[1] || 'png',
        uploadedBy: auth.currentUser.uid,
        uploadedByEmail: auth.currentUser.email || '',
        timestamp: serverTimestamp()
      });
    }
  } catch (err) {
    console.warn('Failed to log media file to Firestore:', err);
  }

  return rawUrl;
}

export function optimizeCloudinaryUrl(url: string, width = 800): string {
  if (!url) return 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80';
  if (url.includes('res.cloudinary.com') && url.includes('/upload/') && !url.includes('f_auto')) {
    return url.replace('/upload/', `/upload/f_auto,q_auto,w_${width}/`);
  }
  return url;
}
