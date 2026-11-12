#!/usr/bin/env node
/**
 * MCP stdio bridge — the missing half of "all transports".
 *
 * llama.cpp can only spawn stdio MCP servers. This process *is* a stdio MCP
 * server (newline-delimited JSON-RPC on stdin/stdout) that forwards to:
 *   - http / sse : remote MCP over Streamable HTTP (SSE replies parsed)
 *   - uds        : the same JSON-RPC over a Unix domain socket
 *   - openai     : an OpenAI-compatible /v1/chat/completions API, exposed as
 *                  the MCP tool `openai_chat`
 *   - anthropic  : an Anthropic Messages API, exposed as `anthropic_messages`
 *
 * Usage: node bridge.mjs /path/to/spec.json   (spec written by the manager,
 * mode 0600, contains the API key — never logged, never on stdout).
 *
 * stdout is the protocol. Diagnostics go to stderr only.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const specPath = process.argv[2];
if (!specPath) {
  process.stderr.write("bridge: missing spec path\n");
  process.exit(2);
}
let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
} catch (e) {
  process.stderr.write(`bridge: cannot read spec: ${e.message}\n`);
  process.exit(2);
}

const log = (msg) => process.stderr.write(`[bridge:${spec.name}] ${msg}\n`);
const timeoutMs = Math.min(Math.max(Number(spec.timeout_ms) || 30000, 1000), 600000);

function headers() {
  const h = { accept: "application/json, text/event-stream", ...(spec.headers || {}) };
  if (spec.apiKey) {
    if (spec.transport === "anthropic") {
      if (!h["x-api-key"]) h["x-api-key"] = spec.apiKey;
      if (!h["anthropic-version"]) h["anthropic-version"] = "2023-06-01";
    } else if (!h.authorization && !h.Authorization) {
      h.authorization = `Bearer ${spec.apiKey}`;
    }
  }
  if (spec.transport === "anthropic" && !h["anthropic-version"]) h["anthropic-version"] = "2023-06-01";
  return h;
}

function request(url, { method = "GET", body, socketPath, timeout = timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`bad url: ${e.message}`)); }
    const mod = u.protocol === "https:" ? https : http;
    const payload = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const h = headers();
    if (payload) { h["content-type"] = "application/json"; h["content-length"] = payload.length; }
    const opts = socketPath
      ? { socketPath, path: u.pathname + u.search, method, headers: h }
      : { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method, headers: h };
    const req = mod.request(opts, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; if (text.length > 8 * 1024 * 1024) req.destroy(new Error("response too large")); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.end(payload || undefined);
  });
}

function rpcFrames(text) {
  const t = String(text || "").trim();
  const out = [];
  if (!t) return out;
  try { const j = JSON.parse(t); return Array.isArray(j) ? j : [j]; } catch {}
  for (const block of t.split(/\n\n/)) {
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!data || data === "[DONE]") continue;
    try { const j = JSON.parse(data); Array.isArray(j) ? out.push(...j) : out.push(j); } catch {}
  }
  return out;
}

/* ------------------------------------------------------------ remote MCP */
const uds = spec.transport === "uds" ? (() => {
  const m = /^unix:\/\/(.+)$/i.exec(spec.url || "");
  if (!m) return { socketPath: spec.url, path: "/" };
  const rest = m[1];
  const i = rest.indexOf(".sock");
  if (i === -1) return { socketPath: rest.replace(/\/+$/, ""), path: "/" };
  return { socketPath: rest.slice(0, i + 5), path: rest.slice(i + 5) || "/" };
})() : null;

const remote = { ready: false, sessionId: null, messageUrl: null, nextId: 1, pending: new Map() };

async function remoteRpc(method, params) {
  if (!remote.ready) await remoteInit();
  const id = remote.nextId++;
  const body = { jsonrpc: "2.0", id, method, params };
  const h = headers();
  if (remote.sessionId) h["mcp-session-id"] = remote.sessionId;
  const url = remote.messageUrl || (uds ? `http://localhost${uds.path}` : spec.url);
  const res = await request(url, { method: "POST", body, socketPath: uds?.socketPath });
  if (res.headers["mcp-session-id"]) remote.sessionId = res.headers["mcp-session-id"];
  if (res.status === 405 || res.status === 404) {
    await legacySse();
    if (remote.messageUrl) return remoteRpc(method, params);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`remote HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  if (res.status === 202 && method.startsWith("notifications/")) return { result: {} };
  const reply = rpcFrames(res.text).find((f) => f && f.id === id) || rpcFrames(res.text).find((f) => f && (f.result || f.error));
  if (!reply) throw new Error(`no JSON-RPC reply for ${method}`);
  if (reply.error) throw new Error(reply.error.message || JSON.stringify(reply.error));
  return { result: reply.result ?? {} };
}

async function remoteInit() {
  const body = {
    jsonrpc: "2.0", id: remote.nextId++, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, clientInfo: { name: "lama-bridge", version: "1.0.0" } },
  };
  const h = headers();
  const url = uds ? `http://localhost${uds.path}` : spec.url;
  const res = await request(url, { method: "POST", body, socketPath: uds?.socketPath });
  if (res.status === 405 || res.status === 404) {
    await legacySse();
    if (!remote.messageUrl) throw new Error(`remote rejected initialize (HTTP ${res.status})`);
    return remoteInit();
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`initialize HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  if (res.headers["mcp-session-id"]) remote.sessionId = res.headers["mcp-session-id"];
  const reply = rpcFrames(res.text).find((f) => f && (f.result || f.error));
  if (!reply || reply.error) throw new Error(`initialize failed: ${reply?.error?.message || "no reply"}`);
  // notification (no id) — servers that require it ignore the reply-less POST
  const nh = headers();
  if (remote.sessionId) nh["mcp-session-id"] = remote.sessionId;
  await request(url, { method: "POST", headers: nh, body: { jsonrpc: "2.0", method: "notifications/initialized" }, socketPath: uds?.socketPath })
    .catch(() => {});
  remote.ready = true;
}

/** Legacy HTTP+SSE (2024-11-05): GET stream announces the POST endpoint. */
async function legacySse() {
  if (remote.messageUrl || !spec.url) return;
  const base = uds ? `http://localhost${uds.path}` : spec.url;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { done = true; resolve(); };
    const req = httpOrHttps(base).request(base, { method: "GET", headers: { accept: "text/event-stream", ...(spec.headers || {}) }, socketPath: uds?.socketPath }, (res) => {
      if (!res.statusCode || res.statusCode >= 300) { finish(); return; }
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        const m = /event:\s*endpoint\s*\ndata:\s*(\S+)/.exec(buf) || /data:\s*(\/\S+)/.exec(buf);
        if (m) {
          try { remote.messageUrl = new URL(m[1], base).toString(); } catch { remote.messageUrl = m[1]; }
          if (remote.messageUrl.startsWith("/") && uds) remote.messageUrl = base.replace(/\/$/, "") + remote.messageUrl;
          finish();
          req.destroy();
        }
      });
      res.on("end", finish);
    });
    req.on("error", finish);
    req.setTimeout(3000, () => { finish(); req.destroy(); });
    req.end();
  });
}

