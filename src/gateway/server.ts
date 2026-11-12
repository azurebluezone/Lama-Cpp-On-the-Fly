import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { authorized, header, sessionId } from "../auth.ts";
import type { Store } from "../db.ts";
import { liveTransport, resolveModel, type EngineManager } from "../engine.ts";
import { identityHeaders, loadIdentity, packageVersion, PROTOCOL, type SystemIdentity } from "../identity.ts";
import type { OsInfo, RequestLogInput, TransportRow } from "../types.ts";
import { openStream, request, type RequestOptions } from "../transport/index.ts";
import { detectMcpTools, ResponseLogger } from "../logging.ts";
import { cacheKey, ResponseCache } from "../cache.ts";
import { LocalIndex } from "../retrieval.ts";
import {
  anthropicAssistantText,
  anthropicDelta,
  anthropicUsage,
} from "../transport/anthropic.ts";
import { openaiAssistantText, openaiDelta, openaiUsage } from "../transport/openai.ts";
import {
  createAdminRuntime,
  handleAdminRequest,
  type AdminRuntime,
} from "../admin.ts";
import { detectAdapter } from "../adapters/registry.ts";

export interface GatewayContext {
  store: Store;
  cfg: Config;
  os: OsInfo;
  engine: EngineManager;
  /** Structured per-transport and per-model response log. */
  logger?: ResponseLogger | undefined;
  /** Proxy-layer response cache: an identical repeat never reaches the engine. */
  cache?: ResponseCache | undefined;
  /** Local corpus index: the model only ever sees the records it needs. */
  index?: LocalIndex | undefined;
  /** Listener that accepted the request: http, https or uds. */
  transportId?: string;
  /** Shared admin runtime when TCP and UDS listeners are mounted together. */
  adminRuntime?: AdminRuntime;
}

const CORS_ALLOW_HEADERS = [
  "authorization",
  "content-type",
  "x-api-key",
  "x-session-id",
  "x-lama-client",
  "anthropic-version",
  "x-request-id",
].join(", ");

const CORS_EXPOSE_HEADERS = [
  "x-session-id",
  "x-request-id",
  "x-system-identity",
  "x-system-version",
  "x-system-owner",
  "x-gateway-upstream",
].join(", ");

const MAX_BODY_BYTES = 16 * 1024 * 1024;

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

function corsHeaders(req: http.IncomingMessage, cfg: Config): Record<string, string> {
  const origin = header(req, "origin");
  if (!origin || !cfg.gatewayOrigins.includes(origin)) return {};
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": CORS_ALLOW_HEADERS,
    "access-control-expose-headers": CORS_EXPOSE_HEADERS,
    "access-control-max-age": "600",
  };
  if (header(req, "access-control-request-private-network") === "true") {
    headers["access-control-allow-private-network"] = "true";
  }
  return headers;
}

function preflight(req: http.IncomingMessage, res: http.ServerResponse, cfg: Config): boolean {
  if (req.method !== "OPTIONS") return false;
  const headers = corsHeaders(req, cfg);
  if (!headers["access-control-allow-origin"]) {
    json(res, 403, { error: { message: "origin is not allowed", type: "cors" } });
    return true;
  }
  res.writeHead(204, headers);
  res.end();
  return true;
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

function identityFor(cfg: Config): SystemIdentity {
  try {
    return loadIdentity(cfg.root);
  } catch {
    // A broken identity file must not take the API down; the generated headers
    // are evidence, not the authentication boundary.
    return {
      name: "lama",
      version: packageVersion(cfg.root),
      tagline: "",
      protocol: PROTOCOL,
      branding: { owner: "unknown", organization: "unknown" },
      license: "unknown",
    };
  }
}

interface ProxyResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") parts.push(item);
    else if (item && typeof item === "object") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

function lastUserMessage(body: Record<string, unknown> | undefined): string {
  if (!body || !Array.isArray(body.messages)) return "";
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const row = body.messages[index];
    if (!row || typeof row !== "object") continue;
    if ((row as { role?: unknown }).role !== "user") continue;
    return textContent((row as { content?: unknown }).content).trim();
  }
  return "";
}

