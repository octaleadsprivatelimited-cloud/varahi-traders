/** Resolve discrete hosting fields without requiring users to URL-encode passwords. */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const keys = ["DATABASE_HOST", "DATABASE_USER", "DATABASE_PASSWORD", "DATABASE_NAME"] as const;
  const supplied = keys.filter(key => env[key] !== undefined);
  if (supplied.length && supplied.length !== keys.length)
    throw new Error("Set all DATABASE_HOST, DATABASE_USER, DATABASE_PASSWORD and DATABASE_NAME fields, or remove them and use DATABASE_URL");
  if (supplied.length) {
    const host = env.DATABASE_HOST!.trim();
    const port = env.DATABASE_PORT || "3306";
    if (!/^[a-zA-Z0-9.-]+$/.test(host) || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error("Invalid DATABASE_HOST or DATABASE_PORT");
    if (!env.DATABASE_USER || !env.DATABASE_PASSWORD || !env.DATABASE_NAME)
      throw new Error("Database user, password and name must not be empty");
    return `mysql://${encodeURIComponent(env.DATABASE_USER)}:${encodeURIComponent(env.DATABASE_PASSWORD)}@${host}:${port}/${encodeURIComponent(env.DATABASE_NAME)}`;
  }
  const value = env.DATABASE_URL || "";
  if (!value) throw new Error("DATABASE_URL or discrete DATABASE_* fields are required");
  try {
    const url = new URL(value);
    if (url.protocol !== "mysql:" || !url.hostname || !url.username || url.pathname.length < 2 || url.hash)
      throw new Error();
  } catch {
    throw new Error("Invalid DATABASE_URL; use a MySQL URL with URL-encoded credentials, or discrete DATABASE_* fields");
  }
  return value;
}
