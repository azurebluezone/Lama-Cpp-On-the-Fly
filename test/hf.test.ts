import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store, seedStore } from "../src/db.ts";
import { clearToken, getToken, maskToken, resolveUrl, sanitizeFileName, setToken } from "../src/hf.ts";
import { testConfig, testOs } from "./helpers.ts";

/**
 * The HF CLI shares its token store and download table with the admin API, so
 * these tests pin the schema (migration v4), the secret handling (masking,
 * masked audit targets) and the pure URL/name guards that keep a download
 * inside the models directory. Network behaviour is covered by `hf smoke`.
 */
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-hf-"));
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, testOs());
  return store;
}

test("migration v4 creates model_downloads and stores are versioned", () => {
  const store = freshStore();
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => (row as { name: string }).name);
  assert.ok(tables.includes("model_downloads"), "model_downloads missing");

  const versions = store.db
    .prepare("SELECT version FROM lama_manager_migrations ORDER BY version")
    .all()
    .map((row) => (row as { version: number }).version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6]);

  const columns = store.db
    .prepare("PRAGMA table_info(model_downloads)")
    .all()
    .map((row) => (row as { name: string }).name);
  for (const column of ["repo", "file", "path", "bytes_total", "bytes_done", "status", "error", "started_at", "finished_at"]) {
    assert.ok(columns.includes(column), `model_downloads.${column} missing`);
  }
});

test("download rows round-trip: start, progress, finish and failure", () => {
  const store = freshStore();
  const row = store.startDownload("owner/repo", "file.gguf", "/tmp/file.gguf");
  assert.equal(row.status, "running");
  assert.equal(row.bytes_done, 0);

  store.updateDownload(row.id, 512, 1024);
  const progressed = store.downloadRow(row.id)!;
  assert.equal(progressed.bytes_done, 512);
  assert.equal(progressed.bytes_total, 1024);

  store.finishDownload(row.id, "/tmp/file.gguf", 1024);
  const done = store.downloadRow(row.id)!;
  assert.equal(done.status, "done");
  assert.equal(done.bytes_done, 1024);
  assert.ok(done.finished_at, "finished_at missing");

  const failed = store.startDownload("owner/repo", "other.gguf", "/tmp/other.gguf");
  store.failDownload(failed.id, "network down");
  assert.equal(store.downloadRow(failed.id)!.status, "failed");
  assert.equal(store.downloadRow(failed.id)!.error, "network down");

  assert.equal(store.listDownloads()[0]!.id, failed.id, "listDownloads must be newest first");
});

test("hf token round-trips through app_settings and is never stored masked", () => {
  const store = freshStore();
  assert.equal(getToken(store), null);

  setToken(store, "hf_abcdefghijkl");
  assert.equal(getToken(store), "hf_abcdefghijkl", "the raw token must be recoverable for HF auth");
  assert.equal(store.setting("hf_token"), "hf_abcdefghijkl");

  clearToken(store);
  assert.equal(getToken(store), null);
});

test("maskToken hides the middle of the secret", () => {
  assert.equal(maskToken("hf_abcdefghijkl"), "hf_****ijkl");
  assert.equal(maskToken("short"), "****");
  assert.notEqual(maskToken("hf_abcdefghijkl").includes("efgh"), true);
});

test("sanitizeFileName keeps downloads inside the destination directory", () => {
  assert.equal(sanitizeFileName("models/qwen.gguf"), "qwen.gguf");
  assert.equal(sanitizeFileName("../../etc/passwd.gguf"), "passwd.gguf");
  assert.equal(sanitizeFileName("weird name!.gguf"), "weird_name_.gguf");
  assert.throws(() => sanitizeFileName(""), /unsafe file name/);
  assert.throws(() => sanitizeFileName(".."), /unsafe file name/);
});

test("resolveUrl builds the canonical Hub resolve link", () => {
  assert.equal(
    resolveUrl("Qwen/Qwen2.5-0.5B-Instruct-GGUF", "qwen2.5-0.5b-instruct-q4_k_m.gguf"),
    "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
  );
  assert.equal(
    resolveUrl("/owner/repo/", "/sub/file.gguf"),
    "https://huggingface.co/owner/repo/resolve/main/sub/file.gguf",
  );
});
