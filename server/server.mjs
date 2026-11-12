#!/usr/bin/env node
/**
 * lama management wrapper — decoration layer around llama.cpp (v3).
 *
 * Policy (owner's architecture, 2026-10-28):
 *   - The engine stays stock. Native llama.cpp capabilities stay native:
 *     TLS via the engine's own --ssl-key-file/--ssl-cert-file, UDS via
 *     --host *.sock, MCP via --mcp-servers-config, tools via chat templates.
 *     No SDK dependency, no custom TLS layer — when TLS is off, the https
 *     self-test reports "skipped" instead of faking a pass.
 *   - Legacy manager: the admin UI moved to the TypeScript app in src/ + web/.
 *   - models/catalog.json is the download ledger: a model is downloaded once;
 *     repeat requests return the existing file.
 *   - Gateway concerns (provider mapping) live in the gateway's own admin,
 *     not here. The manager only exposes the engine through one base URL.
 *
 * Zero dependencies: node:http, node:https, node:tls, node:child_process,
 * node:fs. Env from <lama>/.env (KEY=value); process.env wins over the file.
 * Security: binds 127.0.0.1 by default; LAMA_API_KEY guards /api/* + proxy.
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createStore } from "./lib/db.mjs";
import { normalizeServer, probeServer, writeEngineConfig, TRANSPORTS } from "./lib/mcp.mjs";
import { buildRuntime, parseBinaryVersion, parseBuildInfo, versionMatch } from "./lib/runtime.mjs";

const LAMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const T0 = Date.now();

// ---- config -----------------------------------------------------------------
// process.env wins over .env — including an explicitly empty value, so a test or
// a unit file can switch a feature off without editing the developer's .env.
// LAMA_ENV_FILE selects which file is read; before this, tests read the real .env.
const fileEnv = {};
const ENV_FILE = process.env.LAMA_ENV_FILE || path.join(LAMA, ".env");
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) fileEnv[m[1]] = m[2];
  }
}
const env = (k) => (Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : (fileEnv[k] ?? ""));
const UDS_DEFAULT = path.join(os.tmpdir(), `llama-${process.getuid?.() ?? 0}`, "llama.sock");
const cfg = {
  LLAMA_BIN: env("LLAMA_BIN") || "llama",
  LLAMA_MODEL_CTX: Number(env("LLAMA_MODEL_CTX") || 4096),
  LLAMA_THREADS: Number(env("LLAMA_THREADS") || 4),
  LAMA_LLAMA_HOST: env("LAMA_LLAMA_HOST") || "127.0.0.1",
  LAMA_LLAMA_PORT: Number(env("LAMA_LLAMA_PORT") || 9931),
  LAMA_LLAMA_ARGS: (env("LAMA_LLAMA_ARGS") || "--jinja --no-webui").split(/\s+/).filter(Boolean),
  LAMA_UDS_SOCK: env("LAMA_UDS_SOCK") || UDS_DEFAULT,
  LAMA_SSL_KEY: env("LAMA_SSL_KEY") || "",
  LAMA_SSL_CERT: env("LAMA_SSL_CERT") || "",
  LAMA_MGMT_HOST: env("LAMA_MGMT_HOST") || "127.0.0.1",
  LAMA_MGMT_PORT: Number(env("LAMA_MGMT_PORT") || 9933),
  LAMA_ADMIN_PORT: Number(env("LAMA_ADMIN_PORT") || 9933),
  LAMA_MODELS_DIR: env("LAMA_MODELS_DIR") || path.join(LAMA, "models"),
  LAMA_LOG_DIR: env("LAMA_LOG_DIR") || path.join(LAMA, "logs"),
  LAMA_API_KEY: env("LAMA_API_KEY") || "",
  HF_TOKEN: env("HF_TOKEN") || "",
  LAMA_MCP_CONFIG: env("LAMA_MCP_CONFIG") || "",
  LAMA_GATEWAY_ENV: env("LAMA_GATEWAY_ENV") || "",
  LAMA_GATEWAY_BASE_URL: env("LAMA_GATEWAY_BASE_URL") || "",
  LAMA_DB: env("LAMA_DB") || path.join(LAMA, "data", "lama.db"),
  LAMA_ENV_FILE: ENV_FILE,
  LAMA_DATA_DIR: env("LAMA_DATA_DIR") || path.join(LAMA, "data"),
};
const LLAMA_TLS = Boolean(cfg.LAMA_SSL_KEY && cfg.LAMA_SSL_CERT); // engine-native TLS
const LLAMA_BASE = `http://${cfg.LAMA_LLAMA_HOST}:${cfg.LAMA_LLAMA_PORT}`;          // plaintext origin (http test)
const LLAMA_ORIGIN = `${LLAMA_TLS ? "https" : "http"}://${cfg.LAMA_LLAMA_HOST}:${cfg.LAMA_LLAMA_PORT}`; // what the engine serves

// The current admin (src/main.ts serve) owns 9933 by default. Sharing that port used
// to crash-loop lama-admin.service with an EADDRINUSE stack trace, so refuse up front
// and name both knobs instead of losing the race at listen().
if (cfg.LAMA_MGMT_PORT === cfg.LAMA_ADMIN_PORT) {
  process.stderr.write(
    `legacy lama manager refuses ${cfg.LAMA_MGMT_HOST}:${cfg.LAMA_MGMT_PORT}: the current lama admin owns that port. ` +
      `Set LAMA_MGMT_PORT (for example 9934) or move LAMA_ADMIN_PORT.\n`,
  );
  process.exit(1);
}

// ---- SQLite (source of truth for MCP servers, prompts, chat runs) ----------------
const DATA_DIR = cfg.LAMA_DATA_DIR;
const BRIDGE = path.join(LAMA, "server", "lib", "bridge.mjs");
const store = createStore(cfg.LAMA_DB);
let mcpCfgCache = { key: "", path: "" };
const seedDefaultPrompt = () => {
  try {
    if (store.prompts.list().length) return;
    store.prompts.create({
      name: "lama-default",
      description: "Seeded baseline system prompt for the local engine. Edit by adding a version.",
      content: "You are a helpful, concise assistant running on a local llama.cpp engine. Answer in the user's language.",
      tags: ["seed", "baseline"],
      is_default: true,
      note: "seed v1",
    });
  } catch (e) { log({ kind: "db", action: "seed_failed", message: e.message }); }
};
// ---- logging -----------------------------------------------------------------
fs.mkdirSync(cfg.LAMA_LOG_DIR, { recursive: true });
fs.mkdirSync(cfg.LAMA_MODELS_DIR, { recursive: true });
const MGMT_LOG = path.join(cfg.LAMA_LOG_DIR, "mgmt.jsonl");
const log = (obj) => fs.appendFileSync(MGMT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
seedDefaultPrompt();

const aliasOf = (p) => path.basename(p).replace(/\.gguf$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";

// ---- download catalog (models/catalog.json — one download per model) -------------
const CATALOG = path.join(cfg.LAMA_MODELS_DIR, "catalog.json");
function readCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG, "utf8")); }
  catch { return { version: 1, updated_at: null, models: {} }; }
}
function writeCatalog(c) {
  c.updated_at = new Date().toISOString();
  const tmp = CATALOG + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n");
  fs.renameSync(tmp, CATALOG);
}
function catalogFind(repo, file) {
  const c = readCatalog();
  return Object.entries(c.models).find(([, v]) => v.repo === repo && v.file === file)?.[1] || null;
}

// ---- model scan ----------------------------------------------------------------
function* ggufs(root, depth = 4) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (depth > 0) yield* ggufs(p, depth - 1); }
    else if (e.name.toLowerCase().endsWith(".gguf")) yield p;
  }
}
function scanModels() {
  const catalog = readCatalog();
  const cands = [
    { dir: cfg.LAMA_MODELS_DIR, source: "lama/models" },
    { dir: path.join(HOME, ".cache", "huggingface", "hub"), source: "hf-hub" },
    { dir: path.join(HOME, ".cache", "llama.cpp"), source: "llama-cache" },
    ...(process.env.LAMA_EXTRA_DIRS ? process.env.LAMA_EXTRA_DIRS.split(":").map((d) => ({ dir: d, source: "extra" })) : []),
  ].filter((c) => { try { return fs.statSync(c.dir).isDirectory(); } catch { return false; } });
  const seen = new Set();
  const models = [];
  for (const c of cands) {
    for (const p of ggufs(c.dir)) {
      const key = fs.realpathSync.native(p);
      if (seen.has(key)) continue;
      seen.add(key);
      const cat = Object.values(catalog.models).find((v) => v.path === p);
      models.push({ name: aliasOf(p), path: p, size: fs.statSync(p).size, source: c.source, repo: cat?.repo || null, file: cat?.file || null });
    }
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return { models, dirs: cands.map((c) => c.dir), catalog: CATALOG };
}

// ---- llama server lifecycle -----------------------------------------------------
const cur = { child: null, pid: null, alias: null, model: null, since: null, expiresAt: null, buildInfo: null };
const ttlTimer = { id: null };

function engineGet(reqPath, { timeoutMs = 4000, uds = false, plain = false } = {}) {
  return new Promise((resolve, reject) => {
    const done = (res) => {
      let b = ""; res.on("data", (c) => { b += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    };
    let req;
    if (uds) {
      req = LLAMA_TLS && !plain
        ? https.request({ path: reqPath, method: "GET", rejectUnauthorized: false,
            createConnection: () => tls.connect({ path: cfg.LAMA_UDS_SOCK, rejectUnauthorized: false }) }, done)
        : http.request({ socketPath: cfg.LAMA_UDS_SOCK, path: reqPath, method: "GET" }, done);
    } else {
      req = LLAMA_TLS && !plain
        ? https.request({ host: cfg.LAMA_LLAMA_HOST, port: cfg.LAMA_LLAMA_PORT, path: reqPath,
            method: "GET", rejectUnauthorized: false }, done)
        : http.request(`${LLAMA_BASE}${reqPath}`, { method: "GET" }, done);
    }
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function upstreamHealth(timeoutMs = 2000) {
  try {
    const r = await engineGet("/health", { timeoutMs });
    return r.status === 200 ? "ok" : `http_${r.status}`;
  } catch { return "down"; }
}

// ---- engine identity -------------------------------------------------------------
// Two published sources, both quoted verbatim:
//   `llama --version`     → works even when no model is loaded
//   /props.build_info     → what the *running* engine says about itself
// If they disagree the UI shows a warning; nothing is inferred from the other.
let binVersionCache = null;
function binaryVersion() {
  if (binVersionCache) return binVersionCache;
  if (!fs.existsSync(cfg.LLAMA_BIN)) {
    binVersionCache = { binary: cfg.LLAMA_BIN, found: false, raw: "", version: null, build: null, commit: null };
    return binVersionCache;
  }
  const r = spawnSync(cfg.LLAMA_BIN, ["--version"], { timeout: 4000, encoding: "utf8" });
  const raw = ((r.stdout || "") + (r.stderr || "")).trim().split("\n")[0] || "";
  binVersionCache = { binary: cfg.LLAMA_BIN, found: true, ...(parseBinaryVersion(raw) || { raw, version: null, build: null, commit: null }) };
  return binVersionCache;
}

function engineVersion() {
  const binary = binaryVersion();
  const props = parseBuildInfo(cur.buildInfo || "");
  return {
    binary,
    props,
    build: props?.build || binary.build || null,
    commit: props?.commit || binary.commit || null,
    match: versionMatch(binary, props),
    source: props ? "/props.build_info + llama --version" : "llama --version only (no /props.build_info sampled yet)",
  };
}

function engineMcpConfig() {
  // DB is authoritative: enabled servers generate the Cursor-compatible config
  // the engine reads at spawn. LAMA_MCP_CONFIG remains a manual override.
  try {
    const enabled = store.mcp.enabled();
    if (!enabled.length) return cfg.LAMA_MCP_CONFIG || "";
    const key = enabled.map((s) => `${s.id}:${s.updated_at}:${s.enabled}`).join("|") + "|" + BRIDGE;
    if (mcpCfgCache.key === key && fs.existsSync(mcpCfgCache.path)) return mcpCfgCache.path;
    const { configPath } = writeEngineConfig(enabled, { dataDir: DATA_DIR, bridgePath: BRIDGE });
    mcpCfgCache = { key, path: configPath };
    return configPath;
  } catch (e) { log({ kind: "mcp", action: "config_error", message: e.message }); }
  return cfg.LAMA_MCP_CONFIG || "";
}

function llamaArgs(modelPath, alias, ctx) {
  const hosts = [cfg.LAMA_LLAMA_HOST];
  if (cfg.LAMA_UDS_SOCK) hosts.push(cfg.LAMA_UDS_SOCK);
  const args = ["serve", "-m", modelPath, "--alias", alias,
    "--host", hosts.join(","), "--port", String(cfg.LAMA_LLAMA_PORT),
    "-c", String(ctx || cfg.LLAMA_MODEL_CTX), "-t", String(cfg.LLAMA_THREADS), ...cfg.LAMA_LLAMA_ARGS];
  if (LLAMA_TLS) args.push("--ssl-key-file", cfg.LAMA_SSL_KEY, "--ssl-cert-file", cfg.LAMA_SSL_CERT);
  const mcpConfig = engineMcpConfig();
  if (mcpConfig) args.push("--mcp-servers-config", mcpConfig);
  return args;
}

function scheduleUnload(hours) {
  if (ttlTimer.id) { clearTimeout(ttlTimer.id); ttlTimer.id = null; }
  if (!hours || hours <= 0) { cur.expiresAt = null; return null; }
  cur.expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
  ttlTimer.id = setTimeout(() => { unloadModel(); log({ kind: "model", action: "ttl_expired" }); }, hours * 3600_000);
  ttlTimer.id.unref?.();
  return cur.expiresAt;
}

async function loadModel({ name, path: given, ctx, ttl_hours }) {
  if (cur.child) return { error: "a model is already loaded — POST /api/unload first", alias: cur.alias };
  const { models } = scanModels();
  const modelPath = given || models.find((m) => m.name === name)?.path;
  if (!modelPath || !fs.existsSync(modelPath)) return { error: `model not found: ${name || given}` };
  const alias = aliasOf(modelPath);
  if (cfg.LAMA_UDS_SOCK) {
    fs.mkdirSync(path.dirname(cfg.LAMA_UDS_SOCK), { recursive: true, mode: 0o700 });
    try { fs.unlinkSync(cfg.LAMA_UDS_SOCK); } catch {} // stale socket would block bind
  }
  const out = fs.openSync(path.join(cfg.LAMA_LOG_DIR, `llama-${alias}.log`), "a");
  log({ kind: "model", action: "load", alias, model: modelPath, ctx: ctx || cfg.LLAMA_MODEL_CTX, ttl_hours: ttl_hours || 0 });
  const child = spawn(cfg.LLAMA_BIN, llamaArgs(modelPath, alias, ctx), { stdio: ["ignore", out, out] });
  cur.child = child; cur.pid = child.pid; cur.alias = alias; cur.model = modelPath; cur.since = new Date().toISOString();
  child.on("exit", (code, signal) => {
    log({ kind: "model", action: "exit", alias: cur.alias, code, signal });
    scheduleUnload(0);
    cur.child = null; cur.pid = null; cur.alias = null; cur.model = null; cur.since = null;
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!cur.child) return { error: "llama server exited during startup — see logs/llama-<alias>.log" };
    if (cfg.LAMA_UDS_SOCK) try { fs.chmodSync(cfg.LAMA_UDS_SOCK, 0o660); } catch {}
    if ((await upstreamHealth(1000)) === "ok") break;
  }
  scheduleUnload(ttl_hours);
  if (ttl_hours) log({ kind: "model", action: "ttl_set", alias, expires_at: cur.expiresAt });
  return (await upstreamHealth()) === "ok"
    ? { alias, pid: cur.pid, base_url: LLAMA_ORIGIN, tls: LLAMA_TLS, uds: cfg.LAMA_UDS_SOCK || null, expires_at: cur.expiresAt }
    : { error: "health never turned ok within 180s" };
}

async function unloadModel() {
  if (!cur.child) return { was: null, signal: null };
  const was = cur.alias;
  log({ kind: "model", action: "unload", alias: was });
  const child = cur.child;
  child.kill("SIGTERM");
  for (let i = 0; i < 25 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 200));
  if (child.exitCode === null) child.kill("SIGKILL");
  return { was, signal: "SIGTERM" };
}

// ---- downloader (deduped via catalog.json) ----------------------------------------
async function downloadModel({ repo, file }) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return { error: "repo must look like org/name" };
  if (file.includes("..") || file.includes("/")) return { error: "file must be a bare filename" };
  // Dedupe: same repo+file recorded in the catalog and still on disk -> no second download.
  const hit = catalogFind(repo, file);
  if (hit && fs.existsSync(hit.path)) {
    log({ kind: "download", action: "deduped", repo, file, path: hit.path });
    return { path: hit.path, size: hit.size, cached: true, note: "already in catalog — not re-downloaded" };
  }
  const url = `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
  const headers = { "user-agent": "lama-mgmt/0.1" };
  if (cfg.HF_TOKEN) headers.authorization = `Bearer ${cfg.HF_TOKEN}`;
  log({ kind: "download", action: "start", repo, file, url });
  let res;
  try { res = await fetch(url, { headers, redirect: "follow" }); }
  catch (e) { return { error: `fetch failed: ${e.message}` }; }
  if (!res.ok || !res.body) return { error: `download failed: HTTP ${res.status}` };
  const dest = path.join(cfg.LAMA_MODELS_DIR, file.replace(/[:]/g, "_"));
  const tmp = dest + ".part";
  let total = 0;
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    Readable.fromWeb(res.body).on("data", (chunk) => { total += chunk.length; })
      .pipe(ws).on("finish", resolve).on("error", reject);
  });
  fs.renameSync(tmp, dest);
  const catalog = readCatalog();
  catalog.models[aliasOf(dest)] = { repo, file, path: dest, size: total, downloaded_at: new Date().toISOString() };
  writeCatalog(catalog);
  log({ kind: "download", action: "done", repo, file, path: dest, size: total });
  return { path: dest, size: total, cached: false };
}

// ---- metrics (aggregated from the JSONL log — one source of truth) ---------------
function metrics() {
  const totals = { requests: 0, errors: 0, ms: 0, bytes: 0, max_ms: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const models = {};
  const tests = {};
  let lines = [];
  try { lines = fs.readFileSync(MGMT_LOG, "utf8").trim().split("\n"); } catch { lines = []; }
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.kind === "request") {
      totals.requests++;
      totals.ms += o.ms || 0;
      totals.bytes += o.bytes || 0;
      totals.max_ms = Math.max(totals.max_ms, o.ms || 0);
      totals.prompt_tokens += o.prompt_tokens || 0;
      totals.completion_tokens += o.completion_tokens || 0;
      totals.total_tokens += o.total_tokens || 0;
      const failed = (o.status || 0) >= 400;
      if (failed) totals.errors++;
      const m = o.model || "unmapped";
      const b = (models[m] ||= { calls: 0, ms_sum: 0, max_ms: 0, last: null, errors: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
      b.calls++;
      b.ms_sum += o.ms || 0;
      b.max_ms = Math.max(b.max_ms, o.ms || 0);
      b.prompt_tokens += o.prompt_tokens || 0;
      b.completion_tokens += o.completion_tokens || 0;
      b.total_tokens += o.total_tokens || 0;
      if (failed) b.errors++;
      b.last = o.ts;
    } else if (o.kind === "test") {
      const t = (tests[o.test || "unknown"] ||= { runs: 0, pass: 0, fail: 0, skipped: 0, ms_sum: 0, last: null });
      t.runs++;
      const skipped = String(o.detail || "").startsWith("skipped");
      if (o.ok) t.pass++; else if (skipped) t.skipped++; else t.fail++;
      t.ms_sum += o.ms || 0;
      t.last = o.ts;
    }
  }
  for (const m of Object.values(models)) m.ms_avg = m.calls ? Math.round(m.ms_sum / m.calls) : 0;
  for (const t of Object.values(tests)) t.ms_avg = t.runs ? Math.round(t.ms_sum / t.runs) : 0;
  return { totals, models, tests };
}

// ---- engine log tail (runtime log visible in the admin) ----------------------------
function engineLogTail(n = 80) {
  const cands = [];
  if (cur.alias) cands.push(path.join(cfg.LAMA_LOG_DIR, `llama-${cur.alias}.log`));
  try {
    for (const f of fs.readdirSync(cfg.LAMA_LOG_DIR)) {
      if (f.startsWith("llama-") && f.endsWith(".log")) cands.push(path.join(cfg.LAMA_LOG_DIR, f));
    }
  } catch {}
  const file = cands.find((f) => fs.existsSync(f)) || null;
  if (!file) return { file: null, lines: [] };
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(-n);
  return { file, lines };
}

// ---- gateway mapping (CP_* provider env — the gateway reads it at start) -----------
function gatewayModelState() {
  const file = cfg.LAMA_GATEWAY_ENV;
  if (!file) return { configured: false, env: null, aliases: [] };
  if (!fs.existsSync(file)) return { configured: false, env: file, aliases: [], error: "gateway env not found" };
  try {
    const text = fs.readFileSync(file, "utf8");
    const m = /^CP_LLAMACPP_MODELS=(.*)$/m.exec(text);
    const aliases = m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
    return { configured: true, env: file, aliases };
  } catch (e) {
    return { configured: false, env: file, aliases: [], error: e.message };
  }
}

/**
 * Live catalogue of the gateway (GET /v1/models). The gateway's id is what a
 * client must ask for, e.g. `llamacpp/<upstream_id>` — it is not always the same
 * string as CP_LLAMACPP_MODELS, and a stale catalogue (no restart/sync after a
 * model change) shows up here instead of being guessed. Short timeout: the
 * admin refreshes every few seconds and a down gateway must not stall the page.
 */
