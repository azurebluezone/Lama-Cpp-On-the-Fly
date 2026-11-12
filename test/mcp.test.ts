import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/tools.ts";
import { probeStdio } from "../src/mcp/probe.ts";
import type { McpRow } from "../src/types.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lama-mcp-"));
}

test("workspace tools write and read inside the root", async () => {
  const root = tempRoot();
  const previous = process.env.LAMA_WORKSPACE;
  process.env.LAMA_WORKSPACE = root;
  try {
    const written = (await callTool("write_file", { path: "notes/a.txt", content: "hello" })) as { bytes: number };
    assert.equal(written.bytes, 5);
    const read = (await callTool("read_file", { path: "notes/a.txt" })) as { content: string };
    assert.equal(read.content, "hello");
  } finally {
    if (previous === undefined) delete process.env.LAMA_WORKSPACE;
    else process.env.LAMA_WORKSPACE = previous;
  }
});

test("path escape and secret paths are refused", async () => {
  const root = tempRoot();
  const previous = process.env.LAMA_WORKSPACE;
  process.env.LAMA_WORKSPACE = root;
  try {
    await assert.rejects(() => callTool("read_file", { path: "../outside.txt" }), /escapes the workspace/);
    await assert.rejects(() => callTool("read_file", { path: ".ssh/id_rsa" }), /secret-looking/);
  } finally {
    if (previous === undefined) delete process.env.LAMA_WORKSPACE;
    else process.env.LAMA_WORKSPACE = previous;
  }
});

test("run_shell refuses metacharacters and non-allowlisted commands", async () => {
  // callTool is async, so failures surface as rejections, not synchronous throws.
  await assert.rejects(() => callTool("run_shell", { cmd: "ls; rm -rf /" }), /metacharacters/);
  await assert.rejects(() => callTool("run_shell", { cmd: "bash -c id" }), /allow-list/);
});

test("the MCP server answers initialize and tools/list over stdio", async () => {
  const row: McpRow = {
    id: "lama-tools",
    name: "lama-tools",
    transport: "stdio",
    command: process.execPath,
    args_json: JSON.stringify([path.resolve("src/mcp/server.ts")]),
    env_json: "{}",
    cwd: process.cwd(),
    url: null,
    api_key_ref: null,
    timeout_ms: 5000,
    enabled: 1,
    status: "unknown",
    last_probe_at: null,
    last_probe_detail: "",
    use_count: 0,
    tools_count: 0,
    metadata_json: "{}",
    created_at: "",
    updated_at: "",
  };
  const result = await probeStdio(row, 5000);
  assert.equal(result.ok, true, result.detail);
  assert.ok(result.tools.some((tool) => tool.name === "read_file"));
  assert.ok(result.tools.some((tool) => tool.name === "run_shell"));
});
