#!/usr/bin/env node
/**
 * One-shot installer for the lama manager. Node built-ins only, so the same
 * script runs on Linux, macOS and Windows; steps that a platform cannot do
 * are reported as SKIP instead of hanging.
 *
 * Flow: node >= 24 (downloads it on Linux when missing) -> npm install ->
 * stock llama.cpp engine -> model -> setup (env/db/seeds) -> TLS check ->
 * services -> load the newest model -> open the admin URL.
 *
 * Usage: node scripts/install.mjs [--build bNNNNN] [--no-service] [--no-browser]
 * Exit code: 0 when every mandatory step passed, 1 otherwise.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.platform; // linux | darwin | win32
const IS_LINUX = PLATFORM === "linux";
const MODEL_URL =
  "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf";
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

const say = (line) => process.stdout.write(`${line}\n`);
const results = [];
let failed = 0;

function step(name, fn) {
  const out = [];
  const ok = fn(out);
  results.push({ name, ok });
  say(`${ok ? "[ok]  " : "[FAIL]"} ${name}`);
  for (const line of out) say(`       ${line}`);
  if (!ok) failed += 1;
  return ok;
}

function skip(name, why) {
  results.push({ name, ok: true, skipped: why });
  say(`[skip] ${name} — ${why}`);
}

function sh(command, args, opts = {}) {
  const r = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", timeout: 15 * 60_000, ...opts });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function nodeBin() { return process.execPath; }

function lamaCli(args, opts = {}) {
  return sh(nodeBin(), [path.join(ROOT, "src", "main.ts"), ...args], opts);
}

/** 1. Node.js >= 24 (node:sqlite and native TS need it). Linux installs it when missing. */
function ensureNode(out) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 24) { out.push(`node ${process.versions.node} (>= 24)`); return true; }
  if (!IS_LINUX) { out.push(`node ${process.versions.node} is too old and no auto-install exists on ${PLATFORM}`); return false; }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  out.push(`node ${process.versions.node} < 24 — installing the official v24 build`);
  const list = sh("curl", ["-fsSL", "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt"]);
  const file = /node-v24[\d.]*-linux-.*\.tar\.xz/.exec(list.out)?.[0];
  if (!file) { out.push(list.out.slice(0, 300)); return false; }
  const dest = path.join(process.env.HOME ?? "~", ".local");
  fs.mkdirSync(dest, { recursive: true });
  const tarball = path.join("/tmp", file);
  if (sh("curl", ["-fsSL", `https://nodejs.org/dist/latest-v24.x/${file}`, "-o", tarball]).code !== 0) return false;
  if (sh("tar", ["-xJf", tarball, "-C", dest]).code !== 0) return false;
  const home = process.env.HOME ?? "";
  const rc = path.join(home, ".bashrc");
  const line = 'export PATH="$HOME/.local/node-v24.22.2-linux-x64/bin:$HOME/.local/node/bin:$PATH"';
  if (!fs.existsSync(rc) || !fs.readFileSync(rc, "utf8").includes("$HOME/.local/node")) fs.appendFileSync(rc, `${line}\n`);
  out.push(`installed ${file}; restart this script so the new node is used: node scripts/install.mjs`);
  return false; // a re-run under the new binary is the honest next step
}

/** 2. Project dependencies (dev-only: typescript + node types). */
function installDeps(out) {
  const r = sh(IS_LINUX || PLATFORM === "darwin" ? "npm" : "npm.cmd", ["install", "--no-audit", "--no-fund"]);
  out.push(r.out.split("\n").slice(-3).join(" | "));
  return r.code === 0;
}

/** 3. Stock llama.cpp engine (skips releases that are still uploading). */
function installEngine(out) {
  const args = ["install"];
  const build = value("--build");
  if (build) args.push("--build", build);
  const r = lamaCli(args);
  out.push(r.out.split("\n").slice(-4).join(" | "));
  return r.code === 0;
}

/** 4. Model: register one when none exists, download the gguf when its file is missing. */
function installModel(out) {
  fs.mkdirSync(path.join(ROOT, "models"), { recursive: true });
  const ggufs = fs.readdirSync(path.join(ROOT, "models")).filter((f) => f.endsWith(".gguf"));
  if (ggufs.length) { out.push(`${ggufs.length} gguf already present: ${ggufs[0]}`); return true; }
  const dest = path.join(ROOT, "models", "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf");
  const r = sh("curl", ["-L", "--fail", "-o", dest, MODEL_URL], { timeout: 30 * 60_000 });
  if (r.code !== 0) { out.push(r.out.slice(0, 300)); return false; }
  out.push(`${path.basename(dest)} ${((fs.statSync(dest).size / 1024 / 1024) | 0)} MiB`);
  return true;
}

