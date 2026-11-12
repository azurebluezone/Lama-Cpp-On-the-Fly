#!/usr/bin/env node
/**
 * Integration proof for the DB + MCP layer.
 * Runs against fake transports (stdio/http/uds/openai/anthropic) and a real
 * manager instance on a throwaway port/DB. No live model needed:
 *   node server/test/integration.mjs
 * Exit 0 only when every assertion passes; prints PASS/FAIL per check.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../lib/db.mjs";
import { probeServer, writeEngineConfig, normalizeServer } from "../lib/mcp.mjs";
import { scanProcessMaps, buildRuntime, parseBuildInfo, parseBinaryVersion, versionMatch, engineCounters, parsePrometheus } from "../lib/runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const TMP = path.join("/tmp/opencode", `lama-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startStub(mode, target) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(HERE, "stub-servers.mjs"), mode, target], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const cleanup = () => { try { p.kill("SIGTERM"); } catch {} };
    process.on("exit", cleanup);
    p.stdout.on("data", (c) => {
      out += c;
      const m = /READY (\S+)/.exec(out);
      if (m) resolve({ proc: p, url: m[1] });
    });
    p.stderr.on("data", (c) => process.stderr.write(`[stub:${target}] ${c}`));
    p.on("error", reject);
    setTimeout(() => { cleanup(); reject(new Error(`stub ${target} did not become ready`)); }, 5000);
  });
}

async function rpcOverStdio(child, messages) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const replies = [];
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { replies.push(JSON.parse(line)); } catch {}
      }
      if (replies.length >= messages.filter((m) => m.id !== undefined).length) resolve(replies);
    });
    child.on("error", reject);
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
    setTimeout(() => resolve(replies), 5000);
  });
}

const httpStub = await startStub("http", "0");
const HTTP_BASE = httpStub.url;
const udsPath = path.join(TMP, "stub.sock");
const udsStub = await startStub("http", udsPath);

/* ---------------------------------------------------------------- store */
{
  const store = createStore(path.join(TMP, "store.db"));
  const p1 = store.prompts.create({ name: "Test Persona", content: "Be terse.", is_default: true, tags: ["test"] });
  check("db: prompt create v1", p1.versions_count === 1 && p1.current_version === 1);
  const p2 = store.prompts.addVersion(p1.id, { content: "Be terse and cite evidence.", note: "v2" });
  check("db: prompt versioning is append-only", p2.versions_count === 2 && p2.current_version === 2 && p2.content === "Be terse and cite evidence.");
  const resolved = store.prompts.resolve({});
  check("db: default prompt resolves", resolved?.version === 2, `version=${resolved?.version}`);
  const bound = store.prompts.bind(p1.id, { targetType: "model", targetId: "m1", priority: 1 });
  check("db: binding stored", bound.bindings.length === 1 && bound.bindings[0].target_type === "model");

  const m = store.mcp.create(normalizeServer({ name: "Stub MCP", transport: "http", url: HTTP_BASE + "/mcp", api_key: "secret-123" }));
  const listed = store.mcp.list();
  check("db: mcp secret masked in list", listed.length === 1 && !("api_key" in listed[0]) && listed[0].has_key === true);
  const probe = await probeServer(store.mcp.get(m.id, { secret: true }));
  store.mcp.recordProbe(m.id, probe);
  check("db: probe recorded + tools cached", store.mcp.get(m.id).status === "ok" && store.mcp.get(m.id).tools.length === 1, probe.detail);
  const run = store.runs.add({ model: "m1", format: "openai", status: "ok", latency_ms: 12, prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  check("db: chat run stored", store.runs.stats().totals.total_tokens === 7, `id=${run.id}`);
}

/* --------------------------------------------------------------- probes */
for (const [label, input] of [
  ["http mcp", { name: "h", transport: "http", url: HTTP_BASE + "/mcp", api_key: "k" }],
  ["uds mcp", { name: "u", transport: "uds", url: `unix://${udsPath}/mcp`, api_key: "k" }],
  ["openai api", { name: "o", transport: "openai", url: HTTP_BASE + "/v1", api_key: "k" }],
  ["anthropic api", { name: "a", transport: "anthropic", url: HTTP_BASE, api_key: "k" }],
  ["stdio mcp", { name: "s", transport: "stdio", command: process.execPath, args: [path.join(HERE, "stub-servers.mjs"), "stdio"] }],
]) {
  const r = await probeServer(input);
  check(`probe: ${label}`, r.ok === true, r.detail);
  check(`probe: ${label} latency measured`, Number.isFinite(r.latency_ms) && r.latency_ms >= 0, `${r.latency_ms}ms`);
}

/* --------------------------------------------------------------- bridge */
{
  const bridge = path.join(ROOT, "server", "lib", "bridge.mjs");
  const cases = [
    ["http", HTTP_BASE + "/mcp", "echo"],
    ["uds", `unix://${udsPath}/mcp`, "echo"],
    ["openai", HTTP_BASE + "/v1", "openai_chat"],
    ["anthropic", HTTP_BASE, "anthropic_messages"],
  ];
  for (const [transport, url, tool] of cases) {
    const specFile = path.join(TMP, `bridge-${transport}.json`);
    fs.writeFileSync(specFile, JSON.stringify({ name: transport, transport, url, apiKey: "k", headers: {}, timeout_ms: 8000 }));
    const child = spawn(process.execPath, [bridge, specFile], { stdio: ["pipe", "pipe", "pipe"] });
    const replies = await rpcOverStdio(child, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: { prompt: "ping", value: "x" } } },
    ]);
    child.kill("SIGTERM");
    const init = replies.find((r) => r.id === 1);
    const list = replies.find((r) => r.id === 2);
    const call = replies.find((r) => r.id === 3);
    check(`bridge: ${transport} initialize`, Boolean(init?.result?.serverInfo), JSON.stringify(init?.result?.serverInfo || init?.error));
    check(`bridge: ${transport} tools/list`, Boolean(list?.result?.tools?.length), `${list?.result?.tools?.length || 0} tool(s)`);
    check(`bridge: ${transport} tools/call`, Boolean(call?.result?.content?.[0]?.text), call?.result?.content?.[0]?.text || JSON.stringify(call?.error));
  }
}

