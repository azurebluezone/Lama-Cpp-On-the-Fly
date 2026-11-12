import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayServer, listenGatewayServer } from "../src/gateway/server.ts";
import { Store } from "../src/db.ts";
import { EngineManager } from "../src/engine.ts";
import { testConfig, testOs } from "./helpers.ts";

/**
 * These tests drive the admin routes mounted inside the real gateway: the
 * token gate, the request log CRUD, the session transcript and the static UI.
 * Store rows are inserted through the same methods the gateway uses, so the
 * admin is not reading a hand-written fixture table.
 */
interface Fixture {
  base: string;
  store: Store;
  cfg: ReturnType<typeof testConfig>;
  close: () => Promise<void>;
}

async function startFixture(t: test.TestContext): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-admin-"));
  const cfg = testConfig(root);
  cfg.apiAuth = "required";
  cfg.apiKey = "test-token";
  cfg.adminToken = "test-token";
  cfg.enginePort = 1;
  cfg.engineUrl = "http://127.0.0.1:1";
  cfg.webDir = path.resolve("web");
  const osInfo = testOs();
  const store = new Store(cfg.dbFile);
  const engine = new EngineManager(store, cfg, osInfo);
  const server = createGatewayServer({ store, cfg, os: osInfo, engine, transportId: "http" });
  await listenGatewayServer(server, "127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway did not bind a TCP port");
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  };
  t.after(close);
  return { base: `http://127.0.0.1:${address.port}`, store, cfg, close };
}

function rawRequest(
  base: string,
  method: string,
  urlPath: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const parsed = new URL(base);
  const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (payload) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    headers["content-length"] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: urlPath,
        method,
        headers,
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout calling ${method} ${urlPath}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function jsonCall(
  base: string,
  method: string,
  urlPath: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const reply = await rawRequest(base, method, urlPath, options);
  return { status: reply.status, json: reply.body ? (JSON.parse(reply.body) as Record<string, unknown>) : {} };
}

const auth = { authorization: "Bearer test-token" };

function logRow(store: Store, overrides: Partial<Parameters<Store["logRequest"]>[0]> = {}): void {
  store.logRequest({
    model_id: null,
    model_key: "stub-model",
    provider_id: null,
    transport_id: "http",
    client_adapter: "test",
    user_agent: "node-test",
    protocol: "openai",
    endpoint: "/v1/chat/completions",
    method: "POST",
    status: 200,
    ok: 1,
    stream: 0,
    duration_ms: 12,
    first_token_ms: null,
    prompt_tokens: 3,
    completion_tokens: 5,
    bytes: 100,
    system_prompt_id: null,
    detail: "",
    ...overrides,
  });
}

test("healthz is public and the API rejects missing or wrong tokens", async (t) => {
  const f = await startFixture(t);
  const health = await jsonCall(f.base, "GET", "/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.json.service, "lama-gateway");

  assert.equal((await jsonCall(f.base, "GET", "/api/overview")).status, 401);
  assert.equal((await jsonCall(f.base, "GET", "/api/overview", { headers: { authorization: "Bearer wrong" } })).status, 401);

  const overview = await jsonCall(f.base, "GET", "/api/overview", { headers: auth });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.ok, true);
  const counts = overview.json.counts as Record<string, number>;
  for (const key of ["models", "providers", "transports", "sessions", "requests", "prompts", "documents", "mcp"]) {
    assert.equal(typeof counts[key], "number", `counts.${key} must be a number`);
  }
  assert.equal(counts.requests, 0);
  const engine = overview.json.engine as { status: string };
  assert.equal(engine.status, "stopped");
});

test("request log lists, filters, deletes one row and clears the rest", async (t) => {
  const f = await startFixture(t);
  logRow(f.store, { protocol: "openai", status: 200, ok: 1, model_id: "m1" });
  logRow(f.store, { protocol: "anthropic", status: 500, ok: 0, model_id: "m2", detail: "boom" });
  logRow(f.store, { protocol: "other", status: 401, ok: 0 });

  const all = await jsonCall(f.base, "GET", "/api/requests?limit=10", { headers: auth });
  assert.equal(all.status, 200);
  assert.equal(all.json.count, 3);
  const rows = all.json.requests as Array<{ id: number; protocol: string; status: number }>;
  assert.deepEqual(rows.map((row) => row.protocol), ["other", "anthropic", "openai"]);

  const openai = await jsonCall(f.base, "GET", "/api/requests?protocol=openai", { headers: auth });
  assert.equal((openai.json.requests as unknown[]).length, 1);
  assert.equal(((openai.json.requests as Array<{ protocol: string }>)[0] ?? {}).protocol, "openai");

  const failed = await jsonCall(f.base, "GET", "/api/requests?ok=false", { headers: auth });
  assert.equal((failed.json.requests as unknown[]).length, 2);

  const model = await jsonCall(f.base, "GET", "/api/requests?model_id=m2", { headers: auth });
  assert.equal((model.json.requests as unknown[]).length, 1);

  const target = rows[1]!;
  const deleted = await jsonCall(f.base, "DELETE", `/api/requests/${target.id}`, { headers: auth });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.removed, 1);
  assert.equal((await jsonCall(f.base, "DELETE", `/api/requests/${target.id}`, { headers: auth })).status, 404);

  const cleared = await jsonCall(f.base, "DELETE", "/api/requests", { headers: auth });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.removed, 2);
  const empty = await jsonCall(f.base, "GET", "/api/requests", { headers: auth });
  assert.equal(empty.json.count, 0);
  assert.ok(f.store.listAudit(10).some((row) => row.action === "requests.clear"));
});