/** 5. Environment + database + seeds. */
function setup(out) {
  const r = lamaCli(["setup"]);
  out.push(r.out.split("\n").slice(0, 4).join(" | "));
  return r.code === 0;
}

/** 6. TLS: generate/verify the certificate chain and report linkage. */
function tls(out) {
  const r = lamaCli(["tls", "--check"]);
  out.push(r.out.slice(0, 300));
  return r.code === 0;
}

/** 7. Services: full on Linux, launchd on macOS, printed commands on Windows. */
function services(out) {
  const engine = lamaCli(["service", "install", "user"]);
  const gateway = lamaCli(["service", "install", "user", "--gateway"]);
  out.push(engine.out.replace(/\s+/g, " ").slice(0, 200));
  out.push(gateway.out.replace(/\s+/g, " ").slice(0, 200));
  if (IS_LINUX) {
    const enabled = sh("systemctl", ["--user", "is-enabled", "lama-engine"]);
    const gatewayEnabled = sh("systemctl", ["--user", "is-enabled", "lama-gateway"]);
    out.push(`systemctl is-enabled lama-engine: ${enabled.out || "missing"}`);
    out.push(`systemctl is-enabled lama-gateway: ${gatewayEnabled.out || "missing"}`);
    return engine.code === 0 && gateway.code === 0 && enabled.code === 0 && gatewayEnabled.code === 0;
  }
  return engine.code === 0 && gateway.code === 0;
}

/** 8. Load the newest registered model and wait until the engine answers. */
function loadModel(out) {
  let rows = [];
  try {
    const db = new DatabaseSync(path.join(ROOT, "data", "manager.db"));
    rows = db.prepare("select id, path from models order by created_at desc").all();
    db.close();
  } catch (error) { out.push(`db: ${error.message}`); return false; }
  const row = rows.find((r) => r.path && fs.existsSync(r.path));
  if (!row) { out.push("no registered model with an existing file"); return false; }
  const load = lamaCli(["engine", "load", String(row.id)]);
  out.push(load.out.replace(/\s+/g, " ").slice(0, 240));
  if (load.code !== 0) return false;
  for (let i = 0; i < 60; i += 1) {
    const status = lamaCli(["engine", "status"]);
    if (/"status": "running"/.test(status.out)) { out.push(`engine running (${row.id})`); return true; }
    if (/"status": "error"|"last_error": "(?!null)/.test(status.out)) { out.push(status.out.slice(0, 300)); return false; }
    spawnSync(IS_LINUX ? "sleep" : "ping", IS_LINUX ? ["2"] : ["-n", "3", "127.0.0.1"]);
  }
  out.push("engine did not reach running within 120s");
  return false;
}

/** 9. Open the admin UI (or print the URL when no browser is available). */
function openAdmin(out) {
  const env = fs.existsSync(path.join(ROOT, ".env")) ? fs.readFileSync(path.join(ROOT, ".env"), "utf8") : "";
  const port = /(?:^|\n)LAMA_GATEWAY_PORT=(\d+)/.exec(env)?.[1] ?? "5252";
  const host = /(?:^|\n)LAMA_GATEWAY_HOST=([^\n]+)/.exec(env)?.[1]?.trim() ?? "127.0.0.1";
  const url = `http://${host}:${port}/admin`;
  out.push(`token: grep '^LAMA_ADMIN_TOKEN=' ${path.join(ROOT, ".env")}`);
  const opener = PLATFORM === "darwin" ? ["open", [url]] : PLATFORM === "win32" ? ["cmd", ["/c", "start", url]] : ["xdg-open", [url]];
  const r = sh(opener[0], opener[1], { timeout: 20_000 });
  if (r.code === 0) { out.push(`opened ${url}`); return true; }
  out.push(`no browser here — open manually: ${url}`);
  return true; // headless machines are normal, not a failure
}

say(`lama installer — ${PLATFORM}/${process.arch} root=${ROOT}`);

step("node.js >= 24", ensureNode);
step("project dependencies", installDeps);
step("llama.cpp engine", installEngine);
step("model file", installModel);
step("environment, database, seeds", setup);
step("TLS certificate check", tls);
if (flag("--no-service")) skip("services", "--no-service");
else step("system services", services);
step("load newest model", loadModel);
if (flag("--no-browser")) skip("admin URL", "--no-browser");
else step("admin URL in browser", openAdmin);

say("");
say(`${results.filter((r) => r.ok).length}/${results.length} steps ok${failed ? `, ${failed} failed` : ""}`);
if (failed) {
  say("FAILED — fix the [FAIL] step above and re-run: node scripts/install.mjs");
  process.exit(1);
}
say("DONE — gateway/admin: see the URL above, token lives in .env (LAMA_ADMIN_TOKEN)");
