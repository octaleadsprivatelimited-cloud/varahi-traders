import { describe, expect, it } from "vitest";

// Browser checkout helpers are transformed by Vitest, not API TypeScript.
const autofillSource = "../../src/lib/checkout-autofill.ts";
const { canAutofillDelivery, checkoutAutofill, checkoutMobileInput, defaultCheckoutAddress, fillUntouchedFields, savedCheckoutMobile } = await import(autofillSource);
const profile = { name: " Meera Rao ", email: "meera@example.com", mobile: "+919876543210" };
const home = {
  id: "home", label: "Home", line1: "42 Lake Road", line2: "Flat 2",
  city: "Hyderabad", state: "Telangana", postalCode: "500001", country: "IN",
  phone: "+918765432109", isDefault: true,
};

describe("signed-in checkout autofill", () => {
  it("fills Google profile name and email while leaving the address for the customer", () => {
    expect(checkoutAutofill(profile)).toEqual({ contact: {
      name: "Meera Rao", email: "meera@example.com", phone: "9876543210",
    } });
  });

  it("prefers the default Indian address and maps its phone, apartment and PIN accurately", () => {
    const office = { ...home, id: "office", isDefault: false };
    const otherCountry = { ...home, id: "overseas", country: "US" };
    expect(defaultCheckoutAddress([office, otherCountry, home])).toEqual(home);
    expect(checkoutAutofill(profile, home)).toEqual({
      contact: { name: "Meera Rao", email: "meera@example.com", phone: "8765432109" },
      address: { line1: "42 Lake Road", line2: "Flat 2", city: "Hyderabad", state: "Telangana", country: "IN" },
      postalCode: "500001",
    });
  });

  it("uses the first Indian address when there is no default and skips unsupported countries", () => {
    const office = { ...home, id: "office", isDefault: false };
    const overseas = { ...home, country: "GB", isDefault: true };
    expect(defaultCheckoutAddress([overseas, office])).toEqual(office);
    expect(defaultCheckoutAddress([overseas])).toBeUndefined();
    expect(defaultCheckoutAddress([])).toBeUndefined();
  });

  it("supports historical saved addresses without a phone and still requires a number when no saved mobile exists", () => {
    const historical = { ...home, phone: null, line2: null };
    expect(checkoutAutofill(profile, historical).contact.phone).toBe("9876543210");
    expect(checkoutAutofill({ name: "Meera", email: "meera@example.com" }, historical).contact.phone).toBe("");
    expect(checkoutAutofill(profile, historical).address.line2).toBe("");
  });

  it("preserves fields typed or deliberately cleared while profile loading was in flight", () => {
    const typed = { name: "Gift recipient", email: "", phone: "" };
    const edited = new Set(["name", "email"]);
    expect(fillUntouchedFields(typed, checkoutAutofill(profile).contact, edited)).toEqual({
      name: "Gift recipient", email: "", phone: "9876543210",
    });
    // A phone edit made before the slower address response also wins.
    edited.add("phone");
    const latest = { ...typed, phone: "7654321098" };
    expect(fillUntouchedFields(latest, checkoutAutofill(profile, home).contact, edited)).toEqual(latest);
  });

  it("never mixes a late default address with a manually entered destination", () => {
    expect(canAutofillDelivery(new Set(["name", "phone"]))).toBe(true);
    for (const field of ["line1", "line2", "city", "state", "country", "postalCode"])
      expect(canAutofillDelivery(new Set([field]))).toBe(false);
  });

  it.each(["9876543210", "+919876543210", "91 98765 43210", "+91 (98765) 43210"])(
    "normalizes saved Indian mobile %s to exactly ten displayed digits", (value) => {
      expect(savedCheckoutMobile(value)).toBe("9876543210");
    },
  );

  it.each([undefined, "", "12345", "+449876543210", "5123456789", "9876543210123"])(
    "does not fabricate a valid mobile from invalid saved value %s", (value) => {
      expect(savedCheckoutMobile(value)).toBe("");
    },
  );

  it("supports pasting +91 while keeping typed phone input to ten national digits", () => {
    expect(checkoutMobileInput("+91 98765 43210")).toBe("9876543210");
    expect(checkoutMobileInput("9876543210")).toBe("9876543210");
    expect(checkoutMobileInput("98 abc 7")).toBe("987");
    expect(checkoutMobileInput("9876543210123")).toHaveLength(10);
  });
});
