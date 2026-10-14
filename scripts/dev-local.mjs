import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const children = [];
let stopping = false;
let childEnvironment;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
  }
  process.exitCode = code;
}

async function ready(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    if (await ready(url)) return;
    await delay(500);
  }
  throw new Error(`Service did not become ready at ${url}. Check the startup output.`);
}

function start(args) {
  const child = spawn("pnpm", args, { cwd: root, env: childEnvironment, stdio: "inherit", detached: true });
  children.push(child);
  child.once("error", () => { console.error("Cannot start pnpm."); stop(1); });
  child.once("exit", code => { if (!stopping) stop(code || 0); });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());

try {
  const local = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
  const database = new URL(local.DATABASE_URL);
  if (local.NODE_ENV !== "development" || local.USE_DATABASE !== "true" ||
      local.APP_URL !== "http://localhost:5180" || local.PORT !== "4010" ||
      database.protocol !== "mysql:" || !["localhost", "127.0.0.1"].includes(database.hostname) ||
      database.port !== "3310" || database.pathname !== "/sri_varahi_traders")
    throw new Error("Run pnpm setup:local to configure Varahi's local services first.");
  childEnvironment = { ...process.env, ...local };
  for (const key of ["DATABASE_HOST", "DATABASE_USER", "DATABASE_PASSWORD", "DATABASE_NAME", "DATABASE_PORT"])
    delete childEnvironment[key];
  for (const key of ["FIREBASE_PROJECT_ID", "FIREBASE_API_KEY", "FIREBASE_AUTH_DOMAIN", "FIREBASE_APP_ID", "STORE_ADMIN_EMAIL"])
    if (local[key] === undefined) delete childEnvironment[key];
  if (!await ready("http://localhost:4010/ready")) start(["dev:api"]);
  await waitFor("http://localhost:4010/ready");
  if (!await ready("http://localhost:5180/")) start(["dev", "--host", "127.0.0.1"]);
  await waitFor("http://localhost:5180/");
  console.log("Sri Varahi Traders: http://localhost:5180/ · API: http://localhost:4010/");
  if (process.argv.includes("--open") && process.platform === "darwin")
    spawn("open", ["http://localhost:5180/"], { stdio: "ignore" });
} catch (error) {
  console.error(error instanceof TypeError ? "Invalid local environment. Run pnpm setup:local." : error.message);
  stop(1);
}
