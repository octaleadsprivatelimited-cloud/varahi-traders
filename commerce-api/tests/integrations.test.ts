import { describe, expect, it } from "vitest";
import {
  integrationDefinition,
  integrationDto,
  publicAnalyticsConfig,
  selectRuntimeIntegration,
  testIntegrationConnection,
} from "../src/integrations.js";
import type { StoredIntegration } from "../src/store.js";

const record = (
  id: string,
  environment: "TEST" | "LIVE",
  priority = 1,
): StoredIntegration => ({
  id,
  kind: "PAYMENT",
  provider: "razorpay",
  enabled: true,
  priority,
  environment,
  encryptedCredentials: "not-used",
  publicConfig: {},
  updatedAt: "2026-08-21T12:00:00.000Z",
});

describe("integration runtime safety", () => {
  it.each([
    "This API key is restricted to only send emails.",
    "This API key is restricted to only send emails",
    " This API key is restricted to only send emails. ",
  ])("does not misreport a restricted Resend sending key as failed or delivered: %s", async message => {
    const result = await testIntegrationConnection({
      definition: integrationDefinition("EMAIL", "resend")!,
      credentials: { apiKey: "sending-only-secret" },
      publicConfig: { fromEmail: "orders@updates.example.com" },
      request: async () => new Response(JSON.stringify({ name: "restricted_api_key", message }), { status: 401 }),
    });
    expect(result).toMatchObject({ outcome: "UNSUPPORTED", message: expect.stringContaining("Keep this restricted key") });
  });

  it.each([401, 403])("still rejects inactive or invalid Resend keys (%s)", async status => {
    const result = await testIntegrationConnection({
      definition: integrationDefinition("EMAIL", "resend")!,
      credentials: { apiKey: "invalid-secret" },
      publicConfig: { fromEmail: "orders@updates.example.com" },
      request: async () => new Response(JSON.stringify({ name: "restricted_api_key", message: "API key is not active" }), { status }),
    });
    expect(result.outcome).toBe("FAILED");
  });

  it("exposes only enabled valid public tracking IDs from the runtime environment", () => {
    const analytics = (provider: string, publicConfig: Record<string, unknown>, overrides: Partial<StoredIntegration> = {}): StoredIntegration => ({ ...record(provider, "LIVE"), kind: "ANALYTICS", provider, publicConfig, encryptedCredentials: "encrypted-secret-must-never-leak", ...overrides });
    const values = [
      analytics("google-analytics", { measurementId: "G-TEST1234", apiSecret: "private-secret", _connection: { outcome: "CONNECTED" } }),
      analytics("meta-pixel", { pixelId: "123456789" }),
      analytics("microsoft-clarity", { projectId: "abc12345" }),
    ];
    expect(publicAnalyticsConfig(values, "production")).toEqual({ ga4MeasurementId: "G-TEST1234", metaPixelId: "123456789", clarityProjectId: "abc12345" });
    expect(publicAnalyticsConfig(values, "development")).toEqual({});
    expect(publicAnalyticsConfig([analytics("google-analytics", { measurementId: "G-TEST1234" }, { enabled: false }), analytics("meta-pixel", { pixelId: "12345?token=private" }), analytics("microsoft-clarity", { projectId: "https://evil.example" })], "production")).toEqual({});
    for (const provider of ["google-analytics", "meta-pixel", "microsoft-clarity"]) {
      const definition = integrationDefinition("ANALYTICS", provider)!;
      expect(definition.credentialFields).toEqual([]);
      expect(definition.liveOperations).toBe(true);
    }
  });
  it("selects LIVE only in production and never falls back to TEST", () => {
    const test = record("test", "TEST");
    const live = record("live", "LIVE");
    expect(
      selectRuntimeIntegration(
        [test, live],
        "PAYMENT",
        "RazorPay",
        "production",
      )?.id,
    ).toBe("live");
    expect(
      selectRuntimeIntegration(
        [test],
        "PAYMENT",
        "razorpay",
        "production",
      ),
    ).toBeUndefined();
  });

  it("selects TEST only outside production and never falls back to LIVE", () => {
    const test = record("test", "TEST");
    const live = record("live", "LIVE");
    expect(
      selectRuntimeIntegration(
        [live, test],
        "PAYMENT",
        "razorpay",
        "development",
      )?.id,
    ).toBe("test");
    expect(
      selectRuntimeIntegration(
        [live],
        "PAYMENT",
        "razorpay",
        "test",
      ),
    ).toBeUndefined();
  });

  it("reports unsupported adapters honestly without making a request", async () => {
    const definition = integrationDefinition("SHIPPING", "Delhivery")!;
    let requested = false;
    const result = await testIntegrationConnection({
      definition,
      credentials: { token: "configured" },
      publicConfig: { pickupPostcode: "500001" },
      request: async () => {
        requested = true;
        return new Response(null, { status: 200 });
      },
    });
    expect(result.outcome).toBe("UNSUPPORTED");
    expect(requested).toBe(false);
  });

  it("defines and safely tests the live Twilio SMS adapter", async () => {
    const definition = integrationDefinition("SMS", "Twilio")!;
    expect(definition).toMatchObject({ kind: "SMS", provider: "twilio", liveOperations: true, testConnection: true });
    const fakeAccountSid = "AC_TEST_ACCOUNT_SID";
    let requestedUrl = "", requestedAuthorization = "";
    const result = await testIntegrationConnection({
      definition,
      credentials: { accountSid: fakeAccountSid, authToken: "private-auth-token" },
      publicConfig: { fromNumber: "+15551234567" },
      request: async (input, init) => {
        requestedUrl = String(input);
        requestedAuthorization = String((init?.headers as Record<string, string>)?.authorization || "");
        return new Response(null, { status: 200 });
      },
    });
    expect(result.outcome).toBe("CONNECTED");
    expect(requestedUrl).toContain(`/Accounts/${fakeAccountSid}.json`);
    expect(requestedAuthorization).toBe(`Basic ${Buffer.from(`${fakeAccountSid}:private-auth-token`).toString("base64")}`);
  });

  it("does not expose obsolete editable Google authentication settings", () => {
    expect(integrationDefinition("AUTH", "Google")).toBeUndefined();
  });

  it("never returns undeclared legacy public fields", () => {
    const definition = integrationDefinition("PAYMENT", "razorpay")!;
    const dto = integrationDto({
      definition,
      environment: "TEST",
      record: {
        ...record("PAYMENT:razorpay:TEST", "TEST"),
        publicConfig: {
          currency: "INR",
          accidentallyPublicSecret: "must-never-leak",
          _connection: { outcome: "CONNECTED" },
        },
      },
      credentials: { keyId: "public", keySecret: "private-secret" },
      mask: () => "masked",
    });
    expect(dto.publicConfig).toEqual({ currency: "INR" });
    expect(JSON.stringify(dto)).not.toContain("must-never-leak");
    expect(JSON.stringify(dto)).not.toContain("private-secret");
  });
});