interface LogExtras {
  transportId?: string;
  firstTokenMs?: number | null;
  bytes?: number;
  stream?: number;
  /** Names of the MCP tools that ran for this request. */
  mcpTools?: string[];
  /** GBNF grammar that constrained the generation, when one was applied. */
  grammar?: string | null;
  /** True when the answer came from the proxy cache instead of the engine. */
  cacheHit?: boolean;
  /** The session this request belongs to. */
  session?: string | null;
  /** Transport protocol used to reach the engine. */
  transportProtocol?: string;
}

function logRequest(
  ctx: GatewayContext,
  req: http.IncomingMessage,
  url: URL,
  body: Record<string, unknown> | undefined,
  status: number,
  text: string,
  started: number,
  protocol: "openai" | "anthropic" | "other",
  extras: LogExtras = {},
): void {
  try {
    const modelKey = body && typeof body.model === "string" ? body.model : null;
    const model = modelKey ? resolveModel(ctx.store, modelKey) : undefined;
    const payload = parseJson(text);
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    if (protocol === "anthropic") {
      const usage = anthropicUsage(payload);
      promptTokens = usage?.input_tokens ?? null;
      completionTokens = usage?.output_tokens ?? null;
    } else if (protocol === "openai") {
      const usage = openaiUsage(payload);
      promptTokens = usage?.prompt_tokens ?? null;
      completionTokens = usage?.completion_tokens ?? null;
    }
    const userAgent = header(req, "user-agent").slice(0, 200) || null;
    const adapter = detectAdapter(header(req, "x-lama-client"), userAgent ?? "");
    const input: RequestLogInput = {
      model_id: model?.id ?? null,
      model_key: modelKey,
      provider_id: model?.provider_id ?? null,
      transport_id: extras.transportId ?? ctx.transportId ?? "http",
      client_adapter: adapter,
      user_agent: userAgent,
      protocol,
      endpoint: url.pathname,
      method: req.method ?? "GET",
      status,
      ok: status >= 200 && status < 400 ? 1 : 0,
      stream: extras.stream ?? (body?.stream === true ? 1 : 0),
      duration_ms: Math.max(0, Date.now() - started),
      first_token_ms: extras.firstTokenMs ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      bytes: extras.bytes ?? Buffer.byteLength(text),
      system_prompt_id: null,
      detail: status >= 400 ? text.slice(0, 500) : "",
    };
    ctx.store.logRequest(input);

    // The same fact is written to the per-transport and per-model log files.
    // The database row is the queryable copy; these files are the operator's
    // tail-friendly copy.
    const mcpTools = extras.mcpTools ?? detectMcpTools(payload);
    const totalTokens =
      promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null;
    ctx.logger?.log({
      at: new Date().toISOString(),
      transport: extras.transportId ?? ctx.transportId ?? "http",
      transport_protocol: extras.transportProtocol ?? ctx.cfg.gatewayEngine,
      model: model?.id ?? null,
      model_alias: modelKey,
      protocol,
      client: adapter,
      user_agent: userAgent,
      session: extras.session ?? null,
      endpoint: url.pathname,
      method: req.method ?? "GET",
      status,
      ok: status >= 200 && status < 400,
      stream: extras.stream === 1 || body?.stream === true,
      mcp_tool_executed: mcpTools.length > 0,
      mcp_tools: mcpTools,
      cache_hit: extras.cacheHit === true,
      duration_ms: Math.max(0, Date.now() - started),
      first_token_ms: extras.firstTokenMs ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      bytes: extras.bytes ?? Buffer.byteLength(text),
      grammar: extras.grammar ?? null,
      detail: status >= 400 ? text.slice(0, 500) : "",
    });
  } catch {
    // Telemetry must never break the request path.
  }
}

