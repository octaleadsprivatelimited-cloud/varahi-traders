import { describe, expect, it, vi } from "vitest";
import { createPostalLookup } from "../src/postal-lookup.js";

const primary = (records: unknown[] = [{ office_name: "Madhapur", district: "Hyderabad", state: "Telangana", pincode: "500081", latitude: 17, privateExtra: "omit" }]) => Response.json({ success: true, data: { pincode: "500081", post_offices: records } });
describe("Indian PIN code lookup", () => {
  it("sends only the PIN to a fixed HTTPS provider and caches/deduplicates public results", async () => {
    const request = vi.fn<typeof fetch>(async () => primary()), lookup = createPostalLookup(request);
    const [first, second] = await Promise.all([lookup("500081"), lookup("500081")]);
    expect(first).toEqual({ postalCode: "500081", country: "IN", city: "Hyderabad", state: "Telangana", areas: [{ name: "Madhapur", district: "Hyderabad", state: "Telangana" }] });
    expect(second).toEqual(first); expect(await lookup("500081")).toEqual(first); expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe("https://api.pincodeapi.in/api/v1/pincode/500081");
    const init = (request.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.headers).toEqual({ accept: "application/json" }); expect(init.body).toBeUndefined(); expect(init.redirect).toBe("error"); expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("falls back on network/provider failures without leaking upstream errors", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("private-upstream-error")).mockResolvedValueOnce(Response.json([{ Status: "Success", PostOffice: [{ Name: "Cyberabad", District: "Hyderabad", State: "Telangana", Pincode: "500081" }] }]));
    const result = await createPostalLookup(request)("500081");
    expect(result.city).toBe("Hyderabad"); expect(request.mock.calls[1]![0]).toBe("https://api.postalpincode.in/pincode/500081");
  });
  it("rejects invalid PINs before making any external request", async () => {
    const request = vi.fn(), lookup = createPostalLookup(request);
    for (const pin of ["000000", "50008", "5000811", "https://evil.example", "50008a"])
      await expect(lookup(pin)).rejects.toMatchObject({ status: 400, code: "INVALID_PIN_CODE" });
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects records for another PIN and never invents a city when districts differ", async () => {
    const request = vi.fn(async () => primary([
      { office_name: "A", district: "District A", state: "State A", pincode: "500081" },
      { office_name: "B", district: "District B", state: "State A", pincode: "500081" },
      { office_name: "Wrong", district: "Wrong", state: "Wrong", pincode: "110001" },
    ]));
    const result = await createPostalLookup(request)("500081");
    expect(result.city).toBe(""); expect(result.state).toBe("State A"); expect(result.areas).toHaveLength(2);
  });
  it("returns a safe missing-PIN message and caches negative results", async () => {
    const request = vi.fn(async () => new Response("", { status: 404 })), lookup = createPostalLookup(request);
    await expect(lookup("999999")).rejects.toMatchObject({ status: 404, code: "PIN_CODE_NOT_FOUND" });
    await expect(lookup("999999")).rejects.toMatchObject({ status: 404 }); expect(request).toHaveBeenCalledTimes(2);
  });
  it("keeps manual entry available during an outage and retries on the next request", async () => {
    const request = vi.fn(async () => { throw new Error("sensitive-upstream-diagnostic"); }), lookup = createPostalLookup(request);
    await expect(lookup("500081")).rejects.toMatchObject({ status: 503, code: "PIN_LOOKUP_UNAVAILABLE", message: expect.stringContaining("manually") });
    await expect(lookup("500081")).rejects.toMatchObject({ status: 503 }); expect(request).toHaveBeenCalledTimes(4);
  });
  it("backs off a rate-limited provider and uses the alternative", async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(Response.json([{ Status: "Success", PostOffice: [{ Name: "Madhapur", District: "Hyderabad", State: "Telangana", Pincode: "500081" }] }])).mockResolvedValueOnce(Response.json([{ Status: "Success", PostOffice: [{ Name: "Abids", District: "Hyderabad", State: "Telangana", Pincode: "500001" }] }]));
    const lookup = createPostalLookup(request); await lookup("500081"); await lookup("500001");
    expect(request.mock.calls[2]![0]).toBe("https://api.postalpincode.in/pincode/500001");
  });
});
