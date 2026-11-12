import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SseParser,
  anthropicDelta,
  anthropicMessages,
  anthropicUsage,
  inspectProcessMaps,
  linkSocket,
  openaiChat,
  openaiChatStream,
  openaiDelta,
  openaiUsage,
  parseSseData,
  readFileView,
  requestUds,
} from "../src/transport/index.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lama-uds-"));
}

test("requestUds talks to a real HTTP server on a Unix socket", async () => {
  const root = tempRoot();
  const socket = path.join(root, "test.sock");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  try {
    const result = await requestUds(socket, "/health", { timeoutMs: 5000 });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), { ok: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(socket, { force: true });
  }
});

test("linkSocket creates a symlink and is idempotent", async () => {
  const root = tempRoot();
  const socket = path.join(root, "engine.sock");
  const gateway = path.join(root, "gateway");
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  try {
    const first = linkSocket(socket, gateway);
    assert.equal(first.changed, true);
    assert.equal(fs.readlinkSync(first.target), socket);
    const second = linkSocket(socket, gateway);
    assert.equal(second.changed, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(socket, { force: true });
  }
});

test("SseParser keeps state across chunks and flushes a partial event", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(": ping\n\n"), []);
  assert.deepEqual(parser.push('event: delta\ndata: {"a":'), []);
  assert.deepEqual(parser.push("1}\n\n"), [{ event: "delta", data: '{"a":1}' }]);

  const split = new SseParser();
  const events = [
    ...split.push('id: 7\nretry: 1500\nevent: message\ndata: line1\ndata: line2\n\n'),
    ...split.push("event: tail\ndata: last"),
  ];
  assert.deepEqual(events[0], { event: "message", data: "line1\nline2", id: "7", retry: 1500 });
  assert.deepEqual(split.flush(), [{ event: "tail", data: "last" }]);
  assert.deepEqual(split.flush(), []);

  assert.deepEqual(parseSseData({ event: "message", data: '{"ok":true}' }), { ok: true });
  assert.equal(parseSseData({ event: "message", data: "[DONE]" }), null);
  assert.equal(parseSseData({ event: "message", data: "not json" }), null);
});

test("OpenAI stream deltas and usage are read from real payload shapes", () => {
  assert.equal(openaiDelta({ choices: [{ delta: { content: "Hel" } }] }), "Hel");
  assert.equal(openaiDelta({ choices: [{ message: { content: "full" } }] }), "full");
  assert.equal(
    openaiDelta({ choices: [{ delta: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] } }] }),
    "AB",
  );
  assert.equal(openaiDelta({ choices: [] }), "");
  assert.deepEqual(openaiUsage({ usage: { prompt_tokens: 11, completion_tokens: 4 } }), {
    prompt_tokens: 11,
    completion_tokens: 4,
  });
  assert.equal(openaiUsage({}), null);
});

test("Anthropic deltas and usage are read from real payload shapes", () => {
  assert.equal(anthropicDelta({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }), "Hi");
  assert.equal(
    anthropicDelta({ type: "content_block_start", content_block: { type: "text", text: "Start" } }),
    "Start",
  );
  assert.equal(anthropicDelta({ type: "message_start" }), "");
  assert.deepEqual(
    anthropicUsage({ type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } }),
    { input_tokens: 9, output_tokens: 0 },
  );
  assert.equal(anthropicUsage({}), null);
});

async function startJsonStub(): Promise<{ port: number; seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }>; stop: () => Promise<void> }> {
  const seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub");
      seen.push({ path: url.pathname, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (url.pathname === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: delta\ndata: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      const text = '{"ok":true}\n';
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
      res.end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub did not bind a port");
  return {
    port: address.port,
    seen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("OpenAI and Anthropic modules hit the real routes with their headers", async () => {
  const stub = await startJsonStub();
  try {
    const transport = { protocol: "http" as const, host: "127.0.0.1", port: stub.port, socket_path: null };
    const chat = await openaiChat(transport, { model: "m", messages: [{ role: "user", content: "hi" }] });
    assert.equal(chat.status, 200);
    assert.equal(stub.seen[0]?.path, "/v1/chat/completions");
    assert.equal(JSON.parse(stub.seen[0]!.body).model, "m");

    const messages = await anthropicMessages(transport, {
      model: "m",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(messages.status, 200);
    assert.equal(stub.seen[1]?.path, "/v1/messages");
    assert.equal(stub.seen[1]?.headers["anthropic-version"], "2023-06-01");

    const stream = await openaiChatStream(transport, { model: "m", messages: [{ role: "user", content: "hi" }] });
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(String(chunk));
    const events = new SseParser();
    const parsed = chunks.flatMap((chunk) => events.push(chunk));
    assert.equal(openaiDelta(parseSseData(parsed[0]!)), "Hi");
    assert.equal(parseSseData(parsed[1]!), null);
  } finally {
    await stub.stop();
  }
});

test("readFileView returns a bounded pread window, not a copy of the file", () => {
  const root = tempRoot();
  const file = path.join(root, "model.gguf");
  fs.writeFileSync(file, "0123456789");
  try {
    const view = readFileView(file, 2, 4);
    assert.equal(view.mode, "pread");
    assert.equal(view.offset, 2);
    assert.equal(view.length, 4);
    assert.equal(view.buffer.toString("utf8"), "2345");

    const tail = readFileView(file, 7, 100);
    assert.equal(tail.length, 3);
    assert.equal(tail.buffer.toString("utf8"), "789");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspectProcessMaps reads the live mmap ranges of this process", { skip: process.platform !== "linux" }, () => {
  const snapshot = inspectProcessMaps(process.pid, process.execPath);
  assert.ok(snapshot, "the node binary must appear in /proc/self/maps");
  assert.equal(snapshot.source, "proc-maps");
  assert.ok(snapshot.mapped_bytes > 0);
  assert.ok(snapshot.ranges.length > 0);
  assert.ok(snapshot.ranges.every((range) => range.path === process.execPath));
  assert.equal(inspectProcessMaps(process.pid, "/does/not/exist"), null);
});