async function gatewayCatalogue(timeoutMs = 900) {
  const base = String(cfg.LAMA_GATEWAY_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return { configured: false, ok: false, url: null, models: [], error: "LAMA_GATEWAY_BASE_URL not configured in lama/.env" };
  const url = `${base}/v1/models`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    if (!r.ok) return { configured: true, ok: false, url, models: [], error: `HTTP ${r.status}: ${text.slice(0, 120)}` };
    const j = JSON.parse(text);
    const models = (j.data || []).map((m) => ({
      id: m.id || null,
      owned_by: m.owned_by || null,
      upstream_id: m.metadata?.upstream_id || null,
    })).filter((m) => m.id);
    return { configured: true, ok: true, url, models };
  } catch (e) {
    return { configured: true, ok: false, url, models: [], error: e.message };
  }
}

/** One mapping row: what the env says, what the live catalogue says, and the difference. */
function mappingFor(name, envAliases, catalogue) {
  const slug = `llamacpp/${name}`;
  const live = catalogue.models.find((m) => m.id === slug || m.upstream_id === name) || null;
  const registered = envAliases.includes(name);
  let state = "not-mapped", note = "not registered in CP_LLAMACPP_MODELS and absent from the gateway catalogue";
  if (registered && live) { state = "live"; note = "registered in the env and served by the live catalogue"; }
  else if (registered) { state = "pending-restart"; note = "CP_LLAMACPP_MODELS has this alias, the live catalogue does not — restart or sync zombie-gateway"; }
  else if (live) { state = "catalog-only"; note = "the gateway serves it, but the alias is not in CP_LLAMACPP_MODELS"; }
  return { slug, alias: name, env_registered: registered, catalog_id: live?.id || null, catalog_upstream: live?.upstream_id || null, state, note };
}

