import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store, seedStore } from "../src/db.ts";
import { applySeeds } from "../src/seed.ts";
import { loadIdentity, validateIdentity } from "../src/identity.ts";
import { testConfig, testOs } from "./helpers.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lama-seed-"));
}

test("seed files populate metadata, identity and resolved paths idempotently", () => {
  const root = tempRoot();
  const cfg = testConfig(root);
  cfg.gatewayPort = 19933;
  fs.mkdirSync(cfg.modelsDir, { recursive: true });
  for (const file of ["Qwen2.5-0.5B-Instruct-Q4_K_M.gguf", "Qwen3.5-4B-UD-IQ3_XXS.gguf"]) {
    fs.writeFileSync(path.join(cfg.modelsDir, file), "not a real model");
  }
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, testOs());
  const first = applySeeds(store, cfg, testOs(), { dir: path.resolve("db/seed") });
  assert.equal(first.counts.models, 2);
  assert.equal(first.counts.documents, 5);
  // The seed file no longer ships a second default prompt: prompts/lama-system.md is the one.
  assert.equal(first.counts.prompts, 0);
  assert.equal(store.identity()?.name, "lama");
  assert.equal(store.getProvider("llamacpp")?.base_url, "http://127.0.0.1:19933");
  assert.match(store.getModel("qwen2-5-0-5b-instruct-q4-k-m")?.metadata_json ?? "", /tool_reliability/);
  assert.equal(store.getModel("qwen2-5-0-5b-instruct-q4-k-m")?.path, path.join(cfg.modelsDir, "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"));
  assert.match(store.getDocumentBySlug("openai-http")?.body ?? "", /127\.0\.0\.1:19933/);
  assert.match(store.getDocumentBySlug("openai-uds")?.body ?? "", new RegExp(cfg.udsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // seedStore leaves exactly one bootstrap row and the seed step must not add another.
  assert.equal(store.listPrompts().length, 1);
  assert.equal(store.getPrompt("system")?.id, "system");
  assert.equal(store.getPrompt("default"), undefined);
  const second = applySeeds(store, cfg, testOs(), { dir: path.resolve("db/seed") });
  assert.equal(second.counts.prompts, 0);
  assert.equal(second.skipped.prompts, 0);
  assert.equal(store.listPrompts().length, 1);
});

test("identity validation rejects incomplete manifests", () => {
  assert.throws(() => validateIdentity({ system_identity: { name: "x" } }), /version/);
  const identity = loadIdentity(tempRoot());
  assert.equal(identity.name, "lama");
  assert.equal(identity.branding.owner, "Sahon Srabon");
});

test("the store refuses the legacy JS manager database instead of corrupting it", () => {
  const root = tempRoot();
  const file = path.join(root, "legacy.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE system_prompts (id TEXT PRIMARY KEY, name TEXT, current_version_id TEXT)");
  db.close();
  assert.throws(() => new Store(file), /legacy JS manager/);
});