function persistParts(
  ctx: GatewayContext,
  session: string,
  url: URL,
  body: Record<string, unknown> | undefined,
  protocol: "openai" | "anthropic" | "other",
  assistant: string,
  tokens: number | null,
): void {
  const user = lastUserMessage(body);
  if (!user && !assistant) return;
  try {
    const modelKey = body && typeof body.model === "string" ? body.model : null;
    const model = modelKey ? resolveModel(ctx.store, modelKey) : undefined;
    const existing = ctx.store.getSession(session);
    ctx.store.upsertSession({
      id: session,
      title: existing?.title || (user ? user.slice(0, 80) : `Session ${session.slice(0, 8)}`),
      model_id: model?.id ?? existing?.model_id ?? null,
      system_prompt_id: existing?.system_prompt_id ?? null,
      expires_at: existing?.expires_at ?? null,
    });
    const metadata = JSON.stringify({ endpoint: url.pathname, protocol });
    if (user) {
      ctx.store.addSessionMessage({
        session_id: session,
        role: "user",
        content: user,
        model_id: model?.id ?? null,
        tokens: null,
        metadata_json: metadata,
      });
    }
    if (assistant) {
      ctx.store.addSessionMessage({
        session_id: session,
        role: "assistant",
        content: assistant,
        model_id: model?.id ?? null,
        tokens,
        metadata_json: metadata,
      });
    }
  } catch {
    // Session history is best effort; the response already belongs to the client.
  }
}

function persistTurn(
  ctx: GatewayContext,
  session: string,
  url: URL,
  body: Record<string, unknown> | undefined,
  result: ProxyResult,
  protocol: "openai" | "anthropic" | "other",
): void {
  if (result.status < 200 || result.status >= 300) return;
  const payload = parseJson(result.text);
  const assistant =
    protocol === "anthropic" ? anthropicAssistantText(payload) : protocol === "openai" ? openaiAssistantText(payload) : "";
  const usage = protocol === "anthropic" ? anthropicUsage(payload) : openaiUsage(payload);
  const tokens =
    usage && "output_tokens" in usage
      ? usage.output_tokens
      : usage && "completion_tokens" in usage
        ? usage.completion_tokens
        : null;
  persistParts(ctx, session, url, body, protocol, assistant, tokens);
}

function persistStreamTurn(
  ctx: GatewayContext,
  session: string,
  url: URL,
  body: Record<string, unknown> | undefined,
  protocol: "openai" | "anthropic" | "other",
  assistant: string,
): void {
  persistParts(ctx, session, url, body, protocol, assistant, null);
}

function engineTransport(ctx: GatewayContext): Pick<TransportRow, "protocol" | "host" | "port" | "socket_path"> {
  const cfg = ctx.cfg;
  if (cfg.gatewayEngine === "uds") {
    if (!cfg.udsPath) throw new Error("LAMA_GATEWAY_ENGINE=uds but LAMA_UDS_SOCK is empty");
    return { protocol: "uds", host: null, port: null, socket_path: cfg.udsPath };
  }
  const row = ctx.store.getTransport(cfg.gatewayEngine);
  if (row) return liveTransport(ctx.store, cfg, row);
  if (cfg.gatewayEngine === "https") {
    return { protocol: "https", host: cfg.engineHost, port: cfg.enginePort, socket_path: null };
  }
  return { protocol: "http", host: cfg.engineHost, port: cfg.enginePort, socket_path: null };
}

function transportLabel(transport: Pick<TransportRow, "protocol" | "host" | "port" | "socket_path">): string {
  if (transport.protocol === "uds") return `unix:${transport.socket_path ?? ""}`;
  return `${transport.protocol}://${transport.host || "127.0.0.1"}:${transport.port || 9932}`;
}

function upstreamHeaders(
  req: http.IncomingMessage,
  cfg: Config,
  session: string,
  accept: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept,
    "content-type": "application/json",
    "x-session-id": session,
  };
  if (cfg.engineApiKey) headers.authorization = `Bearer ${cfg.engineApiKey}`;
  const anthropicVersion = header(req, "anthropic-version");
  if (anthropicVersion) headers["anthropic-version"] = anthropicVersion;
  return headers;
}

