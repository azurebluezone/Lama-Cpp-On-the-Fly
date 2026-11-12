import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store, seedStore } from "../src/db.ts";
import type { RequestLogInput } from "../src/types.ts";
import { testConfig, testOs } from "./helpers.ts";

/**
 * Migration v3 and the telemetry tables are what make the Logs view, the per-model counters
 * and the MCP usage matrix real. These tests read the SQLite schema directly and then drive
 * the store methods the admin calls, so "the numbers show up" is proven, not assumed.
 */
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-telemetry-"));
  const store = new Store(testConfig(root).dbFile);
  seedStore(store, testConfig(root), testOs());
  return store;
}

test("migration v3 creates request_logs, tool_usage, mcp_tools and the MCP status columns", () => {
  const store = freshStore();
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => (row as { name: string }).name);
  for (const name of ["request_logs", "tool_usage", "mcp_tools"]) assert.ok(tables.includes(name), `${name} missing`);

  const versions = store.db
    .prepare("SELECT version FROM lama_manager_migrations ORDER BY version")
    .all()
    .map((row) => (row as { version: number }).version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6]);

  const mcpColumns = store.db
    .prepare("PRAGMA table_info(mcp_servers)")
    .all()
    .map((row) => (row as { name: string }).name);
  for (const column of ["status", "last_probe_at", "last_probe_detail", "use_count", "tools_count"]) {
    assert.ok(mcpColumns.includes(column), `mcp_servers.${column} missing`);
  }
});

test("request logs round-trip and aggregate per model and transport", () => {
  const store = freshStore();
  const base: RequestLogInput = {
    model_id: "m1",
    model_key: "tiny",
    provider_id: "llamacpp",
    transport_id: "http",
    client_adapter: "test",
    user_agent: "node-test",
    protocol: "openai",
    endpoint: "http://127.0.0.1:19931/v1/chat/completions",
    method: "POST",
    status: 200,
    ok: 1,
    stream: 0,
    duration_ms: 40,
    first_token_ms: null,
    prompt_tokens: 10,
    completion_tokens: 5,
    bytes: 120,
    system_prompt_id: "system",
    detail: "",
  };
  store.logRequest(base);
  store.logRequest({ ...base, status: 500, ok: 0, duration_ms: 60, prompt_tokens: 4, completion_tokens: 0, detail: "engine 500" });
  store.logRequest({ ...base, transport_id: "uds", protocol: "anthropic", stream: 1, duration_ms: 100, prompt_tokens: 8, completion_tokens: 12 });
  store.logRequest({
    ...base,
    model_id: "m2",
    model_key: "second",
    status: 0,
    ok: 0,
    duration_ms: 7,
    prompt_tokens: null,
    completion_tokens: null,
    detail: "client aborted the stream",
  });

  assert.equal(store.listRequests({ limit: 10 }).length, 4);
  assert.equal(store.listRequests({ transport_id: "uds" }).length, 1);
  assert.equal(store.listRequests({ protocol: "openai", ok: true }).length, 1);
  assert.equal(store.listRequests({ model_id: "m2" })[0]?.detail, "client aborted the stream");

  const stats = store.requestStats();
  const http = stats.find((row) => row.model_id === "m1" && row.transport_id === "http");
  assert.deepEqual(
    http && { total: http.total, ok: http.ok, failed: http.failed, prompt: http.prompt_tokens, completion: http.completion_tokens },
    { total: 2, ok: 1, failed: 1, prompt: 14, completion: 5 },
  );
  const uds = stats.find((row) => row.transport_id === "uds");
  assert.equal(uds?.total, 1);
  assert.equal(uds?.completion_tokens, 12);
  assert.equal(store.requestStats(1).length, stats.length);
});

test("tool usage increments the server counter and aggregates per tool", () => {
  const store = freshStore();
  const before = store.getMcp("lama-tools")?.use_count ?? 0;
  store.logToolUsage({ tool: "read_file", mcp_id: "lama-tools", ok: true, duration_ms: 4, detail: "README.md" });
  store.logToolUsage({ tool: "read_file", mcp_id: "lama-tools", ok: false, duration_ms: 9, detail: "denied" });
  store.logToolUsage({ tool: "list_dir", mcp_id: "lama-tools", ok: true, duration_ms: 2 });

  const [first] = store.toolUsageStats();
  assert.equal(first?.tool, "read_file");
  assert.equal(first?.calls, 2);
  assert.equal(first?.ok, 1);
  assert.equal(first?.failed, 1);
  assert.equal(store.getMcp("lama-tools")?.use_count, before + 3);

  store.upsertMcpTool({ id: "lama-tools:read_file", mcp_id: "lama-tools", name: "read_file", description: "read", use_cases: "", enabled: 1 });
  store.upsertMcpTool({ id: "lama-tools:list_dir", mcp_id: "lama-tools", name: "list_dir", description: "list", use_cases: "", enabled: 1 });
  store.toggleMcpTool("read_file", false);
  const tools = store.listMcpTools("lama-tools");
  assert.equal(tools.find((tool) => tool.name === "read_file")?.enabled, 0);
  assert.deepEqual(tools.map((tool) => tool.name).filter((name) => ["read_file", "list_dir"].includes(name)).sort(), ["list_dir", "read_file"]);
});
