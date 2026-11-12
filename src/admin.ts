import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { adminAuthorized } from "./auth.ts";
import { streamAdminChat } from "./chat.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { liveTransport, resolveModel, type EngineManager, type EngineProgress } from "./engine.ts";
import { identityHeaders, type SystemIdentity } from "./identity.ts";
import { listLogFiles, ResponseLogger } from "./logging.ts";
import { ResponseCache } from "./cache.ts";
import { LocalIndex } from "./retrieval.ts";
import type {
  EngineTransport,
  LoadMode,
  McpTransport,
  ModelRow,
  OsInfo,
  RequestLogRow,
  TransportRow,
} from "./types.ts";
import { linkSocket, probeTransport, request } from "./transport/index.ts";
import { engineMcpConfig, mcpSummary, writeEngineMcpConfig } from "./mcp/config.ts";
import { probeStdio } from "./mcp/probe.ts";
import { MCP_TOOLS, TOOL_USE_CASES, callTool } from "./mcp/tools.ts";
import { ADAPTERS, adapterById, buildAdapterConfig } from "./adapters/registry.ts";
import { parseToolCalls } from "./tools/parser.ts";
import { buildTransportDocs, docsToMarkdown } from "./docs.ts";
import { buildIntegrationDocs, integrationToMarkdown } from "./integration.ts";
import { PROMPT_USAGE, promptMeta, readPromptFile, resetSystemPrompt, saveSystemPrompt } from "./prompt.ts";
import {
  clearToken as hfClearToken,
  downloadFile as hfDownloadFile,
  getToken as hfGetToken,
  listGgufFiles as hfListGgufFiles,
  maskToken as hfMaskToken,
  setToken as hfSetToken,
} from "./hf.ts";

export interface AdminContext {
  store: Store;
  cfg: Config;
  os: OsInfo;
  engine: EngineManager;
  /** Structured per-transport and per-model response log. */
  logger?: ResponseLogger | undefined;
  /** Proxy-layer response cache. */
  cache?: ResponseCache | undefined;
  /** Local corpus index: the model only sees the records it needs. */
  index?: LocalIndex | undefined;
}

export interface AdminRuntime {
  progress: EngineProgress | null;
}

function adminUiUrl(cfg: Config): string {
  return `http://${cfg.gatewayHost}:${cfg.gatewayPort}/admin`;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOAD_MODES = new Set<LoadMode>(["auto", "mmap", "none", "mlock", "mmap+mlock", "dio"]);
const MCP_TRANSPORTS = new Set<McpTransport>(["stdio", "http", "sse"]);
const PROTOCOLS = new Set<EngineTransport>(["http", "https", "uds"]);

function json(
  res: http.ServerResponse,
  status: number,
  value: unknown,
  extra: Record<string, string> = {},
): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(body);
}

function text(
  res: http.ServerResponse,
  status: number,
  value: string,
  type = "text/plain; charset=utf-8",
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": String(Buffer.byteLength(value)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(value);
}

function fail(res: http.ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  json(res, status, { error: { message, type: "admin_error" } }, extra);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  const parsed = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function boolParam(url: URL, name: string): boolean | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  if (/^(1|true|yes|ok)$/i.test(raw)) return true;
  if (/^(0|false|no|failed|fail)$/i.test(raw)) return false;
  return null;
}

