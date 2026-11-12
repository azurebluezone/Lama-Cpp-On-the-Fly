import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdminServer } from "../src/admin.ts";
import { Store, seedStore } from "../src/db.ts";
import { EngineManager } from "../src/engine.ts";
import { testConfig, testOs } from "./helpers.ts";

/**
 * The Logs view is only honest if /api/events really streams named SSE frames. This test keeps
 * a live connection open, triggers a real admin action and waits for the audit frame it causes.
 */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, timeoutMs = 5000): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (!buffer.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${needle}; buffer=${buffer.slice(0, 300)}`);
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), remaining)),
    ]);
    if (next.done) throw new Error(`stream ended before ${needle}; buffer=${buffer.slice(0, 300)}`);
    buffer += decoder.decode(next.value, { stream: true });
  }
  return buffer;
}

async function withAdmin(run: (base: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-events-"));
  const cfg = testConfig(root);
  cfg.webDir = path.resolve("web");
  const osInfo = testOs();
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, osInfo);
  const engine = new EngineManager(store, cfg, osInfo);
  const server = createAdminServer({ store, cfg, os: osInfo, engine });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("SSE requires the admin token", async () => {
  await withAdmin(async (base) => {
    assert.equal((await fetch(`${base}/api/events`)).status, 401);
    assert.equal((await fetch(`${base}/api/events`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  });
});

test("SSE sends hello then broadcasts a real audit event", async () => {
  await withAdmin(async (base) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, {
      headers: { authorization: "Bearer test-token", accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(response.headers.get("cache-control") ?? "", /no-cache/);
    const reader = response.body!.getReader();
    try {
      const hello = await readUntil(reader, "event: hello");
      assert.match(hello, /retry: 3000/);
      assert.match(hello, /"clients":1/);

      const parse = await fetch(`${base}/api/tools/parse`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ text: "TOOL: read_file\nPATH: README.md\n" }),
      });
      assert.equal(parse.status, 200);

      const audit = await readUntil(reader, "event: audit");
      assert.match(audit, /"action":"tools.parse"/);
      assert.match(audit, /"actor":"admin"/);
    } finally {
      controller.abort();
      reader.releaseLock();
    }
  });
});
