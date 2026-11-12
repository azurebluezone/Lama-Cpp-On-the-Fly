import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store, retryDatabaseLocked, seedStore } from "../src/db.ts";
import { testConfig, testOs } from "./helpers.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lama-db-"));
}

test("schema seeds provider, transports, documents, prompt and the llama-tools MCP row", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "models"), { recursive: true });
  fs.writeFileSync(path.join(root, "models", "tiny-model.Q4_K_M.gguf"), "not a real model");
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, testOs());

  assert.equal(store.getProvider("llamacpp")?.id, "llamacpp");
  assert.ok(store.getTransport("http"));
  assert.ok(store.getTransport("uds"));
  assert.ok(store.getDocumentBySlug("openai-http"));
  assert.ok(store.getDocumentBySlug("anthropic-http"));
  assert.ok(store.defaultPrompt());
  assert.equal(store.getMcp("lama-tools")?.transport, "stdio");
  assert.equal(store.listModels().length, 1);
  assert.equal(store.listModels()[0]?.id, "tiny-model-q4-k-m");
});

test("engine-native https row follows LAMA_TLS, not cert-file presence", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "models"), { recursive: true });
  fs.mkdirSync(path.join(root, "certs"), { recursive: true });
  fs.writeFileSync(path.join(root, "certs", "localhost-key.pem"), "key");
  fs.writeFileSync(path.join(root, "certs", "localhost-cert.pem"), "cert");
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, testOs());
  assert.equal(store.getTransport("https"), undefined, "TLS-off seed must not expose the engine-native https row");
  cfg.tls = true;
  seedStore(store, cfg, testOs());
  assert.ok(store.getTransport("https"), "TLS-on seed must expose the engine-native https row");
});

test("seeding skips a GGUF already registered under a custom row id", () => {
  // Regression: models has UNIQUE(provider_id, model_id). A file registered
  // through the admin with a custom id but the filename-slug alias used to make
  // every later boot crash on the seed insert.
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "models"), { recursive: true });
  fs.writeFileSync(path.join(root, "models", "tiny-model.Q4_K_M.gguf"), "not a real model");
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, testOs());
  // The admin registers after the boot seed: remove the auto row, then put the
  // same file back under a custom id with the filename-slug alias.
  store.deleteModel("tiny-model-q4-k-m");
  store.upsertModel({
    id: "custom-id",
    provider_id: "llamacpp",
    name: "tiny",
    model_id: "tiny-model-q4-k-m",
    path: path.join(root, "models", "tiny-model.Q4_K_M.gguf"),
    context: 4096,
    max_tokens: 1024,
    temperature: 0.7,
    quant: null,
    load_mode: "auto",
    ttl_hours: cfg.defaultTtlHours,
    enabled: 1,
    metadata_json: "{}",
  });

  seedStore(store, cfg, testOs());
  seedStore(store, cfg, testOs());

  assert.equal(store.listModels().length, 1, "the seed must not add a second row for the same file");
  assert.equal(store.getModel("tiny-model-q4-k-m"), undefined, "the filename-slug row must stay absent");
  assert.equal(store.getModel("custom-id")?.path, path.join(root, "models", "tiny-model.Q4_K_M.gguf"));
});

test("prompt update increments the stored version", () => {
  const root = tempRoot();
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, testOs());
  // One prompt only: the bootstrap row is id "system" (file-managed).
  assert.equal(store.listPrompts().map((row) => row.id).join(","), "system");
  store.upsertPrompt({ id: "system", name: "system", content: "first", version: 1, is_default: 1, metadata_json: "{}" });
  assert.equal(store.getPrompt("system")?.version, 2);
  store.upsertPrompt({ id: "system", name: "system", content: "second", version: 1, is_default: 1, metadata_json: "{}" });
  assert.equal(store.getPrompt("system")?.version, 3);
});

test("engine state round-trips through SQLite", () => {
  const root = tempRoot();
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  store.setEngineState({
    model_id: "m1",
    pid: 1234,
    status: "running",
    started_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-01-01T04:00:00.000Z",
    load_mode: "auto",
    socket_path: cfg.udsPath,
    port: 19931,
    build: "b11982",
    last_error: null,
  });
  const state = store.engineState();
  assert.equal(state.model_id, "m1");
  assert.equal(state.status, "running");
  assert.equal(state.load_mode, "auto");
  assert.equal(store.listAudit().length, 0);
});

test("boot retry waits out a locked database instead of crashing", () => {
  let calls = 0;
  const delays: number[] = [];
  const result = retryDatabaseLocked(
    () => {
      calls += 1;
      if (calls < 3) throw new Error("database is locked");
      return "opened";
    },
    { attempts: 5, delayMs: 1, onRetry: (_attempt, delay) => delays.push(delay) },
  );
  assert.equal(result, "opened");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1, 2]);
});

test("boot retry gives up after its budget and rethrows the lock", () => {
  let calls = 0;
  assert.throws(
    () =>
      retryDatabaseLocked(
        () => {
          calls += 1;
          throw new Error("database is locked");
        },
        { attempts: 3, delayMs: 1 },
      ),
    /database is locked/,
  );
  assert.equal(calls, 3);
});

test("boot retry never hides an unrelated failure", () => {
  let calls = 0;
  assert.throws(
    () =>
      retryDatabaseLocked(
        () => {
          calls += 1;
          throw new Error("no such table: nope");
        },
        { attempts: 4, delayMs: 1 },
      ),
    /no such table/,
  );
  assert.equal(calls, 1);
});
