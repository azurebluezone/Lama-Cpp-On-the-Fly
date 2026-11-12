import crypto from "node:crypto";
import type http from "node:http";
import type { Config } from "./config.ts";

export function header(req: http.IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return "";
}

export function isLoopback(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * A reverse proxy makes every request look loopback. Trusting that would turn
 * `loopback` auth into a public bypass, so forwarded requests must present a token.
 */
export function isForwarded(req: http.IncomingMessage): boolean {
  return Boolean(header(req, "x-forwarded-for") || header(req, "forwarded"));
}

export function isTrustedLoopback(req: http.IncomingMessage): boolean {
  return isLoopback(req) && !isForwarded(req);
}

export function suppliedToken(req: http.IncomingMessage): string {
  const authorization = header(req, "authorization");
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return header(req, "x-api-key");
}

export function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function authorized(req: http.IncomingMessage, cfg: Config): boolean {
  if (cfg.apiAuth === "open") return true;
  if (cfg.apiAuth === "loopback" && isTrustedLoopback(req)) return true;
  const expected = cfg.apiKey || cfg.adminToken;
  if (!expected) return false;
  return sameToken(suppliedToken(req), expected);
}

/**
 * The admin API is mounted inside the gateway, so it is reachable from a
 * browser origin. Always require the operator token there; `loopback` alone is
 * not an admin boundary.
 */
export function adminAuthorized(req: http.IncomingMessage, cfg: Config): boolean {
  const expected = cfg.apiKey || cfg.adminToken;
  if (!expected) return cfg.apiAuth === "open";
  return sameToken(suppliedToken(req), expected);
}

export function sessionId(req: http.IncomingMessage): string {
  const value = header(req, "x-session-id");
  if (value && /^[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
  return crypto.randomUUID();
}
