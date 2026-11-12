import http from "node:http";
import https from "node:https";

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  allowSelfSigned?: boolean;
}

export function payload(body: unknown): Buffer | null {
  if (body === undefined) return null;
  return Buffer.from(JSON.stringify(body));
}

export function requestHttp(url: string, options: RequestOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = payload(options.body);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.headers ?? {}),
    };
    if (body) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      headers["content-length"] = String(body.length);
    }
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method ?? (body ? "POST" : "GET"),
        headers,
        rejectUnauthorized: parsed.protocol === "https:" ? !(options.allowSelfSigned ?? false) : undefined,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 4 * 1024 * 1024) req.destroy(new Error("response too large"));
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs ?? 15_000, () =>
      req.destroy(new Error(`timeout after ${options.timeoutMs ?? 15_000}ms`)),
    );
    req.end(body ?? undefined);
  });
}

/** Open a response stream without buffering it; used by the streaming relay. */
export function openHttpStream(url: string, options: RequestOptions = {}): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = payload(options.body);
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      ...(options.headers ?? {}),
    };
    if (body) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      headers["content-length"] = String(body.length);
    }
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method ?? (body ? "POST" : "GET"),
        headers,
        rejectUnauthorized: parsed.protocol === "https:" ? !(options.allowSelfSigned ?? false) : undefined,
      },
      (res) => {
        res.setEncoding("utf8");
        resolve(res);
      },
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs ?? 600_000, () =>
      req.destroy(new Error(`stream timeout after ${options.timeoutMs ?? 600_000}ms`)),
    );
    req.end(body ?? undefined);
  });
}
