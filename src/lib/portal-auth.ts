import { CommerceApiError, commerceApi, clearAccessToken } from "./commerce-api";
import { signOutFirebase } from "./firebase-auth";

export type PortalSession = {
  id: string;
  name: string;
  email: string;
  mobile?: string | null;
  role: string;
  permissions: string[];
};

export function hasPortalPermission(
  session: PortalSession,
  ...permissions: string[]
) {
  return (
    session.permissions.includes("*") ||
    permissions.some((permission) => session.permissions.includes(permission))
  );
}

export async function loadPortalSession() {
  return commerceApi<PortalSession>("/api/v1/auth/me");
}

export async function logoutPortalSession() {
  try {
    await commerceApi<{ loggedOut: boolean }>("/api/v1/auth/logout", {
      method: "POST",
    });
  } catch (error) {
    if (!(error instanceof CommerceApiError) || error.status >= 500) throw error;
  } finally {
    clearAccessToken();
    await signOutFirebase();
  }
}