/**
 * Put the retrieved local records in front of the model as one system message.
 * The corpus itself never leaves the proxy.
 */
function withLocalContext(
  ctx: GatewayContext,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const context = localContext(ctx, body);
  if (!context) return body;
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const existing = messages.find(
    (row) => Boolean(row) && typeof row === "object" && (row as { role?: unknown }).role === "system",
  ) as { role: string; content: string } | undefined;
  const block = `Local records retrieved for this question:\n\n${context}`;
  if (existing) {
    const index = messages.indexOf(existing);
    messages[index] = { role: "system", content: `${existing.content}\n\n${block}` };
  } else {
    messages.unshift({ role: "system", content: block });
  }
  return { ...body, messages };
}

/**
 * The local context for a request: the one or two records of the local corpus
 * that actually match what the user asked. The whole corpus stays in the
 * proxy; only these records are ever put in front of the model.
 */
function localContext(ctx: GatewayContext, body: Record<string, unknown> | undefined): string {
  if (!ctx.index || !body || !Array.isArray(body.messages)) return "";
  const question = lastUserMessage(body);
  if (!question) return "";
  const hits = ctx.index.search(question, 2);
  if (hits.length === 0) return "";
  return hits
    .map((hit) => `### ${hit.doc.id}\n${hit.doc.text}`)
    .join("\n\n");
}

/**
 * The cache key of a chat request. The model, the messages and the parameters
 * that change the answer take part; the session id does not, because the same
 * question asked twice deserves the same answer.
 */
function cacheKeyFor(
  body: Record<string, unknown> | undefined,
  protocol: "openai" | "anthropic" | "other",
): string | null {
  if (!body) return null;
  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
        .map((row) => ({
          role: typeof row.role === "string" ? row.role : "",
          content: typeof row.content === "string" ? row.content : JSON.stringify(row.content ?? ""),
        }))
    : null;
  if (!messages || messages.length === 0) return null;
  const parts: Parameters<typeof cacheKey>[0] = {
    model: typeof body.model === "string" ? body.model : "",
    protocol,
    messages,
    stream: body.stream === true,
  };
  // An absent parameter and a parameter set to its default are different
  // requests, so only a real value is added.
  if (typeof body.temperature === "number") parts.temperature = body.temperature;
  if (typeof body.max_tokens === "number") parts.maxTokens = body.max_tokens;
  if (typeof body.grammar === "string" && body.grammar) parts.grammar = body.grammar;
  return cacheKey(parts);
}

/** The protocol the engine is reached over, for the log entry. */
function engineProtocol(ctx: GatewayContext): string {
  try {
    const transport = engineTransport(ctx);
    return transport.protocol === "uds" ? "uds" : transport.protocol;
  } catch {
    return ctx.cfg.gatewayEngine;
  }
}

/** The GBNF grammar a request carries, when the caller constrained it. */
function grammarOf(body: Record<string, unknown> | undefined): string | null {
  if (!body) return null;
  const grammar = body.grammar;
  return typeof grammar === "string" && grammar.trim() ? grammar.trim() : null;
}

async function forward(
  ctx: GatewayContext,
  req: http.IncomingMessage,
  urlPath: string,
  session: string,
  body: Record<string, unknown> | undefined,
): Promise<ProxyResult> {
  const options: RequestOptions = {
    method: req.method ?? "GET",
    headers: upstreamHeaders(req, ctx.cfg, session, header(req, "accept") || "application/json"),
    timeoutMs: 120_000,
    allowSelfSigned: process.env.LAMA_TLS_INSECURE === "1",
  };
  if (body !== undefined) options.body = withLocalContext(ctx, body);

  try {
    return await request(engineTransport(ctx), urlPath, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 502,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({ error: { message: `engine unavailable: ${message}`, type: "engine_unavailable" } }),
    };
  }
}

