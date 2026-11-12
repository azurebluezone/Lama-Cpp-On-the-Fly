#!/usr/bin/env node
/**
 * Build a self-contained dist/ of this manager: compiled JavaScript plus the
 * static assets and (when present) the stock llama.cpp engine. dist/ carries
 * its own package.json with **no dependencies**, so it runs on any Node >= 24
 * without npm install and without touching the project's node_modules.
 *
 * Usage: node scripts/build-dist.mjs [--no-engine] [--no-tar]
 * Exit code: 0 only after the built dist passed a smoke run.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const argv = process.argv.slice(2);
const say = (line) => process.stdout.write(`${line}\n`);
const fail = (line) => { process.stderr.write(`${line}\n`); process.exit(1); };

function sh(command, args, cwd = ROOT) {
  const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 15 * 60_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.cpSync(from, to, { recursive: true });
  return true;
}

// 1. TypeScript -> plain JavaScript (relative .ts imports are rewritten to .js).
const tsc = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
if (!fs.existsSync(tsc)) fail("build: typescript is missing — run npm install first");
fs.rmSync(DIST, { recursive: true, force: true });
const compiled = sh(tsc, ["-p", path.join(ROOT, "tsconfig.build.json")]);
if (compiled.code !== 0) fail(`build: tsc failed\n${compiled.out}`);
say(`[ok]  compiled -> ${path.relative(ROOT, DIST)}/src`);

// 2. Static assets the runtime reads.
const assets = ["web", "db/seed", "prompts", "templates", "README.md"];
for (const rel of assets) {
  const ok = copyTree(path.join(ROOT, rel), path.join(DIST, rel));
  say(`${ok ? "[ok]  " : "[skip]"} asset ${rel}`);
}

// 3. The engine: the official installer keeps one unified binary at
// ~/.local/bin/llama; older layouts may still have a project bin/ link.
let engineInDist = false;
if (argv.includes("--no-engine")) {
  say("[skip] engine (—no-engine)");
} else {
  const official = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "llama.exe" : "llama");
  const projectLink = path.join(ROOT, "bin", process.platform === "win32" ? "llama-server.exe" : "llama-server");
  const source = fs.existsSync(projectLink) ? fs.realpathSync(projectLink) : official;
  if (fs.existsSync(source)) {
    fs.mkdirSync(path.join(DIST, "bin"), { recursive: true });
    const copied = path.join(DIST, "bin", path.basename(source));
    fs.copyFileSync(source, copied);
    fs.chmodSync(copied, 0o755);
    const linkPath = path.join(DIST, "bin", process.platform === "win32" ? "llama-server.exe" : "llama-server");
    if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { force: true });
    fs.symlinkSync(path.basename(source), linkPath); // relative: dist stays relocatable
    engineInDist = true;
    say(`[ok]  engine ${source}`);
  } else {
    say("[skip] engine not installed yet — dist can fetch it: node src/main.js install");
  }
}

// 4. dist owns its manifest: zero dependencies by construction.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
fs.writeFileSync(
  path.join(DIST, "package.json"),
  `${JSON.stringify(
    { name: `${pkg.name}-dist`, version: pkg.version, private: true, type: "module", description: "Self-contained build of the lama manager (no runtime dependencies).", engines: pkg.engines, scripts: { start: "node src/main.js serve", doctor: "node src/main.js doctor" } },
    null,
    2,
  )}\n`,
);
say("[ok]  dist/package.json (dependencies: none)");

// 5. Smoke run: the dist must work with no node_modules in sight. Without the
// engine binary doctor exits 1 by design ("binary NOT FOUND") — acceptable only
// when this build skipped the engine.
const smoke = sh(process.execPath, ["src/main.js", "doctor"], DIST);
const acceptable = smoke.code === 0 || (!engineInDist && /binary\s+NOT FOUND/.test(smoke.out));
if (!acceptable) fail(`build: dist smoke run failed (exit ${smoke.code})\n${smoke.out}`);
if (fs.existsSync(path.join(DIST, "node_modules"))) fail("build: dist must not contain node_modules");
say(`[ok]  smoke run doctor exit=${smoke.code}${engineInDist ? "" : " (engine skipped)"}, no node_modules`);

// 6. Tarball for copying to another machine.
if (argv.includes("--no-tar")) say("[skip] tarball (—no-tar)");
else {
  const tarball = path.join(ROOT, `lama-dist-${pkg.version}.tgz`);
  const tar = sh("tar", ["-czf", tarball, "-C", DIST, "."]);
  if (tar.code === 0) say(`[ok]  ${path.basename(tarball)} ${((fs.statSync(tarball).size / 1024 / 1024) * 1).toFixed(1)} MiB`);
  else say("[skip] tar unavailable");
}
say("BUILD DONE");
