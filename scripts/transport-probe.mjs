#!/usr/bin/env node
/**
 * Transport surface probe: for every enabled model, load it once and hit the
 * whole llama.cpp endpoint surface twice — once over TCP (http) and once over
 * the unix socket (uds) — then unload.
 *
 * Why a separate script from model-matrix.mjs: the matrix proves load/unload and
 * that each transport answers; this one proves the two non-TLS transports are
 * *equivalent* endpoint by endpoint, and records the truth about endpoints the
 * build does not implement instead of hiding them.
 *
 * Evidence: data/transport-probe.json + docs/transport-probe.md
 * `--verify` re-reads the evidence (no models are loaded) and prints PROBE-OK.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { detectOs } from "../src/os.ts";
import { Store } from "../src/db.ts";
import { EngineManager } from "../src/engine.ts";
import { request } from "../src/transport/index.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REPORT_JSON = path.join(ROOT, "data", "transport-probe.json");
const REPORT_MD = path.join(ROOT, "docs", "transport-probe.md");

/** Endpoints the engine must answer on every transport. */
const CORE = [
  "health",
  "props",
  "models",
  "metrics",
  "tokenize",
  "detokenize",
  "chat",
  "chat-stream",
  "completions",
  "chat-tools",
];
/** Endpoints that depend on the build/model (embedding model, FIM, Anthropic shim). */
const OPTIONAL = new Set(["embeddings", "messages", "responses", "infill", "slots"]);

function verdict(id, status) {
  if (status !== null && status >= 200 && status < 300) return "pass";
  if (status === null) return "fail";
  if (OPTIONAL.has(id) && [400, 404, 405, 415, 501].includes(status)) return "unsupported";
  return "fail";
}

function snippet(text, max = 90) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function streamFirst(transport, body, headers) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const opts =
      transport.protocol === "uds"
        ? { socketPath: transport.socket_path, path: "/v1/chat/completions", method: "POST" }
        : { hostname: transport.host, port: transport.port, path: "/v1/chat/completions", method: "POST" };
    const started = performance.now();
    let settled = false;
    let chunks = 0;
    let firstMs = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {
        // already closed
      }
      resolve({ ms: Math.round(performance.now() - started), chunks, first_ms: firstMs, ...result });
    };
    const req = http.request({
      ...opts,
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "content-length": payload.length,
        ...headers,
      },
    });
    req.on("response", (res) => {
      res.on("data", (buf) => {
        if (firstMs === null) firstMs = Math.round(performance.now() - started);
        chunks += 1;
        const text = buf.toString("utf8");
        if (text.includes("[DONE]") || chunks >= 3) finish({ status: res.statusCode, text });
      });
      res.on("end", () => finish({ status: res.statusCode, text: "" }));
      res.on("error", (error) => finish({ status: res.statusCode, error: error.message }));
    });
    req.on("error", (error) => finish({ status: null, error: error.message }));
    req.setTimeout(120_000, () => finish({ status: null, error: "stream timeout" }));
    req.end(payload);
  });
}

