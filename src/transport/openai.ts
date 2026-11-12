import type http from "node:http";
import type { TransportRow } from "../types.ts";
import { openStream, request } from "./transport.ts";
import type { HttpResult, RequestOptions } from "./http.ts";

export interface OpenAiChatBody {
  model: string;
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

export function openaiChat(
  transport: Pick<TransportRow, "protocol" | "host" | "port" | "socket_path">,
  body: OpenAiChatBody,
  options: RequestOptions = {},
): Promise<HttpResult> {
  return request(transport, "/v1/chat/completions", { ...options, body });
}

export function openaiChatStream(
  transport: Pick<TransportRow, "protocol" | "host" | "port" | "socket_path">,
  body: OpenAiChatBody,
  options: RequestOptions = {},
): Promise<http.IncomingMessage> {
  return openStream(transport, "/v1/chat/completions", { ...options, body: { ...body, stream: true } });
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") parts.push(item);
    else if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join("");
}

export function openaiDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const choice = first as { delta?: { content?: unknown }; message?: { content?: unknown } };
  return textOf(choice.delta?.content ?? choice.message?.content);
}

export function openaiAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  return textOf((first as { message?: { content?: unknown } }).message?.content);
}

export function openaiUsage(payload: unknown): { prompt_tokens: number | null; completion_tokens: number | null } | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const row = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  return {
    prompt_tokens: typeof row.prompt_tokens === "number" ? row.prompt_tokens : null,
    completion_tokens: typeof row.completion_tokens === "number" ? row.completion_tokens : null,
  };
}
