import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store, seedStore } from "../src/db.ts";
import { buildTransportDocs, docsToMarkdown } from "../src/docs.ts";
import { testConfig, testOs } from "./helpers.ts";

/**
 * The Transports view renders exactly what this generator returns, and the .md download is the
 * same data. The tests read the real seeded transports so a copy-pasted curl block must point
 * at the configured endpoint, not a hard-coded one.
 */
function seeded(): { store: Store; cfg: ReturnType<typeof testConfig> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-docs-"));
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, testOs());
  return { store, cfg };
}

test("HTTP docs carry the live endpoint, model alias and runnable curl blocks", () => {
  const { store, cfg } = seeded();
  const transport = store.getTransport("http");
  assert.ok(transport);
  const docs = buildTransportDocs(store, cfg, transport, "tiny-model");

  const endpoint = `http://${cfg.engineHost}:${cfg.enginePort}`;
  assert.equal(docs.transport.endpoint, endpoint);
  assert.equal(docs.model_alias, "tiny-model");
  const ids = docs.sections.map((section) => section.id);
  for (const id of ["connection", "models", "openai-chat", "anthropic-messages", "system-prompt", "parser", "errors", "realtime"]) {
    assert.ok(ids.includes(id), `missing section ${id}`);
  }

  const code = docs.sections.flatMap((section) => section.blocks).filter((block) => block.kind === "code");
  assert.ok(code.length >= 4);
  assert.ok(code.some((block) => block.text?.includes(`${endpoint}/v1/chat/completions`)));
  assert.ok(code.some((block) => block.text?.includes('"stream":true')));
  assert.ok(code.some((block) => block.text?.includes('"tools"')));
  assert.ok(docs.sections.every((section) => section.summary.length > 0));
});

test("UDS docs use --unix-socket and never the TCP host", () => {
  const { store, cfg } = seeded();
  const transport = store.getTransport("uds");
  assert.ok(transport);
  const docs = buildTransportDocs(store, cfg, transport, "tiny-model");

  assert.equal(docs.transport.endpoint, cfg.udsPath);
  const code = docs.sections.flatMap((section) => section.blocks).filter((block) => block.kind === "code");
  assert.ok(code.some((block) => block.text?.includes(`--unix-socket ${cfg.udsPath}`)));
  assert.ok(code.some((block) => block.text?.includes("socketPath")));
  assert.ok(!code.some((block) => block.text?.includes("http://127.0.0.1:19931")));
  assert.ok(code.some((block) => block.text?.includes("http://localhost/v1/chat/completions")));
});

test("markdown export keeps headings, tables and fences and leaks no token", () => {
  const { store, cfg } = seeded();
  const transport = store.getTransport("http");
  assert.ok(transport);
  const markdown = docsToMarkdown(buildTransportDocs(store, cfg, transport, "tiny-model"));

  assert.match(markdown, /^# HTTP loopback — integration guide/m);
  assert.match(markdown, /^## OpenAI-compatible chat$/m);
  assert.match(markdown, /Streaming: send "stream": true/);
  assert.match(markdown, /\| Field \| Value \|/);
  assert.match(markdown, /```bash/);
  assert.match(markdown, /\/api\/events/);
  assert.ok(!markdown.includes(cfg.adminToken), "admin token must never appear in docs");
  assert.ok(!markdown.includes("LAMA_ENGINE_API_KEY="), "docs must not print a value for the engine key");
});
