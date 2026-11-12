import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { payload, type HttpResult, type RequestOptions } from "./http.ts";

export function requestUds(socketPath: string, urlPath: string, options: RequestOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = payload(options.body);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.headers ?? {}),
    };
    if (body) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      headers["content-length"] = String(body.length);
    }
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method: options.method ?? (body ? "POST" : "GET"),
        headers,
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

/** Open a UDS response stream without buffering it; used by the streaming relay. */
export function openUdsStream(
  socketPath: string,
  urlPath: string,
  options: RequestOptions = {},
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const body = payload(options.body);
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      ...(options.headers ?? {}),
    };
    if (body) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      headers["content-length"] = String(body.length);
    }
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method: options.method ?? (body ? "POST" : "GET"),
        headers,
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

export function linkSocket(source: string, gatewayDir: string): { target: string; changed: boolean } {
  const stat = fs.statSync(source);
  if (!stat.isSocket()) throw new Error(`${source} is not a socket`);
  fs.mkdirSync(gatewayDir, { recursive: true, mode: 0o700 });
  const target = path.join(gatewayDir, "llama.sock");
  try {
    const existing = fs.lstatSync(target);
    if (existing.isSymbolicLink()) {
      const resolved = path.resolve(gatewayDir, fs.readlinkSync(target));
      if (resolved === path.resolve(source)) return { target, changed: false };
      throw new Error(`${target} already points to ${resolved}; remove it explicitly before relinking`);
    }
    throw new Error(`${target} exists and is not a symlink; remove it explicitly before relinking`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.symlinkSync(source, target, "file");
  return { target, changed: true };
}
