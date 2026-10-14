import { describe, expect, it } from "vitest";
import { base32Encode, generateTotpCode, verifyTotp } from "../src/security.js";

describe("administrator TOTP", () => {
  it("accepts the current authenticator code and a one-step clock skew", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const now = 1_787_272_100_000;
    expect(verifyTotp(secret, generateTotpCode(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, generateTotpCode(secret, now - 30_000), now)).toBe(true);
  });
  it("rejects malformed and stale authenticator codes", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890")), now = 1_787_272_100_000;
    expect(verifyTotp(secret, "abcdef", now)).toBe(false);
    expect(verifyTotp(secret, generateTotpCode(secret, now - 120_000), now)).toBe(false);
  });
});
