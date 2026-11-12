import { randomUUID } from "node:crypto";
import type http from "node:http";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { resolveModel } from "./engine.ts";
import {
  formatSse,
  openStream,
  openaiDelta,
  openaiUsage,
  parseSseData,
  readSse,
} from "./transport/index.ts";
import type { RequestLogInput, TransportRow } from "./types.ts";
import { detectMcpTools, ResponseLogger } from "./logging.ts";

export interface ChatContext {
  store: Store;
  cfg: Config;
  /** Structured per-transport and per-model response log. */
  logger?: ResponseLogger | undefined;
}

function engineTransport(cfg: Config): Pick<TransportRow, "protocol" | "host" | "port" | "socket_path"> {
  if (cfg.gatewayEngine === "uds") {
    if (!cfg.udsPath) throw new Error("LAMA_GATEWAY_ENGINE=uds but LAMA_UDS_SOCK is empty");
    return { protocol: "uds", host: null, port: null, socket_path: cfg.udsPath };
  }
  return { protocol: cfg.gatewayEngine, host: cfg.engineHost, port: cfg.enginePort, socket_path: null };
}

const MAX_CHAT_BYTES = 256 * 1024;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function json(res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    ...extra,
  });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_CHAT_BYTES) throw new Error(`chat body exceeds ${MAX_CHAT_BYTES} bytes`);
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

function startSse(res: http.ServerResponse, base: Record<string, string>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...base,
  });
  res.flushHeaders();
}

function send(res: http.ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(formatSse(event, JSON.stringify(data)));
}

