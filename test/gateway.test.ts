import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/db.ts";
import { EngineManager } from "../src/engine.ts";
import {
  createGatewayServer,
  gatewayHealth,
  listenGatewayServer,
  listenGatewayUds,
  type GatewayContext,
} from "../src/gateway/server.ts";
import { testConfig, testOs } from "./helpers.ts";

interface SeenRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: unknown;
}

interface StubEngine {
  server: http.Server;
  port: number;
  seen: SeenRequest[];
  stop: () => Promise<void>;
}

async function startStubEngine(socketPath?: string): Promise<StubEngine> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://stub");
      seen.push({ method: req.method ?? "GET", path: url.pathname + url.search, headers: req.headers, body });
      let parsed: Record<string, unknown> = {};
      if (body.trim()) {
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
      }
      const send = (status: number, value: unknown): void => {
        const text = `${JSON.stringify(value)}\n`;
        res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
        res.end(text);
      };
      if (url.pathname === "/health") return send(200, { status: "ok" });
      if (url.pathname === "/v1/models") return send(200, { object: "list", data: [{ id: "stub-model" }] });
      if (url.pathname === "/v1/chat/completions") {
        if (parsed.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.write('data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n');
          res.write('data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"content":"stub "}}]}\n\n');
          res.write('data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n');
          res.write('data: {"id":"chatcmpl-test","usage":{"prompt_tokens":4,"completion_tokens":2},"choices":[]}\n\n');
          res.end("data: [DONE]\n\n");
          return;
        }
        return send(200, {
          id: "chatcmpl-test",
          object: "chat.completion",
          model: "stub-model",
          choices: [{ index: 0, message: { role: "assistant", content: "stub answer" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        });
      }
      if (url.pathname === "/v1/messages") {
        return send(200, {
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "stub anthropic answer" }],
        });
      }
      return send(404, { error: { message: `stub has no route for ${url.pathname}` } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const ready = (): void => {
      server.off("error", reject);
      resolve();
    };
    if (socketPath) {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      server.listen(socketPath, ready);
    } else {
      server.listen(0, "127.0.0.1", ready);
    }
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    server,
    port,
    seen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Fixture {
  root: string;
  cfg: ReturnType<typeof testConfig>;
  store: Store;
  engine: EngineManager;
  gatewayPort: number;
  stub: StubEngine;
}

async function startFixture(t: test.TestContext): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-gateway-"));
  const cfg = testConfig(root);
  cfg.apiAuth = "required";
  cfg.apiKey = "test-token";
  cfg.adminToken = "test-token";
  cfg.gatewayOrigins = ["https://test.local"];
  cfg.webDir = path.resolve("web");
  const stub = await startStubEngine();
  cfg.enginePort = stub.port;
  cfg.engineUrl = `http://127.0.0.1:${stub.port}`;
  const store = new Store(cfg.dbFile);
  const engine = new EngineManager(store, cfg, testOs());
  const context: GatewayContext = { store, cfg, os: testOs(), engine };
  const server = createGatewayServer(context);
  await listenGatewayServer(server, "127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway did not bind a TCP port");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stub.stop();
  });
  return { root, cfg, store, engine, gatewayPort: address.port, stub };
}

function call(
  port: number,
  method: string,
  urlPath: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (payload) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      headers["content-length"] = String(payload.length);
    }
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(body) as unknown;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout calling ${method} ${urlPath}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const bearer = { authorization: "Bearer test-token" };