/* ------------------------------------------------- engine config generated */
{
  const rows = [
    { id: 1, name: "direct", transport: "stdio", command: "node", args: ["x.js"], env: {}, enabled: 1, timeout_ms: 30000 },
    { id: 2, name: "remote", transport: "http", url: HTTP_BASE + "/mcp", api_key: "k", headers: {}, enabled: 1, timeout_ms: 30000 },
  ];
  const { configPath, json, specs } = writeEngineConfig(rows, { dataDir: TMP, bridgePath: path.join(ROOT, "server", "lib", "bridge.mjs") });
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  check("config: every engine entry has a command (llama.cpp requirement)",
    Object.values(cfg.mcpServers).every((s) => typeof s.command === "string" && s.command.length > 0),
    Object.keys(cfg.mcpServers).join(","));
  check("config: remote transport goes through the bridge", cfg.mcpServers.remote.args[0].endsWith("bridge.mjs"));
  check("config: secret lives in a 0600 spec, not the engine config",
    !JSON.stringify(cfg).includes("api_key") && (fs.statSync(specs[0].specFile).mode & 0o777) === 0o600);
}

/* ----------------------------------------------------- mmap truth source */
{
  const maps = [
    "710000000000-710070000000 r--s 00000000 08:13 3584823 /home/x/models/m.gguf",
    "710070000000-710071000000 rw-p 00000000 00:00 0 ",
    "710071000000-710071100000 r--s 00000000 08:13 3584823 /home/x/models/m.gguf (deleted)",
    "710080000000-710080100000 rw-s 00000000 00:00 0 /dev/shm/llama-kv",
  ].join("\n");
  const pm = scanProcessMaps(4242, "/home/x/models/m.gguf", maps);
  check("maps: /proc maps is the mmap source (shared vs private)",
    pm.mapped_regions === 2 && pm.shared_regions === 2 && pm.private_regions === 0,
    `${pm.mapped_regions} region(s), ${pm.shared_regions} shared, ${pm.private_regions} private`);
  check("maps: region sizes summed in MiB", pm.mapped_mib === 1793, `${pm.mapped_mib} MiB`);
  check("maps: /dev/shm segments counted separately", pm.shm_segments === 1, `${pm.shm_segments}`);

  const down = buildRuntime({
    health: "down", props: null, slots: null, prom: "",
    logText: "CPU_Mapped model buffer size = 100.0 MiB",
    alias: null, model: null, pid: null,
  });
  check("runtime: no pid → mmap null (not 0), log stays a hint",
    down.memory.source === null && down.memory.mapped_regions === null && down.memory.log_hint?.mapped_buffers === 1,
    JSON.stringify({ source: down.memory.source, regions: down.memory.mapped_regions, hint: down.memory.log_hint?.mapped_buffers, note: down.memory.note }));
}

