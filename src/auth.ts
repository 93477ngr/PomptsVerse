import { 
  auth, 
  googleProvider, 
  syncUserDoc, 
  getUserRole 
} from './firebase';
import { 
  signInWithPopup, 
  signInWithRedirect, 
  getRedirectResult, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  sendEmailVerification, 
  sendPasswordResetEmail, 
  signOut as firebaseSignOut, 
  updateProfile,
  User 
} from 'firebase/auth';

export function mapAuthError(code: string): string {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Invalid email address or password. Please double check and try again.';
    case 'auth/email-already-in-use':
      return 'An account with this email address already exists. Please login instead.';
    case 'auth/weak-password':
      return 'Password should be at least 8 characters long.';
    case 'auth/too-many-requests':
      return 'Too many unsuccessful login attempts. Please wait a moment and try again.';
    case 'auth/popup-closed-by-user':
      return 'Sign-in window was closed before completing authentication.';
    case 'auth/popup-blocked':
      return 'Sign-in popup was blocked by your browser. Attempting redirect mode...';
    case 'auth/network-request-failed':
      return 'Network connection issue. Please check your internet connection.';
    case 'auth/unauthorized-domain':
      return 'Domain not authorized in Firebase Console. Please add domain in Firebase Auth Settings.';
    case 'auth/operation-not-allowed':
      return 'Email/Password or Google authentication is not enabled in Firebase Console.';
    default:
      return code ? `Authentication notice: ${code.replace('auth/', '').replace(/-/g, ' ')}` : 'Authentication failed. Please try again.';
  }
}

export async function handleGoogleAuth(): Promise<User> {
  // Mobile / In-app browser detection
  const isMobileOrInApp = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|FBAN|FBAV|Instagram|LinkedInApp/i.test(navigator.userAgent);

  if (isMobileOrInApp) {
    try {
      await signInWithRedirect(auth, googleProvider);
      // Wait for redirect execution
      return new Promise(() => {});
    } catch (err: any) {
      throw new Error(mapAuthError(err.code || err.message));
    }
  }

  try {
    const result = await signInWithPopup(auth, googleProvider);
    await syncUserDoc(result.user);
    return result.user;
  } catch (err: any) {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-user') {
      try {
        await signInWithRedirect(auth, googleProvider);
        return new Promise(() => {});
      } catch (redirectErr: any) {
        throw new Error(mapAuthError(redirectErr.code || redirectErr.message));
      }
    }
    throw new Error(mapAuthError(err.code || err.message));
  }
}

export async function checkRedirectAuthResult(): Promise<User | null> {
  try {
    const result = await getRedirectResult(auth);
    if (result && result.user) {
      await syncUserDoc(result.user);
      return result.user;
    }
  } catch (err: any) {
    console.warn('[Auth Redirect Notice]', err);
  }
  return null;
}

export async function loginWithEmail(email: string, pass: string): Promise<User> {
  try {
    const cred = await signInWithEmailAndPassword(auth, email.trim(), pass);
    await syncUserDoc(cred.user);
    return cred.user;
  } catch (err: any) {
    throw new Error(mapAuthError(err.code || err.message));
  }
}

export async function registerWithEmail(displayName: string, email: string, pass: string): Promise<User> {
  if (pass.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  try {
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), pass);
    if (displayName.trim()) {
      await updateProfile(cred.user, { displayName: displayName.trim() });
    }
    await syncUserDoc(cred.user);
    await sendEmailVerification(cred.user).catch(err => {
      console.warn('Verification email notice:', err);
    });
    return cred.user;
  } catch (err: any) {
    throw new Error(mapAuthError(err.code || err.message));
  }
}

export async function requestPasswordReset(email: string): Promise<void> {
  try {
    await sendPasswordResetEmail(auth, email.trim());
  } catch (err: any) {
    throw new Error(mapAuthError(err.code || err.message));
  }
}

export async function logoutUser(): Promise<void> {
  try {
    await firebaseSignOut(auth);
  } catch (err: any) {
    console.warn('Logout notice:', err);
  }
}