async function probeSurface(transport, model, systemPrompt, apiKey) {
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const checks = [];
  const endpoint = transport.protocol === "uds" ? `uds ${transport.socket_path}` : `${transport.protocol} ${transport.host}:${transport.port}`;

  const call = async (id, method, target, body) => {
    const started = performance.now();
    let result;
    try {
      const res = await request(transport, target, { method, timeoutMs: 120_000, headers, body });
      result = { id, status: res.status, ms: Math.round(performance.now() - started), text: res.text };
    } catch (error) {
      result = { id, status: null, ms: Math.round(performance.now() - started), error: error.message, text: "" };
    }
    checks.push(result);
    return result;
  };

  await call("health", "GET", "/health");
  await call("props", "GET", "/props");
  await call("models", "GET", "/v1/models");
  const metrics = await call("metrics", "GET", "/metrics");
  if (metrics.status === 200) metrics.note = snippet(metrics.text, 60);
  const slots = await call("slots", "GET", "/slots");
  if (slots.status === 200) {
    try {
      slots.note = `slots=${JSON.parse(slots.text).length ?? "?"}`;
    } catch {
      slots.note = snippet(slots.text, 40);
    }
  }

  // llama.cpp renamed `prompt` to `content`; try the current shape, then the old one.
  let tokenize = await call("tokenize", "POST", "/tokenize", { content: "lama transport probe" });
  if (tokenize.status === 400) {
    checks.pop();
    tokenize = await call("tokenize", "POST", "/tokenize", { prompt: "lama transport probe" });
  }
  let tokens = [];
  if (tokenize.status === 200) {
    try {
      tokens = JSON.parse(tokenize.text).tokens ?? [];
      tokenize.note = `tokens=${tokens.length}`;
    } catch {
      tokenize.note = "unparsable body";
    }
  }
  const detokenize = await call("detokenize", "POST", "/detokenize", { tokens });
  if (detokenize.status === 200) {
    try {
      detokenize.note = snippet(JSON.parse(detokenize.text).content ?? detokenize.text, 40);
    } catch {
      detokenize.note = "unparsable body";
    }
  }

  const chat = await call("chat", "POST", "/v1/chat/completions", {
    model: model.model_id,
    max_tokens: 16,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
  });
  if (chat.status === 200) {
    try {
      const message = JSON.parse(chat.text)?.choices?.[0]?.message ?? {};
      chat.note = snippet(message.content ?? message.reasoning_content ?? "", 40);
    } catch {
      chat.note = "unparsable body";
    }
  }

  const stream = await streamFirst(
    transport,
    {
      model: model.model_id,
      max_tokens: 24,
      temperature: 0,
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "user", content: "Count: one, two" }],
    },
    headers,
  );
  checks.push({
    id: "chat-stream",
    status: stream.status ?? null,
    ms: stream.ms,
    note: stream.error ? stream.error : `chunks=${stream.chunks} first=${stream.first_ms}ms`,
    text: stream.text ?? "",
  });

  const completion = await call("completions", "POST", "/v1/completions", {
    model: model.model_id,
    prompt: "Say ok",
    max_tokens: 8,
    temperature: 0,
  });
  if (completion.status === 200) {
    try {
      completion.note = snippet(JSON.parse(completion.text)?.choices?.[0]?.text ?? "", 40);
    } catch {
      completion.note = "unparsable body";
    }
  }

  const tools = await call("chat-tools", "POST", "/v1/chat/completions", {
    model: model.model_id,
    max_tokens: 64,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: "user", content: "What is 2+2? Use the add tool." }],
    tools: [
      {
        type: "function",
        function: {
          name: "add",
          description: "add two numbers",
          parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
        },
      },
    ],
  });
  if (tools.status === 200) {
    try {
      const message = JSON.parse(tools.text)?.choices?.[0]?.message ?? {};
      tools.note = message.tool_calls ? "tool_calls returned" : "no tool_calls (model chose prose)";
    } catch {
      tools.note = "unparsable body";
    }
  }

  await call("embeddings", "POST", "/v1/embeddings", { model: model.model_id, input: "hello" });
  await call("messages", "POST", "/v1/messages", {
    model: model.model_id,
    max_tokens: 16,
    messages: [{ role: "user", content: "ok" }],
  });
  await call("responses", "POST", "/v1/responses", { model: model.model_id, input: "ok", max_output_tokens: 16 });
  await call("infill", "POST", "/infill", { prompt: "def add(a, b):", n_predict: 8, temperature: 0 });

  const identity = await request(transport, "/v1/chat/completions", {
    timeoutMs: 300_000,
    headers,
    body: {
      model: model.model_id,
      max_tokens: 96,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Who are you? Answer in one short Bengali sentence." },
      ],
    },
  })
    .then((res) => {
      const message = JSON.parse(res.text)?.choices?.[0]?.message ?? {};
      return { status: res.status, answer: String(message.content ?? "").trim() || String(message.reasoning_content ?? "").trim() };
    })
    .catch((error) => ({ status: null, answer: "", error: error.message }));

  for (const check of checks) {
    check.verdict = verdict(check.id, check.status);
    check.path = check.id;
  }
  return { endpoint, checks, identity };
}