async function mapToGateway({ name }) {
  if (!cfg.LAMA_GATEWAY_ENV) return { error: "LAMA_GATEWAY_ENV not configured in lama/.env" };
  if (!fs.existsSync(cfg.LAMA_GATEWAY_ENV)) return { error: `gateway env not found: ${cfg.LAMA_GATEWAY_ENV}` };
  const { models } = scanModels();
  const m = models.find((x) => x.name === name);
  if (!m) return { error: `model not found in scan: ${name}` };
  const alias = m.name;
  const mgrURL = `http://${cfg.LAMA_MGMT_HOST}:${cfg.LAMA_MGMT_PORT}`;
  const backup = `${cfg.LAMA_GATEWAY_ENV}.bak.${Date.now()}`;
  fs.copyFileSync(cfg.LAMA_GATEWAY_ENV, backup);
  let text = fs.readFileSync(cfg.LAMA_GATEWAY_ENV, "utf8");
  const changes = [];
  // 1. Point the llamacpp provider at this manager (TTL + metrics + proxy in the path).
  if (!/^CP_LLAMACPP_BASE_URL=/m.test(text)) {
    text += `\nCP_LLAMACPP_BASE_URL=${mgrURL}\n`;
    changes.push(`CP_LLAMACPP_BASE_URL=${mgrURL} (new line)`);
  } else if (!new RegExp(`^CP_LLAMACPP_BASE_URL=.*:${cfg.LAMA_MGMT_PORT}`, "m").test(text)) {
    text = text.replace(/^CP_LLAMACPP_BASE_URL=.*$/m, `CP_LLAMACPP_BASE_URL=${mgrURL}`);
    changes.push(`CP_LLAMACPP_BASE_URL=${mgrURL}`);
  }
  // 2. Register the alias in CP_LLAMACPP_MODELS.
  const mm = text.match(/^CP_LLAMACPP_MODELS=(.*)$/m);
  if (mm) {
    const list = mm[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(alias)) {
      list.push(alias);
      text = text.replace(/^CP_LLAMACPP_MODELS=.*$/m, `CP_LLAMACPP_MODELS=${list.join(", ")}`);
      changes.push(`CP_LLAMACPP_MODELS += ${alias}`);
    }
  } else {
    text += `CP_LLAMACPP_MODELS=${alias}\n`;
    changes.push(`CP_LLAMACPP_MODELS=${alias} (new line)`);
  }
  fs.writeFileSync(cfg.LAMA_GATEWAY_ENV, text, { mode: 0o600 });
  log({ kind: "map", alias, gateway_env: cfg.LAMA_GATEWAY_ENV, changes, backup });
  return { mapped: alias, id: `llamacpp/${alias}`, changes, backup, note: "restart zombie-gateway.service to re-read .env" };
}

