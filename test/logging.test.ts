import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendJsonLine, detectMcpTools, listLogFiles, ResponseLogger, safeLogName } from "../src/logging.ts";
import { testConfig } from "./helpers.ts";

/**
 * The owner asked for one log file per transport and one per model, with the
 * model, the protocol, the client, the MCP tool execution, the duration and
 * the token counts in every entry. These tests prove the files and the fields.
 */
function tempConfig(): ReturnType<typeof testConfig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-logging-"));
  const cfg = testConfig(root);
  fs.mkdirSync(cfg.logsDir, { recursive: true });
  return cfg;
}

function entry(overrides: Record<string, unknown> = {}): Parameters<ResponseLogger["log"]>[0] {
  return {
    at: new Date().toISOString(),
    transport: "http",
    transport_protocol: "http",
    model: "deepseek-v4-pro",
    model_alias: "deepseek-v4-pro",
    protocol: "openai",
    client: "opencode",
    user_agent: "opencode/1.0",
    session: "sess-1",
    endpoint: "/v1/chat/completions",
    method: "POST",
    status: 200,
    ok: true,
    stream: false,
    mcp_tool_executed: false,
    mcp_tools: [],
    cache_hit: false,
    duration_ms: 120,
    first_token_ms: 40,
    prompt_tokens: 30,
    completion_tokens: 12,
    total_tokens: 42,
    bytes: 512,
    grammar: null,
    detail: "",
    ...overrides,
  };
}

test("a response is written to one transport file and one model file", () => {
  const cfg = tempConfig();
  const logger = new ResponseLogger(cfg);
  logger.log(entry());

  assert.ok(fs.existsSync(path.join(cfg.logsDir, "transport-http.log")));
  assert.ok(fs.existsSync(path.join(cfg.logsDir, "model-deepseek-v4-pro.log")));

  const rows = fs
    .readFileSync(path.join(cfg.logsDir, "transport-http.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.model, "deepseek-v4-pro");
  assert.equal(rows[0]?.protocol, "openai");
  assert.equal(rows[0]?.client, "opencode");
  assert.equal(rows[0]?.duration_ms, 120);
  assert.equal(rows[0]?.total_tokens, 42);
});

test("two transports get two files and two models get two files", () => {
  const cfg = tempConfig();
  const logger = new ResponseLogger(cfg);
  logger.log(entry({ transport: "http", model: "model-a" }));
  logger.log(entry({ transport: "uds", model: "model-b" }));

  assert.ok(fs.existsSync(path.join(cfg.logsDir, "transport-http.log")));
  assert.ok(fs.existsSync(path.join(cfg.logsDir, "transport-uds.log")));
  assert.ok(fs.existsSync(path.join(cfg.logsDir, "model-model-a.log")));
  assert.ok(fs.existsSync(path.join(cfg.logsDir, "model-model-b.log")));
  assert.equal(listLogFiles(cfg).length, 4);
});

test("the entry records the MCP tool execution and the token counts", () => {
  const cfg = tempConfig();
  const logger = new ResponseLogger(cfg);
  logger.log(
    entry({
      mcp_tool_executed: true,
      mcp_tools: ["read_file"],
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      grammar: 'root ::= "ok"',
    }),
  );
  const row = JSON.parse(
    fs.readFileSync(path.join(cfg.logsDir, "transport-http.log"), "utf8").trim(),
  ) as Record<string, unknown>;
  assert.equal(row.mcp_tool_executed, true);
  assert.deepEqual(row.mcp_tools, ["read_file"]);
  assert.equal(row.total_tokens, 18);
  assert.equal(row.grammar, 'root ::= "ok"');
});

test("a response without a model still lands in the transport file", () => {
  const cfg = tempConfig();
  const logger = new ResponseLogger(cfg);
  logger.log(entry({ model: null, model_alias: null }));
  assert.ok(fs.existsSync(path.join(cfg.logsDir, "transport-http.log")));
  assert.ok(fs.existsSync(path.join(cfg.logsDir, "model-unknown.log")));
});

test("a log file name never escapes the logs directory", () => {
  assert.equal(safeLogName("../../etc/passwd"), "etc-passwd");
  assert.equal(safeLogName(""), "unknown");
  assert.equal(safeLogName(".."), "unknown");
  assert.equal(safeLogName("UPPER Case/../x"), "upper-case-.-x");
  // No output name may contain a path separator or climb out of the folder.
  for (const value of ["../../etc/passwd", "..", "a/b", "a\\b", "/abs/path"]) {
    const name = safeLogName(value);
    assert.doesNotMatch(name, /\.\./);
    assert.doesNotMatch(name, /[/\\]/);
  }
});

test("detectMcpTools finds the tool names in an OpenAI and an Anthropic payload", () => {
  const openai = {
    choices: [{ message: { tool_calls: [{ function: { name: "read_file" } }] } }],
  };
  assert.deepEqual(detectMcpTools(openai), ["read_file"]);

  const anthropic = {
    content: [{ type: "tool_use", name: "write_file" }],
  };
  assert.deepEqual(detectMcpTools(anthropic), ["write_file"]);

  assert.deepEqual(detectMcpTools({ choices: [{ message: { content: "hi" } }] }), []);
  assert.deepEqual(detectMcpTools(null), []);
});

test("appendJsonLine appends one JSON object per line", () => {
  const cfg = tempConfig();
  const file = path.join(cfg.logsDir, "plain.log");
  appendJsonLine(file, { a: 1 });
  appendJsonLine(file, { b: 2 });
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).a, 1);
  assert.equal(JSON.parse(lines[1]!).b, 2);
});
