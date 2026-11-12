import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGatewayServer, listenGatewayServer } from "../src/gateway/server.ts";
import { Store, seedStore } from "../src/db.ts";
import { EngineManager } from "../src/engine.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-admin-verify-"));
const dataDir = path.join(root, "data");
const cfg = {
  root,
  dataDir,
  modelsDir: path.join(root, "models"),
  logsDir: path.join(root, "logs"),
  runDir: path.join(root, "run"),
  certsDir: path.join(root, "certs"),
  webDir: path.resolve("web"),
  workspaceDir: path.join(root, "workspace"),
  dbFile: path.join(dataDir, "lama.db"),
  stateFile: path.join(dataDir, "engine.json"),
  lockFile: path.join(dataDir, "engine.lock"),
  pidFile: path.join(root, "run", "engine.pid"),
  envFile: path.join(root, ".env"),
  adminToken: "verify-token",
  gatewayHost: "127.0.0.1",
  gatewayPort: 5252,
  gatewayEngine: "http",
  gatewayUdsPath: "",
  tlsPort: 19930,
  gatewayOrigins: ["http://127.0.0.1:5252"],
  apiKey: "verify-token",
  apiAuth: "required",
  engineApiKey: "",
  engineHost: "127.0.0.1",
  enginePort: 1,
  engineUrl: "http://127.0.0.1:1",
  udsPath: path.join(root, "run", "llama.sock"),
  llamaBin: "llama-server",
  loadMode: "auto",
  accel: "cpu",
  build: null,
  tlsKey: path.join(root, "certs", "localhost-key.pem"),
  tlsCert: path.join(root, "certs", "localhost-cert.pem"),
  tls: false,
  serviceMode: "none",
  gatewayDir: path.join(root, "gateway"),
  defaultTtlHours: 4,
  warnings: [],
};
const osInfo = {
  platform: "linux",
  arch: "x64",
  distro: "ubuntu",
  distroVersion: "24.04",
  glibc: "2.39",
  isRoot: false,
  serviceManager: "systemd",
  home: "/home/test",
  pathSep: "/",
};

const store = new Store(cfg.dbFile);
seedStore(store, cfg, osInfo);
const engine = new EngineManager(store, cfg, osInfo);
const server = createGatewayServer({ store, cfg, os: osInfo, engine, transportId: "http" });
await listenGatewayServer(server, "127.0.0.1", 0);
const address = server.address();
assert.ok(address && typeof address !== "string", "gateway did not bind a TCP port");
const base = `http://127.0.0.1:${address.port}`;
const auth = { authorization: "Bearer verify-token" };