function createSseTap(protocol: "openai" | "anthropic" | "other"): {
  push: (chunk: string) => void;
  text: () => string;
  tools: () => string[];
} {
  let buffer = "";
  let assistant = "";
  const tools = new Set<string>();
  return {
    push(chunk: string): void {
      if (buffer.length > 262_144) return;
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") {
            const payload = parseJson(data);
            const delta = protocol === "anthropic" ? anthropicDelta(payload) : protocol === "openai" ? openaiDelta(payload) : "";
            if (delta) assistant += delta;
            if (assistant.length > 262_144) assistant = assistant.slice(0, 262_144);
            // A streamed tool call travels in the same frames as the text.
            for (const name of detectMcpTools(payload)) tools.add(name);
          }
        }
        newline = buffer.indexOf("\n");
      }
    },
    text(): string {
      return assistant;
    },
    tools(): string[] {
      return [...tools];
    },
  };
}

async function forwardStream(
  ctx: GatewayContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  session: string,
  body: Record<string, unknown>,
  protocol: "openai" | "anthropic" | "other",
  started: number,
  base: Record<string, string>,
): Promise<void> {
  const transport = engineTransport(ctx);
  let upstream: http.IncomingMessage;
  try {
    upstream = await openStream(transport, urlPath, {
      method: req.method ?? "POST",
      headers: upstreamHeaders(req, ctx.cfg, session, "text/event-stream"),
      body,
      timeoutMs: 600_000,
      allowSelfSigned: process.env.LAMA_TLS_INSECURE === "1",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = JSON.stringify({ error: { message: `engine unavailable: ${message}`, type: "engine_unavailable" } });
    logRequest(ctx, req, new URL(req.url ?? "/", "http://gateway.local"), body, 502, text, started, protocol, {
      session,
      transportProtocol: engineProtocol(ctx),
      grammar: grammarOf(body),
    });
    json(res, 502, JSON.parse(text) as unknown, base);
    return;
  }

  const status = upstream.statusCode ?? 502;
  const contentType = upstream.headers["content-type"];
  res.writeHead(status, {
    ...base,
    "content-type": Array.isArray(contentType) ? contentType[0] ?? "text/event-stream" : contentType ?? "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-gateway-upstream": transportLabel(transport),
  });

  const tap = createSseTap(protocol);
  let bytes = 0;
  let firstTokenMs: number | null = null;
  let ended = false;
  let logged = false;
  const logStream = (statusCode: number): void => {
    if (logged) return;
    logged = true;
    const url = new URL(req.url ?? "/", "http://gateway.local");
    logRequest(ctx, req, url, body, statusCode, "", started, protocol, {
      firstTokenMs,
      bytes,
      stream: 1,
      mcpTools: tap.tools(),
      session,
      transportProtocol: engineProtocol(ctx),
      grammar: grammarOf(body),
    });
    if (statusCode >= 200 && statusCode < 300) {
      persistStreamTurn(ctx, session, url, body, protocol, tap.text());
    }
  };
  upstream.on("data", (chunk: string) => {
    if (firstTokenMs === null) firstTokenMs = Date.now() - started;
    bytes += Buffer.byteLength(chunk);
    if (protocol !== "other") tap.push(chunk);
  });
  upstream.on("error", () => {
    if (!res.writableEnded) res.destroy();
  });
  upstream.on("end", () => {
    ended = true;
    logStream(status);
  });
  res.on("close", () => {
    if (ended) return;
    upstream.destroy();
    logStream(499);
  });
  upstream.pipe(res);
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: GatewayContext,
  identity: SystemIdentity,
  runtime: AdminRuntime,
): Promise<void> {
  if (preflight(req, res, ctx.cfg)) return;

  const origin = header(req, "origin");
  const cors = corsHeaders(req, ctx.cfg);
  if (origin && !cors["access-control-allow-origin"]) {
    json(res, 403, { error: { message: "origin is not allowed", type: "cors" } });
    return;
  }

  const base = { ...identityHeaders(identity), ...cors };
  const url = new URL(req.url ?? "/", "http://gateway.local");
  const session = sessionId(req);
  base["x-session-id"] = session;
  const method = req.method ?? "GET";
  const started = Date.now();

  if (url.pathname === "/healthz" && method === "GET") {
    json(res, 200, { ok: true, service: "lama-gateway", version: identity.version }, base);
    return;
  }

  // The admin API and UI are routes of this server, not a second process.
  // Delegate before reading the body: the admin handlers own their own parsers.
  if (!url.pathname.startsWith("/v1/")) {
    await handleAdminRequest(req, res, ctx, identity, runtime, cors);
    return;
  }

  if (!authorized(req, ctx.cfg)) {
    const text = JSON.stringify({ error: { message: "missing or invalid bearer token", type: "authentication_error" } });
    logRequest(ctx, req, url, undefined, 401, text, started, "other", { session });
    json(res, 401, JSON.parse(text) as unknown, base);
    return;
  }

  let raw = "";
  if (method !== "GET" && method !== "HEAD") raw = await readBody(req);
  let body: Record<string, unknown> | undefined;
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("request body must be a JSON object");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      const text = JSON.stringify({
        error: { message: "request body is not valid JSON", type: "invalid_request_error" },
      });
      logRequest(ctx, req, url, undefined, 400, text, started, "other", { session });
      json(res, 400, JSON.parse(text) as unknown, base);
      return;
    }
  }

  const protocol: "openai" | "anthropic" | "other" = url.pathname.startsWith("/v1/messages")
    ? "anthropic"
    : url.pathname.startsWith("/v1/chat/completions") || url.pathname.startsWith("/v1/completions")
      ? "openai"
      : "other";

  if (url.pathname.startsWith("/v1/messages") && !header(req, "anthropic-version")) {
    const text = JSON.stringify({
      error: { message: "anthropic-version header is required", type: "invalid_request_error" },
    });
    logRequest(ctx, req, url, body, 400, text, started, "anthropic", { session });
    json(res, 400, JSON.parse(text) as unknown, base);
    return;
  }

  if (body?.stream === true) {
    await forwardStream(ctx, req, res, url.pathname + url.search, session, body, protocol, started, base);
    return;
  }

  // A repeated request is answered from the cache, without the engine.
  const cacheable = body?.stream !== true;
  const key = cacheable ? cacheKeyFor(body, protocol) : null;
  if (key && ctx.cache) {
    const cached = ctx.cache.get(key);
    if (cached && typeof cached.value === "object" && cached.value !== null) {
      const hit = cached.value as { status: number; text: string; headers?: Record<string, string> };
      logRequest(ctx, req, url, body, hit.status, hit.text, started, protocol, {
        session,
        transportProtocol: engineProtocol(ctx),
        grammar: grammarOf(body),
        cacheHit: true,
      });
      const cachedType = hit.headers?.["content-type"] ?? "application/json";
      res.writeHead(hit.status, {
        ...base,
        "content-type": cachedType,
        "content-length": String(Buffer.byteLength(hit.text)),
        "x-lama-cache": "hit",
      });
      res.end(hit.text);
      return;
    }
  }

  const result = await forward(ctx, req, url.pathname + url.search, session, body);
  if (key && ctx.cache && result.status === 200) {
    ctx.cache.set(key, { status: result.status, text: result.text });
  }
  logRequest(ctx, req, url, body, result.status, result.text, started, protocol, {
    session,
    transportProtocol: engineProtocol(ctx),
    grammar: grammarOf(body),
    cacheHit: false,
  });
  persistTurn(ctx, session, url, body, result, protocol);
  let upstream = ctx.cfg.engineUrl;
  try {
    upstream = transportLabel(engineTransport(ctx));
  } catch {
    // The forward path already returned a 502 with the real error.
  }
  const contentType = result.headers["content-type"];
  const responseHeaders: Record<string, string> = {
    ...base,
    "content-type": Array.isArray(contentType) ? contentType[0] ?? "application/json" : contentType ?? "application/json",
    "content-length": String(Buffer.byteLength(result.text)),
    "x-gateway-upstream": upstream,
  };
  res.writeHead(result.status, responseHeaders);
  res.end(result.text);
}

