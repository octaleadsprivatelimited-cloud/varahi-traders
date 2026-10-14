import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecodedIdToken } from "firebase-admin/auth";
import { createFirebaseGoogleVerifier } from "../src/firebase-auth.js";
const claims = { sub: "firebase-uid", uid: "firebase-uid", aud: "test-commerce", iss: "https://securetoken.google.com/test-commerce", exp: 9999999999, iat: 1, auth_time: 1, email: "User@Gmail.com", email_verified: true, firebase: { identities: { "google.com": ["original-google-subject"] }, sign_in_provider: "google.com" } } as DecodedIdToken;
afterEach(() => vi.unstubAllEnvs());
describe("Firebase Google verification", () => {
  it("uses verified Google provider subject rather than Firebase uid", async () => {
    const verify = vi.fn(async () => claims);
    const result = await createFirebaseGoogleVerifier(verify)("firebase-token", "test-commerce");
    expect(verify).toHaveBeenCalledWith("firebase-token", "test-commerce");
    expect(result).toMatchObject({ sub: "original-google-subject", email: "user@gmail.com", aud: "test-commerce" });
    expect(result).not.toHaveProperty("hd");
  });
  it.each([
    { ...claims, email_verified: false },
    { ...claims, aud: "wrong-project" },
    { ...claims, iss: "https://accounts.google.com" },
    { ...claims, firebase: { ...claims.firebase, sign_in_provider: "password" } },
    { ...claims, firebase: { ...claims.firebase, identities: {} } },
  ])("rejects unverified, wrong-project and non-Google identities", async invalid => {
    await expect(createFirebaseGoogleVerifier(async () => invalid as DecodedIdToken)("token", "test-commerce")).rejects.toMatchObject({ status: 401, code: "INVALID_GOOGLE_TOKEN" });
  });
  it("rejects SDK signature/expiry failures without leaking credentials", async () => {
    await expect(createFirebaseGoogleVerifier(async () => { throw new Error("secret token"); })("token", "test-commerce")).rejects.toMatchObject({ message: "Firebase Google credential could not be verified" });
  });
  it("rejects emulator bypass and missing project", async () => {
    const verify = vi.fn(async () => claims);
    await expect(createFirebaseGoogleVerifier(verify)("token", "")).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "localhost:9099");
    await expect(createFirebaseGoogleVerifier(verify)("token", "test-commerce")).rejects.toMatchObject({ status: 503 });
    expect(verify).not.toHaveBeenCalled();
  });
});