function logChat(ctx: ChatContext, input: RequestLogInput): void {
  try {
    ctx.store.logRequest(input);
  } catch {
    // Telemetry must never break a delivered answer.
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * POST /api/chat: one browser request, one SSE response. The admin socket stays
 * open while llama.cpp streams; every delta is forwarded immediately and the
 * finished turn is written to sessions/session_messages plus request_logs.
 */
export async function streamAdminChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ChatContext,
  base: Record<string, string>,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = parseObject(await readBody(req));
  } catch (error) {
    json(res, 400, { error: { message: (error as Error).message, type: "admin_error" } }, base);
    return;
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    json(res, 400, { error: { message: "message is required", type: "admin_error" } }, base);
    return;
  }
  if (message.length > 32_000) {
    json(res, 400, { error: { message: "message is longer than 32000 characters", type: "admin_error" } }, base);
    return;
  }

  const modelKey = typeof body.model_id === "string" ? body.model_id : "";
  const model = resolveModel(ctx.store, modelKey);
  if (!model) {
    // The stream shape stays the same even for a client error, so the browser
    // always reads one protocol instead of guessing between JSON and SSE.
    startSse(res, base);
    send(res, "error", { message: `model ${modelKey || "(empty)"} not found`, type: "model_not_found" });
    res.end();
    return;
  }

  const requested = typeof body.session_id === "string" ? body.session_id : "";
  if (requested && !SESSION_RE.test(requested)) {
    json(res, 400, { error: { message: "session_id has invalid characters", type: "admin_error" } }, base);
    return;
  }
  const sessionId = requested || randomUUID();
  const existing = ctx.store.getSession(sessionId);
  const title = existing?.title || message.slice(0, 80);
  const system = typeof body.system === "string" ? body.system.trim() : "";
  const maxTokens =
    typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
      ? clamp(Math.trunc(body.max_tokens), 1, 8192)
      : model.max_tokens ?? 1024;
  const temperature =
    typeof body.temperature === "number" && Number.isFinite(body.temperature)
      ? clamp(body.temperature, 0, 2)
      : model.temperature;

  const history = ctx.store.listSessionMessages(sessionId, 1000);
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  for (const row of history) {
    if (!row.content.trim()) continue;
    if (row.role !== "system" && row.role !== "user" && row.role !== "assistant") continue;
    messages.push({ role: row.role, content: row.content });
  }
  messages.push({ role: "user", content: message });

  try {
    ctx.store.upsertSession({
      id: sessionId,
      title,
      model_id: model.id,
      system_prompt_id: existing?.system_prompt_id ?? null,
      expires_at: existing?.expires_at ?? null,
    });
    ctx.store.addSessionMessage({
      session_id: sessionId,
      role: "user",
      content: message,
      model_id: model.id,
      tokens: null,
      metadata_json: JSON.stringify({ endpoint: "/api/chat", protocol: "openai" }),
    });
  } catch (error) {
    json(res, 500, { error: { message: (error as Error).message, type: "admin_error" } }, base);
    return;
  }

  startSse(res, base);
  send(res, "meta", { session_id: sessionId, model_id: model.id, model_key: model.model_id, title });

  const started = Date.now();
  let firstTokenMs: number | null = null;
  let content = "";
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let status = 200;
  let errorMessage = "";
  let aborted = false;
  let upstream: http.IncomingMessage | null = null;

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15_000);

  res.on("close", () => {
    if (res.writableEnded) return;
    aborted = true;
    upstream?.destroy();
  });

  try {
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      "content-type": "application/json",
    };
    if (ctx.cfg.engineApiKey) headers.authorization = `Bearer ${ctx.cfg.engineApiKey}`;
    upstream = await openStream(engineTransport(ctx.cfg), "/v1/chat/completions", {
      method: "POST",
      headers,
      timeoutMs: 600_000,
      allowSelfSigned: process.env.LAMA_TLS_INSECURE === "1",
      body: {
        model: model.model_id,
        messages,
        stream: true,
        // llama.cpp only emits the final usage block when this flag is asked
        // for; without it the token counts stay null in the database.
        stream_options: { include_usage: true },
        max_tokens: maxTokens,
        temperature,
      },
    });

    if ((upstream.statusCode ?? 0) !== 200) {
      let detail = "";
      upstream.setEncoding("utf8");
      for await (const chunk of upstream) {
        detail += chunk;
        if (detail.length > 4000) break;
      }
      status = 502;
      errorMessage = `engine HTTP ${upstream.statusCode ?? "?"}: ${detail.trim().slice(0, 300)}`;
    } else {
      for await (const event of readSse(upstream)) {
        if (event.data === "[DONE]") break;
        if (event.event === "error") {
          throw new Error(event.data.slice(0, 300) || "engine stream error");
        }
        const payload = parseSseData(event);
        if (payload && typeof payload === "object" && "error" in payload) {
          const detail = (payload as { error?: { message?: unknown } }).error;
          throw new Error(typeof detail?.message === "string" ? detail.message : "engine returned an error event");
        }
        const delta = openaiDelta(payload);
        if (delta) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - started;
          content += delta;
          send(res, "delta", { text: delta });
        }
        const usage = openaiUsage(payload);
        if (usage) {
          promptTokens = usage.prompt_tokens;
          completionTokens = usage.completion_tokens;
        }
      }
    }
  } catch (error) {
    if (!aborted) {
      status = 502;
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  } finally {
    clearInterval(heartbeat);
    if (aborted) status = 499;
  }

  const duration = Date.now() - started;
  try {
    if (content.trim()) {
      ctx.store.addSessionMessage({
        session_id: sessionId,
        role: "assistant",
        content,
        model_id: model.id,
        tokens: completionTokens,
        metadata_json: JSON.stringify({
          endpoint: "/api/chat",
          protocol: "openai",
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
          aborted,
        }),
      });
    }
    ctx.store.upsertSession({
      id: sessionId,
      title,
      model_id: model.id,
      system_prompt_id: existing?.system_prompt_id ?? null,
      expires_at: existing?.expires_at ?? null,
    });
    ctx.store.audit("chat.message", sessionId, `status=${status} chars=${content.length}`, "admin");
  } catch {
    // The answer is already on the wire; a history write failure is logged by
    // the request row below, not turned into a second protocol error.
  }

  const totalTokens =
    promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null;
  const input: RequestLogInput = {
    model_id: model.id,
    model_key: model.model_id,
    provider_id: model.provider_id,
    transport_id: ctx.cfg.gatewayEngine,
    client_adapter: "admin-ui",
    user_agent: null,
    protocol: "openai",
    endpoint: "/api/chat",
    method: "POST",
    status,
    ok: status >= 200 && status < 400 ? 1 : 0,
    stream: 1,
    duration_ms: duration,
    first_token_ms: firstTokenMs,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    bytes: Buffer.byteLength(content),
    system_prompt_id: null,
    detail: status >= 400 ? errorMessage.slice(0, 500) : "",
  };
  logChat(ctx, input);

  // The same fact goes to the per-transport and per-model log files.
  const mcpTools = detectMcpTools({ content });
  ctx.logger?.log({
    at: new Date().toISOString(),
    transport: "admin-ui",
    transport_protocol: ctx.cfg.gatewayEngine,
    model: model.id,
    model_alias: model.model_id,
    protocol: "openai",
    client: "admin-ui",
    user_agent: null,
    session: sessionId,
    endpoint: "/api/chat",
    method: "POST",
    status,
    ok: status >= 200 && status < 400,
    stream: true,
    mcp_tool_executed: mcpTools.length > 0,
    mcp_tools: mcpTools,
    cache_hit: false,
    duration_ms: duration,
    first_token_ms: firstTokenMs,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    bytes: Buffer.byteLength(content),
    grammar: null,
    detail: status >= 400 ? errorMessage.slice(0, 500) : "",
  });

  if (aborted) return;
  if (status >= 400) {
    send(res, "error", { message: errorMessage || `chat failed with ${status}`, type: "chat_error" });
  } else {
    send(res, "usage", { prompt_tokens: promptTokens, completion_tokens: completionTokens });
    send(res, "done", {
      session_id: sessionId,
      tokens: completionTokens,
      duration_ms: duration,
      first_token_ms: firstTokenMs,
      chars: content.length,
    });
  }
  res.end();
}
