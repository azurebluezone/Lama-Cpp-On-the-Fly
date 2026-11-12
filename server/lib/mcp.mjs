/**
 * MCP connection layer: validation, live connection probes and generation of
 * the Cursor-compatible config that llama.cpp consumes.
 *
 * Transport reality (verified against this llama.cpp build, 0.7.0-dev):
 *   - `--mcp-servers-config` only speaks **stdio**: every entry needs a
 *     `command`; entries without one are skipped ("has no command, skipping").
 *   - The engine's own API speaks OpenAI + Anthropic over HTTP/UDS. Remote
 *     MCP servers (http/sse/uds) and OpenAI/Anthropic APIs are therefore
 *     reached through `bridge.mjs`, a stdio MCP server that forwards JSON-RPC.
 *   - So the DB can store six transports; the engine config always ends up
 *     stdio (directly or via the bridge). No fake support claims.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";

export const TRANSPORTS = ["stdio", "http", "sse", "uds", "openai", "anthropic"];
const API_TRANSPORTS = new Set(["openai", "anthropic"]);
const REMOTE_MCP = new Set(["http", "sse", "uds"]);
export const needsBridge = (transport) => transport !== "stdio";

const trimSlash = (s) => String(s || "").trim().replace(/\/+$/, "");

export function parseJsonField(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON`); }
}

/** Normalize + validate an MCP server row coming from the admin form or JSON. */
export function normalizeServer(input = {}) {
  const name = String(input.name || "").trim();
  const transport = String(input.transport || "").trim().toLowerCase();
  if (!name) throw new Error("name is required");
  if (name.length > 64) throw new Error("name must be <= 64 chars");
  if (!TRANSPORTS.includes(transport)) throw new Error(`transport must be one of ${TRANSPORTS.join(", ")}`);

  const url = trimSlash(input.url);
  const command = String(input.command || "").trim();
  if (transport === "stdio" && !command) throw new Error("stdio transport needs a command");
  if (transport !== "stdio" && !url) throw new Error(`${transport} transport needs a url`);

  let args = parseJsonField(input.args, [], "args");
  if (!Array.isArray(args)) throw new Error("args must be a JSON array");
  args = args.map(String);

  const env = parseJsonField(input.env, {}, "env");
  const headers = parseJsonField(input.headers, {}, "headers");
  if (typeof env !== "object" || Array.isArray(env)) throw new Error("env must be a JSON object");
  if (typeof headers !== "object" || Array.isArray(headers)) throw new Error("headers must be a JSON object");

  const timeoutMs = Math.min(Math.max(Number(input.timeout_ms) || 30000, 1000), 600000);
  return {
    name,
    transport,
    url,
    api_key: String(input.api_key ?? ""),
    headers,
    command,
    args,
    env,
    cwd: String(input.cwd || "").trim(),
    timeout_ms: timeoutMs,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
  };
}

/** unix:///tmp/x.sock/mcp -> { socketPath, path }. Bare path -> path "/". */
export function parseUdsUrl(raw) {
  const s = String(raw || "");
  const m = /^unix:\/\/(.+)$/i.exec(s);
  if (!m) return { socketPath: s, path: "/" };
  const rest = m[1];
  const i = rest.indexOf(".sock");
  if (i === -1) return { socketPath: rest.replace(/\/+$/, ""), path: "/" };
  const socketPath = rest.slice(0, i + 5);
  const p = rest.slice(i + 5);
  return { socketPath, path: p || "/" };
}

/** Base URL + OpenAI-style path: /v1 is added only when the base lacks it. */
export function apiUrl(base, suffix) {
  const b = trimSlash(base);
  return /\/v1$/.test(b) ? `${b}${suffix}` : `${b}/v1${suffix}`;
}

function requestText(url, { method = "GET", headers = {}, body, timeoutMs = 15000, socketPath } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { accept: "application/json, text/event-stream", ...headers };
    if (payload) { h["content-type"] = "application/json"; h["content-length"] = payload.length; }
    const opts = socketPath
      ? { socketPath, path: u.pathname + u.search, method, headers: h }
      : { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method, headers: h };
    const req = mod.request(opts, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; if (text.length > 4 * 1024 * 1024) req.destroy(new Error("response too large")); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end(payload || undefined);
  });
}

/** Parse JSON-RPC frames from a JSON body or an SSE body. */
export function parseRpcFrames(text) {
  const frames = [];
  const t = String(text || "").trim();
  if (!t) return frames;
  try {
    const j = JSON.parse(t);
    return Array.isArray(j) ? j : [j];
  } catch {}
  for (const block of t.split(/\n\n/)) {
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!data || data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      if (Array.isArray(j)) frames.push(...j); else frames.push(j);
    } catch {}
  }
  return frames;
}

