import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeToolCalls, parseToolCalls, looksLikeSchemaEcho, mislabelHint } from "../src/tools/parser.ts";

const allowed = ["read_file", "write_file", "run_shell", "http_fetch"];

test("native OpenAI tool_calls are accepted", () => {
  const calls = parseNativeToolCalls([
    { id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "read_file");
  assert.deepEqual(calls[0]?.arguments, { path: "a.txt" });
});

test("Anthropic tool_use content is accepted as native input", () => {
  const result = parseToolCalls("", allowed, [
    { type: "tool_use", id: "t1", name: "write_file", input: { path: "a.txt", content: "hi" } },
  ]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.name, "write_file");
});

test("schema echo is not a call", () => {
  const echo = {
    type: "function",
    function: { name: "write_file", description: "write", parameters: { type: "object" } },
  };
  assert.equal(looksLikeSchemaEcho(echo), true);
  const result = parseToolCalls(JSON.stringify(echo), allowed);
  assert.equal(result.calls.length, 0);
  assert.equal(result.rejected[0]?.reason, "schema echo, not a call");
});

test("TOOL/PATH/CONTENT marker is recovered", () => {
  const text = "TOOL: write_file\nPATH: notes/a.txt\nCONTENT: hello\n";
  const result = parseToolCalls(text, allowed);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.source, "marker");
  assert.deepEqual(result.calls[0]?.arguments, { path: "notes/a.txt", content: "hello" });
});

test("TOOL/ARGS marker is recovered", () => {
  const text = 'TOOL: read_file\nARGS: {"path":"a.txt"}\n';
  const result = parseToolCalls(text, allowed);
  assert.equal(result.calls[0]?.name, "read_file");
  assert.deepEqual(result.calls[0]?.arguments, { path: "a.txt" });
});

test("JSON block is recovered", () => {
  const text = 'Sure.\n```json\n{"name":"http_fetch","arguments":{"url":"https://example.com"}}\n```';
  const result = parseToolCalls(text, allowed);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.source, "json");
});

test("mislabel hint points at the tool implied by arguments", () => {
  const hint = mislabelHint("run_shell", { path: "a.txt", content: "hi" }, new Set(allowed));
  assert.match(hint ?? "", /write_file/);
});

test("prose without a call returns nothing", () => {
  const result = parseToolCalls("I would read the file if I could.", allowed);
  assert.equal(result.calls.length, 0);
});