// ---- runtime preflight (owner-requested checks, live) ------------------------------
async function preflight() {
  const checks = [];
  const add = (check, ok, detail, ms = 0, skip = false) => checks.push({ check, ok, skip, detail, ms });

  add("os", true, `${os.type()} ${os.release()} ${os.arch()}`);
  add("node", true, process.version);

  let t = Date.now();
  const bin = binaryVersion();
  add("llama.cpp installed", bin.found, bin.found ? `${bin.binary}${bin.raw ? " · " + bin.raw : ""}` : `missing: ${bin.binary}`, Date.now() - t);

  t = Date.now();
  const { models } = scanModels();
  add("models synced", models.length > 0, `${models.length} model(s)${models.length ? ": " + models.slice(0, 3).map((m) => m.name).join(", ") : ""}`, Date.now() - t);

  t = Date.now();
  const health = await upstreamHealth(3000);
  add("server up", health === "ok", `health=${health} · ${LLAMA_ORIGIN}`, Date.now() - t);

  add("model loaded", !!cur.alias, cur.alias || "none loaded");

  if (cur.alias) {
    t = Date.now();
    try {
      const r = await engineJSON("/v1/chat/completions", { body: { model: cur.alias, max_tokens: 8, temperature: 0, messages: [{ role: "user", content: "Say OK" }] }, timeoutMs: 120_000 });
      const j = JSON.parse(r.text);
      add("openai response", r.status === 200 && j.object === "chat.completion", `finish=${j.choices?.[0]?.finish_reason} · usage=${j.usage?.total_tokens}`, Date.now() - t);
    } catch (e) { add("openai response", false, e.message, Date.now() - t); }
    t = Date.now();
    try {
      const r = await engineJSON("/v1/messages", { headers: { "anthropic-version": "2023-06-01" }, body: { model: cur.alias, max_tokens: 16, messages: [{ role: "user", content: "Say OK" }] }, timeoutMs: 120_000 });
      const j = JSON.parse(r.text);
      add("anthropic response", r.status === 200 && Array.isArray(j.content), `blocks=${(j.content || []).map((b) => b.type).join(",")} · stop=${j.stop_reason}`, Date.now() - t);
    } catch (e) { add("anthropic response", false, e.message, Date.now() - t); }
  } else {
    add("openai response", false, "no model loaded", 0, true);
    add("anthropic response", false, "no model loaded", 0, true);
  }

  const ok = checks.every((c) => c.ok || c.skip);
  log({ kind: "preflight", ok, checks: checks.map((c) => `${c.ok ? "PASS" : c.skip ? "SKIP" : "FAIL"} ${c.check}`) });
  return { ok, checks };
}

// ---- protocol self-tests (engine-native surfaces, documented shapes) ---------------
async function timed(fn) {
  const t0 = Date.now();
  try {
    const detail = await fn(); // measure AFTER the work, not before
    return { ok: true, ms: Date.now() - t0, ...detail };
  } catch (e) { return { ok: false, ms: Date.now() - t0, detail: e.message }; }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

function engineJSON(reqPath, { method = "POST", body, headers = {}, timeoutMs = 120_000, uds = false, plain = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const allHeaders = { ...headers };
    if (payload) allHeaders["content-type"] = "application/json";
    const done = (res) => {
      let b = ""; res.on("data", (c) => { b += c; });
      res.on("end", () => resolve({ status: res.statusCode, text: b }));
    };
    let req;
    if (uds) {
      req = LLAMA_TLS && !plain
        ? https.request({ path: reqPath, method, headers: allHeaders, rejectUnauthorized: false,
            createConnection: () => tls.connect({ path: cfg.LAMA_UDS_SOCK, rejectUnauthorized: false }) }, done)
        : http.request({ socketPath: cfg.LAMA_UDS_SOCK, path: reqPath, method, headers: allHeaders }, done);
    } else {
      req = LLAMA_TLS && !plain
        ? https.request({ host: cfg.LAMA_LLAMA_HOST, port: cfg.LAMA_LLAMA_PORT, path: reqPath, method, headers: allHeaders, rejectUnauthorized: false }, done)
        : http.request(`${LLAMA_BASE}${reqPath}`, { method, headers: allHeaders }, done);
    }
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.end(payload || undefined);
  });
}