async function get(urlPath, withAuth = true) {
  const response = await fetch(base + urlPath, {
    headers: withAuth ? auth : {},
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  return { status: response.status, body, type: response.headers.get("content-type") || "" };
}

try {
  const page = await get("/admin/");
  assert.equal(page.status, 200, "GET /admin/ must serve the admin UI");
  assert.match(page.type, /text\/html/);
  const navIds = [...page.body.matchAll(/href="#([a-z]+)"/g)].map((match) => match[1]);
  const expected = [
    "metrics", "engine", "requests", "sessions", "chat", "models", "providers",
    "transports", "documents", "tools", "mcp", "runtime", "auth", "test", "audit",
  ];
  assert.deepEqual(navIds, expected, `nav must contain exactly ${expected.length} views`);
  for (const id of expected) {
    assert.ok(page.body.includes(`id="${id}"`), `missing section #${id}`);
  }
  assert.ok(page.body.includes("assets/css/style.min.css"), "Darkone CSS must be linked");
  assert.ok(page.body.includes("assets/js/vendor.min.js"), "Darkone vendor JS must be linked");

  // Each sidebar entry owns one section; the dashboard must not leak another view.
  const viewNames = [...page.body.matchAll(/class="view-section" data-view="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(viewNames, expected, `expected ${expected.length} isolated view wrappers`);
  assert.equal((page.body.match(/data-view="/g) || []).length, expected.length * 2,
    "each view needs a wrapper and a sidebar link");
  assert.ok(page.body.includes(".view-section { display: none; }"), "inactive views must be hidden");
  assert.ok(page.body.includes(".view-section.active { display: block; }"), "active view must be visible");
  assert.ok(page.body.includes("function showView("), "showView must switch views");
  assert.ok(page.body.includes("function withSpinner("), "async actions must share a spinner helper");
  assert.ok(page.body.includes('id="confirmModal"'), "destructive actions must use the template modal");
  assert.ok(page.body.includes('id="transportDetail"'), "transports need a detail panel");
  assert.ok(page.body.includes('id="tdDocs"') && page.body.includes('id="tdRequests"'),
    "transport detail must expose docs and requests");

  for (const id of expected) {
    const start = page.body.indexOf(`class="view-section" data-view="${id}"`);
    assert.ok(start >= 0, `missing view wrapper for ${id}`);
    const next = page.body.indexOf('class="view-section" data-view="', start + 1);
    const block = page.body.slice(start, next === -1 ? undefined : next);
    assert.ok(block.includes(`id="${id}"`), `view ${id} must contain its own section`);
  }
  const dashboardStart = page.body.indexOf('class="view-section" data-view="metrics"');
  const dashboardEnd = page.body.indexOf('class="view-section" data-view="engine"');
  const dashboard = page.body.slice(dashboardStart, dashboardEnd);
  assert.ok(dashboard.includes('id="dashboard-status"'), "dashboard must own the gateway/quick-action row");
  assert.ok(!dashboard.includes('id="engine"'), "dashboard must not contain the engine section");
  assert.ok(!dashboard.includes('id="chat"'), "dashboard must not contain the chat section");

  for (const asset of ["/assets/css/style.min.css", "/assets/js/vendor.min.js", "/assets/fonts/boxicons.woff2"]) {
    const reply = await get(asset, false);
    assert.equal(reply.status, 200, `${asset} must be served`);
  }

  assert.equal((await get("/api/overview", false)).status, 401, "API must reject a missing token");
  assert.equal((await get("/api/overview", true)).status, 200, "API must accept the admin token");

  const endpoints = [
    "/healthz", "/api/overview", "/api/state", "/api/requests?limit=10", "/api/requests/stats",
    "/api/sessions", "/api/models", "/api/providers", "/api/transports", "/api/documents",
    "/api/tools", "/api/mcp", "/api/mcp/matrix", "/api/mcp/config", "/api/runtime",
    "/api/prompts", "/api/system-prompt", "/api/system-prompt.txt", "/api/hf/token",
    "/api/hf/downloads", "/api/config", "/api/config/ports", "/api/auth", "/api/engine/status",
    "/api/engine/relay", "/api/engine/progress", "/api/audit?limit=10",
  ];
  for (const endpoint of endpoints) {
    const reply = await get(endpoint, endpoint !== "/healthz");
    assert.equal(reply.status, 200, `${endpoint} returned ${reply.status}: ${reply.body.slice(0, 200)}`);
    if (endpoint !== "/api/system-prompt.txt") {
      assert.match(reply.type, /application\/json/, `${endpoint} must be JSON`);
    }
  }

  const docs = await get("/api/docs/integration", true);
  assert.equal(docs.status, 200, "/api/docs/integration must answer");

  const transports = JSON.parse((await get("/api/transports", true)).body).transports;
  assert.ok(transports.length >= 1, "seed must register at least one transport");
  for (const transport of transports) {
    const reply = await get(`/api/transports/${encodeURIComponent(transport.id)}/docs`, true);
    assert.equal(reply.status, 200, `docs for ${transport.id} must answer`);
    const detail = await get(`/api/transports/${encodeURIComponent(transport.id)}`, true);
    assert.equal(detail.status, 200, `detail for ${transport.id} must answer`);
    const payload = JSON.parse(detail.body);
    assert.ok(payload.transport && payload.transport.id === transport.id, "detail must return the transport");
    assert.ok(Array.isArray(payload.requests), "detail must return requests");
    assert.ok(Array.isArray(payload.documents), "detail must return documents");
    assert.ok(payload.stats && typeof payload.stats.total === "number", "detail must return stats");
    const markdown = await get(`/api/transports/${encodeURIComponent(transport.id)}/docs.txt`, true);
    assert.equal(markdown.status, 200, `markdown docs for ${transport.id} must answer`);
    assert.match(markdown.type, /text\/markdown/, "transport docs download must be markdown");
  }

  console.log(`ADMIN_VIEWS_PASS views=${viewNames.length} dashboard=isolated transports=detail spinners=on`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
