import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", () => reject(new Error(`Cannot run ${command}.`)));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}).`)));
  });
}

try {
  const local = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
  const database = new URL(local.DATABASE_URL);
  if (local.NODE_ENV !== "development" || database.protocol !== "mysql:" ||
      !["localhost", "127.0.0.1"].includes(database.hostname) || database.port !== "3310" ||
      database.pathname !== "/sri_varahi_traders" || decodeURIComponent(database.username) !== "varahi" ||
      ["DATABASE_HOST", "DATABASE_USER", "DATABASE_PASSWORD", "DATABASE_NAME"].some(key => local[key] !== undefined || process.env[key] !== undefined))
    throw new Error("Database verification requires Varahi's local development configuration. Run pnpm setup:local first.");
  database.pathname = "/sri_varahi_traders_test";
  database.searchParams.set("connection_limit", "5");
  const env = { ...process.env, ...local, NODE_ENV: "test", DATABASE_URL: database.href, RUN_DB_TESTS: "1" };
  // The root password is expanded inside the Varahi container, never passed in
  // command arguments or logged. Only the dedicated test schema receives a grant.
  await run("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    "MYSQL_PWD=\"$MYSQL_ROOT_PASSWORD\" mysql --user=root --execute \"CREATE DATABASE IF NOT EXISTS sri_varahi_traders_test; GRANT ALL PRIVILEGES ON sri_varahi_traders_test.* TO 'varahi'@'%';\""], process.env);
  console.log("Verifying isolated database: sri_varahi_traders_test.");
  await run("pnpm", ["--dir", "commerce-api", "db:deploy"], env);
  await run("pnpm", ["--dir", "commerce-api", "seed"], env);
  await run("pnpm", ["--dir", "commerce-api", "exec", "vitest", "run", "--maxWorkers=2"], env);
} catch (error) {
  console.error(error instanceof TypeError ? "Invalid local database configuration." : error.message);
  process.exitCode = 1;
}
