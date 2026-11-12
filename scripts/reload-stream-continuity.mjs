#!/usr/bin/env node
// Blue-green reload proof over the stable gateway proxy (5252).
//
// A real OpenAI SSE stream starts, then POST /api/engine/reload fires after the
// first delta. The systemd supervisor must warm a second engine on the spare
// port, point engine_state at it, keep the old engine alive until its real
// llamacpp:requests_processing gauge reaches 0 (drain), then stop the old pid.
// The stream that was already open must finish with content and [DONE].
//
// Evidence printed as one JSON block. STREAM_CONTINUITY_PASS only when every
// assertion held in this run; anything else prints the failing checks.
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PROXY = 5252;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const token = /^LAMA_ADMIN_TOKEN=(.*)$/m.exec(env)?.[1]?.trim() ?? "";
const auth = token ? { authorization: `Bearer ${token}` } : {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (ok, text) => {
  if (!ok) failures.push(text);
  console.log(`${ok ? "PASS" : "FAIL"} ${text}`);
  return ok;
};

function request(method, path, body, timeoutMs = 120_000) {
  const raw = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const begin = Date.now();
    const req = http.request(
      {
        host: HOST,
        port: PROXY,
        method,
        path,
        headers: {
          ...auth,
          ...(raw ? { "content-type": "application/json", "content-length": Buffer.byteLength(raw) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, text, json, ms: Date.now() - begin });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on("error", (error) => resolve({ status: 0, text: error.message, json: null, ms: Date.now() - begin }));
    req.end(raw ?? undefined);
  });
}

// One real streaming completion. onFirstDelta fires exactly once, as soon as the
// first non-empty content delta arrives.
function streamOnce(onFirstDelta) {
  const raw = JSON.stringify({
    model: "qwen2.5-0.5b",
    stream: true,
    max_tokens: 700,
    temperature: 0.4,
    messages: [
      {
        role: "user",
        content: "Repeat the word lama 400 times, separated by spaces. Output nothing else.",
      },
    ],
  });
  return new Promise((resolve) => {
    const begin = Date.now();
    let buffer = "";
    let content = "";
    let chunks = 0;
    let sawDone = false;
    let firstDeltaAt = 0;
    const finish = (extra) => {
      resolve({
        status: extra.status ?? 200,
        ok: sawDone && content.length > 0,
        error: extra.error ?? null,
        saw_done: sawDone,
        content_len: content.length,
        chunks,
        first_delta_ms: firstDeltaAt ? firstDeltaAt - begin : null,
        total_ms: Date.now() - begin,
        ended_at: Date.now(),
      });
    };
    const req = http.request(
      {
        host: HOST,
        port: PROXY,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw) },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => finish({ status: res.statusCode ?? 0, error: text.slice(0, 200) }));
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const index = buffer.indexOf("\n");
            if (index < 0) break;
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") {
              sawDone = true;
              continue;
            }
            let event = null;
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }
            const delta = event?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length) {
              content += delta;
              chunks += 1;
              if (!firstDeltaAt) {
                firstDeltaAt = Date.now();
                onFirstDelta?.();
              }
            }
          }
        });
        res.on("end", () => finish({}));
        res.on("error", (error) => finish({ status: 0, error: error.message }));
      },
    );
    req.on("error", (error) => finish({ status: 0, error: error.message }));
    req.end(raw);
  });
}

async function status() {
  const res = await request("GET", "/api/engine/status", undefined, 10_000);
  if (res.status !== 200 || !res.json) throw new Error(`status ${res.status}: ${res.text.slice(0, 120)}`);
  return res.json;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function readAudit() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(`${ROOT}data/manager.db`, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT action, at, detail FROM audit_events WHERE action IN ('engine.swap','engine.drain') ORDER BY id DESC LIMIT 4",
      )
      .all();
    db.close();
    return rows;
  } catch (error) {
    return [{ error: error.message }];
  }
}

// --- run -------------------------------------------------------------------
const before = await status();
check(before.status === "running" && !!before.pid, `engine running before reload (pid=${before.pid} port=${before.port})`);
if (before.status !== "running" || !before.pid) {
  console.log(JSON.stringify({ before }, null, 2));
  console.log("STREAM_CONTINUITY_FAIL");
  process.exit(1);
}

const oldPid = before.pid;
const oldPort = before.port;
const samples = [];
let streamEnded = false;
let reload = null;
let reloadFiredAt = 0;

