#!/usr/bin/env node
// uds-prompt-bench.mjs — measure llama.cpp /v1/chat/completions latency over the engine UDS
// for several prompts, and repeat two of them over TCP against the same llama process.
// Every number comes from the live server response; nothing is synthesized.

import fs from "node:fs";
import http from "node:http";

const UDS = process.env.LAMA_UDS ?? "/tmp/llama-1000/llama.sock";
const MODEL = process.env.LAMA_MODEL ?? "deepseek-v4-pro";
const TCP_HOST = process.env.LAMA_TCP_HOST ?? "127.0.0.1";
const TCP_PORT = Number(process.env.LAMA_TCP_PORT ?? 9932);
const MAX_TOKENS = Number(process.env.LAMA_BENCH_MAX_TOKENS ?? 8);
const REQUEST_TIMEOUT_MS = Number(process.env.LAMA_BENCH_TIMEOUT_MS ?? 45_000);

const MEDIUM = [
  "The project ships a TypeScript lifecycle manager for a stock llama.cpp server.",
  "It installs binaries, registers models, exposes an admin API, and relays requests",
  "over both TCP and a Unix domain socket. The registry lives in SQLite and the",
  "gateway rewrites model aliases before forwarding. Operators can start, stop, and",
  "health-check each instance from one CLI. Summarize the paragraph in one sentence.",
].join(" ");

const CASES = [
  { label: "p1_hello", transport: "uds", text: "hello" },
  { label: "p2_math", transport: "uds", text: "What is 2+2? Answer with one number." },
  { label: "p3_medium", transport: "uds", text: MEDIUM },
  { label: "p4_bengali", transport: "uds", text: "বাংলায় এক বাক্যে বলো: ঢাকা কোথায়?" },
  { label: "p5_hello_again", transport: "uds", text: "hello" },
  { label: "p1_hello_tcp", transport: "tcp", text: "hello" },
  { label: "p3_medium_tcp", transport: "tcp", text: MEDIUM },
];

function post(transport, payload) {
  const body = JSON.stringify(payload);
  const options =
    transport === "uds"
      ? { socketPath: UDS, path: "/v1/chat/completions", method: "POST" }
      : { host: TCP_HOST, port: TCP_PORT, path: "/v1/chat/completions", method: "POST" };
  options.headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
  options.timeout = REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    let headersMs = null;
    const req = http.request(options, (res) => {
      headersMs = Number(process.hrtime.bigint() - started) / 1e6;
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({
          status: res.statusCode ?? 0,
          json,
          wallMs: Number(process.hrtime.bigint() - started) / 1e6,
          headersMs,
          bytes: text.length,
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

function fmt(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

const rows = [];
let failed = false;

if (!fs.existsSync(UDS)) {
  console.log(`BENCH_ERROR=uds_missing path=${UDS}`);
  process.exit(1);
}

for (const item of CASES) {
  let result;
  try {
    result = await post(item.transport, {
      model: MODEL,
      messages: [{ role: "user", content: item.text }],
      max_tokens: MAX_TOKENS,
      temperature: 0,
      cache_prompt: false,
      stream: false,
    });
  } catch (error) {
    console.log(`${item.label.padEnd(15)} ${item.transport.padEnd(4)} error=${error.message}`);
    failed = true;
    break;
  }
  const timings = result.json?.timings ?? {};
  const usage = result.json?.usage ?? {};
  const computeMs = (timings.prompt_ms ?? 0) + (timings.predicted_ms ?? 0);
  const row = {
    label: item.label,
    transport: item.transport,
    status: result.status,
    wallMs: result.wallMs,
    computeMs,
    promptN: timings.prompt_n ?? null,
    cacheN: timings.cache_n ?? null,
    predictedN: timings.predicted_n ?? null,
    promptTps: timings.prompt_per_second ?? null,
    decodeTps: timings.predicted_per_second ?? null,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
  };
  rows.push(row);
  if (result.status !== 200 || usage.prompt_tokens == null) failed = true;
  console.log(
    `${item.label.padEnd(15)} ${item.transport.padEnd(4)} wall=${fmt(row.wallMs / 1000)}s ` +
      `prompt_n=${row.promptN} cache_n=${row.cacheN} prefill=${fmt(row.promptTps, 2)}t/s ` +
      `gen_n=${row.predictedN} decode=${fmt(row.decodeTps, 2)}t/s status=${row.status}`,
  );
}

const statusOkAll = rows.length === CASES.length && rows.every((r) => r.status === 200 && r.promptTokens != null);
// 10ms tolerance for clock granularity between client wall clock and server-side timings.
const wallGeComputeAll = rows.length === CASES.length && rows.every((r) => r.wallMs + 10 >= r.computeMs);
const summary = {
  rows: rows.length,
  transports: [...new Set(rows.map((r) => r.transport))],
  status_ok_all: statusOkAll,
  wall_ge_compute_all: wallGeComputeAll,
  socket_present: true,
  load_avg_1m: Number(fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0]),
  walls_ms: rows.map((r) => Math.round(r.wallMs)),
  decode_tps: rows.map((r) => (r.decodeTps == null ? null : Number(r.decodeTps.toFixed(2)))),
};
console.log(`BENCH_SUMMARY ${JSON.stringify(summary)}`);
process.exit(!failed && summary.rows === CASES.length && statusOkAll && wallGeComputeAll ? 0 : 1);
