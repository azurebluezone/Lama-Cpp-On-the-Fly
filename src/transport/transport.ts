import type http from "node:http";
import type { DocumentRow, EngineTransport, TransportRow } from "../types.ts";
import { openHttpStream, requestHttp, type HttpResult, type RequestOptions } from "./http.ts";
import { openUdsStream, requestUds } from "./uds.ts";

export async function request(
  transport: Pick<TransportRow, "protocol" | "host" | "port" | "socket_path">,
  urlPath: string,
  options: RequestOptions = {},
): Promise<HttpResult> {
  if (transport.protocol === "uds") {
    if (!transport.socket_path) throw new Error("UDS transport has no socket_path");
    return requestUds(transport.socket_path, urlPath, options);
  }
  const host = transport.host || "127.0.0.1";
  const port = transport.port || 9932;
  return requestHttp(`${transport.protocol}://${host}:${port}${urlPath}`, options);
}

/** Open a response stream without buffering it; used by the streaming relay. */
export function openStream(
  transport: Pick<TransportRow, "protocol" | "host" | "port" | "socket_path">,
  urlPath: string,
  options: RequestOptions = {},
): Promise<http.IncomingMessage> {
  if (transport.protocol === "uds") {
    if (!transport.socket_path) throw new Error("UDS transport has no socket_path");
    return openUdsStream(transport.socket_path, urlPath, options);
  }
  const host = transport.host || "127.0.0.1";
  const port = transport.port || 9932;
  return openHttpStream(`${transport.protocol}://${host}:${port}${urlPath}`, options);
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
  status: number | null;
}

export async function probeTransport(
  transport: TransportRow,
  modelId: string,
  apiKey = "",
): Promise<ProbeResult> {
  const auth = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  try {
    const health = await request(transport, "/health", { timeoutMs: 5000, headers: auth });
    if (health.status !== 200) return { ok: false, detail: `health HTTP ${health.status}`, status: health.status };
    const props = await request(transport, "/props", { timeoutMs: 5000, headers: auth });
    if (props.status !== 200) return { ok: false, detail: `props HTTP ${props.status}`, status: props.status };
    const models = await request(transport, "/v1/models", { timeoutMs: 5000, headers: auth });
    if (models.status !== 200) return { ok: false, detail: `models HTTP ${models.status}`, status: models.status };
    const body = {
      model: modelId,
      max_tokens: 8,
      temperature: 0,
      messages: [{ role: "user", content: "Reply with ok." }],
    };
    const chat = await request(transport, "/v1/chat/completions", {
      timeoutMs: 60_000,
      headers: auth,
      body,
    });
    if (chat.status !== 200) {
      return { ok: false, detail: `chat HTTP ${chat.status}: ${chat.text.slice(0, 200)}`, status: chat.status };
    }
    const parsed = JSON.parse(chat.text) as { choices?: Array<{ message?: { content?: string } }> };
    if (!parsed.choices?.[0]?.message) {
      return { ok: false, detail: "chat response has no choices[0].message", status: chat.status };
    }
    return { ok: true, detail: "health 200, props 200, models 200, chat 200", status: 200 };
  } catch (error) {
    return { ok: false, detail: (error as Error).message, status: null };
  }
}

export function protocolLabel(protocol: EngineTransport): string {
  return protocol === "uds" ? "UDS" : protocol.toUpperCase();
}

export function documentTransport(
  store: { getTransport: (id: string) => TransportRow | undefined },
  doc: DocumentRow,
): TransportRow | undefined {
  return doc.transport_id ? store.getTransport(doc.transport_id) : undefined;
}
