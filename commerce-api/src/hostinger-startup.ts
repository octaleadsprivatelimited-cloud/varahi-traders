import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrl } from "./database-env.js";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

export async function prepareHostingerDatabase() {
  process.env.DATABASE_URL = resolveDatabaseUrl(process.env);
  // Resolve paths relative to the compiled module, independent of Hostinger's cwd.
  const directory = fileURLToPath(new URL("../../", import.meta.url));
  try {
    await execute(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", `${directory}/prisma/schema.prisma`], {
      cwd: directory, env: process.env, timeout: 120_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    // CLI output can include connection details. Report only a known Prisma code.
    const output = String((error as { stderr?: string }).stderr || "") + String((error as { stdout?: string }).stdout || "");
    const code = output.match(/\bP\d{4}\b/)?.[0];
    const hint = code === "P1000" ? "Database credentials were rejected. Check the database user's password and connection settings."
      : code === "P1001" ? "Database server is unreachable. Check DATABASE_HOST and hosting database access."
      : "Review database permissions and migration state; no reset was attempted.";
    throw new Error(`Database migration failed${code ? ` (${code})` : ""}. ${hint}`);
  }
  console.log("Database migrations are up to date.");
  if (process.env.SEED_CATALOG === "true") {
    const db = new PrismaClient();
    try {
      if (await db.product.count() === 0 && await db.order.count() === 0) {
        await execute(process.execPath, [`${directory}/dist/prisma/seed.js`], {
          cwd: directory, env: process.env, timeout: 120_000,
        }).catch(() => { throw new Error("Initial catalog setup failed; review database permissions. No database reset was attempted."); });
        console.log("Initial catalog created. Remove SEED_CATALOG from the hosting environment.");
      } else console.log("Initial catalog setup skipped: database already contains products or orders.");
    } finally { await db.$disconnect(); }
  }
}
