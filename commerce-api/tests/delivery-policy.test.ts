import { expect, it } from "vitest";
import { additionalAnnouncement, deliveryAnnouncement, deliveryEstimate, freeDeliveryQualifies } from "../src/delivery-policy.js";
import { defaultStorefrontConfig, storefrontConfigSchema } from "../src/storefront-config.js";

it("derives the active delivery copy from editable settings and removes legacy price announcements", () => {
  const first = { ...defaultStorefrontConfig, manualDeliveryEnabled: true, deliveryCharge: 59, freeShippingThreshold: 999 };
  expect(deliveryAnnouncement(first)).toContain("₹59"); expect(deliveryAnnouncement(first)).toContain("₹999");
  const changed = { ...first, deliveryCharge: 89, freeShippingThreshold: 799, deliveryMinDays: 2, deliveryMaxDays: 4 };
  expect(deliveryAnnouncement(changed)).toContain("₹89"); expect(deliveryAnnouncement(changed)).toContain("₹799");
  expect(deliveryAnnouncement(changed)).not.toMatch(/₹59|₹999/); expect(deliveryEstimate(changed)).toBe("2–4 business days");
  expect(additionalAnnouncement("Free delivery on orders above ₹999")).toBe("");
  expect(storefrontConfigSchema.parse({ ...first, announcement: "Delivery charges ₹49" }).announcement).toBe("");
  expect(additionalAnnouncement("Freshly ground every week")).toBe("Freshly ground every week");
  expect(deliveryAnnouncement({ ...first, settingsLoaded: false })).not.toMatch(/₹/);
});
it("uses an inclusive threshold and treats zero as free delivery for every order", () => {
  const policy = { ...defaultStorefrontConfig, manualDeliveryEnabled: true };
  expect(freeDeliveryQualifies(policy, 998.99)).toBe(false); expect(freeDeliveryQualifies(policy, 999)).toBe(true);
  expect(freeDeliveryQualifies({ ...policy, freeShippingThreshold: 0 }, 1)).toBe(true);
  expect(deliveryAnnouncement({ ...policy, freeShippingThreshold: 0 })).toBe("Free delivery on every order");
  expect(deliveryAnnouncement({ ...policy, deliveryCharge: 0 })).toBe("Free delivery on every order");
});
it("rejects negative charges, excess decimal precision and reversed delivery dates", () => {
  for (const patch of [{ deliveryCharge: -1 }, { deliveryCharge: 59.001 }, { deliveryMinDays: 7, deliveryMaxDays: 3 }])
    expect(storefrontConfigSchema.safeParse({ ...defaultStorefrontConfig, ...patch }).success).toBe(false);
});