async function firstSSEChunks(body, want = 2) {
  const { status, contentType, res } = await new Promise((resolve, reject) => {
    const done = (res) => {
      const ct = res.headers["content-type"] || "";
      if (!res.statusCode?.toString().startsWith("2") || !ct.includes("text/event-stream")) {
        let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => reject(new Error(`HTTP ${res.statusCode} (${ct}): ${b.slice(0, 140)}`)));
        return;
      }
      resolve({ status: res.statusCode, contentType: ct, res });
    };
    let req;
    if (LLAMA_TLS) {
      req = https.request({ host: cfg.LAMA_LLAMA_HOST, port: cfg.LAMA_LLAMA_PORT, path: "/v1/chat/completions",
        method: "POST", headers: { "content-type": "application/json" }, rejectUnauthorized: false }, done);
    } else {
      req = http.request(`${LLAMA_BASE}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" } }, done);
    }
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error("timeout")));
    req.end(Buffer.from(JSON.stringify(body)));
  });
  const chunks = [];
  return await new Promise((resolve) => {
    let buf = "";
    const onData = (c) => {
      buf += c.toString();
      let idx;
      while (chunks.length < want && (idx = buf.indexOf("\n\n")) !== -1) {
        const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = evt.split("\n").find((l) => l.startsWith("data: "));
        if (line) { try { chunks.push(JSON.parse(line.slice(6))); } catch {} }
      }
      if (chunks.length >= want) { res.removeListener("data", onData); res.destroy(); resolve(chunks); }
    };
    res.on("data", onData);
    res.on("end", () => resolve(chunks));
  });
}

async function runTest(kind) {
  const model = cur.alias;
  const needModel = ["openai", "stream", "anthropic", "tools"];
  if (needModel.includes(kind) && !model) return { kind, ok: false, detail: "skipped: no model loaded (load one first)" };
  switch (kind) {
    case "http": return { kind, ...await timed(async () => {
      let r;
      try { r = await engineGet("/health", { plain: true }); }
      catch (e) {
        if (LLAMA_TLS) throw new Error(`engine is TLS-only (LAMA_SSL_* set) — plaintext refused (${e.message}); run the HTTPS test`);
        throw e;
      }
      assert(r.status === 200, `HTTP ${r.status}`);
      return { what: `GET ${LLAMA_BASE}/health (plain)` };
    }) };
    case "https": return { kind, ...await timed(async () => {
      assert(LLAMA_TLS, "skipped: LAMA_SSL_KEY/LAMA_SSL_CERT not configured — engine-native TLS is off (by design)");
      const r = await engineGet("/health");
      assert(r.status === 200, `HTTP ${r.status}`);
      return { what: `GET ${LLAMA_ORIGIN}/health (engine-native TLS)` };
    }) };
    case "uds": return { kind, ...await timed(async () => {
      const r = await engineGet("/health", { uds: true });
      assert(r.status === 200, `HTTP ${r.status}`);
      return { what: `GET unix://${cfg.LAMA_UDS_SOCK}/health${LLAMA_TLS ? " (TLS over UDS)" : ""}` };
    }) };
    case "openai": return { kind, model, ...await timed(async () => {
      const r = await engineJSON("/v1/chat/completions", { body: { model, max_tokens: 8, temperature: 0, messages: [{ role: "user", content: "Say OK" }] } });
      assert(r.status === 200, `HTTP ${r.status}`);
      const j = JSON.parse(r.text);
      assert(j.object === "chat.completion" && Array.isArray(j.choices), "not an OpenAI chat.completion shape");
      return { what: "POST /v1/chat/completions (non-stream)", finish: j.choices[0]?.finish_reason, usage: j.usage?.total_tokens };
    }) };
    case "stream": return { kind, model, ...await timed(async () => {
      const chunks = await firstSSEChunks({ model, stream: true, max_tokens: 8, messages: [{ role: "user", content: "Count 1 2 3" }] });
      assert(chunks.length && chunks[0].object === "chat.completion.chunk", "no SSE chat.completion.chunk frames");
      return { what: "POST /v1/chat/completions stream:true", frames: chunks.length };
    }) };
    case "anthropic": return { kind, model, ...await timed(async () => {
      const r = await engineJSON("/v1/messages", { headers: { "anthropic-version": "2023-06-01" },
        body: { model, max_tokens: 16, messages: [{ role: "user", content: "Say OK" }] } });
      assert(r.status === 200, `HTTP ${r.status}`);
      const j = JSON.parse(r.text);
      assert(Array.isArray(j.content), "no content blocks (Anthropic Messages shape)");
      return { what: "POST /v1/messages", blocks: j.content.map((b) => b.type), stop: j.stop_reason };
    }) };
    case "tools": return { kind, model, ...await timed(async () => {
      const r = await engineJSON("/v1/chat/completions", { body: {
        model, temperature: 0.2, max_tokens: 256,
        messages: [{ role: "user", content: "What is the weather in Istanbul?" }],
        tools: [{ type: "function", function: { name: "get_current_weather", description: "Get the current weather for a city",
          parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } } }],
      }, timeoutMs: 180_000 });
      assert(r.status === 200, `HTTP ${r.status}`);
      const j = JSON.parse(r.text);
      const call = j.choices?.[0]?.message?.tool_calls?.[0];
      assert(call, `no tool_calls (finish_reason=${j.choices?.[0]?.finish_reason}) — model may be tool-incapable`);
      return { what: "POST /v1/chat/completions with tools", tool: call?.function?.name, args: call?.function?.arguments, finish: j.choices?.[0]?.finish_reason };
    }) };
    default: return { kind, ok: false, detail: `unknown test kind: ${kind}` };
  }
}

// ---- runtime snapshot (engine truth, not guesses) ----------------------------------
async function runtimeSnapshot() {
  const health = await upstreamHealth(1500);
  let props = null, slots = null, prom = "";
  if (health === "ok") {
    const [a, b, c] = await Promise.all([
      engineGet("/props", { timeoutMs: 2500 }).catch(() => null),
      engineGet("/slots", { timeoutMs: 2500 }).catch(() => null),
      engineGet("/metrics", { timeoutMs: 2500 }).catch(() => null),
    ]);
    try { props = a ? JSON.parse(a.body) : null; } catch { props = null; }
    try { slots = b ? JSON.parse(b.body) : null; } catch { slots = null; }
    prom = c?.body || "";
  }
  const tail = engineLogTail(4000);
  cur.buildInfo = props?.build_info || null; // /props.build_info — the running engine's own build id
  const runtime = buildRuntime({
    health, props, slots, prom, logText: tail.lines.join("\n"),
    alias: cur.alias, model: cur.model, pid: cur.pid, since: cur.since,
    expiresAt: cur.expiresAt, baseUrl: LLAMA_ORIGIN, udsPath: cfg.LAMA_UDS_SOCK || null,
    binaryVersion: binaryVersion(),
  });
  runtime.log_file = tail.file;
  runtime.mcp_config = engineMcpConfig() || null;
  runtime.mcp_servers = store.mcp.list().map((s) => ({ id: s.id, name: s.name, transport: s.transport, status: s.status, enabled: s.enabled }));
  runtime.chat_lab = store.runs.stats();
  runtime.names = [...new Set([...(cur.alias ? [cur.alias] : []), ...runtime.chat_lab.models.map((m) => m.model).filter(Boolean)])];
  return runtime;
}

