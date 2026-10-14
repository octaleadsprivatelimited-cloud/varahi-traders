// Admin rights require the new client's explicitly configured, verified Google account.
export const SINGLE_ADMIN_EMAIL = (process.env.STORE_ADMIN_EMAIL || "").trim().toLowerCase();
export const isStoreAdminEmail = (email: string) => Boolean(SINGLE_ADMIN_EMAIL) && email.trim().toLowerCase() === SINGLE_ADMIN_EMAIL;
export const googleAccountRole = (verifiedEmail: string) => isStoreAdminEmail(verifiedEmail) ? "ADMIN" as const : "CUSTOMER" as const;