export function createGatewayServer(ctx: GatewayContext): http.Server {
  const identity = identityFor(ctx.cfg);
  const runtime = ctx.adminRuntime ?? createAdminRuntime(ctx);
  return http.createServer((req, res) => {
    void handle(req, res, ctx, identity, runtime).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: { message, type: "internal_error" } });
    });
  });
}

/** Listen on a Unix socket so local clients can skip TCP entirely. */
export function listenGatewayUds(server: http.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    try {
      const stat = fs.lstatSync(socketPath);
      if (stat.isSocket() || stat.isSymbolicLink()) fs.rmSync(socketPath, { force: true });
    } catch {
      // ENOENT is the normal first-boot case.
    }
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onListening = (): void => {
      cleanup();
      try {
        fs.chmodSync(socketPath, 0o660);
      } catch {
        // chmod is best effort on non-POSIX filesystems.
      }
      resolve();
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      cleanup();
      reject(new Error(`gateway UDS ${socketPath}: ${error.message}`));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

export function listenGatewayServer(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      cleanup();
      if (error.code === "EADDRINUSE") {
        error.message = `gateway port ${host}:${port} is already in use; find the owner with \`ss -ltnp | grep :${port}\` or set LAMA_GATEWAY_PORT`;
      } else if (error.code === "EACCES") {
        error.message = `gateway port ${host}:${port} needs elevated privileges or is reserved; set LAMA_GATEWAY_PORT to a free port`;
      }
      reject(error);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function gatewayHealth(host: string, port: number, timeoutMs = 1500): Promise<{ up: boolean; detail: string }> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/healthz", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      res.on("end", () => {
        let service: string | undefined;
        try {
          service = (JSON.parse(body) as { service?: string }).service;
        } catch {
          service = undefined;
        }
        if (res.statusCode === 200 && service === "lama-gateway") resolve({ up: true, detail: "lama-gateway healthz 200" });
        else resolve({ up: false, detail: `port ${port} answered ${res.statusCode ?? "?"} but not as lama-gateway` });
      });
      res.on("error", (error: Error) => resolve({ up: false, detail: error.message }));
    });
    req.on("timeout", () => req.destroy(new Error(`no answer from ${host}:${port} within ${timeoutMs}ms`)));
    req.on("error", (error: Error) => resolve({ up: false, detail: error.message }));
  });
}