// ---- usage extraction (OpenAI + Anthropic, JSON or SSE) ---------------------------
function usageOf(obj) {
  const u = obj?.usage || obj?.response?.usage || obj?.message?.usage || null;
  if (!u) return null;
  const prompt = u.prompt_tokens ?? u.input_tokens ?? null;
  const completion = u.completion_tokens ?? u.output_tokens ?? null;
  const total = u.total_tokens ?? (prompt !== null || completion !== null ? (prompt || 0) + (completion || 0) : null);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function extractUsage(text) {
  const empty = { prompt_tokens: null, completion_tokens: null, total_tokens: null };
  const t = String(text || "");
  if (!t) return empty;
  try { const u = usageOf(JSON.parse(t)); if (u) return u; } catch {}
  for (const m of t.matchAll(/^data:\s*(\{.*\})\s*$/gm)) {
    try { const u = usageOf(JSON.parse(m[1])); if (u) return u; } catch {}
  }
  return empty;
}

// ---- streaming engine call (SSE captured, ttft measured honestly) -----------------
function engineSSE(reqPath, body, { timeoutMs = 240_000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let status = 0, ttft = null, text = "", frames = 0, usage = null, buf = "", errBody = "";
    const done = (res) => {
      status = res.statusCode;
      const ct = res.headers["content-type"] || "";
      if (!status || status < 200 || status >= 300) {
        let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => reject(new Error(`HTTP ${status} (${ct}): ${b.slice(0, 200)}`)));
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (!data) continue;
          if (data === "[DONE]") { res.destroy(); continue; }
          let j; try { j = JSON.parse(data); } catch { continue; }
          frames++;
          const u = usageOf(j); if (u) usage = u;
          const delta = j.choices?.[0]?.delta?.content ?? j.delta?.text ?? "";
          const reason = j.choices?.[0]?.delta?.reasoning_content ?? "";
          if (delta && ttft === null) ttft = Date.now() - t0;
          if (reason && ttft === null) ttft = Date.now() - t0;
          if (typeof delta === "string" && delta) text += delta;
          else if (typeof reason === "string" && reason) {
            if (!text.startsWith("[reasoning]")) text += "[reasoning] ";
            text += reason;
          }
        }
      });
      res.on("end", () => resolve({ status, ttft_ms: ttft, text, frames, usage: usage || { prompt_tokens: null, completion_tokens: null, total_tokens: null } }));
      res.on("error", () => resolve({ status, ttft_ms: ttft, text, frames, usage: usage || { prompt_tokens: null, completion_tokens: null, total_tokens: null } }));
    };
    const payload = Buffer.from(JSON.stringify(body));
    const h = { "content-type": "application/json", accept: "text/event-stream", ...headers };
    h["content-length"] = payload.length;
    const req = LLAMA_TLS
      ? https.request({ host: cfg.LAMA_LLAMA_HOST, port: cfg.LAMA_LLAMA_PORT, path: reqPath, method: "POST", headers: h, rejectUnauthorized: false }, done)
      : http.request(`${LLAMA_BASE}${reqPath}`, { method: "POST", headers: h }, done);
    req.on("error", (e) => (errBody ? reject(new Error(errBody)) : reject(e)));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end(payload);
  });
}

// ---- chat lab: one model, many protocols ------------------------------------------
const TOOL_DEF = [{ type: "function", function: { name: "get_current_weather", description: "Get the current weather for a city",
  parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } } }];

async function chatTest(input = {}) {
  const model = String(input.model || cur.alias || "");
  const format = String(input.format || "openai");
  const stream = Boolean(input.stream) && format === "openai";
  const useTools = format === "tools" || Boolean(input.tools);
  const prompt = String(input.prompt || "Say OK in one short sentence.");
  const maxTokens = Math.min(Math.max(Number(input.max_tokens) || 128, 1), 4096);
  const temperature = Number.isFinite(Number(input.temperature)) ? Number(input.temperature) : 0.7;
  const resolved = store.prompts.resolve({ model });
  const system = input.system !== undefined ? String(input.system) : (resolved?.content || "");
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const run = {
    model, format, stream, tools: useTools, prompt_text: prompt,
    prompt_version_id: input.prompt_version_id ?? resolved?.version_id ?? null, status: "error",
    http_status: null, latency_ms: 0, ttft_ms: null,
    prompt_tokens: null, completion_tokens: null, total_tokens: null,
    finish_reason: "", error: "", response_excerpt: "",
  };
  if (!model) {
    run.error = "no model selected and none loaded";
    const saved = store.runs.add(run);
    return { ok: false, run: saved, error: run.error };
  }

  const t0 = Date.now();
  let text = "", usage = null, finish = "", raw = "";
  try {
    if (format === "openai" || format === "tools") {
      const body = { model, messages, max_tokens: maxTokens, temperature };
      if (useTools) body.tools = TOOL_DEF;
      if (stream) {
        body.stream = true;
        body.stream_options = { include_usage: true };
        const r = await engineSSE("/v1/chat/completions", body);
        text = r.text; usage = r.usage; run.ttft_ms = r.ttft_ms; run.http_status = r.status;
        raw = `frames=${r.frames}`;
      } else {
        const r = await engineJSON("/v1/chat/completions", { body, timeoutMs: 240_000 });
        run.http_status = r.status;
        const j = JSON.parse(r.text);
        if (r.status !== 200) throw new Error(j?.error?.message || `HTTP ${r.status}`);
        const msg = j.choices?.[0]?.message || {};
        text = msg.content || "";
        if (!text && msg.reasoning_content) text = `[reasoning] ${msg.reasoning_content}`;
        usage = usageOf(j);
        finish = j.choices?.[0]?.finish_reason || "";
        if (useTools) {
          const call = j.choices?.[0]?.message?.tool_calls?.[0];
          if (call) text = `${text}${text ? "\n" : ""}tool: ${call.function?.name}(${call.function?.arguments})`;
        }
        raw = JSON.stringify(j).slice(0, 4000);
      }
    } else if (format === "anthropic") {
      const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
      if (system) body.system = system;
      const r = await engineJSON("/v1/messages", { headers: { "anthropic-version": "2023-06-01" }, body, timeoutMs: 240_000 });
      run.http_status = r.status;
      const j = JSON.parse(r.text);
      if (r.status !== 200) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      const blocks = j.content || [];
      text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (!text) {
        const thinking = blocks.filter((b) => b.type === "thinking").map((b) => b.thinking).join("\n");
        if (thinking) text = `[thinking] ${thinking}`;
      }
      usage = usageOf(j);
      finish = j.stop_reason || "";
      raw = JSON.stringify(j).slice(0, 4000);
    } else if (format === "responses") {
      const body = { model, input: prompt, max_output_tokens: maxTokens, temperature };
      if (system) body.instructions = system;
      const r = await engineJSON("/v1/responses", { body, timeoutMs: 240_000 });
      run.http_status = r.status;
      const j = JSON.parse(r.text);
      if (r.status !== 200) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      text = j.output_text || (j.output || []).flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("\n");
      if (!text) {
        const reasoning = (j.output || []).flatMap((o) => o.content || []).filter((c) => c.type === "reasoning_text" || c.type === "summary_text").map((c) => c.text || c.summary).join("\n");
        if (reasoning) text = `[reasoning] ${reasoning}`;
      }
      usage = usageOf(j) || { prompt_tokens: j.usage?.input_tokens ?? null, completion_tokens: j.usage?.output_tokens ?? null, total_tokens: j.usage?.total_tokens ?? null };
      finish = j.status || "";
      raw = JSON.stringify(j).slice(0, 4000);
    } else if (format === "embeddings") {
      const r = await engineJSON("/v1/embeddings", { body: { model, input: prompt }, timeoutMs: 120_000 });
      run.http_status = r.status;
      const j = JSON.parse(r.text);
      if (r.status !== 200) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      const vec = j.data?.[0]?.embedding || [];
      text = `embedding dims=${vec.length} first=${vec.slice(0, 4).map((n) => Number(n).toFixed(4)).join(", ")}`;
      usage = usageOf(j) || { prompt_tokens: j.usage?.prompt_tokens ?? null, completion_tokens: 0, total_tokens: j.usage?.total_tokens ?? null };
      raw = JSON.stringify({ dims: vec.length, usage: j.usage }).slice(0, 1000);
    } else {
      throw new Error(`unknown format: ${format} (openai, tools, anthropic, responses, embeddings)`);
    }
    run.status = "ok";
  } catch (e) {
    run.status = "error";
    run.error = e.message;
  }
  run.latency_ms = Date.now() - t0;
  if (usage) {
    run.prompt_tokens = usage.prompt_tokens ?? null;
    run.completion_tokens = usage.completion_tokens ?? null;
    run.total_tokens = usage.total_tokens ?? null;
  }
  run.finish_reason = finish;
  run.response_excerpt = String(text || raw || "").slice(0, 2000);
  const saved = store.runs.add(run);
  log({ kind: "chatlab", model, format, stream, tools: useTools, status: run.status, ms: run.latency_ms, total_tokens: run.total_tokens, detail: run.error || run.finish_reason });
  return { ok: run.status === "ok", run: saved, text: String(text || "").slice(0, 4000), raw, usage };
}

