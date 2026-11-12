import type http from "node:http";
import type { TransportRow } from "../types.ts";
import { openStream, request } from "./transport.ts";
import type { HttpResult, RequestOptions } from "./http.ts";

export const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicMessageBody {
  model: string;
  max_tokens: number;
  messages: Array<Record<string, unknown>>;
  system?: unknown;
  stream?: boolean;
  temperature?: number;
  [key: string]: unknown;
}

function versionHeaders(options: RequestOptions): RequestOptions {
  const headers: Record<string, string> = {
    "anthropic-version": ANTHROPIC_VERSION,
    ...(options.headers ?? {}),
  };
  return { ...options, headers };
}

export function anthropicMessages(
  transport: Pick<TransportRow, "protocol" | "host" | "port" | "socket_path">,
  body: AnthropicMessageBody,
  options: RequestOptions = {},
): Promise<HttpResult> {
  return request(transport, "/v1/messages", { ...versionHeaders(options), body });
}

export function anthropicMessagesStream(
  transport: Pick<TransportRow, "protocol" | "host" | "port" | "socket_path">,
  body: AnthropicMessageBody,
  options: RequestOptions = {},
): Promise<http.IncomingMessage> {
  return openStream(transport, "/v1/messages", {
    ...versionHeaders(options),
    body: { ...body, stream: true },
  });
}

export function anthropicDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const row = payload as {
    type?: unknown;
    delta?: { type?: unknown; text?: unknown };
    content_block?: { type?: unknown; text?: unknown };
  };
  if (row.type === "content_block_delta" && row.delta?.type === "text_delta" && typeof row.delta.text === "string") {
    return row.delta.text;
  }
  if (row.type === "content_block_start" && row.content_block?.type === "text" && typeof row.content_block.text === "string") {
    return row.content_block.text;
  }
  return "";
}

export function anthropicAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("");
}

export function anthropicUsage(payload: unknown): {
  input_tokens: number | null;
  output_tokens: number | null;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as {
    message?: { usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  const usage = row.message?.usage ?? row.usage;
  if (!usage) return null;
  return {
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
  };
}