test("sessions expose their persisted messages and can be deleted", async (t) => {
  const f = await startFixture(t);
  f.store.upsertProvider({
    id: "p1",
    name: "Stub provider",
    kind: "llamacpp",
    base_url: "http://127.0.0.1:1",
    build: null,
    config_json: "{}",
    metadata_json: "{}",
  });
  f.store.upsertModel({
    id: "m1",
    provider_id: "p1",
    name: "Stub model",
    model_id: "stub-model",
    path: null,
    context: null,
    max_tokens: null,
    temperature: 0.7,
    quant: null,
    load_mode: "auto",
    ttl_hours: null,
    enabled: 1,
    metadata_json: "{}",
  });
  f.store.upsertSession({
    id: "sess-admin",
    title: "Admin session",
    model_id: "m1",
    system_prompt_id: null,
    expires_at: null,
  });
  f.store.addSessionMessage({
    session_id: "sess-admin",
    role: "user",
    content: "hello",
    model_id: "m1",
    tokens: null,
    metadata_json: "{}",
  });
  f.store.addSessionMessage({
    session_id: "sess-admin",
    role: "assistant",
    content: "world",
    model_id: "m1",
    tokens: 7,
    metadata_json: "{}",
  });

  const list = await jsonCall(f.base, "GET", "/api/sessions", { headers: auth });
  assert.equal(list.status, 200);
  const sessions = list.json.sessions as Array<{ id: string; title: string }>;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.title, "Admin session");

  const detail = await jsonCall(f.base, "GET", "/api/sessions/sess-admin", { headers: auth });
  assert.equal(detail.status, 200);
  const messages = detail.json.messages as Array<{ role: string; content: string; tokens: number | null }>;
  assert.deepEqual(messages.map((message) => [message.role, message.content]), [
    ["user", "hello"],
    ["assistant", "world"],
  ]);
  assert.equal(messages[1]?.tokens, 7);

  assert.equal((await jsonCall(f.base, "GET", "/api/sessions/nope", { headers: auth })).status, 404);
  assert.equal((await jsonCall(f.base, "DELETE", "/api/sessions/sess-admin", { headers: auth })).status, 200);
  assert.equal((await jsonCall(f.base, "GET", "/api/sessions/sess-admin", { headers: auth })).status, 404);
  assert.equal(f.store.listSessionMessages("sess-admin").length, 0, "messages must cascade with the session");
});

test("the admin serves its UI and refuses path traversal", async (t) => {
  const f = await startFixture(t);
  const page = await rawRequest(f.base, "GET", "/");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /text\/html/);
  assert.match(page.body, /class="app-sidebar"/);
  assert.match(page.body, /class="page-content"/);
  assert.match(page.body, /assets\/css\/style\.min\.css/);
  for (const id of ["metrics", "requests", "sessions", "chat", "engine", "models", "transports", "audit"]) {
    assert.match(page.body, new RegExp(`href="#${id}"`), `menu must link to #${id}`);
    assert.match(page.body, new RegExp(`id="${id}"`), `section #${id} must exist`);
  }

  const css = await rawRequest(f.base, "GET", "/assets/css/style.min.css");
  assert.equal(css.status, 200);
  assert.match(String(css.headers["content-type"]), /text\/css/);
  assert.match(css.body, /\.app-sidebar/);

  const js = await rawRequest(f.base, "GET", "/assets/js/vendor.min.js");
  assert.equal(js.status, 200);
  assert.match(String(js.headers["content-type"]), /text\/javascript/);

  const font = await rawRequest(f.base, "GET", "/assets/fonts/boxicons.woff2");
  assert.equal(font.status, 200);
  assert.equal(String(font.headers["content-type"]), "font/woff2");

  const aliased = await rawRequest(f.base, "GET", "/admin/");
  assert.equal(aliased.status, 200);

  const mountedCss = await rawRequest(f.base, "GET", "/admin/assets/css/style.min.css");
  assert.equal(mountedCss.status, 200, "the UI must find its CSS under /admin/");
  const mountedJs = await rawRequest(f.base, "GET", "/admin/assets/js/vendor.min.js");
  assert.equal(mountedJs.status, 200, "the UI must find its JS under /admin/");

  const traversal = await rawRequest(f.base, "GET", "/../etc/passwd");
  assert.equal(traversal.status, 404);

  const unknown = await rawRequest(f.base, "GET", "/nope.js");
  assert.equal(unknown.status, 404);
});