// ---- proxy (TLS-aware; buffers the small request JSON to tag the model) -----------
const PROXIED = [/^\/v1\//, /^\/props/, /^\/tokenize/, /^\/detokenize/, /^\/slots/, /^\/metrics/, /^\/health/];
const REQ_BUF_MAX = 2 * 1024 * 1024;

function proxy(req, res) {
  const t0 = Date.now();
  const chunks = [];
  let size = 0;
  req.on("data", (c) => { size += c.length; if (size <= REQ_BUF_MAX) chunks.push(c); });
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    let modelTag = "unmapped";
    try { const j = JSON.parse(body.toString("utf8") || "{}"); modelTag = j.model || modelTag; } catch {}
    const headers = { ...req.headers };
    delete headers.host;
    if (body.length) headers["content-length"] = Buffer.byteLength(body);
    const sendUp = (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      let bytes = 0;
      let seen = "";
      ur.on("data", (c) => {
        bytes += c.length;
        if (seen.length < 262144) seen += c.toString("utf8");
      });
      ur.pipe(res);
      ur.on("end", () => {
        const usage = extractUsage(seen);
        log({ kind: "request", method: req.method, path: req.url.split("?")[0], status: ur.statusCode, ms: Date.now() - t0, bytes, model: modelTag, remote: req.socket.remoteAddress, ...usage });
      });
    };
    let upstream;
    if (LLAMA_TLS) {
      upstream = https.request({ host: cfg.LAMA_LLAMA_HOST, port: cfg.LAMA_LLAMA_PORT, path: req.url, method: req.method, headers, rejectUnauthorized: false }, sendUp);
    } else {
      upstream = http.request(`${LLAMA_BASE}${req.url}`, { method: req.method, headers }, sendUp);
    }
    upstream.on("error", (e) => {
      if (!res.headersSent) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 503, message: `llama server not reachable: ${e.message}`, type: "unavailable_error" } }));
      }
      log({ kind: "error", where: "proxy", path: req.url, message: e.message });
    });
    upstream.end(body.length ? body : undefined);
  });
}