async function run() {
  const cfg = loadConfig();
  if (cfg.tls) throw new Error("transport-probe is the non-TLS probe: set LAMA_TLS=0 first");
  const osInfo = detectOs();
  const store = new Store(cfg.dbFile);
  const engine = new EngineManager(store, cfg, osInfo);
  const promptRow = store.getPrompt("system") ?? store.defaultPrompt();
  if (!promptRow) throw new Error("no system prompt row; boot the admin once so prompts/lama-system.md syncs");
  const systemPrompt = promptRow.content;

  const models = [];
  try {
    for (const model of store.listModels().filter((row) => row.enabled === 1)) {
      const started = performance.now();
      const state = await engine.start(model.model_id, 1);
      const loaded = state.status === "running";
      const entry = {
        id: model.id,
        alias: model.model_id,
        ctx: model.context,
        load_ms: Math.round(performance.now() - started),
        pid: state.pid,
        mmap: state.mmap,
        surfaces: [],
      };
      if (loaded) {
        for (const id of ["http", "uds"]) {
          const row = store.getTransport(id);
          if (!row) {
            entry.surfaces.push({ transport: id, endpoint: "missing", checks: [], identity: null });
            continue;
          }
          entry.surfaces.push({ transport: id, ...(await probeSurface({ ...row, protocol: id }, model, systemPrompt, cfg.engineApiKey)) });
        }
      }
      const stopped = await engine.stop();
      entry.unload = { ok: stopped.status === "stopped" && stopped.pid === null, detail: `status ${stopped.status} pid ${stopped.pid ?? "-"}` };
      entry.load_ok = loaded;
      models.push(entry);
    }
  } finally {
    // Never leave a half-loaded engine behind if a probe throws.
    const state = store.engineState();
    if (state.status === "running" || state.status === "starting") await engine.stop().catch(() => undefined);
  }

  const report = {
    generated_at: new Date().toISOString(),
    host: `${osInfo.platform}/${osInfo.arch} ${osInfo.distro} ${osInfo.distroVersion}`,
    binary: engine.binaryVersion(),
    prompt: { id: promptRow.id, version: promptRow.version, chars: promptRow.content.length },
    core: CORE,
    models,
  };
  fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(REPORT_MD, markdown(report));
  return report;
}