function httpOrHttps(u) {
  try { return new URL(u).protocol === "https:" ? https : http; } catch { return http; }
}

async function listTools() {
  if (spec.transport === "openai" || spec.transport === "anthropic") {
    const isOpenAI = spec.transport === "openai";
    return {
      tools: [{
        name: isOpenAI ? "openai_chat" : "anthropic_messages",
        description: isOpenAI
          ? `Send a chat completion to the OpenAI-compatible endpoint behind ${spec.name}.`
          : `Send a Messages request to the Anthropic-compatible endpoint behind ${spec.name}.`,
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "User message to send" },
            system: { type: "string", description: "Optional system prompt" },
            model: { type: "string", description: "Model id (default: the endpoint's default)" },
            max_tokens: { type: "integer", description: "Maximum output tokens" },
          },
          required: ["prompt"],
        },
      }],
    };
  }
  const r = await remoteRpc("tools/list", {});
  return { tools: r.result?.tools || [] };
}

async function callTool(name, args) {
  if (spec.transport === "openai" || spec.transport === "anthropic") return callApiTool(name, args || {});
  const r = await remoteRpc("tools/call", { name, arguments: args || {} });
  const result = r.result || {};
  if (result.content) return { content: result.content, isError: Boolean(result.isError) };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

async function callApiTool(name, args) {
  const prompt = String(args.prompt ?? args.input ?? "");
  if (!prompt) throw new Error("prompt is required");
  const model = String(args.model || spec.model || "default");
  const maxTokens = Math.min(Math.max(Number(args.max_tokens) || 256, 1), 8192);
  const base = (spec.url || "").replace(/\/+$/, "");
  const v1 = (p) => (/\/v1$/.test(base) ? `${base}${p}` : `${base}/v1${p}`);
  if (spec.transport === "openai") {
    const body = { model, max_tokens: maxTokens, messages: [] };
    if (args.system) body.messages.push({ role: "system", content: String(args.system) });
    body.messages.push({ role: "user", content: prompt });
    const res = await request(v1("/chat/completions"), { method: "POST", body, socketPath: uds?.socketPath });
    if (res.status < 200 || res.status >= 300) throw new Error(`OpenAI HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    const j = rpcFrames(res.text)[0] || {};
    const text = j.choices?.[0]?.message?.content ?? JSON.stringify(j);
    return {
      content: [{ type: "text", text: String(text) }],
      structuredContent: { usage: j.usage || null, finish_reason: j.choices?.[0]?.finish_reason || null },
    };
  }
  const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  if (args.system) body.system = String(args.system);
  const res = await request(v1("/messages"), { method: "POST", body, socketPath: uds?.socketPath });
  if (res.status < 200 || res.status >= 300) throw new Error(`Anthropic HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  const j = rpcFrames(res.text)[0] || {};
  const text = Array.isArray(j.content) ? j.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : JSON.stringify(j);
  return {
    content: [{ type: "text", text: String(text) }],
    structuredContent: { usage: j.usage || null, stop_reason: j.stop_reason || null },
  };
}

/* -------------------------------------------------------------- stdio MCP */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log(`bad JSON from engine: ${line.slice(0, 120)}`); continue; }
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      let result;
      switch (msg.method) {
        case "initialize":
          result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: `lama-bridge:${spec.name}`, version: "1.0.0" } };
          break;
        case "notifications/initialized":
        case "notifications/cancelled":
          continue;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = await listTools();
          break;
        case "tools/call":
          result = await callTool(msg.params?.name, msg.params?.arguments);
          break;
        default:
          if (isNotification) continue;
          throw new Error(`unsupported method: ${msg.method}`);
      }
      if (!isNotification) send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      log(`error on ${msg.method}: ${e.message}`);
      if (!isNotification) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e.message } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