// ---- auth + routing ---------------------------------------------------------------
function authorized(req) {
  if (!cfg.LAMA_API_KEY) return true;
  return req.headers.authorization === `Bearer ${cfg.LAMA_API_KEY}`;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const readBody = () => new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      if (!b) return resolve({});
      try { resolve(JSON.parse(b)); } catch { reject(new Error("invalid JSON body")); }
    });
  });

  if (p === "/healthz") return send(200, { ok: true });
  if (!authorized(req)) return send(401, { error: { code: 401, message: "bad or missing bearer token", type: "authentication_error" } });

  if (p === "/api/status") {
    const health = await upstreamHealth();
    return send(200, {
      mgmt: { uptime_s: Math.round((Date.now() - T0) / 1000), node: process.version, db: cfg.LAMA_DB },
      llama: {
        health, base_url: LLAMA_ORIGIN, tls: LLAMA_TLS, uds: cfg.LAMA_UDS_SOCK || null,
        alias: cur.alias, model: cur.model, since: cur.since, expires_at: cur.expiresAt,
        pid: cur.pid, active: !!cur.child, mcp_config: engineMcpConfig() || null,
        version: engineVersion(),
      },
      mcp: { total: store.mcp.list().length, enabled: store.mcp.enabled().length },
      prompts: { total: store.prompts.list().length, resolved: store.prompts.resolve({}) },
    });
  }
  if (p === "/api/models") {
    const s = scanModels();
    const gw = gatewayModelState();
    const cat = await gatewayCatalogue();
    return send(200, {
      ...s,
      gateway: { ...gw, base_url: cfg.LAMA_GATEWAY_BASE_URL || null, catalogue: { configured: cat.configured, ok: cat.ok, url: cat.url, error: cat.error || null, count: cat.models.length, ids: cat.models.map((m) => m.id) } },
      models: s.models.map((m) => ({ ...m, gateway_mapped: gw.aliases.includes(m.name), mapping: mappingFor(m.name, gw.aliases, cat) })),
    });
  }
  if (p === "/api/metrics") return send(200, metrics());
  if (p === "/api/sync" && req.method === "POST") {
    const s = scanModels();
    log({ kind: "sync", count: s.models.length });
    return send(200, { synced_at: new Date().toISOString(), count: s.models.length, models: s.models, dirs: s.dirs });
  }
  if (p === "/api/map" && req.method === "POST") {
    const r = await mapToGateway(await readBody());
    return send(r.error ? 400 : 200, r);
  }
  if (p === "/api/engine-logs") {
    const n = Number(u.searchParams.get("n")) || 80;
    return send(200, engineLogTail(n));
  }
  if (p === "/api/preflight") return send(200, await preflight());
  if (p === "/api/runtime") return send(200, await runtimeSnapshot());
  if (p === "/api/config") {
    return send(200, {
      db: cfg.LAMA_DB, data_dir: DATA_DIR, bridge: BRIDGE,
      mcp_config: engineMcpConfig() || null, transports: TRANSPORTS,
      default_prompt: store.prompts.resolve({}), settings: store.settings.all(),
    });
  }

  // ---- MCP servers (DB-backed) ---------------------------------------------------
  if (p === "/api/mcp" && req.method === "GET") {
    return send(200, { servers: store.mcp.list(), transports: TRANSPORTS });
  }
  if (p === "/api/mcp/test" && req.method === "POST") {
    const body = await readBody();
    try {
      let merged = body;
      if (body.id) {
        const stored = store.mcp.get(Number(body.id), { secret: true });
        if (!stored) return send(404, { error: { message: `mcp server not found: ${body.id}` } });
        merged = { ...stored, ...body, api_key: body.api_key || stored.api_key };
      }
      const probe = await probeServer(merged);
      if (body.id) store.mcp.recordProbe(Number(body.id), probe);
      return send(200, probe);
    } catch (e) {
      return send(400, { ok: false, error: { message: e.message }, detail: e.message });
    }
  }
  if (p === "/api/mcp" && req.method === "POST") {
    const body = await readBody();
    try {
      const normalized = normalizeServer(body);
      let probe = null;
      if (body.test_first !== false) {
        probe = await probeServer(normalized);
        if (!probe.ok) {
          return send(400, {
            error: { message: `connection test failed — nothing stored: ${probe.detail}` },
            probe,
          });
        }
      }
      const created = store.mcp.create(normalized);
      if (probe) store.mcp.recordProbe(created.id, probe);
      const final = store.mcp.get(created.id);
      log({ kind: "mcp", action: "create", id: created.id, name: created.name, transport: created.transport, tested: Boolean(probe), ok: probe?.ok });
      return send(201, { ...final, probe });
    } catch (e) {
      return send(400, { error: { message: e.message } });
    }
  }
  if (p === "/api/mcp/apply" && req.method === "POST") {
    const enabled = store.mcp.enabled();
    const { configPath, json, specs } = writeEngineConfig(enabled, { dataDir: DATA_DIR, bridgePath: BRIDGE });
    let envUpdated = false, backup = null;
    try {
      if (fs.existsSync(cfg.LAMA_ENV_FILE)) {
        let text = fs.readFileSync(cfg.LAMA_ENV_FILE, "utf8");
        backup = `${cfg.LAMA_ENV_FILE}.bak.${Date.now()}`;
        fs.copyFileSync(cfg.LAMA_ENV_FILE, backup);
        if (/^LAMA_MCP_CONFIG=/m.test(text)) text = text.replace(/^LAMA_MCP_CONFIG=.*$/m, `LAMA_MCP_CONFIG=${configPath}`);
        else text += `${text.endsWith("\n") ? "" : "\n"}LAMA_MCP_CONFIG=${configPath}\n`;
        fs.writeFileSync(cfg.LAMA_ENV_FILE, text, { mode: 0o600 });
        envUpdated = true;
      }
    } catch (e) { log({ kind: "mcp", action: "env_write_failed", message: e.message }); }
    log({ kind: "mcp", action: "apply", config: configPath, servers: Object.keys(json.mcpServers), env_updated: envUpdated });
    return send(200, {
      config_path: configPath, servers: Object.keys(json.mcpServers),
      specs: specs.map((s) => s.name), env_updated: envUpdated, backup,
      reload_required: true, note: "load (or reload) the model so llama.cpp reads the new --mcp-servers-config",
    });
  }
  const mcpMatch = /^\/api\/mcp\/(\d+)(?:\/(test|probes|tools))?$/.exec(p);
  if (mcpMatch) {
    const id = Number(mcpMatch[1]);
    const sub = mcpMatch[2] || "";
    const row = store.mcp.get(id, { secret: true });
    if (!row) return send(404, { error: { message: `mcp server not found: ${id}` } });
    if (!sub && req.method === "GET") return send(200, store.mcp.get(id));
    if (!sub && req.method === "PATCH") {
      try { return send(200, store.mcp.update(id, await readBody())); }
      catch (e) { return send(400, { error: { message: e.message } }); }
    }
    if (!sub && req.method === "DELETE") return send(200, store.mcp.remove(id));
    if (sub === "test" && req.method === "POST") {
      const probe = await probeServer(row);
      store.mcp.recordProbe(id, probe);
      return send(200, probe);
    }
    if (sub === "probes" && req.method === "GET") {
      return send(200, { server: store.mcp.get(id), probes: store.mcp.probes(id) });
    }
    if (sub === "tools" && req.method === "GET") {
      return send(200, { server: store.mcp.get(id), tools: store.mcp.get(id)?.tools || [] });
    }
  }

  // ---- system prompts (immutable versions + bindings) ----------------------------
  if (p === "/api/prompts" && req.method === "GET") {
    return send(200, { prompts: store.prompts.list({ includeArchived: u.searchParams.get("all") === "1" }), resolved: store.prompts.resolve({ model: u.searchParams.get("model") || "" }) });
  }
  if (p === "/api/prompts" && req.method === "POST") {
    try { return send(201, store.prompts.create(await readBody())); }
    catch (e) { return send(400, { error: { message: e.message } }); }
  }
  const promptMatch = /^\/api\/prompts\/(\d+)(?:\/(versions|default|bind|archive))?$/.exec(p);
  if (promptMatch) {
    const id = Number(promptMatch[1]);
    const sub = promptMatch[2] || "";
    if (!store.prompts.get(id)) return send(404, { error: { message: `prompt not found: ${id}` } });
    if (!sub && req.method === "GET") return send(200, store.prompts.get(id));
    if (!sub && req.method === "PATCH") {
      try { return send(200, store.prompts.updateMeta(id, await readBody())); }
      catch (e) { return send(400, { error: { message: e.message } }); }
    }
    if (!sub && req.method === "DELETE") return send(200, store.prompts.archive(id));
    if (sub === "versions" && req.method === "POST") {
      try { return send(201, store.prompts.addVersion(id, await readBody())); }
      catch (e) { return send(400, { error: { message: e.message } }); }
    }
    if (sub === "default" && req.method === "POST") return send(200, store.prompts.setDefault(id));
    if (sub === "bind" && req.method === "POST") {
      try { return send(200, store.prompts.bind(id, await readBody())); }
      catch (e) { return send(400, { error: { message: e.message } }); }
    }
    if (sub === "archive" && req.method === "POST") return send(200, store.prompts.archive(id));
  }

  // ---- chat lab ------------------------------------------------------------------
  if (p === "/api/chat/test" && req.method === "POST") {
    return send(200, await chatTest(await readBody()));
  }
  if (p === "/api/chat/runs") {
    const n = Math.min(Math.max(Number(u.searchParams.get("limit")) || 50, 1), 500);
    return send(200, { runs: store.runs.list(n) });
  }
  if (p === "/api/chat/stats") return send(200, store.runs.stats());

  if (p === "/api/load" && req.method === "POST") {
    const r = await loadModel(await readBody());
    return send(r.error ? 409 : 200, r);
  }
  if (p === "/api/unload" && req.method === "POST") return send(200, await unloadModel());
  if (p === "/api/test" && req.method === "POST") {
    const { kind } = await readBody();
    const r = await runTest(String(kind || ""));
    log({ kind: "test", test: r.kind, ok: r.ok, ms: r.ms, detail: r.detail || r.what || "", model: r.model });
    return send(r.ok ? 200 : (String(r.detail || "").startsWith("skipped") ? 200 : 500), r);
  }
  if (p === "/api/download" && req.method === "POST") {
    const r = await downloadModel(await readBody());
    return send(r.error ? 502 : 200, r);
  }
  if (p === "/api/logs") {
    const n = Number(u.searchParams.get("n")) || 10;
    const lines = fs.existsSync(MGMT_LOG) ? fs.readFileSync(MGMT_LOG, "utf8").trim().split("\n").slice(-n) : [];
    return send(200, { lines });
  }
  if (p === "/api/requests") {
    const n = Number(u.searchParams.get("n")) || 10;
    let lines = [];
    if (fs.existsSync(MGMT_LOG)) {
      lines = fs.readFileSync(MGMT_LOG, "utf8").trim().split("\n")
        .filter((l) => l.includes('"kind":"request"')).slice(-n);
    }
    return send(200, { lines });
  }
  if (p === "/admin" || p === "/") {
    // The legacy HTML admin was removed; the current UI ships with the TypeScript manager.
    return send(410, { error: { code: 410, message: "legacy admin removed; use the current lama admin (npm start)", type: "gone_error" } });
  }
  if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
  if (PROXIED.some((re) => re.test(p))) return proxy(req, res);
  send(404, { error: { code: 404, message: "no such route — legacy manager, admin moved to npm start", type: "invalid_request_error" } });
});

server.listen(cfg.LAMA_MGMT_PORT, cfg.LAMA_MGMT_HOST, () => {
  log({ kind: "start", mgmt: `http://${cfg.LAMA_MGMT_HOST}:${cfg.LAMA_MGMT_PORT}`, llama_base: LLAMA_ORIGIN, llama_bin: cfg.LLAMA_BIN, tls: LLAMA_TLS, uds: cfg.LAMA_UDS_SOCK || null });
  process.stdout.write(`legacy lama manager on http://${cfg.LAMA_MGMT_HOST}:${cfg.LAMA_MGMT_PORT} (llama base ${LLAMA_ORIGIN}, tls=${LLAMA_TLS}, uds=${cfg.LAMA_UDS_SOCK || "off"})\n`);
});