export function gatewayUrl(cfg: Config): string {
  return `http://${cfg.gatewayHost}:${cfg.gatewayPort}`;
}

export function adminUrl(cfg: Config): string {
  return `${gatewayUrl(cfg)}/admin`;
}

export function gatewayUdsHealth(socketPath: string, timeoutMs = 1500): Promise<{ up: boolean; detail: string }> {
  return new Promise((resolve) => {
    if (!socketPath) {
      resolve({ up: false, detail: "UDS disabled" });
      return;
    }
    const req = http.get({ socketPath, path: "/healthz", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      res.on("end", () => {
        let service: string | undefined;
        try {
          service = (JSON.parse(body) as { service?: string }).service;
        } catch {
          service = undefined;
        }
        if (res.statusCode === 200 && service === "lama-gateway") resolve({ up: true, detail: "lama-gateway UDS healthz 200" });
        else resolve({ up: false, detail: `UDS answered ${res.statusCode ?? "?"} but not as lama-gateway` });
      });
      res.on("error", (error: Error) => resolve({ up: false, detail: error.message }));
    });
    req.on("timeout", () => req.destroy(new Error(`no UDS answer within ${timeoutMs}ms`)));
    req.on("error", (error: Error) => resolve({ up: false, detail: error.message }));
  });
}
