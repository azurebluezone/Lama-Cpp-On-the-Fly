#!/usr/bin/env node
/**
 * Compatibility shim. `npm run setup` is `node src/main.ts setup`; this file
 * used to write a legacy .env and lama-mgmt.service from templates/ that the
 * current app never reads. Keeping the old logic here created a second, wrong
 * database on fresh machines, so the entry point now delegates.
 *
 * Usage: node scripts/setup.mjs [same flags as src/main.ts setup]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, [path.join(root, "src", "main.ts"), "setup", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(`setup: cannot start src/main.ts setup: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
