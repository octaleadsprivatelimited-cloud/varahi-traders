export type CheckoutProfile = { name: string; email: string; mobile?: string | null };
export type SavedCheckoutAddress = {
  id: string;
  label: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string | null;
  isDefault: boolean;
};
export type CheckoutContact = { name: string; email: string; phone: string };
export type CheckoutAddress = { line1: string; line2: string; city: string; state: string; country: string };
export const deliveryFields = ["line1", "line2", "city", "state", "country", "postalCode"] as const;

/** Return national digits only when the saved value is an Indian mobile. */
export function savedCheckoutMobile(value?: string | null) {
  const digits = (value || "").replace(/\D/g, "");
  const national = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(national) ? national : "";
}

export function checkoutMobileInput(value: string) {
  const digits = value.replace(/\D/g, "");
  return (digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits).slice(0, 10);
}

export function defaultCheckoutAddress(addresses: SavedCheckoutAddress[]) {
  const indianAddresses = addresses.filter((address) => address.country.toUpperCase() === "IN");
  return indianAddresses.find((address) => address.isDefault) || indianAddresses[0];
}

export function checkoutAutofill(profile: CheckoutProfile, address?: SavedCheckoutAddress) {
  return {
    contact: {
      name: profile.name.trim(),
      email: profile.email.trim(),
      phone: savedCheckoutMobile(address?.phone) || savedCheckoutMobile(profile.mobile),
    },
    ...(address ? {
      address: {
        line1: address.line1,
        line2: address.line2 || "",
        city: address.city,
        state: address.state,
        country: "IN",
      },
      postalCode: address.postalCode,
    } : {}),
  };
}

/** User edits, including deliberate empty values, always win over late loads. */
export function fillUntouchedFields<T extends Record<string, string>>(
  current: T,
  incoming: Partial<T>,
  edited: ReadonlySet<string>,
): T {
  const result = { ...current };
  for (const key of Object.keys(incoming) as Array<keyof T>) {
    if (!edited.has(String(key)) && incoming[key] !== undefined) result[key] = incoming[key]!;
  }
  return result;
}

export function canAutofillDelivery(edited: ReadonlySet<string>) {
  return !deliveryFields.some((field) => edited.has(field));
}
