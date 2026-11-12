import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";

/**
 * Structured file logging for every proxied response.
 *
 * The manager writes two families of files in logs/:
 *   transport-<id>.log   one file per transport the request travelled on
 *   model-<id>.log       one file per model that produced the answer
 *
 * Every entry is one JSON object per line (JSONL), so `jq` can read it and a
 * human can still tail it. The entry records what an operator asked for:
 * which model answered, which protocol carried the response, who sent the
 * request, whether an MCP tool ran, how long it took and how many tokens were
 * processed.
 */
export interface ResponseLogEntry {
  at: string;
  /** Transport the request arrived on (http, uds, ...). */
  transport: string;
  /** Protocol used to reach the engine over that transport. */
  transport_protocol: string;
  /** Model row id that produced the answer. */
  model: string | null;
  /** Model alias the client asked for. */
  model_alias: string | null;
  /** Wire protocol of the request/response pair. */
  protocol: "openai" | "anthropic" | "other";
  /** Who sent it: the detected client adapter. */
  client: string | null;
  user_agent: string | null;
  /** Session the request belongs to. */
  session: string | null;
  endpoint: string;
  method: string;
  status: number;
  ok: boolean;
  stream: boolean;
  /** Whether an MCP tool was executed while serving this request. */
  mcp_tool_executed: boolean;
  /** Names of the MCP tools that ran for this request. */
  mcp_tools: string[];
  /** Whether the response was served from the proxy cache instead of the engine. */
  cache_hit: boolean;
  duration_ms: number;
  first_token_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  bytes: number;
  /** GBNF grammar that constrained the generation, when one was applied. */
  grammar: string | null;
  detail: string;
}

/** Turn an arbitrary id into a safe file name part. */
export function safeLogName(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // A leading dot would make a hidden file, and ".." would climb out of the
    // logs directory. Both are refused, not renamed into something odd.
    .replace(/\.+/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "unknown";
}

/** Append one JSON line to a file, creating the directory on demand. */
export function appendJsonLine(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch {
    // Telemetry must never break the request path.
  }
}

/**
 * Detect an MCP tool execution inside a response payload. llama.cpp executes
 * MCP tools itself when the engine was started with --mcp-servers-config, so
 * the tool call travels back inside the model answer.
 */
export function detectMcpTools(payload: unknown): string[] {
  const names: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const row = value as Record<string, unknown>;
    const type = typeof row.type === "string" ? row.type : "";
    if ((type === "tool_use" || type === "tool_call" || type === "function") && typeof row.name === "string") {
      names.push(row.name);
    }
    if (row.function && typeof row.function === "object") {
      const fn = row.function as Record<string, unknown>;
      if (typeof fn.name === "string") names.push(fn.name);
    }
    for (const child of Object.values(row)) visit(child, depth + 1);
  };
  visit(payload, 0);
  return [...new Set(names)];
}

export class ResponseLogger {
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  transportFile(transport: string): string {
    return path.join(this.cfg.logsDir, `transport-${safeLogName(transport)}.log`);
  }

  modelFile(model: string | null): string {
    return path.join(this.cfg.logsDir, `model-${safeLogName(model ?? "unknown")}.log`);
  }

  /**
   * Write the entry to the transport file and to the model file. A response
   * that names no model still lands in the transport file, so nothing is lost.
   */
  log(entry: ResponseLogEntry): void {
    appendJsonLine(this.transportFile(entry.transport), entry);
    appendJsonLine(this.modelFile(entry.model), entry);
  }
}

/** Every log file the manager writes, so the admin UI can list them. */
export function listLogFiles(cfg: Config): Array<{ name: string; bytes: number; path: string }> {
  try {
    return fs
      .readdirSync(cfg.logsDir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => {
        const full = path.join(cfg.logsDir, name);
        let bytes = 0;
        try {
          bytes = fs.statSync(full).size;
        } catch {
          bytes = 0;
        }
        return { name, bytes, path: full };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