function str(value: unknown, name: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${name} exceeds ${max} chars`);
  return trimmed;
}

function num(value: unknown, name: string, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function objectJson(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
  return JSON.stringify(value);
}

function staticFile(cfg: Config, pathname: string): string | null {
  if (pathname === "/" || pathname === "/admin" || pathname === "/admin/") {
    const file = path.join(cfg.webDir, "admin.html");
    return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
  }
  // The UI is mounted at /admin/, so its relative asset URLs arrive as
  // /admin/assets/... and must resolve inside webDir, not webDir/admin.
  const mountRelative = pathname.startsWith("/admin/") ? pathname.slice("/admin".length) : pathname;
  const relative = mountRelative.replace(/^\/+/, "");
  if (relative.includes("\0")) return null;
  const file = path.resolve(cfg.webDir, relative);
  const root = path.resolve(cfg.webDir);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json") || file.endsWith(".map")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".gif")) return "image/gif";
  if (file.endsWith(".ico")) return "image/x-icon";
  if (file.endsWith(".woff2")) return "font/woff2";
  if (file.endsWith(".woff")) return "font/woff";
  if (file.endsWith(".ttf")) return "font/ttf";
  if (file.endsWith(".otf")) return "font/otf";
  if (file.endsWith(".eot")) return "application/vnd.ms-fontobject";
  if (file.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function baseHeaders(identity: SystemIdentity): Record<string, string> {
  return identityHeaders(identity);
}

function findModel(store: Store, key: string | null | undefined): ModelRow | undefined {
  if (!key) return undefined;
  const direct = resolveModel(store, key);
  if (direct) return direct;
  const tail = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : "";
  return tail ? resolveModel(store, tail) : undefined;
}

function activeModel(store: Store): ModelRow | undefined {
  const state = store.engineState();
  return (
    (state.model_id ? store.getModel(state.model_id) : undefined) ??
    store.listModels().find((row) => row.enabled) ??
    store.listModels()[0]
  );
}

function activeAlias(store: Store): string {
  return activeModel(store)?.model_id ?? "model";
}

function resolveEndpoint(
  store: Store,
  cfg: Config,
  id: string | null | undefined,
): { id: string; protocol: EngineTransport; host: string | null; port: number | null; socket_path: string | null } {
  const row = id ? store.getTransport(id) : undefined;
  if (row) {
    if (row.id === "https" && row.protocol === "https" && !cfg.tls) {
      throw new Error(
        "invalid transport: engine-native TLS is disabled (LAMA_TLS=0); use http, uds, or the Caddy edge https://127.0.0.1:9931",
      );
    }
    const live = liveTransport(store, cfg, row);
    return { id: live.id, protocol: live.protocol, host: live.host, port: live.port, socket_path: live.socket_path };
  }
  const protocol: EngineTransport = id === "uds" || (!id && cfg.udsPath) ? "uds" : cfg.tls ? "https" : "http";
  if (protocol === "uds" && cfg.udsPath) {
    return { id: "uds", protocol: "uds", host: null, port: null, socket_path: cfg.udsPath };
  }
  return { id: protocol, protocol, host: cfg.engineHost, port: cfg.enginePort, socket_path: null };
}

function providerModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

function authHeaders(cfg: Config): Record<string, string> {
  const token = cfg.engineApiKey || cfg.apiKey;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<{ status: number; text: string; json: unknown; ms: number }> {
  const started = Date.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  return { status: response.status, text: body, json: parsed, ms: Date.now() - started };
}

async function probeDocument(ctx: AdminContext, id: string): Promise<{ ok: boolean; detail: string }> {
  const doc = ctx.store.getDocument(id);
  if (!doc) throw new Error("document not found");
  const transport = doc.transport_id ? ctx.store.getTransport(doc.transport_id) : undefined;
  if (!transport) throw new Error("document has no transport");
  const model = activeModel(ctx.store);
  if (!model) throw new Error("no model row to probe with");
  const health = await request(transport, "/health", { timeoutMs: 5000 }).catch((error: unknown) => ({
    status: 0,
    headers: {},
    text: error instanceof Error ? error.message : String(error),
  }));
  if (health.status !== 200) {
    return { ok: false, detail: `health HTTP ${health.status || "unreachable"}: ${health.text.slice(0, 200)}` };
  }
  if (doc.slug.includes("anthropic")) {
    const response = await request(transport, "/v1/messages", {
      timeoutMs: 60_000,
      body: { model: model.model_id, max_tokens: 8, messages: [{ role: "user", content: "Reply with ok." }] },
    }).catch((error: unknown) => ({
      status: 0,
      headers: {},
      text: error instanceof Error ? error.message : String(error),
    }));
    if (response.status !== 200) {
      return { ok: false, detail: `messages HTTP ${response.status || "unreachable"}: ${response.text.slice(0, 200)}` };
    }
    const parsed = JSON.parse(response.text) as { content?: unknown };
    if (!Array.isArray(parsed.content)) return { ok: false, detail: "messages response has no content array" };
    return { ok: true, detail: "health 200, messages 200, content array present" };
  }
  const response = await request(transport, "/v1/chat/completions", {
    timeoutMs: 60_000,
    body: { model: model.model_id, max_tokens: 8, temperature: 0, messages: [{ role: "user", content: "Reply with ok." }] },
  }).catch((error: unknown) => ({
    status: 0,
    headers: {},
    text: error instanceof Error ? error.message : String(error),
  }));
  if (response.status !== 200) {
    return { ok: false, detail: `chat HTTP ${response.status || "unreachable"}: ${response.text.slice(0, 200)}` };
  }
  const parsed = JSON.parse(response.text) as { choices?: unknown };
  if (!Array.isArray(parsed.choices)) return { ok: false, detail: "chat response has no choices array" };
  return { ok: true, detail: "health 200, chat 200, choices array present" };
}

function updateEnvFile(
  file: string,
  updates: Record<string, string>,
): { file: string; backup: string | null; keys: string[] } {
  const existed = fs.existsSync(file);
  const backup = existed ? `${file}.bak-${Date.now()}` : null;
  if (backup) fs.copyFileSync(file, backup);
  const lines = existed ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const output = lines.map((line) => {
    const eq = line.indexOf("=");
    if (eq <= 0 || line.trimStart().startsWith("#")) return line;
    const key = line.slice(0, eq).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) output.push(`${key}=${value}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${output.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
  return { file, backup, keys: Object.keys(updates) };
}

async function overview(ctx: AdminContext, identity: SystemIdentity): Promise<Record<string, unknown>> {
  const engine = await ctx.engine.status();
  const gatewayUrl = `http://${ctx.cfg.gatewayHost}:${ctx.cfg.gatewayPort}`;
  return {
    ok: true,
    service: "lama-gateway",
    identity,
    auth: {
      mode: ctx.cfg.apiAuth,
      admin_token_set: Boolean(ctx.cfg.adminToken),
      api_key_set: Boolean(ctx.cfg.apiKey),
    },
    config: {
      root: ctx.cfg.root,
      data_dir: ctx.cfg.dataDir,
      models_dir: ctx.cfg.modelsDir,
      web_dir: ctx.cfg.webDir,
      uds: ctx.cfg.udsPath,
      gateway_uds: ctx.cfg.gatewayUdsPath,
      admin: { url: adminUiUrl(ctx.cfg), mounted: true },
      engine: { host: ctx.cfg.engineHost, port: ctx.cfg.enginePort, url: ctx.cfg.engineUrl, uds: ctx.cfg.udsPath, transport: ctx.cfg.gatewayEngine },
      gateway: { host: ctx.cfg.gatewayHost, port: ctx.cfg.gatewayPort, url: gatewayUrl, origins: ctx.cfg.gatewayOrigins },
      tls: ctx.cfg.tls,
      tls_port: ctx.cfg.tlsPort,
      load_mode: ctx.cfg.loadMode,
      accel: ctx.cfg.accel,
      default_ttl_hours: ctx.cfg.defaultTtlHours,
    },
    gateway: { host: ctx.cfg.gatewayHost, port: ctx.cfg.gatewayPort, origins: ctx.cfg.gatewayOrigins },
    engine,
    counts: {
      models: ctx.store.listModels().length,
      providers: ctx.store.listProviders().length,
      transports: ctx.store.listTransports().length,
      sessions: ctx.store.listSessions().length,
      requests: ctx.store.requestStats(0).reduce((sum, row) => sum + row.total, 0),
      prompts: ctx.store.listPrompts().length,
      documents: ctx.store.listDocuments().length,
      mcp: ctx.store.listMcp().length,
      downloads: ctx.store.listDownloads().length,
    },
    requests: ctx.store.requestStats(24),
    series: ctx.store.requestSeries(24),
    recent: ctx.store.listRequests({ limit: 5 }),
    warnings: ctx.cfg.warnings,
  };
}

function requestFilter(url: URL): {
  limit: number;
  model_id?: string;
  transport_id?: string;
  protocol?: string;
  ok?: boolean;
} {
  const filter: {
    limit: number;
    model_id?: string;
    transport_id?: string;
    protocol?: string;
    ok?: boolean;
  } = { limit: intParam(url, "limit", 100, 1, 1000) };
  const model = url.searchParams.get("model_id");
  if (model) filter.model_id = model;
  const transport = url.searchParams.get("transport_id");
  if (transport) filter.transport_id = transport;
  const protocol = url.searchParams.get("protocol");
  if (protocol) filter.protocol = protocol;
  const ok = boolParam(url, "ok");
  if (ok !== null) filter.ok = ok;
  return filter;
}

function requestRow(row: RequestLogRow): RequestLogRow {
  return row;
}

function toolServer(store: Store, tool: string): string | null {
  return store.listMcpTools().find((row) => row.name === tool)?.mcp_id ?? null;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AdminContext,
  identity: SystemIdentity,
  runtime: AdminRuntime,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://admin.local");
  const method = req.method ?? "GET";
  const base = { ...baseHeaders(identity), ...extraHeaders };

  if (url.pathname === "/healthz" && method === "GET") {
    json(res, 200, { ok: true, service: "lama-gateway", admin: true, auth: ctx.cfg.apiAuth, version: identity.version }, base);
    return;
  }

  if (url.pathname.startsWith("/api/") && !adminAuthorized(req, ctx.cfg)) {
    fail(res, 401, "missing or invalid bearer token; the admin API always requires the operator token", base);
    return;
  }

  if (url.pathname === "/api/chat") {
    if (method !== "POST") {
      fail(res, 405, "use POST", base);
      return;
    }
    await streamAdminChat(req, res, { store: ctx.store, cfg: ctx.cfg, logger: ctx.logger }, base);
    return;
  }

  if (url.pathname === "/api/state" || url.pathname === "/api/overview") {
    if (method !== "GET") {
      fail(res, 405, "use GET", base);
      return;
    }
    json(res, 200, await overview(ctx, identity), base);
    return;
  }

  // ---------- requests ----------
  if (url.pathname === "/api/requests" && method === "GET") {
    const filter = requestFilter(url);
    const rows = ctx.store.listRequests(filter);
    const hours = intParam(url, "hours", 24, 0, 24 * 30);
    json(
      res,
      200,
      { ok: true, count: rows.length, requests: rows.map(requestRow), stats: ctx.store.requestStats(hours) },
      base,
    );
    return;
  }

  if (url.pathname === "/api/corpus" && method === "GET") {
    // The local corpus: what the proxy holds so the model never sees it all.
    json(
      res,
      200,
      {
        ok: true,
        stats: ctx.index?.stats() ?? { docs: 0, tokens: 0, postings: 0 },
        cache: ctx.cache?.stats() ?? null,
      },
      base,
    );
    return;
  }

  if (url.pathname === "/api/corpus/search" && method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      fail(res, 400, "q is required", base);
      return;
    }
    const limit = intParam(url, "limit", 2, 1, 20);
    const hits = ctx.index?.search(query, limit) ?? [];
    json(
      res,
      200,
      {
        ok: true,
        query,
        hits: hits.map((hit) => ({ id: hit.doc.id, score: hit.score, text: hit.doc.text, meta: hit.doc.meta ?? {} })),
      },
      base,
    );
    return;
  }

  if (url.pathname === "/api/corpus" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    const id = typeof input.id === "string" ? input.id.trim() : "";
    const text = typeof input.text === "string" ? input.text : "";
    if (!id || !text.trim()) {
      fail(res, 400, "id and text are required", base);
      return;
    }
    if (!ctx.index) {
      fail(res, 503, "the local index is not available", base);
      return;
    }
    const meta = input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)
      ? (input.meta as Record<string, unknown>)
      : undefined;
    // Only a real metadata object is attached; an absent one is left out.
    ctx.index.upsert(meta ? { id, text, meta } : { id, text });
    ctx.store.audit("corpus.upsert", id, `${text.length} chars`, "admin");
    json(res, 200, { ok: true, stats: ctx.index.stats() }, base);
    return;
  }

  if (url.pathname === "/api/logs" && method === "GET") {
    // The per-transport and per-model log files the manager writes.
    json(res, 200, { ok: true, logs: listLogFiles(ctx.cfg) }, base);
    return;
  }

  if (url.pathname === "/api/requests/stats" && method === "GET") {
    const hours = intParam(url, "hours", 24, 0, 24 * 30);
    json(res, 200, { ok: true, stats: ctx.store.requestStats(hours) }, base);
    return;
  }

  if (url.pathname === "/api/stats/transports" && method === "GET") {
    const hours = intParam(url, "hours", 24, 0, 24 * 30);
    json(res, 200, { ok: true, hours, stats: ctx.store.transportStats(hours) }, base);
    return;
  }

  if (url.pathname === "/api/adapters" && method === "GET") {
    json(
      res,
      200,
      {
        ok: true,
        adapters: ADAPTERS.map((adapter) => ({
          id: adapter.id,
          name: adapter.name,
          protocol: adapter.protocol,
          description: adapter.description,
          client_header: adapter.client_header,
        })),
      },
      base,
    );
    return;
  }

  if (url.pathname.startsWith("/api/adapters/") && method === "GET") {
    const id = decodeURIComponent(url.pathname.slice("/api/adapters/".length));
    const definition = adapterById(id);
    if (!definition) {
      fail(res, 404, `unknown adapter ${id}`, base);
      return;
    }
    const baseUrl = url.searchParams.get("base_url") || `http://${ctx.cfg.gatewayHost}:${ctx.cfg.gatewayPort}`;
    const model = url.searchParams.get("model") || activeAlias(ctx.store) || "default";
    const config = buildAdapterConfig(definition.id, { baseUrl, model, token: "<LAMA_ADMIN_TOKEN>" });
    json(res, 200, { ok: true, config }, base);
    return;
  }

  if (url.pathname === "/api/requests" && method === "DELETE") {
    const removed = ctx.store.clearRequests();
    ctx.store.audit("requests.clear", "all", `removed ${removed} request log rows`, "admin");
    json(res, 200, { ok: true, removed }, base);
    return;
  }

  const requestId = /^\/api\/requests\/(\d+)$/.exec(url.pathname);
  if (requestId && method === "DELETE") {
    const id = Number(requestId[1]);
    const removed = ctx.store.deleteRequest(id);
    if (removed === 0) {
      fail(res, 404, `request log ${id} not found`, base);
      return;
    }
    ctx.store.audit("request.delete", String(id), "removed one request log row", "admin");
    json(res, 200, { ok: true, id, removed }, base);
    return;
  }

  // ---------- sessions ----------
  if (url.pathname === "/api/sessions" && method === "GET") {
    json(res, 200, { ok: true, sessions: ctx.store.listSessions() }, base);
    return;
  }

  const sessionId = /^\/api\/sessions\/([A-Za-z0-9._:-]{1,128})$/.exec(url.pathname);
  if (sessionId) {
    const id = sessionId[1]!;
    if (method === "GET") {
      const session = ctx.store.getSession(id);
      if (!session) {
        fail(res, 404, `session ${id} not found`, base);
        return;
      }
      json(res, 200, { ok: true, session, messages: ctx.store.listSessionMessages(id) }, base);
      return;
    }
    if (method === "DELETE") {
      ctx.store.deleteSession(id);
      ctx.store.audit("session.delete", id, "removed session and messages", "admin");
      json(res, 200, { ok: true, id }, base);
      return;
    }
  }

  // ---------- engine ----------
  if (url.pathname === "/api/engine/status" && method === "GET") {
    json(res, 200, { ok: true, engine: await ctx.engine.status() }, base);
    return;
  }

  if (url.pathname === "/api/engine/relay" && method === "GET") {
    json(res, 200, await ctx.engine.relayStatus(), base);
    return;
  }

  if (url.pathname === "/api/engine/progress" && method === "GET") {
    json(
      res,
      200,
      { ok: true, progress: runtime.progress, engine: ctx.store.engineState() },
      base,
    );
    return;
  }

  if (url.pathname === "/api/engine/load" && method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    const key = typeof body.model_id === "string" ? body.model_id.trim() : "";
    if (!key) {
      fail(res, 400, "model_id is required", base);
      return;
    }
    const model = findModel(ctx.store, key);
    if (!model) {
      fail(res, 404, `model ${key} not found`, base);
      return;
    }
    const ttl = body.ttl_hours === undefined ? null : num(body.ttl_hours, "ttl_hours", 0, 0, 720);
    runtime.progress = null;
    const engine = await ctx.engine.start(model.id, ttl);
    ctx.store.audit("engine.load", model.id, `status=${engine.status}`, "admin");
    json(res, engine.status === "running" ? 200 : 500, { ok: engine.status === "running", engine }, base);
    return;
  }

  if (url.pathname === "/api/engine/unload" && method === "POST") {
    runtime.progress = null;
    const engine = await ctx.engine.stop();
    ctx.store.audit("engine.unload", engine.model_id ?? "", `status=${engine.status}`, "admin");
    json(res, 200, { ok: true, engine }, base);
    return;
  }

  if (url.pathname === "/api/engine/reload" && method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    const key = typeof body.model_id === "string" && body.model_id.trim() ? body.model_id.trim() : undefined;
    const model = key ? findModel(ctx.store, key) : undefined;
    if (key && !model) {
      fail(res, 404, `model ${key} not found`, base);
      return;
    }
    const ttl = body.ttl_hours === undefined ? undefined : num(body.ttl_hours, "ttl_hours", 0, 0, 720);
    runtime.progress = null;
    const engine = model ? await ctx.engine.reload(model.id, ttl) : await ctx.engine.reload(undefined, ttl);
    ctx.store.audit("engine.reload", engine.model_id ?? "", `status=${engine.status}`, "admin");
    json(res, engine.status === "running" ? 200 : 500, { ok: engine.status === "running", engine }, base);
    return;
  }

  // ---------- models ----------
  if (url.pathname === "/api/models" && method === "GET") {
    const provider = url.searchParams.get("provider_id");
    const models = provider
      ? ctx.store.listModels().filter((row) => row.provider_id === provider)
      : ctx.store.listModels();
    json(res, 200, { ok: true, models }, base);
    return;
  }

  if (url.pathname === "/api/models/discover" && method === "GET") {
    const registered = new Set(ctx.store.listModels().map((row) => row.path));
    const files: Array<{ file: string; name: string; id: string; bytes: number; registered: boolean }> = [];
    const scans: Array<{ dir: string; depth: number }> = [{ dir: ctx.cfg.modelsDir, depth: 0 }];
    while (scans.length > 0) {
      const item = scans.shift()!;
      if (item.depth > 2) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(item.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const file = path.join(item.dir, entry.name);
        if (entry.isDirectory()) {
          scans.push({ dir: file, depth: item.depth + 1 });
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
          const name = entry.name.replace(/\.gguf$/i, "");
          files.push({ file, name, id: slug(name), bytes: fs.statSync(file).size, registered: registered.has(file) });
        }
      }
    }
    json(res, 200, { ok: true, dir: ctx.cfg.modelsDir, files }, base);
    return;
  }

  if (url.pathname === "/api/models" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const id = slug(typeof input.id === "string" && input.id.trim() ? input.id : str(input.name, "name", 200));
      const existing = ctx.store.getModel(id);
      const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : existing?.name;
      if (!name) throw new Error("name is required for a new model");
      const providerId =
        typeof input.provider_id === "string" && input.provider_id.trim()
          ? input.provider_id.trim()
          : existing?.provider_id ?? "llamacpp";
      if (!ctx.store.getProvider(providerId)) throw new Error(`unknown provider_id: ${providerId}`);
      const modelKey =
        typeof input.model_id === "string" && input.model_id.trim()
          ? input.model_id.trim()
          : existing?.model_id ?? id;
      const clash = ctx.store
        .listModels()
        .find((row) => row.id !== id && row.provider_id === providerId && row.model_id === modelKey);
      if (clash) throw new Error(`model_id "${modelKey}" is already registered as "${clash.id}"; pick another alias`);
      const pathValue =
        typeof input.path === "string" && input.path.trim() ? input.path.trim() : existing?.path ?? "";
      if (!pathValue) throw new Error("path is required for a new model");
      if (!path.isAbsolute(pathValue) || !fs.existsSync(pathValue)) throw new Error("path must be an existing absolute file");
      if (!pathValue.toLowerCase().endsWith(".gguf")) throw new Error("path must point to a .gguf file");
      ctx.store.upsertModel({
        id,
        provider_id: providerId,
        name,
        model_id: modelKey,
        path: pathValue,
        context: num(input.context, "context", existing?.context ?? 4096, 256, 1_048_576),
        max_tokens: num(input.max_tokens, "max_tokens", existing?.max_tokens ?? 1024, 1, 1_048_576),
        temperature: num(input.temperature, "temperature", existing?.temperature ?? 0.7, 0, 2),
        quant: typeof input.quant === "string" ? input.quant : existing?.quant ?? null,
        load_mode:
          typeof input.load_mode === "string" && LOAD_MODES.has(input.load_mode as LoadMode)
            ? (input.load_mode as LoadMode)
            : existing?.load_mode ?? "auto",
        ttl_hours:
          input.ttl_hours === undefined || input.ttl_hours === ""
            ? existing?.ttl_hours ?? ctx.cfg.defaultTtlHours
            : num(input.ttl_hours, "ttl_hours", ctx.cfg.defaultTtlHours, 0, 720),
        enabled: input.enabled === false ? 0 : input.enabled === true ? 1 : existing?.enabled ?? 1,
        metadata_json: objectJson(input.metadata, existing?.metadata_json ?? "{}"),
      });
      ctx.store.audit("model.upsert", id, `${providerId} · alias=${ctx.store.getModel(id)?.model_id}`, "admin");
      json(res, 200, { ok: true, model: ctx.store.getModel(id) }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  const modelDelete = /^\/api\/models\/([A-Za-z0-9._:-]{1,128})$/.exec(url.pathname);
  if (modelDelete && method === "DELETE") {
    const id = modelDelete[1]!;
    if (ctx.store.engineState().model_id === id) {
      fail(res, 409, "unload the engine before deleting the active model", base);
      return;
    }
    ctx.store.deleteModel(id);
    ctx.store.audit("model.delete", id, "", "admin");
    json(res, 200, { ok: true }, base);
    return;
  }

  // ---------- providers ----------
  if (url.pathname === "/api/providers" && method === "GET") {
    const models = ctx.store.listModels();
    const providers = ctx.store.listProviders().map((row) => ({
      ...row,
      models_count: models.filter((model) => model.provider_id === row.id).length,
    }));
    json(res, 200, { ok: true, providers }, base);
    return;
  }

  if (url.pathname === "/api/providers" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const name = str(input.name, "name", 120);
      const id = slug(typeof input.id === "string" && input.id.trim() ? input.id : name);
      const existing = ctx.store.getProvider(id);
      const baseUrl =
        typeof input.base_url === "string" && input.base_url.trim()
          ? input.base_url.trim()
          : existing?.base_url ?? ctx.cfg.engineUrl;
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("base_url must be an http or https URL");
      }
      ctx.store.upsertProvider({
        id,
        name,
        kind: "llamacpp",
        base_url: baseUrl.replace(/\/+$/, ""),
        build: typeof input.build === "string" && input.build.trim() ? input.build.trim() : existing?.build ?? null,
        config_json: objectJson(input.config, existing?.config_json ?? "{}"),
        metadata_json: objectJson(input.metadata, existing?.metadata_json ?? "{}"),
      });
      ctx.store.audit("provider.upsert", id, baseUrl, "admin");
      json(res, 200, { ok: true, provider: ctx.store.getProvider(id) }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  const providerAction = /^\/api\/providers\/([A-Za-z0-9._:-]{1,128})\/(test|sync)$/.exec(url.pathname);
  if (providerAction && method === "POST") {
    const id = providerAction[1]!;
    const action = providerAction[2]!;
    const provider = ctx.store.getProvider(id);
    if (!provider) {
      fail(res, 404, `provider ${id} not found`, base);
      return;
    }
    try {
      const probe = await fetchJson(providerModelsUrl(provider.base_url), { headers: authHeaders(ctx.cfg) }, 15_000);
      if (action === "test") {
        const payload = probe.json as { data?: Array<{ id?: string }> } | null;
        const models = Array.isArray(payload?.data) ? payload.data.map((row) => row.id).filter(Boolean) : [];
        json(
          res,
          probe.status === 200 ? 200 : 502,
          {
            ok: probe.status === 200,
            status: probe.status,
            ms: probe.ms,
            models: models.length,
            detail: probe.status === 200 ? `${models.length} models` : probe.text.slice(0, 300),
          },
          base,
        );
        return;
      }
      if (probe.status !== 200) {
        fail(res, 502, `provider /v1/models returned HTTP ${probe.status}: ${probe.text.slice(0, 300)}`, base);
        return;
      }
      const payload = probe.json as { data?: Array<{ id?: string }> } | null;
      const ids = Array.isArray(payload?.data)
        ? [...new Set(payload.data.map((row) => row.id).filter((value): value is string => typeof value === "string" && value.length > 0))]
        : [];
      const existing = new Set(
        ctx.store.listModels().filter((row) => row.provider_id === provider.id).map((row) => row.model_id),
      );
      let created = 0;
      for (const modelId of ids) {
        if (existing.has(modelId)) continue;
        const rowId = slug(modelId);
        if (ctx.store.getModel(rowId)) continue;
        ctx.store.upsertModel({
          id: rowId,
          provider_id: provider.id,
          name: modelId,
          model_id: modelId,
          path: null,
          context: null,
          max_tokens: null,
          temperature: 0.7,
          quant: null,
          load_mode: "auto",
          ttl_hours: null,
          enabled: 0,
          metadata_json: JSON.stringify({ synced_from: provider.id, synced_at: new Date().toISOString() }),
        });
        created += 1;
      }
      ctx.store.audit("provider.sync", provider.id, `discovered=${ids.length} created=${created}`, "admin");
      json(res, 200, { ok: true, provider: provider.id, discovered: ids.length, created, skipped: ids.length - created }, base);
    } catch (error) {
      fail(res, 502, (error as Error).message, base);
    }
    return;
  }

  const providerDelete = /^\/api\/providers\/([A-Za-z0-9._:-]{1,128})$/.exec(url.pathname);
  if (providerDelete && method === "DELETE") {
    const id = providerDelete[1]!;
    if (ctx.store.listModels().some((row) => row.provider_id === id)) {
      fail(res, 409, "delete the provider's models first", base);
      return;
    }
    ctx.store.deleteProvider(id);
    ctx.store.audit("provider.delete", id, "", "admin");
    json(res, 200, { ok: true }, base);
    return;
  }

  // ---------- Hugging Face ----------
  if (url.pathname === "/api/hf/token" && method === "GET") {
    const token = hfGetToken(ctx.store);
    json(res, 200, { ok: true, set: Boolean(token), preview: token ? hfMaskToken(token) : null }, base);
    return;
  }

  if (url.pathname === "/api/hf/token" && method === "PUT") {
    try {
      const input = parseObject(await readBody(req));
      const token = str(input.token, "token", 4000);
      hfSetToken(ctx.store, token);
      ctx.store.audit("hf.token.set", hfMaskToken(token), "admin");
      json(res, 200, { ok: true, set: true, preview: hfMaskToken(token) }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  if (url.pathname === "/api/hf/token" && method === "DELETE") {
    hfClearToken(ctx.store);
    ctx.store.audit("hf.token.clear", "", "admin");
    json(res, 200, { ok: true, set: false }, base);
    return;
  }

  if (url.pathname === "/api/hf/files" && method === "GET") {
    const repo = (url.searchParams.get("repo") ?? "").trim();
    if (!repo) {
      fail(res, 400, "repo query parameter is required, e.g. ?repo=Qwen/Qwen2.5-0.5B-Instruct-GGUF", base);
      return;
    }
    try {
      const files = await hfListGgufFiles(repo, hfGetToken(ctx.store));
      json(res, 200, { ok: true, repo, files }, base);
    } catch (error) {
      fail(res, 502, (error as Error).message, base);
    }
    return;
  }

  if (url.pathname === "/api/hf/downloads" && method === "GET") {
    json(res, 200, { ok: true, downloads: ctx.store.listDownloads() }, base);
    return;
  }

  if (url.pathname === "/api/models/download" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const repo = str(input.repo, "repo", 300);
      const file = str(input.file, "file", 300);
      const token = hfGetToken(ctx.store);
      const row = ctx.store.startDownload(repo, file, path.join(ctx.cfg.modelsDir, path.basename(file)));
      json(res, 202, { ok: true, download: row }, base);
      void (async () => {
        let lastWrite = 0;
        try {
          const result = await hfDownloadFile(repo, file, ctx.cfg.modelsDir, token, (done, total) => {
            const stamp = Date.now();
            if (stamp - lastWrite < 1000) return;
            lastWrite = stamp;
            ctx.store.updateDownload(row.id, done, total);
          });
          ctx.store.finishDownload(row.id, result.path, result.bytes);
          ctx.store.audit("hf.download", `${repo}/${file}`, result.path, "admin");
        } catch (error) {
          ctx.store.failDownload(row.id, error instanceof Error ? error.message : String(error));
        }
      })();
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  // ---------- prompts (seeded rows are editable, never creatable) ----------
  if (url.pathname === "/api/prompts" && method === "GET") {
    json(
      res,
      200,
      {
        ok: true,
        prompts: ctx.store.listPrompts(),
        default_id: ctx.store.defaultPrompt()?.id ?? null,
        usage: PROMPT_USAGE,
      },
      base,
    );
    return;
  }

  const promptRoute = /^\/api\/prompts\/([A-Za-z0-9._:-]{1,128})$/.exec(url.pathname);
  if (promptRoute && method === "PUT") {
    const id = promptRoute[1]!;
    const existing = ctx.store.getPrompt(id);
    if (!existing) {
      fail(res, 404, `prompt ${id} not found; new prompts cannot be created from the admin`, base);
      return;
    }
    try {
      const input = parseObject(await readBody(req));
      const content = str(input.content, "content", 100_000);
      if (id === "system") {
        const saved = saveSystemPrompt(ctx.store, content, identity);
        ctx.store.audit("prompt.save", saved.id, `v${saved.version}`, "admin");
        json(res, 200, { ok: true, prompt: saved, usage: PROMPT_USAGE }, base);
        return;
      }
      ctx.store.upsertPrompt({
        id,
        name: existing.name,
        content,
        version: existing.version,
        is_default: existing.is_default,
        metadata_json: JSON.stringify({ ...JSON.parse(existing.metadata_json || "{}"), edited: true }),
      });
      ctx.store.audit("prompt.save", id, `v${ctx.store.getPrompt(id)?.version ?? "?"}`, "admin");
      json(res, 200, { ok: true, prompt: ctx.store.getPrompt(id) }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  const promptReset = /^\/api\/prompts\/([A-Za-z0-9._:-]{1,128})\/reset$/.exec(url.pathname);
  if (promptReset && method === "POST") {
    const id = promptReset[1]!;
    if (id !== "system") {
      fail(res, 400, "only the seeded system prompt has a source file to reset from", base);
      return;
    }
    const reset = resetSystemPrompt(ctx.store, ctx.cfg);
    ctx.store.audit("prompt.reset", "system", reset.action, "admin");
    json(
      res,
      200,
      { ok: true, ...promptMeta(reset.prompt, ctx.cfg), content: reset.prompt?.content ?? "", usage: PROMPT_USAGE },
      base,
    );
    return;
  }

  if (url.pathname === "/api/system-prompt" && method === "GET") {
    const prompt = ctx.store.getPrompt("system") ?? ctx.store.defaultPrompt();
    json(
      res,
      200,
      {
        ok: true,
        ...promptMeta(prompt, ctx.cfg),
        content: prompt?.content ?? "",
        usage: PROMPT_USAGE,
        file_content: readPromptFile(ctx.cfg)?.content ?? null,
      },
      base,
    );
    return;
  }

  if (url.pathname === "/api/system-prompt" && method === "PUT") {
    try {
      const input = parseObject(await readBody(req));
      const content = str(input.content, "content", 100_000);
      const saved = saveSystemPrompt(ctx.store, content, identity);
      ctx.store.audit("prompt.save", saved.id, `v${saved.version}`, "admin");
      json(res, 200, { ok: true, ...promptMeta(saved, ctx.cfg), content: saved.content, usage: PROMPT_USAGE }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  if (url.pathname === "/api/system-prompt/reset" && method === "POST") {
    const reset = resetSystemPrompt(ctx.store, ctx.cfg);
    ctx.store.audit("prompt.reset", "system", reset.action, "admin");
    json(
      res,
      200,
      { ok: true, ...promptMeta(reset.prompt, ctx.cfg), content: reset.prompt?.content ?? "", usage: PROMPT_USAGE },
      base,
    );
    return;
  }

  if (url.pathname === "/api/system-prompt.txt" && method === "GET") {
    const prompt = ctx.store.getPrompt("system") ?? ctx.store.defaultPrompt();
    text(res, 200, `${prompt?.content ?? ""}\n`, "text/markdown; charset=utf-8", base);
    return;
  }

  // ---------- MCP ----------
  if (url.pathname === "/api/mcp" && method === "GET") {
    const servers = ctx.store.listMcp().map(mcpSummary);
    json(res, 200, { ok: true, servers, mcp: servers }, base);
    return;
  }

  if (url.pathname === "/api/mcp" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const name = str(input.name, "name", 64);
      const id = slug(typeof input.id === "string" && input.id.trim() ? input.id : name);
      const existing = ctx.store.getMcp(id);
      const transport = (
        typeof input.transport === "string" && input.transport.trim()
          ? input.transport.trim()
          : existing?.transport ?? "stdio"
      ) as McpTransport;
      if (!MCP_TRANSPORTS.has(transport)) throw new Error("transport must be stdio, http or sse");
      const command = transport === "stdio" ? str(input.command ?? existing?.command, "command", 2000) : null;
      const urlValue =
        transport === "stdio"
          ? null
          : str(input.url ?? existing?.url, "url", 4000);
      const args = input.args === undefined ? JSON.parse(existing?.args_json ?? "[]") : input.args;
      if (!Array.isArray(args)) throw new Error("args must be an array");
      const env = input.env === undefined ? JSON.parse(existing?.env_json ?? "{}") : input.env;
      if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("env must be an object");
      ctx.store.upsertMcp({
        id,
        name,
        transport,
        command,
        args_json: JSON.stringify(args.map(String)),
        env_json: JSON.stringify(env),
        cwd:
          typeof input.cwd === "string"
            ? input.cwd
            : typeof existing?.cwd === "string"
              ? existing.cwd
              : null,
        url: urlValue,
        api_key_ref:
          typeof input.api_key_ref === "string"
            ? input.api_key_ref
            : existing?.api_key_ref ?? null,
        timeout_ms: num(input.timeout_ms, "timeout_ms", existing?.timeout_ms ?? 30_000, 1000, 600_000),
        enabled: input.enabled === false ? 0 : input.enabled === true ? 1 : existing?.enabled ?? 1,
        metadata_json: objectJson(input.metadata, existing?.metadata_json ?? "{}"),
      });
      const sync = writeEngineMcpConfig(ctx.store, ctx.cfg);
      ctx.store.audit("mcp.upsert", name, `transport=${transport} synced=${sync.count}`, "admin");
      json(res, 200, { ok: true, row: mcpSummary(ctx.store.getMcp(id)!), sync }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  const mcpProbe = /^\/api\/mcp\/([A-Za-z0-9._:-]{1,128})\/probe$/.exec(url.pathname);
  if (mcpProbe && method === "POST") {
    const row = ctx.store.getMcp(mcpProbe[1]!);
    if (!row) {
      fail(res, 404, "mcp server not found", base);
      return;
    }
    const result = await probeStdio(row);
    ctx.store.setMcpProbe(row.id, result.ok, result.detail, result.tools);
    ctx.store.audit("mcp.probe", row.name, result.detail, "admin");
    json(res, 200, { ...result, ok: result.ok, row: mcpSummary(ctx.store.getMcp(row.id)!) }, base);
    return;
  }

  const mcpToggle = /^\/api\/mcp\/([A-Za-z0-9._:-]{1,128})\/toggle$/.exec(url.pathname);
  if (mcpToggle && method === "POST") {
    const row = ctx.store.getMcp(mcpToggle[1]!);
    if (!row) {
      fail(res, 404, "mcp server not found", base);
      return;
    }
    let enabled = !row.enabled;
    try {
      const input = parseObject(await readBody(req));
      if (typeof input.enabled === "boolean") enabled = input.enabled;
    } catch {
      // An empty body means "flip".
    }
    ctx.store.upsertMcp({
      id: row.id,
      name: row.name,
      transport: row.transport,
      command: row.command,
      args_json: row.args_json,
      env_json: row.env_json,
      cwd: row.cwd,
      url: row.url,
      api_key_ref: row.api_key_ref,
      timeout_ms: row.timeout_ms,
      enabled: enabled ? 1 : 0,
      metadata_json: row.metadata_json,
    });
    const sync = writeEngineMcpConfig(ctx.store, ctx.cfg);
    ctx.store.audit("mcp.toggle", row.name, enabled ? "enabled" : "disabled", "admin");
    json(res, 200, { ok: true, row: mcpSummary(ctx.store.getMcp(row.id)!), sync }, base);
    return;
  }

  if (url.pathname === "/api/mcp/sync" && method === "POST") {
    const sync = writeEngineMcpConfig(ctx.store, ctx.cfg);
    ctx.store.audit("mcp.sync", "", `${sync.count} stdio servers`, "admin");
    json(res, 200, { ok: true, ...sync }, base);
    return;
  }

  if (url.pathname === "/api/mcp/config" && method === "GET") {
    const config = engineMcpConfig(ctx.store);
    const servers = config.mcpServers as Record<string, { command?: string; args?: string[] }>;
    json(
      res,
      200,
      {
        ok: true,
        path: path.join(ctx.cfg.dataDir, "mcp-servers.generated.json"),
        servers: Object.fromEntries(
          Object.entries(servers).map(([name, value]) => [name, { command: value.command, args: value.args ?? [] }]),
        ),
      },
      base,
    );
    return;
  }

  if (url.pathname === "/api/mcp/matrix" && method === "GET") {
    const usage = new Map(ctx.store.toolUsageStats().map((row) => [row.tool, row]));
    json(
      res,
      200,
      {
        ok: true,
        servers: ctx.store.listMcp().map(mcpSummary),
        tools: ctx.store.listMcpTools().map((tool) => {
          const server = ctx.store.getMcp(tool.mcp_id);
          const stats = usage.get(tool.name);
          return {
            ...tool,
            enabled: Boolean(tool.enabled),
            server: server ? server.name : tool.mcp_id,
            active: Boolean(server?.enabled) && server?.status === "active",
            calls: stats?.calls ?? 0,
            ok: stats?.ok ?? 0,
            failed: stats?.failed ?? 0,
            last_at: stats?.last_at ?? null,
            use_cases: tool.use_cases || TOOL_USE_CASES[tool.name] || "",
          };
        }),
      },
      base,
    );
    return;
  }

  const mcpToolToggle = /^\/api\/mcp\/tools\/([A-Za-z0-9._:-]{1,128})\/toggle$/.exec(url.pathname);
  if (mcpToolToggle && method === "POST") {
    const name = mcpToolToggle[1]!;
    const row = ctx.store.listMcpTools().find((tool) => tool.name === name);
    if (!row) {
      fail(res, 404, "mcp tool not found", base);
      return;
    }
    let enabled = !row.enabled;
    try {
      const input = parseObject(await readBody(req));
      if (typeof input.enabled === "boolean") enabled = input.enabled;
    } catch {
      // flip
    }
    ctx.store.toggleMcpTool(name, enabled);
    ctx.store.audit("mcp.tool.toggle", name, enabled ? "enabled" : "disabled", "admin");
    json(res, 200, { ok: true, tool: name, enabled }, base);
    return;
  }

  const mcpDelete = /^\/api\/mcp\/([A-Za-z0-9._:-]{1,128})$/.exec(url.pathname);
  if (mcpDelete && method === "DELETE") {
    const id = mcpDelete[1]!;
    ctx.store.deleteMcp(id);
    writeEngineMcpConfig(ctx.store, ctx.cfg);
    ctx.store.audit("mcp.delete", id, "", "admin");
    json(res, 200, { ok: true }, base);
    return;
  }

  // ---------- transports + docs ----------
  if (url.pathname === "/api/transports" && method === "GET") {
    json(res, 200, { ok: true, transports: ctx.store.listTransports() }, base);
    return;
  }

  if (url.pathname === "/api/transports" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const protocol = str(input.protocol, "protocol", 10) as EngineTransport;
      if (!PROTOCOLS.has(protocol)) throw new Error("protocol must be http, https or uds");
      const name = str(input.name, "name", 100);
      const id = slug(typeof input.id === "string" ? input.id : name);
      const existing = ctx.store.getTransport(id);
      ctx.store.upsertTransport({
        id,
        name,
        protocol,
        host: protocol === "uds" ? null : str(input.host ?? existing?.host ?? "127.0.0.1", "host", 200),
        port: protocol === "uds" ? null : num(input.port, "port", existing?.port ?? ctx.cfg.enginePort, 1, 65535),
        socket_path:
          protocol === "uds" ? str(input.socket_path ?? existing?.socket_path, "socket_path", 4000) : null,
        tls_key: typeof input.tls_key === "string" ? input.tls_key : existing?.tls_key ?? null,
        tls_cert: typeof input.tls_cert === "string" ? input.tls_cert : existing?.tls_cert ?? null,
        gateway_hint: typeof input.gateway_hint === "string" ? input.gateway_hint : existing?.gateway_hint ?? "",
        metadata_json: objectJson(input.metadata, existing?.metadata_json ?? "{}"),
      });
      ctx.store.audit("transport.upsert", id, protocol, "admin");
      json(res, 200, { ok: true, transport: ctx.store.getTransport(id) }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  if (url.pathname === "/api/transports/probe" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const transport = ctx.store.getTransport(str(input.id, "id", 100));
      if (!transport) throw new Error("transport not found");
      if (transport.id === "https" && transport.protocol === "https" && !ctx.cfg.tls) {
        throw new Error(
          "invalid transport: engine-native TLS is disabled (LAMA_TLS=0); use http, uds, or the Caddy edge https://127.0.0.1:9931",
        );
      }
      const model = activeModel(ctx.store);
      if (!model) throw new Error("no model row to probe with");
      const result = await probeTransport(transport, model.model_id, ctx.cfg.engineApiKey);
      ctx.store.audit("transport.probe", transport.id, result.detail, "admin");
      json(res, result.ok ? 200 : 502, { ...result, ok: result.ok }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  const linkSocketRoute = /^\/api\/transports\/([A-Za-z0-9._:-]{1,128})\/link-socket$/.exec(url.pathname);
  if (linkSocketRoute && method === "POST") {
    const transport = ctx.store.getTransport(linkSocketRoute[1]!);
    if (!transport) {
      fail(res, 404, "transport not found", base);
      return;
    }
    if (transport.protocol !== "uds" || !transport.socket_path) {
      fail(res, 400, "only UDS transports can be linked", base);
      return;
    }
    try {
      const result = linkSocket(transport.socket_path, ctx.cfg.gatewayDir);
      ctx.store.audit("transport.link_socket", transport.id, result.target, "admin");
      json(res, 200, { ok: true, ...result }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  if (url.pathname === "/api/docs/integration" && method === "GET") {
    const docs = buildIntegrationDocs(ctx.store, ctx.cfg, activeAlias(ctx.store));
    json(res, 200, docs, base);
    return;
  }

  if (url.pathname === "/api/docs/integration.md" && method === "GET") {
    const docs = buildIntegrationDocs(ctx.store, ctx.cfg, activeAlias(ctx.store));
    text(res, 200, integrationToMarkdown(docs), "text/markdown; charset=utf-8", base);
    return;
  }

  const transportDocs = /^\/api\/transports\/([A-Za-z0-9._:-]{1,128})\/docs(\.txt)?$/.exec(url.pathname);
  if (transportDocs && method === "GET") {
    const transport = ctx.store.getTransport(transportDocs[1]!);
    if (!transport) {
      fail(res, 404, "transport not found", base);
      return;
    }
    const docs = buildTransportDocs(ctx.store, ctx.cfg, transport, activeAlias(ctx.store));
    if (transportDocs[2]) {
      text(res, 200, docsToMarkdown(docs), "text/markdown; charset=utf-8", base);
      return;
    }
    json(res, 200, docs, base);
    return;
  }

  const transportDetail = /^\/api\/transports\/([A-Za-z0-9._:-]{1,128})$/.exec(url.pathname);
  if (transportDetail && method === "GET") {
    const transport = ctx.store.getTransport(transportDetail[1]!);
    if (!transport) {
      fail(res, 404, "transport not found", base);
      return;
    }
    const requests = ctx.store.listRequests({ transport_id: transport.id, limit: 100 });
    const totals = requests.reduce(
      (acc, row) => ({
        total: acc.total + 1,
        ok: acc.ok + (row.ok ? 1 : 0),
        failed: acc.failed + (row.ok ? 0 : 1),
        avg_ms: acc.avg_ms + row.duration_ms,
      }),
      { total: 0, ok: 0, failed: 0, avg_ms: 0 },
    );
    json(
      res,
      200,
      {
        ok: true,
        transport,
        documents: ctx.store.listDocuments().filter((doc) => doc.transport_id === transport.id),
        requests,
        stats: {
          total: totals.total,
          ok: totals.ok,
          failed: totals.failed,
          avg_ms: totals.total ? Math.round(totals.avg_ms / totals.total) : 0,
        },
      },
      base,
    );
    return;
  }

  // ---------- documents ----------
  if (url.pathname === "/api/documents" && method === "GET") {
    json(res, 200, { ok: true, documents: ctx.store.listDocuments() }, base);
    return;
  }

  if (url.pathname === "/api/documents" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const slugValue = slug(str(input.slug ?? input.title, "slug", 120));
      const title = str(input.title, "title", 200);
      const bodyText = str(input.body, "body", 100_000);
      const transportId =
        typeof input.transport_id === "string" && input.transport_id.trim() ? input.transport_id.trim() : null;
      if (transportId && !ctx.store.getTransport(transportId)) throw new Error("unknown transport_id");
      const existing = ctx.store.getDocumentBySlug(slugValue);
      ctx.store.upsertDocument({
        id: existing?.id ?? slugValue,
        slug: slugValue,
        title,
        transport_id: transportId,
        body: bodyText,
        verified_at: existing?.verified_at ?? null,
        metadata_json: objectJson(input.metadata, existing?.metadata_json ?? "{}"),
      });
      ctx.store.audit("document.upsert", slugValue, "", "admin");
      json(res, 200, { ok: true, document: ctx.store.getDocumentBySlug(slugValue) }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  const documentVerify = /^\/api\/documents\/([A-Za-z0-9._:-]{1,128})\/verify$/.exec(url.pathname);
  if (documentVerify && method === "POST") {
    const id = documentVerify[1]!;
    try {
      const result = await probeDocument(ctx, id);
      if (result.ok) ctx.store.markDocumentVerified(id, result.detail);
      else ctx.store.audit("document.verify_failed", id, result.detail, "admin");
      json(res, result.ok ? 200 : 502, { ...result, ok: result.ok }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  const documentDelete = /^\/api\/documents\/([A-Za-z0-9._:-]{1,128})$/.exec(url.pathname);
  if (documentDelete && method === "DELETE") {
    const id = documentDelete[1]!;
    const row = ctx.store.getDocument(id);
    if (!row) {
      fail(res, 404, "document not found", base);
      return;
    }
    ctx.store.deleteDocument(id);
    ctx.store.audit("document.delete", id, "", "admin");
    json(res, 200, { ok: true }, base);
    return;
  }

  // ---------- tools ----------
  if (url.pathname === "/api/tools" && method === "GET") {
    const stats = new Map(ctx.store.toolUsageStats().map((row) => [row.tool, row]));
    const switches = new Map(ctx.store.listMcpTools().map((row) => [row.name, row.enabled]));
    json(
      res,
      200,
      {
        ok: true,
        tools: MCP_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          schema: tool.inputSchema,
          enabled: switches.get(tool.name) === undefined ? true : Boolean(switches.get(tool.name)),
          calls: stats.get(tool.name)?.calls ?? 0,
          ok: stats.get(tool.name)?.ok ?? 0,
          failed: stats.get(tool.name)?.failed ?? 0,
          last_at: stats.get(tool.name)?.last_at ?? null,
          use_cases: TOOL_USE_CASES[tool.name] ?? "",
        })),
        stages: ["native", "marker", "json"],
      },
      base,
    );
    return;
  }

  if (url.pathname === "/api/tools/parse" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    const parseText = typeof input.text === "string" ? input.text : "";
    if (parseText.length > 200_000) {
      fail(res, 400, "text exceeds 200000 chars", base);
      return;
    }
    const result = parseToolCalls(parseText, MCP_TOOLS.map((tool) => tool.name), input.native);
    ctx.store.audit("tools.parse", `${result.calls.length} call(s)`, `${result.rejected.length} rejected`, "admin");
    json(res, 200, { ok: true, ...result }, base);
    return;
  }

  if (url.pathname === "/api/tools/call" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const name = str(input.name, "name", 64);
      if (!MCP_TOOLS.some((tool) => tool.name === name)) throw new Error(`unknown tool ${name}`);
      const switchRow = ctx.store.listMcpTools().find((tool) => tool.name === name);
      if (switchRow && !switchRow.enabled) throw new Error(`tool ${name} is disabled`);
      const args =
        input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
          ? (input.arguments as Record<string, unknown>)
          : {};
      const started = Date.now();
      try {
        const result = await callTool(name, args);
        const usage = ctx.store.logToolUsage({
          tool: name,
          mcp_id: toolServer(ctx.store, name),
          ok: true,
          duration_ms: Date.now() - started,
          detail: Object.keys(args).join(","),
        });
        ctx.store.audit("tools.call", name, Object.keys(args).join(","), "admin");
        json(res, 200, { ok: true, name, result, duration_ms: usage.duration_ms }, base);
      } catch (error) {
        const usage = ctx.store.logToolUsage({
          tool: name,
          mcp_id: toolServer(ctx.store, name),
          ok: false,
          duration_ms: Date.now() - started,
          detail: (error as Error).message,
        });
        ctx.store.audit("tools.call_failed", name, (error as Error).message, "admin");
        json(res, 500, { ok: false, error: { message: (error as Error).message, type: "tool_error" }, duration_ms: usage.duration_ms }, base);
      }
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  // ---------- service + config + auth + runtime ----------
  if (url.pathname === "/api/service/mode" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const mode = str(input.mode, "mode", 10);
      if (!["none", "user", "system"].includes(mode)) throw new Error("mode must be none, user or system");
      ctx.store.setSetting("service_mode", mode);
      const env = updateEnvFile(ctx.cfg.envFile, { LAMA_SERVICE_MODE: mode });
      ctx.store.audit("service.mode", mode, `env=${env.file}`, "admin");
      json(res, 200, { ok: true, mode, restart_required: true, backup: env.backup }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  if (url.pathname === "/api/config" && method === "GET") {
    json(
      res,
      200,
      {
        ok: true,
        auth: { mode: ctx.cfg.apiAuth },
        gateway: { host: ctx.cfg.gatewayHost, port: ctx.cfg.gatewayPort, origins: ctx.cfg.gatewayOrigins, uds: ctx.cfg.gatewayUdsPath, engine_transport: ctx.cfg.gatewayEngine },
        admin: { url: adminUiUrl(ctx.cfg), mounted: true },
        engine: { host: ctx.cfg.engineHost, port: ctx.cfg.enginePort, url: ctx.cfg.engineUrl },
        uds: ctx.cfg.udsPath,
        origins: ctx.cfg.gatewayOrigins,
        tls: ctx.cfg.tls,
        tls_port: ctx.cfg.tlsPort,
        load_mode: ctx.cfg.loadMode,
        accel: ctx.cfg.accel,
        service_mode: ctx.store.setting("service_mode") ?? ctx.cfg.serviceMode,
        default_ttl_hours: ctx.cfg.defaultTtlHours,
        env_file: ctx.cfg.envFile,
      },
      base,
    );
    return;
  }

  if (url.pathname === "/api/config/ports" && method === "GET") {
    json(
      res,
      200,
      {
        ok: true,
        gateway: { host: ctx.cfg.gatewayHost, port: ctx.cfg.gatewayPort, uds: ctx.cfg.gatewayUdsPath },
        admin: { url: adminUiUrl(ctx.cfg), mounted: true },
        engine: { host: ctx.cfg.engineHost, port: ctx.cfg.enginePort },
        tls_port: ctx.cfg.tlsPort,
        env_file: ctx.cfg.envFile,
      },
      base,
    );
    return;
  }

  if (url.pathname === "/api/config/ports" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const updates: Record<string, string> = {};
      const pairs: Array<[string, string]> = [
        ["gateway_port", "LAMA_GATEWAY_PORT"],
        ["engine_port", "LAMA_ENGINE_PORT"],
        ["tls_port", "LAMA_TLS_PORT"],
      ];
      for (const [field, key] of pairs) {
        if (input[field] === undefined) continue;
        updates[key] = String(num(input[field], field, 1, 1, 65535));
      }
      if (Object.keys(updates).length === 0) throw new Error("provide at least one of gateway_port, engine_port, tls_port");
      const seen = new Set<string>();
      for (const value of Object.values(updates)) {
        if (seen.has(value)) throw new Error("ports must be distinct");
        seen.add(value);
      }
      const env = updateEnvFile(ctx.cfg.envFile, updates);
      ctx.store.audit("config.ports", Object.keys(updates).join(","), `env=${env.file}`, "admin");
      json(res, 200, { ok: true, updated: updates, restart_required: true, backup: env.backup }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  if (url.pathname === "/api/auth" && method === "GET") {
    json(
      res,
      200,
      {
        ok: true,
        mode: ctx.cfg.apiAuth,
        token_required: ctx.cfg.apiAuth === "required",
        admin_token_set: Boolean(ctx.cfg.adminToken),
        api_key_set: Boolean(ctx.cfg.apiKey),
        origins: ctx.cfg.gatewayOrigins,
        env_file: ctx.cfg.envFile,
      },
      base,
    );
    return;
  }

  if (url.pathname === "/api/auth/mode" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const mode = str(input.mode, "mode", 20);
      const value = mode === "open" ? "false" : mode === "required" ? "true" : mode === "loopback" ? "" : null;
      if (value === null) throw new Error("mode must be open, loopback or required");
      const env = updateEnvFile(ctx.cfg.envFile, { LAMA_API_KEY: value });
      ctx.store.audit("auth.mode", mode, `env=${env.file}`, "admin");
      json(res, 200, { ok: true, mode, restart_required: true, backup: env.backup }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  if (url.pathname === "/api/auth/token" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const token = str(input.token, "token", 4000);
      if (token.length < 8) throw new Error("token must be at least 8 characters");
      const env = updateEnvFile(ctx.cfg.envFile, { LAMA_ADMIN_TOKEN: token });
      ctx.store.audit("auth.token.set", hfMaskToken(token), `env=${env.file}`, "admin");
      json(res, 200, { ok: true, preview: hfMaskToken(token), restart_required: true, backup: env.backup }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  if (url.pathname === "/api/runtime" && method === "GET") {
    const memory = process.memoryUsage();
    let disk: Record<string, number> | null = null;
    try {
      const stat = fs.statfsSync(ctx.cfg.root);
      disk = {
        block_size: stat.bsize,
        blocks: stat.blocks,
        free_blocks: stat.bfree,
        available_blocks: stat.bavail,
        total_bytes: stat.blocks * stat.bsize,
        free_bytes: stat.bfree * stat.bsize,
        available_bytes: stat.bavail * stat.bsize,
      };
    } catch {
      disk = null;
    }
    json(
      res,
      200,
      {
        ok: true,
        process: {
          pid: process.pid,
          uptime_s: Math.round(process.uptime()),
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cwd: process.cwd(),
          memory: {
            rss: memory.rss,
            heap_total: memory.heapTotal,
            heap_used: memory.heapUsed,
            external: memory.external,
          },
        },
        os: ctx.os,
        config: {
          load_mode: ctx.cfg.loadMode,
          accel: ctx.cfg.accel,
          tls: ctx.cfg.tls,
          service_mode: ctx.store.setting("service_mode") ?? ctx.cfg.serviceMode,
          default_ttl_hours: ctx.cfg.defaultTtlHours,
          models_dir: ctx.cfg.modelsDir,
          data_dir: ctx.cfg.dataDir,
          uds: ctx.cfg.udsPath,
        },
        engine: await ctx.engine.status(),
        relay: await ctx.engine.relayStatus(),
        progress: runtime.progress,
        disk,
      },
      base,
    );
    return;
  }

  if (url.pathname === "/api/test/probe" && method === "POST") {
    let input: Record<string, unknown>;
    try {
      input = parseObject(await readBody(req));
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
      return;
    }
    try {
      const rawBase =
        typeof input.base_url === "string" && input.base_url.trim()
          ? input.base_url.trim().replace(/\/+$/, "")
          : `http://${ctx.cfg.gatewayHost}:${ctx.cfg.gatewayPort}`;
      const parsed = new URL(rawBase);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("base_url must be an http or https URL");
      }
      const model =
        typeof input.model === "string" && input.model.trim() ? input.model.trim() : activeAlias(ctx.store);
      const protocol = input.protocol === "anthropic" ? "anthropic" : "openai";
      const token = ctx.cfg.apiKey || ctx.cfg.adminToken;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      const checks: Array<{ name: string; ok: boolean; status: number | null; ms: number; detail: string }> = [];

      const health = await fetchJson(`${rawBase}/healthz`, {}, 8000).catch((error: unknown) => ({
        status: 0,
        text: (error as Error).message,
        json: null,
        ms: 0,
      }));
      checks.push({
        name: "GET /healthz",
        ok: health.status === 200,
        status: health.status || null,
        ms: health.ms,
        detail: health.status === 200 ? "gateway answered" : health.text.slice(0, 300),
      });

      const state = await fetchJson(`${rawBase}/api/state`, { headers }, 8000).catch((error: unknown) => ({
        status: 0,
        text: (error as Error).message,
        json: null,
        ms: 0,
      }));
      checks.push({
        name: "GET /api/state",
        ok: state.status === 200,
        status: state.status || null,
        ms: state.ms,
        detail: state.status === 200 ? "gateway state readable" : state.text.slice(0, 300),
      });

      const models = await fetchJson(`${rawBase}/v1/models`, { headers }, 15_000).catch((error: unknown) => ({
        status: 0,
        text: (error as Error).message,
        json: null,
        ms: 0,
      }));
      const modelPayload = models.json as { data?: Array<{ id?: string }> } | null;
      const ids = Array.isArray(modelPayload?.data) ? modelPayload.data.map((row) => row.id).filter(Boolean) : [];
      checks.push({
        name: "GET /v1/models",
        ok: models.status === 200 && Array.isArray(modelPayload?.data),
        status: models.status || null,
        ms: models.ms,
        detail:
          models.status === 200
            ? `${ids.length} model(s): ${ids.slice(0, 5).join(", ")}`
            : models.text.slice(0, 300),
      });

      if (protocol === "anthropic") {
        const messages = await fetchJson(
          `${rawBase}/v1/messages`,
          {
            method: "POST",
            headers: { ...headers, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "Reply with ok." }] }),
          },
          60_000,
        ).catch((error: unknown) => ({ status: 0, text: (error as Error).message, json: null, ms: 0 }));
        const payload = messages.json as { content?: unknown } | null;
        checks.push({
          name: "POST /v1/messages",
          ok: messages.status === 200 && Array.isArray(payload?.content),
          status: messages.status || null,
          ms: messages.ms,
          detail:
            messages.status === 200
              ? "anthropic content blocks present"
              : messages.text.slice(0, 300),
        });
      } else {
        const chat = await fetchJson(
          `${rawBase}/v1/chat/completions`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              model,
              max_tokens: 8,
              temperature: 0,
              messages: [{ role: "user", content: "Reply with ok." }],
            }),
          },
          60_000,
        ).catch((error: unknown) => ({ status: 0, text: (error as Error).message, json: null, ms: 0 }));
        const payload = chat.json as { choices?: unknown } | null;
        checks.push({
          name: "POST /v1/chat/completions",
          ok: chat.status === 200 && Array.isArray(payload?.choices),
          status: chat.status || null,
          ms: chat.ms,
          detail:
            chat.status === 200
              ? "openai choices present"
              : chat.text.slice(0, 300),
        });
      }

      const ok = checks.every((check) => check.ok);
      ctx.store.audit("test.probe", `${rawBase} ${protocol}`, ok ? "PASS" : "FAIL", "admin");
      json(res, ok ? 200 : 502, { ok, base_url: rawBase, protocol, model, checks }, base);
    } catch (error) {
      fail(res, 400, (error as Error).message, base);
    }
    return;
  }

  if (url.pathname === "/api/audit" && method === "GET") {
    const limit = intParam(url, "limit", 100, 1, 500);
    json(res, 200, { ok: true, audit: ctx.store.listAudit(limit) }, base);
    return;
  }

  // ---------- static ----------
  if (method === "GET" && (url.pathname === "/" || url.pathname === "/admin" || url.pathname === "/admin/")) {
    const file = staticFile(ctx.cfg, url.pathname);
    if (!file) {
      fail(res, 404, `admin UI missing: ${path.join(ctx.cfg.webDir, "admin.html")}`, base);
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      "content-type": contentType(file),
      "content-length": String(body.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...base,
    });
    res.end(body);
    return;
  }

  if (method === "GET") {
    const file = staticFile(ctx.cfg, url.pathname);
    if (file) {
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        "content-type": contentType(file),
        "content-length": String(body.length),
        "cache-control": "no-store",
        ...base,
      });
      res.end(body);
      return;
    }
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  fail(res, 404, `no route for ${method} ${url.pathname}`, base);
}

export function createAdminRuntime(ctx: AdminContext): AdminRuntime {
  const runtime: AdminRuntime = { progress: null };
  ctx.engine.setProgressListener((event) => {
    runtime.progress = event;
  });
  return runtime;
}

/**
 * Mount the admin API and UI inside the gateway. The gateway already checked
 * the origin; this handler enforces the operator token on every /api route.
 */
export function handleAdminRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AdminContext,
  identity: SystemIdentity,
  runtime: AdminRuntime,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  return handle(req, res, ctx, identity, runtime, extraHeaders).catch((error: unknown) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    fail(res, 500, error instanceof Error ? error.message : String(error), extraHeaders);
  });
}