/* ------------------------------------------------------- version + counters */
{
  const bin = parseBinaryVersion("version: 0.7.0-dev (build 11941, commit 19ff817fb)\nbuilt with Clang 22.1.8 for Linux x86_64");
  const props = parseBuildInfo("b11941-19ff817fb");
  check("version: /props.build_info split into build + commit", props.build === "11941" && props.commit === "19ff817fb", props.raw);
  check("version: llama --version parsed", bin.version === "0.7.0-dev" && bin.build === "11941" && bin.commit === "19ff817fb", bin.raw);
  check("version: the two sources are compared, not assumed equal", versionMatch(bin, props) === true);
  check("version: a different running build is reported as mismatch",
    versionMatch(bin, parseBuildInfo("b11000-abcdef1")) === false);

  const prom = parsePrometheus([
    "llamacpp:prompt_tokens_total 12",
    "llamacpp:prompt_tokens_seconds 41.5",
    "llamacpp:tokens_predicted_total 8",
    "llamacpp:tokens_predicted_seconds_total 2.8",
    "llamacpp:requests_processing 0",
  ].join("\n"));
  const c = engineCounters(prom);
  check("metrics: exact documented names — the *_seconds gauge is not a token count",
    c.prompt_tokens === 12 && c.completion_tokens === 8 && c.prompt_per_second === 41.5,
    JSON.stringify({ prompt: c.prompt_tokens, completion: c.completion_tokens, gauge: c.prompt_per_second }));
  check("metrics: undocumented KV gauge stays null, never 0", c.kv_cache_usage_ratio === null);
}

/* -------------------------------------------------------------- manager */
const envFile = path.join(TMP, ".env");
fs.writeFileSync(envFile, "LLAMA_BIN=/home/sahon/.local/bin/llama\nLAMA_DB=" + path.join(TMP, "lama.db") + "\n");
const manager = spawn(process.execPath, [path.join(ROOT, "server", "server.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    LAMA_MGMT_PORT: "9946", LAMA_LLAMA_PORT: "9947",
    LAMA_DB: path.join(TMP, "lama.db"), LAMA_LOG_DIR: path.join(TMP, "logs"),
    LAMA_MODELS_DIR: path.join(ROOT, "models"), LAMA_ENV_FILE: envFile,
    LAMA_DATA_DIR: path.join(TMP, "data"),
    LAMA_API_KEY: "", LAMA_MCP_CONFIG: "", LAMA_UDS_SOCK: "", LAMA_GATEWAY_ENV: "",
    LAMA_GATEWAY_BASE_URL: "", LAMA_SSL_KEY: "", LAMA_SSL_CERT: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let managerErr = "";
manager.stderr.on("data", (c) => { managerErr += c; });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`manager did not start: ${managerErr.slice(-500)}`)), 10000);
  manager.stdout.on("data", (c) => { if (String(c).includes("lama manager on")) { clearTimeout(t); resolve(); } });
  manager.on("exit", (code) => { clearTimeout(t); reject(new Error(`manager exited ${code}: ${managerErr.slice(-800)}`)); });
});