function callUds(
  socketPath: string,
  method: string,
  urlPath: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (payload) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      headers["content-length"] = String(payload.length);
    }
    const req = http.request({ socketPath, path: urlPath, method, headers, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json: unknown = null;
        try {
          json = JSON.parse(body) as unknown;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout calling ${method} ${urlPath}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("healthz answers without a token and echoes a valid session id", async (t) => {
  const f = await startFixture(t);
  const generated = await call(f.gatewayPort, "GET", "/healthz");
  assert.equal(generated.status, 200);
  const body = generated.json as { ok: boolean; service: string; version: string };
  assert.equal(body.ok, true);
  assert.equal(body.service, "lama-gateway");
  assert.ok(body.version);
  assert.match(String(generated.headers["x-session-id"]), /^[0-9a-f-]{36}$/);

  const echoed = await call(f.gatewayPort, "GET", "/healthz", { headers: { "x-session-id": "sess-abc_123" } });
  assert.equal(echoed.status, 200);
  assert.equal(echoed.headers["x-session-id"], "sess-abc_123");

  const rejected = await call(f.gatewayPort, "GET", "/healthz", { headers: { "x-session-id": "bad id!" } });
  assert.equal(rejected.status, 200);
  assert.notEqual(rejected.headers["x-session-id"], "bad id!");
  assert.match(String(rejected.headers["x-session-id"]), /^[0-9a-f-]{36}$/);
});

test("CORS preflight allows configured origins and rejects others", async (t) => {
  const f = await startFixture(t);
  const preflight = await call(f.gatewayPort, "OPTIONS", "/v1/chat/completions", {
    headers: {
      origin: "https://test.local",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
      "access-control-request-private-network": "true",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://test.local");
  assert.equal(preflight.headers["access-control-allow-private-network"], "true");
  const allowHeaders = String(preflight.headers["access-control-allow-headers"] ?? "");
  for (const name of ["authorization", "content-type", "x-api-key", "x-session-id", "anthropic-version"]) {
    assert.ok(allowHeaders.includes(name), `preflight must allow ${name}`);
  }

  const blocked = await call(f.gatewayPort, "OPTIONS", "/v1/chat/completions", {
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  assert.equal(blocked.status, 403);

  const blockedGet = await call(f.gatewayPort, "GET", "/healthz", { headers: { origin: "https://evil.example" } });
  assert.equal(blockedGet.status, 403);
});

test("token auth accepts bearer and x-api-key, rejects missing tokens", async (t) => {
  const f = await startFixture(t);
  const closed = await call(f.gatewayPort, "GET", "/v1/models");
  assert.equal(closed.status, 401);
  const error = closed.json as { error: { type: string } };
  assert.equal(error.error.type, "authentication_error");

  const wrong = await call(f.gatewayPort, "GET", "/v1/models", { headers: { authorization: "Bearer wrong" } });
  assert.equal(wrong.status, 401);

  const viaBearer = await call(f.gatewayPort, "GET", "/v1/models", { headers: bearer });
  assert.equal(viaBearer.status, 200);
  const list = viaBearer.json as { data: Array<{ id: string }> };
  assert.equal(list.data[0]?.id, "stub-model");
  assert.equal(viaBearer.headers["x-gateway-upstream"], f.cfg.engineUrl);

  const viaApiKey = await call(f.gatewayPort, "GET", "/v1/models", { headers: { "x-api-key": "test-token" } });
  assert.equal(viaApiKey.status, 200);
});

test("OpenAI chat completions are proxied with the session header", async (t) => {
  const f = await startFixture(t);
  const reply = await call(f.gatewayPort, "POST", "/v1/chat/completions", {
    headers: { ...bearer, "x-session-id": "sess-openai" },
    body: { model: "stub-model", messages: [{ role: "user", content: "hi" }], stream: false },
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["x-session-id"], "sess-openai");
  const body = reply.json as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, "stub answer");

  const forwarded = f.stub.seen.find((row) => row.path === "/v1/chat/completions");
  assert.ok(forwarded, "stub must receive the chat completion");
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.headers["x-session-id"], "sess-openai");
  const sent = JSON.parse(forwarded.body) as { model: string };
  assert.equal(sent.model, "stub-model");
});

test("Anthropic messages require anthropic-version and forward it", async (t) => {
  const f = await startFixture(t);
  const before = f.stub.seen.length;
  const missing = await call(f.gatewayPort, "POST", "/v1/messages", {
    headers: bearer,
    body: { model: "stub-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(missing.status, 400);
  assert.equal(f.stub.seen.length, before, "invalid request must not reach the engine");

  const reply = await call(f.gatewayPort, "POST", "/v1/messages", {
    headers: { ...bearer, "anthropic-version": "2023-06-01", "x-session-id": "sess-anthropic" },
    body: { model: "stub-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(reply.status, 200);
  const forwarded = f.stub.seen.find((row) => row.path === "/v1/messages");
  assert.ok(forwarded, "stub must receive the Anthropic message");
  assert.equal(forwarded.headers["anthropic-version"], "2023-06-01");
  assert.equal(forwarded.headers["x-session-id"], "sess-anthropic");
});

test("streaming is relayed as real SSE and logged with first-token timing", async (t) => {
  const f = await startFixture(t);
  const reply = await call(f.gatewayPort, "POST", "/v1/chat/completions", {
    headers: { ...bearer, "x-session-id": "sess-stream", "x-lama-client": "opencode" },
    body: { model: "stub-model", messages: [{ role: "user", content: "hi" }], stream: true },
  });
  assert.equal(reply.status, 200);
  assert.match(String(reply.headers["content-type"]), /text\/event-stream/);
  assert.equal(reply.headers["x-accel-buffering"], "no");
  assert.match(reply.body, /"delta":\{"content":"stub "\}/);
  assert.match(reply.body, /data: \[DONE\]/);

  const logged = f.store.listRequests({ limit: 10 }).find((row) => row.endpoint === "/v1/chat/completions");
  assert.ok(logged, "a stream must write one request row");
  assert.equal(logged.stream, 1);
  assert.equal(logged.transport_id, "http");
  assert.equal(logged.client_adapter, "opencode");
  assert.notEqual(logged.first_token_ms, null);
  assert.ok(logged.bytes > 0);

  const messages = f.store.listSessionMessages("sess-stream");
  assert.deepEqual(
    messages.map((row) => [row.role, row.content]),
    [
      ["user", "hi"],
      ["assistant", "stub answer"],
    ],
  );
});

test("successful completions persist a request log and the session turn", async (t) => {
  const f = await startFixture(t);
  const reply = await call(f.gatewayPort, "POST", "/v1/chat/completions", {
    headers: { ...bearer, "x-session-id": "sess-log-1" },
    body: { model: "stub-model", messages: [{ role: "user", content: "hello log" }], stream: false },
  });
  assert.equal(reply.status, 200);

  const logged = f.store.listRequests({ limit: 10 }).find((row) => row.endpoint === "/v1/chat/completions");
  assert.ok(logged, "request log row must be written");
  assert.equal(logged.status, 200);
  assert.equal(logged.ok, 1);
  assert.equal(logged.protocol, "openai");
  assert.equal(logged.method, "POST");
  assert.equal(logged.model_key, "stub-model");
  assert.equal(logged.stream, 0);

  const sessions = f.store.listSessions();
  const session = sessions.find((row) => row.id === "sess-log-1");
  assert.ok(session, "session row must be created from the x-session-id header");
  assert.equal(session.title, "hello log");

  const messages = f.store.listSessionMessages("sess-log-1");
  assert.deepEqual(
    messages.map((row) => [row.role, row.content]),
    [
      ["user", "hello log"],
      ["assistant", "stub answer"],
    ],
  );
});

test("failed requests are logged with their status and stream flag", async (t) => {
  const f = await startFixture(t);
  const unauthorized = await call(f.gatewayPort, "GET", "/v1/models");
  assert.equal(unauthorized.status, 401);
  const streamed = await call(f.gatewayPort, "POST", "/v1/chat/completions", {
    headers: bearer,
    body: { model: "stub-model", messages: [{ role: "user", content: "hi" }], stream: true },
  });
  assert.equal(streamed.status, 200);

  const rows = f.store.listRequests({ limit: 10 });
  const rejected = rows.find((row) => row.status === 401);
  assert.ok(rejected, "401 must be written to request_logs");
  assert.equal(rejected.ok, 0);
  assert.equal(rejected.endpoint, "/v1/models");

  const delivered = rows.find((row) => row.endpoint === "/v1/chat/completions");
  assert.ok(delivered, "the stream must write a request row");
  assert.equal(delivered.ok, 1);
  assert.equal(delivered.stream, 1);
});

test("engine-down returns 502 instead of a hang", async (t) => {
  const f = await startFixture(t);
  f.cfg.engineUrl = "http://127.0.0.1:1";
  f.cfg.enginePort = 1;
  const reply = await call(f.gatewayPort, "POST", "/v1/chat/completions", {
    headers: bearer,
    body: { model: "stub-model", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(reply.status, 502);
  const body = reply.json as { error: { type: string } };
  assert.equal(body.error.type, "engine_unavailable");
});

test("api state exposes counts and gateway metadata", async (t) => {
  const f = await startFixture(t);
  const unauthorized = await call(f.gatewayPort, "GET", "/api/state");
  assert.equal(unauthorized.status, 401);

  const reply = await call(f.gatewayPort, "GET", "/api/state", { headers: bearer });
  assert.equal(reply.status, 200);
  const body = reply.json as {
    ok: boolean;
    service: string;
    gateway: { origins: string[] };
    counts: { models: number; transports: number; mcp: number };
  };
  assert.equal(body.ok, true);
  assert.equal(body.service, "lama-gateway");
  assert.deepEqual(body.gateway.origins, ["https://test.local"]);
  assert.equal(typeof body.counts.models, "number");
});

test("gateway mounts admin API, streams OpenAI SSE, and records the adapter and transport", async (t) => {
  const f = await startFixture(t);

  const adapters = await call(f.gatewayPort, "GET", "/api/adapters", { headers: bearer });
  assert.equal(adapters.status, 200, "admin API must be reachable on the gateway port");
  const ids = ((adapters.json as { adapters: Array<{ id: string }> }).adapters ?? []).map((row) => row.id);
  assert.ok(ids.includes("opencode"), `adapter list must include opencode, got ${ids.join(",")}`);

  const page = await call(f.gatewayPort, "GET", "/admin/");
  assert.equal(page.status, 200, "admin UI is a gateway route, not a second process");
  assert.match(String(page.headers["content-type"]), /text\/html/);

  const streamed = await call(f.gatewayPort, "POST", "/v1/chat/completions", {
    headers: {
      ...bearer,
      "x-session-id": "sess-accept",
      "x-lama-client": "opencode",
      accept: "text/event-stream",
    },
    body: { model: "stub-model", messages: [{ role: "user", content: "prove it" }], stream: true },
  });
  assert.equal(streamed.status, 200);
  assert.match(String(streamed.headers["content-type"]), /text\/event-stream/);
  assert.match(streamed.body, /data: \{"id":"chatcmpl-test"/);
  assert.match(streamed.body, /"content":"stub "/);
  assert.match(streamed.body, /data: \[DONE\]/);

  const row = f.store.listRequests({ limit: 1 })[0];
  assert.ok(row, "the stream must leave a request log row");
  assert.equal(row.endpoint, "/v1/chat/completions");
  assert.equal(row.transport_id, "http", "transport_id must name the listener that accepted the call");
  assert.equal(row.client_adapter, "opencode", "client_adapter must come from x-lama-client");
  assert.equal(row.stream, 1);
  assert.equal(row.status, 200);
  assert.notEqual(row.first_token_ms, null);
});

test("the same routes answer on the gateway UDS and log transport_id=uds", async (t) => {
  const f = await startFixture(t);
  const socketPath = path.join(f.root, "gateway.sock");
  const server = createGatewayServer({
    store: f.store,
    cfg: f.cfg,
    os: testOs(),
    engine: f.engine,
    transportId: "uds",
  });
  await listenGatewayUds(server, socketPath);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const reply = await callUds(socketPath, "GET", "/v1/models", { headers: bearer });
  assert.equal(reply.status, 200);
  const list = reply.json as { data: Array<{ id: string }> };
  assert.equal(list.data[0]?.id, "stub-model");

  const row = f.store.listRequests({ limit: 1 })[0];
  assert.ok(row, "a UDS call must be logged");
  assert.equal(row.transport_id, "uds", "transport_id must name the socket that accepted the call");

  const page = await callUds(socketPath, "GET", "/healthz");
  assert.equal(page.status, 200, "admin/gateway routes share the same handler on UDS");
});

test("LAMA_GATEWAY_ENGINE=uds forwards over the engine socket, not TCP", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-uds-engine-"));
  const socketPath = path.join(root, "engine.sock");
  const stub = await startStubEngine(socketPath);
  const cfg = testConfig(root);
  cfg.apiAuth = "required";
  cfg.apiKey = "test-token";
  cfg.adminToken = "test-token";
  cfg.gatewayEngine = "uds";
  cfg.udsPath = socketPath;
  cfg.enginePort = 1;
  cfg.engineUrl = "http://127.0.0.1:1";
  cfg.webDir = path.resolve("web");
  const store = new Store(cfg.dbFile);
  const engine = new EngineManager(store, cfg, testOs());
  const server = createGatewayServer({ store, cfg, os: testOs(), engine, transportId: "http" });
  await listenGatewayServer(server, "127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway did not bind a TCP port");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stub.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const reply = await call(address.port, "GET", "/v1/models", { headers: bearer });
  assert.equal(reply.status, 200);
  assert.match(String(reply.headers["x-gateway-upstream"]), /^unix:/);
  assert.equal(stub.seen.length, 1, "the UDS engine stub must receive the call");
  assert.equal(stub.seen[0]?.path, "/v1/models");
});

test("gatewayHealth recognises the gateway and a closed port", async (t) => {
  const f = await startFixture(t);
  const up = await gatewayHealth("127.0.0.1", f.gatewayPort);
  assert.equal(up.up, true);
  assert.match(up.detail, /lama-gateway/);

  const down = await gatewayHealth("127.0.0.1", 1, 300);
  assert.equal(down.up, false);
});
