import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { AppError } from "./errors.js";

export type GoogleClaims = { sub: string; email: string; email_verified: boolean; name?: string; picture?: string; aud: string | string[]; iss: string; exp: number; iat?: number };
type Verify = (token: string, projectId: string) => Promise<DecodedIdToken>;
const verifyWithAdmin: Verify = async (token, projectId) => {
  const name = `commerce-auth-${projectId}`;
  const app = getApps().find(app => app.name === name) || initializeApp({ projectId }, name);
  return getAuth(app).verifyIdToken(token);
};
export function createFirebaseGoogleVerifier(verify: Verify = verifyWithAdmin) {
  return async (token: string, projectId: string): Promise<GoogleClaims> => {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || process.env.FIREBASE_AUTH_EMULATOR_HOST)
      throw new AppError(503, "GOOGLE_AUTH_NOT_CONFIGURED", "Firebase Google sign-in is not configured securely");
    try {
      const claims = await verify(token, projectId);
      const identities = claims.firebase?.identities?.["google.com"];
      const subject = Array.isArray(identities) && identities.length === 1 ? identities[0] : undefined;
      if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}` ||
          claims.firebase?.sign_in_provider !== "google.com" || claims.email_verified !== true ||
          typeof subject !== "string" || !subject.trim() || typeof claims.email !== "string" || !claims.email.trim())
        throw new Error("Invalid Firebase Google identity");
      return { sub: subject.trim(), email: claims.email.trim().toLowerCase(), email_verified: true,
        name: claims.name, picture: claims.picture, aud: projectId, iss: claims.iss, exp: claims.exp, iat: claims.iat };
    } catch {
      throw new AppError(401, "INVALID_GOOGLE_TOKEN", "Firebase Google credential could not be verified");
    }
  };
}
export const verifyFirebaseGoogleToken = createFirebaseGoogleVerifier();
