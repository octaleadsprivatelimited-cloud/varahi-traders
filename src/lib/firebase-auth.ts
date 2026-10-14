import { initializeApp, getApps } from "firebase/app";
import { getAuth, GoogleAuthProvider, inMemoryPersistence, setPersistence, signInWithPopup, signOut, type Auth } from "firebase/auth";
import { commerceApi } from "./commerce-api";

let authPromise: Promise<Auth> | null = null;
let preparedAuth: Auth | null = null;

export function prepareFirebaseAuth(): Promise<Auth> {
  if (!authPromise) {
    authPromise = commerceApi<{ firebase: { enabled: boolean; apiKey: string; authDomain: string; projectId: string; appId?: string } }>("/api/v1/auth/providers")
      .then(async ({ firebase }) => {
        if (!firebase?.enabled || !firebase.apiKey || !firebase.authDomain || !firebase.projectId) {
          throw new Error("Google sign-in is not configured for this store. Contact the administrator.");
        }
        const app = getApps().find((candidate) => candidate.name === "varahi-commerce-auth") ?? initializeApp({ apiKey: firebase.apiKey, authDomain: firebase.authDomain, projectId: firebase.projectId, appId: firebase.appId }, "varahi-commerce-auth");
        const auth = getAuth(app);
        await setPersistence(auth, inMemoryPersistence);
        preparedAuth = auth;
        return auth;
      }).catch((error) => { authPromise = null; throw error; });
  }
  return authPromise;
}

export async function firebaseGoogleCredential() {
  // Buttons are enabled only after preparation, so the popup opens directly
  // from the click without waiting for network or persistence setup.
  if (!preparedAuth) throw new Error("Google sign-in is still preparing. Please try again.");
  const auth = preparedAuth;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(auth, provider);
  return result.user.getIdToken(true);
}

export async function signOutFirebase() {
  if (!authPromise) return;
  const auth = await authPromise.catch(() => null);
  if (auth) await signOut(auth);
}

export function firebaseAuthMessage(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return "Google sign-in was cancelled. Try again when ready.";
  if (code === "auth/popup-blocked") return "Allow pop-ups for this site, then try Google sign-in again.";
  if (code === "auth/unauthorized-domain") return "Google sign-in is not enabled for this website address. Contact the administrator.";
  if (code === "auth/network-request-failed") return "Check your connection and try Google sign-in again.";
  return error instanceof Error ? error.message : "Google sign-in failed. Please try again.";
}