function markdown(report) {
  const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    "# HTTP + UDS transport surface report",
    "",
    `Generated: \`${report.generated_at}\` · Host: \`${report.host}\` · Binary: \`${report.binary ?? "unknown"}\``,
    `System prompt: \`${report.prompt.id}\` v${report.prompt.version} (${report.prompt.chars} chars)`,
    "",
    "`PASS` = 2xx · `N/A` = build/model does not implement it (real status recorded) · `FAIL` = unexpected.",
    "",
  ];
  for (const model of report.models) {
    lines.push(`## ${model.alias} (\`${model.id}\`)`, "");
    lines.push(
      `Load ${model.load_ok ? "PASS" : "FAIL"} (${model.load_ms} ms, pid ${model.pid ?? "-"}) · mmap ${model.mmap?.mapped ? `${model.mmap.bytes} bytes` : "no"} · unload ${model.unload.ok ? "PASS" : "FAIL"}`,
      "",
    );
    const http = model.surfaces.find((s) => s.transport === "http");
    const uds = model.surfaces.find((s) => s.transport === "uds");
    const ids = [...new Set([...(http?.checks ?? []), ...(uds?.checks ?? [])].map((c) => c.id))];
    lines.push("| Endpoint | http | uds | Verdict | Detail |", "| --- | --- | --- | --- | --- |");
    for (const id of ids) {
      const a = http?.checks.find((c) => c.id === id);
      const b = uds?.checks.find((c) => c.id === id);
      const state = a?.verdict === "pass" && b?.verdict === "pass" ? "PASS" : a?.verdict === "fail" || b?.verdict === "fail" ? "FAIL" : "N/A";
      const detail = cell(a?.note || b?.note || a?.error || b?.error || "");
      lines.push(`| ${id} | ${a?.status ?? "-"} (${a?.ms ?? "-"} ms) | ${b?.status ?? "-"} (${b?.ms ?? "-"} ms) | ${state} | ${detail} |`);
    }
    lines.push("");
    lines.push(`Identity over http: ${cell(http?.identity?.answer) || `(${cell(http?.identity?.error ?? "no answer")})`}`);
    lines.push(`Identity over uds: ${cell(uds?.identity?.answer) || `(${cell(uds?.identity?.error ?? "no answer")})`}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function verify() {
  const failures = [];
  if (!fs.existsSync(REPORT_JSON)) throw new Error(`${REPORT_JSON} is missing; run \`node scripts/transport-probe.mjs\` first`);
  const report = JSON.parse(fs.readFileSync(REPORT_JSON, "utf8"));
  const cfg = loadConfig();
  const store = new Store(cfg.dbFile);
  const enabled = store.listModels().filter((row) => row.enabled === 1);
  const prompts = store.listPrompts();
  if (prompts.length !== 1 || prompts[0].id !== "system") {
    failures.push(`expected exactly one system prompt (id system), found ${prompts.map((row) => row.id).join(", ") || "none"}`);
  }

  if (report.models.length !== enabled.length) failures.push(`report has ${report.models.length} models, registry has ${enabled.length}`);
  let checkCount = 0;
  for (const model of enabled) {
    const row = report.models.find((item) => item.id === model.id);
    if (!row) {
      failures.push(`${model.id}: no report entry`);
      continue;
    }
    if (!row.load_ok) failures.push(`${model.id}: was not loaded`);
    if (!row.unload?.ok) failures.push(`${model.id}: unload failed — ${row.unload?.detail ?? "not recorded"}`);
    const surfaces = new Map(row.surfaces.map((surface) => [surface.transport, surface]));
    for (const id of ["http", "uds"]) {
      if (!surfaces.has(id)) failures.push(`${model.id}: transport ${id} not probed`);
    }
    const http = surfaces.get("http");
    const uds = surfaces.get("uds");
    if (!http || !uds) continue;
    for (const surface of [http, uds]) {
      for (const endpoint of CORE) {
        const check = surface.checks.find((item) => item.id === endpoint);
        checkCount += 1;
        if (!check) failures.push(`${model.id}/${surface.transport}: endpoint ${endpoint} missing`);
        else if (check.verdict !== "pass") failures.push(`${model.id}/${surface.transport}: ${endpoint} ${check.status ?? check.error} (${check.note ?? ""})`);
      }
      for (const check of surface.checks) {
        if (check.verdict === "fail" && !CORE.includes(check.id)) failures.push(`${model.id}/${surface.transport}: ${check.id} ${check.status ?? check.error}`);
      }
      const answer = String(surface.identity?.answer ?? "");
      if (!answer) failures.push(`${model.id}/${surface.transport}: identity answer empty`);
      else if (!/lama/i.test(answer)) failures.push(`${model.id}/${surface.transport}: identity answer does not mention lama — "${answer.slice(0, 80)}"`);
    }
    for (const check of http.checks) {
      const other = uds.checks.find((item) => item.id === check.id);
      if (!other) failures.push(`${model.id}: ${check.id} missing over uds`);
      else if (check.status !== other.status) failures.push(`${model.id}: ${check.id} http ${check.status} != uds ${other.status}`);
    }
  }

  if (failures.length) {
    process.stderr.write(`PROBE-FAIL\n- ${failures.join("\n- ")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `PROBE-OK: ${enabled.length} models x http,uds — ${checkCount} core checks, statuses identical, identity verified, 1 system prompt (system v${prompts[0].version})\n`,
  );
}

if (process.argv.includes("--verify")) {
  verify();
} else {
  const report = await run();
  const rows = report.models.flatMap((model) => model.surfaces.flatMap((surface) => surface.checks));
  const passed = rows.filter((row) => row.verdict === "pass").length;
  const unsupported = rows.filter((row) => row.verdict === "unsupported").length;
  process.stdout.write(
    `${JSON.stringify({ report: REPORT_JSON, markdown: REPORT_MD, models: report.models.length, checks: rows.length, passed, unsupported }, null, 2)}\n`,
  );
}