const BASE = "http://127.0.0.1:9946";
const api = async (p, init) => {
  const r = await fetch(BASE + p, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
};

{
  const cfg = await api("/api/config");
  check("manager: /api/config exposes db + transports", cfg.status === 200 && cfg.body.transports.includes("uds"), cfg.body.db);

  const okMcp = await api("/api/mcp", { method: "POST", body: JSON.stringify({ name: "Stub via manager", transport: "http", url: HTTP_BASE + "/mcp", api_key: "k" }) });
  check("manager: test-first MCP add returns 201", okMcp.status === 201 && okMcp.body.probe?.ok === true, okMcp.body.probe?.detail);

  const badMcp = await api("/api/mcp", { method: "POST", body: JSON.stringify({ name: "dead", transport: "http", url: "http://127.0.0.1:1/mcp" }) });
  check("manager: failed connection is not stored", badMcp.status === 400, badMcp.body.error?.message);

  const list = await api("/api/mcp");
  check("manager: list masks api_key", list.body.servers.length === 1 && list.body.servers[0].api_key === undefined && list.body.servers[0].has_key === true);

  const id = list.body.servers[0].id;
  const retest = await api(`/api/mcp/${id}/test`, { method: "POST", body: "{}" });
  check("manager: retest stored server", retest.status === 200 && retest.body.ok === true, retest.body.detail);

  const apply = await api("/api/mcp/apply", { method: "POST", body: "{}" });
  check("manager: apply writes engine config + .env", apply.status === 200 && apply.body.servers.length === 1 && apply.body.env_updated === true, apply.body.config_path);
  const envText = fs.readFileSync(envFile, "utf8");
  check("manager: .env points at generated config", envText.includes(`LAMA_MCP_CONFIG=${apply.body.config_path}`));

  const prompt = await api("/api/prompts", { method: "POST", body: JSON.stringify({ name: "Manager Persona", content: "v1 body", is_default: true }) });
  const pid = prompt.body.id;
  const v2 = await api(`/api/prompts/${pid}/versions`, { method: "POST", body: JSON.stringify({ content: "v2 body", note: "second" }) });
  check("manager: prompt version 2 created", v2.status === 201 && v2.body.current_version === 2, `version=${v2.body.current_version}`);
  const resolved = await api(`/api/prompts?model=x`);
  check("manager: default prompt resolves to v2", resolved.body.resolved?.version === 2, resolved.body.resolved?.content);

  const rt = await api("/api/runtime");
  check("manager: runtime reports engine down honestly", rt.status === 200 && rt.body.engine.state === "not-loaded" && rt.body.engine.health === "down");
  check("manager: down engine exposes no mmap numbers, only a note",
    rt.body.memory.source === null && rt.body.memory.mapped_regions === null && typeof rt.body.memory.note === "string",
    rt.body.memory.note);

  const st = await api("/api/status");
  const ver = st.body.llama?.version || {};
  check("manager: /api/status exposes the llama.cpp version with its source",
    typeof ver.source === "string" && ver.binary && "found" in ver.binary && "match" in ver,
    `${ver.binary?.raw || "(no binary)"} · ${ver.source}`);

  const models = await api("/api/models");
  check("manager: every model carries its gateway mapping id (llamacpp/<alias>)",
    Array.isArray(models.body.models) && models.body.models.every((m) => m.mapping?.slug === `llamacpp/${m.name}` && typeof m.mapping.state === "string"),
    `${models.body.models?.length || 0} model(s), catalogue ${models.body.gateway?.catalogue?.ok ? "ok" : "off"}`);

  const chat = await api("/api/chat/test", { method: "POST", body: JSON.stringify({ model: "ghost", format: "openai", prompt: "hi", max_tokens: 8 }) });
  check("manager: chat run failure is stored, not hidden", chat.body.ok === false && chat.body.run.status === "error", chat.body.run.error);
  const runs = await api("/api/chat/runs");
  check("manager: chat run visible in history", runs.body.runs.length >= 1);

  const admin = await fetch(BASE + "/admin");
  check("legacy manager: admin UI is gone (moved to the TypeScript app)", admin.status === 410);
}

manager.kill("SIGTERM");
httpStub.proc.kill("SIGTERM");
udsStub.proc.kill("SIGTERM");
await sleep(300);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (failed) {
  console.log(`FAILED: ${failed}`);
  process.exit(1);
}
process.exit(0);
