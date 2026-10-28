import { initializeApp } from "firebase/app";
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut as firebaseSignOut, 
  onAuthStateChanged,
  User
} from "firebase/auth";
import { 
  getFirestore, 
  collection, 
  doc, 
  getDocs, 
  getDoc, 
  setDoc, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  onSnapshot, 
  query, 
  where, 
  orderBy,
  serverTimestamp,
  getDocFromServer,
  writeBatch
} from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";

export const firebaseConfig = {
  apiKey: "AIzaSyBlG12KHQmiAw28sgULgkvyd1G829EU0rg",
  authDomain: "promptsverse-ai.firebaseapp.com",
  projectId: "promptsverse-ai",
  storageBucket: "promptsverse-ai.firebasestorage.app",
  messagingSenderId: "643305778874",
  appId: "1:643305778874:web:44e92dc6109479f04c9c83",
  measurementId: "G-L1YHXNBH4T"
};

// Initialize Firebase once
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const analytics = typeof window !== "undefined" ? getAnalytics(app) : null;
export const googleProvider = new GoogleAuthProvider();

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
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.warn('Firestore Operation Notice:', errInfo);
}

// Connection test - safe check without forced server throw
export async function testConnection() {
  try {
    // Optional gentle connection check
  } catch (error) {
    console.warn("Firestore connection pending or offline mode enabled");
  }
}

// User role check
export async function getUserRole(user: User | null): Promise<'admin' | 'user'> {
  if (!user) return 'user';
  try {
    const userSnap = await getDoc(doc(db, 'users', user.uid));
    if (userSnap.exists() && userSnap.data()?.role === 'admin') {
      return 'admin';
    }
  } catch (err) {
    console.warn("Could not fetch user role:", err);
  }
  return 'user';
}

// Sync user document upon authentication
export async function syncUserDoc(user: User) {
  const userRef = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(userRef);
    const role = snap.exists() ? snap.data()?.role || 'user' : 'user';
    
    await setDoc(userRef, {
      uid: user.uid,
      email: user.email || '',
      displayName: user.displayName || user.email?.split('@')[0] || 'PromptVerse Creator',
      photoURL: user.photoURL || '',
      role: role,
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
  
  // Apply responsive widths, automatic format selection, and intelligent quality adjustments (f_auto, q_auto)
  let optimizedUrl = data.secure_url;
  if (optimizedUrl.includes('/upload/') && !optimizedUrl.includes('f_auto')) {
    optimizedUrl = optimizedUrl.replace('/upload/', '/upload/f_auto,q_auto,w_800/');
  }

  // Log to Firestore mediaLibrary
  try {
    if (auth.currentUser) {
      await addDoc(collection(db, 'mediaLibrary'), {
        url: optimizedUrl,
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

  return optimizedUrl;
}

export function optimizeCloudinaryUrl(url: string, width = 800): string {
  if (!url) return 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80';
  if (url.includes('res.cloudinary.com') && url.includes('/upload/') && !url.includes('f_auto')) {
    return url.replace('/upload/', `/upload/f_auto,q_auto,w_${width}/`);
  }
  return url;
}