const INIT = {
  protocolVersion: "2024-11-05",
  capabilities: { tools: {} },
  clientInfo: { name: "lama-manager", version: "1.0.0" },
};

function authHeaders(s) {
  const h = { ...s.headers };
  if (s.api_key) {
    if (s.transport === "anthropic") {
      if (!h["x-api-key"]) h["x-api-key"] = s.api_key;
      if (!h["anthropic-version"]) h["anthropic-version"] = "2023-06-01";
    } else if (!h.authorization && !h.Authorization) {
      h.authorization = `Bearer ${s.api_key}`;
    }
  }
  if (s.transport === "anthropic" && !h["anthropic-version"]) h["anthropic-version"] = "2023-06-01";
  return h;
}

async function rpcCall(s, method, params, { id = 1, timeoutMs = s.timeout_ms || 15000, sessionId } = {}) {
  const headers = authHeaders(s);
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const body = { jsonrpc: "2.0", id, method, params };
  const socketPath = s.transport === "uds" ? parseUdsUrl(s.url).socketPath : undefined;
  const url = s.transport === "uds" ? `http://localhost${parseUdsUrl(s.url).path}` : s.url;
  const res = await requestText(url, { method: "POST", headers, body, timeoutMs, socketPath });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}: ${String(res.text || "").slice(0, 200)}`);
  }
  const frames = parseRpcFrames(res.text);
  const reply = frames.find((f) => f && f.id === id) || frames.find((f) => f && (f.result || f.error));
  if (!reply) throw new Error(`no JSON-RPC reply for ${method}`);
  if (reply.error) throw new Error(`${method} error: ${reply.error.message || JSON.stringify(reply.error)}`);
  return { result: reply.result, sessionId: res.headers["mcp-session-id"] };
}

async function probeStdio(s, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(s.command, s.args, {
        cwd: s.cwd || undefined,
        env: { ...process.env, ...s.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({ ok: false, latency_ms: Date.now() - started, detail: `spawn failed: ${e.message}`, tools: [] });
    }
    let buf = "", err = "", settled = false, initialized = false, tools = [];
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch {}
      resolve({ ok, latency_ms: Date.now() - started, detail, tools });
    };
    const timer = setTimeout(() => finish(false, `timeout after ${timeoutMs}ms${err ? `: ${err.slice(-200)}` : ""}`), timeoutMs);

    const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch {} };
    child.on("error", (e) => finish(false, `spawn failed: ${e.message}`));
    child.on("exit", (code) => { if (!settled) finish(false, `process exited (code ${code})${err ? `: ${err.slice(-200)}` : ""}`); });
    child.stderr.on("data", (c) => { err += c.toString(); if (err.length > 4000) err = err.slice(-4000); });
    child.stdout.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          initialized = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (msg.id === 1 && msg.error) {
          finish(false, `initialize error: ${msg.error.message || JSON.stringify(msg.error)}`);
        } else if (msg.id === 2 && msg.result) {
          tools = (msg.result.tools || []).map((t) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || {} }));
          finish(true, `stdio handshake ok · ${tools.length} tool(s)`);
        } else if (msg.id === 2 && msg.error) {
          finish(false, `tools/list error: ${msg.error.message || JSON.stringify(msg.error)}`);
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
  });
}

async function probeRemoteMcp(s, timeoutMs) {
  const started = Date.now();
  let sessionId;
  try {
    const init = await rpcCall(s, "initialize", INIT, { id: 1, timeoutMs });
    sessionId = init.sessionId;
    const list = await rpcCall(s, "tools/list", {}, { id: 2, timeoutMs, sessionId });
    const tools = (list.result?.tools || []).map((t) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || {} }));
    return {
      ok: true, latency_ms: Date.now() - started,
      detail: `${s.transport} MCP handshake ok · ${tools.length} tool(s)`,
      tools, session: Boolean(sessionId),
    };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - started, detail: `${s.transport} MCP probe failed: ${e.message}`, tools: [] };
  }
}

async function probeApi(s, timeoutMs) {
  const started = Date.now();
  const headers = authHeaders(s);
  const socketPath = s.transport === "uds" ? parseUdsUrl(s.url).socketPath : undefined;
  const base = s.transport === "uds" ? `http://localhost${parseUdsUrl(s.url).path}` : s.url;
  try {
    if (s.transport === "openai") {
      const r = await requestText(apiUrl(base, "/models"), { headers, timeoutMs, socketPath });
      if (r.status >= 200 && r.status < 300) {
        const j = parseRpcFrames(r.text)[0] || {};
        const n = Array.isArray(j.data) ? j.data.length : 0;
        return { ok: true, latency_ms: Date.now() - started, detail: `OpenAI /v1/models ok · ${n} model(s)`, tools: [] };
      }
      if (r.status === 401 || r.status === 403) throw new Error(`HTTP ${r.status} — API key rejected`);
      // Some gateways only implement chat; prove it with a 1-token call.
      const c = await requestText(apiUrl(base, "/chat/completions"), {
        method: "POST", headers, timeoutMs, socketPath,
        body: { model: "default", max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
      });
      if (c.status >= 200 && c.status < 300) {
        return { ok: true, latency_ms: Date.now() - started, detail: `OpenAI chat/completions ok (no /models) · HTTP ${c.status}`, tools: [] };
      }
      throw new Error(`models HTTP ${r.status}, chat HTTP ${c.status}`);
    }
    // anthropic
    const r = await requestText(apiUrl(base, "/models"), { headers, timeoutMs, socketPath });
    if (r.status >= 200 && r.status < 300) {
      const j = parseRpcFrames(r.text)[0] || {};
      const n = Array.isArray(j.data) ? j.data.length : 0;
      return { ok: true, latency_ms: Date.now() - started, detail: `Anthropic /v1/models ok · ${n} model(s)`, tools: [] };
    }
    if (r.status === 401 || r.status === 403) throw new Error(`HTTP ${r.status} — API key rejected`);
    const c = await requestText(apiUrl(base, "/messages"), {
      method: "POST", headers, timeoutMs, socketPath,
      body: { model: "default", max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    });
    if (c.status >= 200 && c.status < 300) {
      return { ok: true, latency_ms: Date.now() - started, detail: `Anthropic messages ok (no /models) · HTTP ${c.status}`, tools: [] };
    }
    throw new Error(`models HTTP ${r.status}, messages HTTP ${c.status}`);
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - started, detail: `${s.transport} probe failed: ${e.message}`, tools: [] };
  }
}