const poll = setInterval(() => {
  if (streamEnded) return;
  void status()
    .then((snapshot) => {
      samples.push({ at: Date.now(), pid: snapshot.pid, port: snapshot.port, status: snapshot.status });
    })
    .catch(() => {
      // transient while the engine swaps; the sample set simply misses a beat
    });
}, 250);

let stream = await streamOnce(() => {
  reloadFiredAt = Date.now();
  void request("POST", "/api/engine/reload", {}).then((res) => {
    reload = res;
  });
});
if (!stream.ok && stream.chunks === 0) {
  // Known llama.cpp keep-alive wart can reset a pooled socket before any byte.
  // One SDK-like retry, recorded, never more.
  console.log(`RETRY stream failed before the first delta: ${stream.error ?? "no content"}`);
  stream = await streamOnce(() => {
    reloadFiredAt = Date.now();
    void request("POST", "/api/engine/reload", {}).then((res) => {
      reload = res;
    });
  });
  stream.retried = true;
}
streamEnded = true;
clearInterval(poll);

// Wait for the reload response (it resolves only after warm-up + drain + kill).
const reloadDeadline = Date.now() + 90_000;
while (!reload && Date.now() < reloadDeadline) await sleep(200);
const reloadResult = reload ?? { status: 0, ms: Date.now() - reloadFiredAt, text: "no response" };

const swapSample = samples.find((sample) => sample.status === "running" && sample.pid && sample.pid !== oldPid);
const after = await status();
let gone = !alive(oldPid);
for (let i = 0; i < 40 && !gone; i++) {
  await sleep(250);
  gone = !alive(oldPid);
}
const audit = await readAudit();
const swapEvent = Array.isArray(audit)
  ? audit.find((row) => row.action === "engine.swap" && String(row.detail ?? "").includes(String(oldPid)))
  : null;
const drainEvent = Array.isArray(audit)
  ? audit.find((row) => row.action === "engine.drain" && String(row.detail ?? "").includes(String(oldPid)))
  : null;

const swapWhileStreaming = !!swapSample && swapSample.at <= stream.ended_at;
check(stream.ok, `stream completed with [DONE] and content (${stream.content_len} chars in ${stream.chunks} chunks, ${stream.total_ms}ms)`);
check(reloadResult.status === 200, `reload returned HTTP 200 (${reloadResult.ms}ms): ${reloadResult.text.slice(0, 160)}`);
check(swapWhileStreaming, `engine_state switched to another pid while the stream was open (sample ${JSON.stringify(swapSample ?? null)} at <= ${stream.ended_at})`);
check(after.status === "running" && after.pid !== oldPid, `engine running on the new pid after reload (${oldPid} -> ${after.pid})`);
check(after.port !== oldPort, `proxy target port moved (${oldPort} -> ${after.port})`);
check(gone, `old engine pid ${oldPid} is gone`);
check(
  !!swapEvent && !!drainEvent,
  `audit has engine.swap and engine.drain (${JSON.stringify(audit).slice(0, 320)})`,
);
check(
  !!swapEvent && !!drainEvent && String(swapEvent.detail ?? "").includes(String(oldPid)),
  `engine.swap records the old pid ${oldPid}`,
);
check(
  !!drainEvent && !!drainEvent.detail && String(drainEvent.detail).includes(String(oldPid)),
  `engine.drain records the old pid ${oldPid}`,
);

const summary = {
  old_pid: oldPid,
  old_port: oldPort,
  new_pid: after.pid,
  new_port: after.port,
  stream: {
    retried: !!stream.retried,
    saw_done: stream.saw_done,
    content_len: stream.content_len,
    chunks: stream.chunks,
    first_delta_ms: stream.first_delta_ms,
    total_ms: stream.total_ms,
  },
  swap_while_streaming: swapWhileStreaming,
  swap_sample: swapSample ?? null,
  reload: { status: reloadResult.status, ms: reloadResult.ms },
  old_pid_gone: gone,
  audit: Array.isArray(audit) ? audit : [],
  failures,
};
console.log(JSON.stringify(summary, null, 2));
const pass = failures.length === 0;
console.log(pass ? "STREAM_CONTINUITY_PASS" : "STREAM_CONTINUITY_FAIL");
if (!pass) process.exitCode = 1;