test("POST /api/chat streams SSE deltas and persists both turns plus a request log", async (t) => {
  const f = await startFixture(t);
  const seen: Array<{ stream?: boolean; messages?: Array<{ role: string; content: string }> }> = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        stream?: boolean;
        messages?: Array<{ role: string; content: string }>;
      };
      seen.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":4,"completion_tokens":2},"choices":[]}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const port = (upstream.address() as AddressInfo).port;
  f.cfg.engineUrl = `http://127.0.0.1:${port}`;
  f.cfg.enginePort = port;

  f.store.upsertProvider({
    id: "p1",
    name: "Stub provider",
    kind: "llamacpp",
    base_url: f.cfg.engineUrl,
    build: null,
    config_json: "{}",
    metadata_json: "{}",
  });
  f.store.upsertModel({
    id: "m-chat",
    provider_id: "p1",
    name: "Stub chat model",
    model_id: "stub-chat",
    path: null,
    context: null,
    max_tokens: 64,
    temperature: 0.2,
    quant: null,
    load_mode: "auto",
    ttl_hours: null,
    enabled: 1,
    metadata_json: "{}",
  });

  const reply = await rawRequest(f.base, "POST", "/api/chat", {
    headers: { ...auth, accept: "text/event-stream" },
    body: { model_id: "m-chat", message: "hello stream" },
  });
  assert.equal(reply.status, 200);
  assert.match(String(reply.headers["content-type"]), /text\/event-stream/);
  assert.match(reply.body, /event: meta/);
  assert.match(reply.body, /event: delta/);
  assert.match(reply.body, /event: usage/);
  assert.match(reply.body, /event: done/);
  assert.doesNotMatch(reply.body, /event: error/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.stream, true);
  assert.equal(seen[0]?.messages?.at(-1)?.content, "hello stream");

  const metaLine = /event: meta\ndata: (.+)\n/.exec(reply.body);
  assert.ok(metaLine, "meta event must carry JSON");
  const meta = JSON.parse(metaLine[1]!) as { session_id: string; model_id: string };
  assert.equal(meta.model_id, "m-chat");

  const messages = f.store.listSessionMessages(meta.session_id);
  assert.deepEqual(messages.map((row) => [row.role, row.content]), [
    ["user", "hello stream"],
    ["assistant", "Hello"],
  ]);
  assert.equal(messages[1]?.tokens, 2);

  const logs = f.store.listRequests({ limit: 1 });
  assert.equal(logs[0]?.endpoint, "/api/chat");
  assert.equal(logs[0]?.stream, 1);
  assert.equal(logs[0]?.status, 200);
  assert.equal(logs[0]?.ok, 1);
  assert.equal(logs[0]?.model_id, "m-chat");
  assert.equal(logs[0]?.completion_tokens, 2);
  assert.ok(f.store.listAudit(10).some((row) => row.action === "chat.message"));
});

test("POST /api/chat keeps the SSE shape for an unknown model", async (t) => {
  const f = await startFixture(t);
  const reply = await rawRequest(f.base, "POST", "/api/chat", {
    headers: { ...auth, accept: "text/event-stream" },
    body: { model_id: "__missing__", message: "ping" },
  });
  assert.equal(reply.status, 200);
  assert.match(String(reply.headers["content-type"]), /text\/event-stream/);
  assert.match(reply.body, /event: error/);
  const line = /event: error\ndata: (.+)\n/.exec(reply.body);
  assert.ok(line, "error event must carry JSON");
  const payload = JSON.parse(line[1]!) as { type: string; message: string };
  assert.equal(payload.type, "model_not_found");
  assert.match(payload.message, /not found/);
  assert.equal(f.store.listRequests({ limit: 1 }).length, 0, "an unknown model must not write a request log");
});

test("admin routes are mounted in the gateway and the UI reports the gateway service", async (t) => {
  const f = await startFixture(t);
  const page = await rawRequest(f.base, "GET", "/admin/");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /text\/html/);
  const config = await jsonCall(f.base, "GET", "/api/config", { headers: auth });
  assert.equal(config.status, 200);
  const admin = config.json.admin as { mounted: boolean; url: string };
  assert.equal(admin.mounted, true);
  assert.match(admin.url, /\/admin$/);
  const overview = await jsonCall(f.base, "GET", "/api/overview", { headers: auth });
  assert.equal(overview.json.service, "lama-gateway");
});