/** Live connection test. Nothing is written by this function. */
export async function probeServer(input, { timeoutMs } = {}) {
  const s = normalizeServer(input);
  const t = Math.min(Number(timeoutMs) || (s.transport === "stdio" ? 12000 : 15000), 60000);
  if (s.transport === "stdio") return probeStdio(s, t);
  if (REMOTE_MCP.has(s.transport)) return probeRemoteMcp(s, Math.min(t, s.timeout_ms || t));
  return probeApi(s, t);
}

/**
 * Write the engine config + per-server bridge specs from DB rows.
 * Returns { configPath, json, specs } — secrets only live in 0600 spec files.
 */
export function writeEngineConfig(servers, { dataDir, bridgePath }) {
  const mcpDir = path.join(dataDir, "mcp");
  fs.mkdirSync(mcpDir, { recursive: true, mode: 0o700 });
  const out = { mcpServers: {} };
  const specs = [];
  for (const s of servers) {
    if (!s.enabled) continue;
    if (s.transport === "stdio") {
      const entry = { command: s.command, args: s.args || [], timeout_ms: s.timeout_ms || 30000 };
      if (s.cwd) entry.cwd = s.cwd;
      if (s.env && Object.keys(s.env).length) entry.env = s.env;
      out.mcpServers[s.name] = entry;
      continue;
    }
    const specFile = path.join(mcpDir, `${s.id}.json`);
    const spec = {
      name: s.name, transport: s.transport, url: s.url,
      apiKey: s.api_key || "", headers: s.headers || {},
      timeout_ms: s.timeout_ms || 30000,
    };
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2) + "\n", { mode: 0o600 });
    specs.push({ name: s.name, specFile });
    out.mcpServers[s.name] = {
      command: process.execPath,
      args: [bridgePath, specFile],
      timeout_ms: s.timeout_ms || 30000,
    };
  }
  const configPath = path.join(dataDir, "mcp-servers.generated.json");
  fs.writeFileSync(configPath, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  return { configPath, json: out, specs };
}

/** Map DB rows to bridge-friendly specs (same shape as the spec files). */
export function bridgeSpec(s) {
  return {
    name: s.name, transport: s.transport, url: s.url,
    apiKey: s.api_key || "", headers: s.headers || {},
    timeout_ms: s.timeout_ms || 30000,
  };
}

export function serverSummary(s) {
  return {
    id: s.id, name: s.name, transport: s.transport,
    target: s.transport === "stdio" ? `${s.command} ${(s.args || []).join(" ")}`.trim() : s.url,
    enabled: !!s.enabled, status: s.status,
  };
}
