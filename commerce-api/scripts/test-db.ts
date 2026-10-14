import { spawnSync } from "node:child_process";
const result = spawnSync("pnpm", ["exec", "vitest", "run"], {
  stdio: "inherit",
  env: { ...process.env, RUN_DB_TESTS: "1" },
});
process.exitCode = result.status ?? 1;
