import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const envPath = new URL("../.env", import.meta.url);
let childEnvironment = process.env;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: childEnvironment, stdio: "inherit" });
    child.once("error", () => reject(new Error(`Cannot run ${command}. Install it and retry.`)));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}).`)));
  });
}

try {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Use Node.js 24 for this project.");
  let source;
  try { source = await readFile(envPath, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    source = await readFile(new URL("../.env.example", import.meta.url), "utf8");
    const password = randomBytes(24).toString("hex");
    const replacements = {
      DATABASE_URL: `mysql://varahi:${password}@localhost:3310/sri_varahi_traders`,
      MYSQL_PASSWORD: password,
      MYSQL_ROOT_PASSWORD: randomBytes(32).toString("hex"),
      JWT_SECRET: randomBytes(48).toString("hex"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("hex"),
      INTEGRATION_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    };
    for (const [key, value] of Object.entries(replacements))
      source = source.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
    await writeFile(envPath, source, { flag: "wx", mode: 0o600 });
    console.log("Created private Varahi environment with fresh local credentials.");
  }
  const env = parseEnv(source);
  const database = new URL(env.DATABASE_URL);
  if (env.NODE_ENV !== "development" || env.USE_DATABASE !== "true" ||
      env.APP_URL !== "http://localhost:5180" || env.PORT !== "4010" ||
      !["localhost", "127.0.0.1"].includes(database.hostname) ||
      database.protocol !== "mysql:" || database.port !== "3310" ||
      database.pathname !== "/sri_varahi_traders" ||
      env.MYSQL_DATABASE !== "sri_varahi_traders" || env.MYSQL_USER !== "varahi" ||
      decodeURIComponent(database.username) !== env.MYSQL_USER ||
      decodeURIComponent(database.password) !== env.MYSQL_PASSWORD ||
      ["DATABASE_HOST", "DATABASE_USER", "DATABASE_PASSWORD", "DATABASE_NAME"].some(key => env[key] !== undefined))
    throw new Error("Local setup requires Varahi's development database on port 3310 and storefront on port 5180. Check .env against .env.example; existing settings were not changed.");
  for (const key of ["MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD", "JWT_SECRET", "JWT_REFRESH_SECRET", "INTEGRATION_ENCRYPTION_KEY"])
    if (!env[key] || env[key].length < 32 || /change_|replace-|encoded-32-byte-key/i.test(env[key]))
      throw new Error(`Set a unique random ${key} in .env before continuing.`);
  childEnvironment = { ...process.env, ...env };
  // Shell database overrides must never redirect local migrations elsewhere.
  for (const key of ["DATABASE_HOST", "DATABASE_USER", "DATABASE_PASSWORD", "DATABASE_NAME", "DATABASE_PORT"])
    delete childEnvironment[key];
  console.log("Installing dependencies and preparing Varahi's local MySQL database. Docker must be running.");
  await run("pnpm", ["install", "--frozen-lockfile"]);
  await run("pnpm", ["--dir", "commerce-api", "install", "--frozen-lockfile"]);
  await run("docker", ["compose", "up", "-d", "--wait", "mysql", "redis"]);
  await run("pnpm", ["--dir", "commerce-api", "db:deploy"]);
  await run("pnpm", ["--dir", "commerce-api", "seed"]);
  await run("pnpm", ["--dir", "commerce-api", "db:smoke"]);
  console.log("Varahi backend is configured. Run pnpm dev:local, or double-click START-WEBSITE.command.");
} catch (error) {
  // Configuration errors may contain credentials; only show our own messages.
  console.error(error instanceof TypeError ? "Invalid local environment. Check .env against .env.example." : error.message);
  process.exitCode = 1;
}
