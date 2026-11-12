#!/usr/bin/env node
/**
 * Model × transport matrix: load every registered model, probe the engine over
 * HTTP/UDS (TLS off) and HTTPS (TLS on), unload, then write:
 *   data/model-matrix.json      machine-readable evidence
 *   docs/model-test-report.md   human report
 *
 * `--verify` does not run models: it re-reads the machine evidence and the live
 * state (one system prompt, gateway on 5252, optional legacy manager on 9935) and prints
 * MATRIX-OK only when every check holds.
 *
 * The engine runs under systemd (LAMA_SERVICE_MODE=user), so TLS is switched by
 * editing .env and restarting the unit through EngineManager.start/stop — the
 * same path the CLI uses. The original .env is restored on exit.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { detectOs } from "../src/os.ts";
import { Store } from "../src/db.ts";
import { EngineManager } from "../src/engine.ts";
import { request, requestHttp } from "../src/transport/index.ts";
import { gatewayHealth } from "../src/gateway/server.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REPORT_JSON = path.join(ROOT, "data", "model-matrix.json");
const REPORT_MD = path.join(ROOT, "docs", "model-test-report.md");
const ENV_FILE = process.env.LAMA_ENV_FILE || path.join(ROOT, ".env");
const ADMIN = { host: "127.0.0.1", port: 5252 };
// Reference-only; 9934 is the blue-green spare engine, so the legacy manager
// must not be pointed there.
const LEGACY = { url: "http://127.0.0.1:9935" };

function readEnvFile() {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
}

function setEnv(updates) {
  const lines = readEnvFile().split(/\r?\n/);
  const wanted = new Map(Object.entries(updates));
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match || !wanted.has(match[1])) {
      out.push(line);
      continue;
    }
    seen.add(match[1]);
    if (wanted.get(match[1]) !== null) out.push(`${match[1]}=${wanted.get(match[1])}`);
  }
  for (const [key, value] of wanted) if (!seen.has(key) && value !== null) out.push(`${key}=${value}`);
  const text = `${out.join("\n").replace(/\n+$/, "")}\n`;
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
}

function phaseEnv(phase) {
  setEnv({ LAMA_TLS: phase.tls ? "1" : "0", LAMA_TLS_INSECURE: phase.tls ? "1" : null });
  // loadConfig() prefers process.env over .env, so these two must be set *before* it
  // reads: otherwise the manager keeps probing http while the engine serves https.
  process.env.LAMA_TLS = phase.tls ? "1" : "0";
  if (phase.tls) process.env.LAMA_TLS_INSECURE = "1";
  else delete process.env.LAMA_TLS_INSECURE;
  return loadConfig();
}

async function probe(transport, modelId, apiKey) {
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const started = performance.now();
  const steps = {};
  const out = { id: transport.id, phase: transport.phase, status: "fail", steps, latency_ms: 0, reply: "", detail: "" };
  try {
    const health = await request(transport, "/health", { timeoutMs: 5000, headers, allowSelfSigned: true });
    steps.health = health.status;
    if (health.status !== 200) throw new Error(`health HTTP ${health.status}`);
    const props = await request(transport, "/props", { timeoutMs: 5000, headers, allowSelfSigned: true });
    steps.props = props.status;
    if (props.status !== 200) throw new Error(`props HTTP ${props.status}`);
    const models = await request(transport, "/v1/models", { timeoutMs: 5000, headers, allowSelfSigned: true });
    steps.models = models.status;
    if (models.status !== 200) throw new Error(`models HTTP ${models.status}`);
    const chat = await request(transport, "/v1/chat/completions", {
      timeoutMs: 180_000,
      headers,
      allowSelfSigned: true,
      body: {
        model: modelId,
        max_tokens: 16,
        temperature: 0,
        // Keep the probe cheap and deterministic on thinking-capable models.
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
      },
    });
    steps.chat = chat.status;
    if (chat.status !== 200) throw new Error(`chat HTTP ${chat.status}: ${chat.text.slice(0, 200)}`);
    const parsed = JSON.parse(chat.text);
    const message = parsed?.choices?.[0]?.message ?? {};
    out.reply = String(message.content ?? message.reasoning_content ?? "").trim().slice(0, 200);
    if (!out.reply) throw new Error("chat response has no choices[0].message content");
    out.status = "pass";
    out.detail = `health ${steps.health}, props ${steps.props}, models ${steps.models}, chat ${steps.chat}`;
  } catch (error) {
    out.detail = error.message;
  }
  out.latency_ms = Math.round(performance.now() - started);
  return out;
}

async function identityChat(transport, modelId, systemPrompt, apiKey) {
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const started = performance.now();
  try {
    const res = await request(transport, "/v1/chat/completions", {
      timeoutMs: 300_000,
      headers,
      allowSelfSigned: true,
      body: {
        model: modelId,
        max_tokens: 96,
        temperature: 0,
        // Qwen3-family models default to a thinking trace; the identity answer is in `content`.
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Who are you? Answer in one short Bengali sentence." },
        ],
      },
    });
    if (res.status !== 200) return { status: res.status, answer: "", detail: `HTTP ${res.status}`, duration_ms: Math.round(performance.now() - started) };
    const parsed = JSON.parse(res.text);
    const message = parsed?.choices?.[0]?.message ?? {};
    const answer = String(message.content ?? "").trim() || String(message.reasoning_content ?? "").trim();
    return { status: res.status, answer: answer.slice(0, 400), detail: "", duration_ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { status: null, answer: "", detail: error.message, duration_ms: Math.round(performance.now() - started) };
  }
}

async function run() {
  const savedEnv = readEnvFile();
  const osInfo = detectOs();
  const phases = [
    { id: "tls-off", tls: false, transports: ["http", "uds"] },
    { id: "tls-on", tls: true, transports: ["https"] },
  ];
  const models = [];
  let promptRef = null;
  let binary = null;

  try {
    for (const phase of phases) {
      const cfg = phaseEnv(phase);
      process.env.LAMA_TLS = phase.tls ? "1" : "0";
      const store = new Store(cfg.dbFile);
      const engine = new EngineManager(store, cfg, osInfo);
      binary = binary ?? engine.binaryVersion();
      const promptRow = store.getPrompt("system") ?? store.defaultPrompt();
      promptRef = promptRef ?? {
        id: promptRow?.id ?? null,
        version: promptRow?.version ?? null,
        chars: promptRow?.content.length ?? 0,
        sha: promptRow ? createHash("sha256").update(promptRow.content).digest("hex") : null,
      };
      const systemPrompt = promptRow?.content ?? "";

      for (const model of store.listModels().filter((row) => row.enabled === 1)) {
        const entry =
          models.find((item) => item.id === model.id) ??
          (() => {
            const created = {
              id: model.id,
              alias: model.model_id,
              file: model.path,
              contexts: model.context,
              loads: [],
              mmap: null,
              unloads: [],
              identity: null,
              transports: [],
            };
            models.push(created);
            return created;
          })();

        const loadStarted = performance.now();
        let phaseOk = false;
        try {
          const state = await engine.start(model.model_id, 1);
          phaseOk = state.status === "running";
          entry.loads.push({
            phase: phase.id,
            ok: phaseOk,
            duration_ms: Math.round(performance.now() - loadStarted),
            detail: `status ${state.status} pid ${state.pid ?? "-"}`,
          });
          if (phaseOk) entry.mmap = state.mmap;
        } catch (error) {
          entry.loads.push({ phase: phase.id, ok: false, duration_ms: Math.round(performance.now() - loadStarted), detail: error.message });
        }

        if (phaseOk) {
          for (const id of phase.transports) {
            const row = store.getTransport(id);
            if (!row) {
              entry.transports.push({ id, phase: phase.id, status: "fail", steps: {}, latency_ms: 0, reply: "", detail: "transport row missing" });
              continue;
            }
            entry.transports.push(await probe({ ...row, phase: phase.id }, model.model_id, cfg.engineApiKey));
          }
          if (!entry.identity && phase.id === "tls-off") {
            const row = store.getTransport("http");
            if (row) entry.identity = await identityChat({ ...row, phase: phase.id }, model.model_id, systemPrompt, cfg.engineApiKey);
          }
        }

        try {
          const stopped = await engine.stop();
          entry.unloads.push({ phase: phase.id, ok: stopped.status === "stopped" && stopped.pid === null, detail: `status ${stopped.status} pid ${stopped.pid ?? "-"}` });
        } catch (error) {
          entry.unloads.push({ phase: phase.id, ok: false, detail: error.message });
        }
      }
    }
  } finally {
    fs.writeFileSync(ENV_FILE, savedEnv, { mode: 0o600 });
    process.env.LAMA_TLS = "0";
    delete process.env.LAMA_TLS_INSECURE;
  }

  const admin = await gatewayHealth(ADMIN.host, ADMIN.port);
  let legacy = { up: false, detail: "unreachable" };
  try {
    const res = await requestHttp(`${LEGACY.url}/healthz`, { timeoutMs: 3000 });
    const body = JSON.parse(res.text);
    legacy = {
      up: res.status === 200 && body?.ok === true && body?.service !== "lama-gateway",
      detail: `HTTP ${res.status} ${res.text.trim().slice(0, 120)}`,
    };
  } catch (error) {
    legacy.detail = error.message;
  }

  const report = {
    generated_at: new Date().toISOString(),
    host: `${osInfo.platform}/${osInfo.arch} ${osInfo.distro} ${osInfo.distroVersion}`,
    binary,
    service_mode: loadConfig().serviceMode,
    prompt: promptRef,
    ports: { admin: { url: `http://${ADMIN.host}:${ADMIN.port}`, up: admin.up, detail: admin.detail }, legacy: { url: LEGACY.url, up: legacy.up, detail: legacy.detail } },
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
    "# Model × transport test report",
    "",
    `Generated: \`${report.generated_at}\`  ·  Host: \`${report.host}\`  ·  Service mode: \`${report.service_mode}\``,
    `Binary: \`${report.binary ?? "unknown"}\``,
    "",
    "## System prompt (one for every model)",
    "",
    `id \`${report.prompt?.id}\` · version ${report.prompt?.version} · ${report.prompt?.chars ?? 0} chars · sha256 \`${report.prompt?.sha ?? "n/a"}\``,
    "",
    "## Ports",
    "",
    "| Surface | URL | State | Detail |",
    "| --- | --- | --- | --- |",
    `| admin | ${report.ports.admin.url} | ${report.ports.admin.up ? "up" : "down"} | ${cell(report.ports.admin.detail)} |`,
    `| legacy manager | ${report.ports.legacy.url} | ${report.ports.legacy.up ? "up" : "down"} | ${cell(report.ports.legacy.detail)} |`,
    "",
  ];
  for (const model of report.models) {
    lines.push(`## ${model.alias} (\`${model.id}\`)`, "");
    lines.push(`File: \`${model.file}\` · ctx ${model.contexts}`, "");
    lines.push("| Phase | Load | Load ms | Unload | Unload detail |", "| --- | --- | --- | --- | --- |");
    for (const load of model.loads) {
      const unload = model.unloads.find((item) => item.phase === load.phase);
      lines.push(
        `| ${load.phase} | ${load.ok ? "PASS" : "FAIL"} | ${load.duration_ms} | ${unload?.ok ? "PASS" : "FAIL"} | ${cell(unload?.detail ?? "not attempted")} |`,
      );
    }
    lines.push("");
    lines.push(
      `Load detail: ${cell(model.loads.map((load) => `${load.phase}: ${load.ok ? "ok" : "fail"} ${load.detail}`).join(" · "))}`,
      `Mmap: ${model.mmap?.mapped ? `PASS (${model.mmap.bytes} bytes, ${model.mmap.perms})` : `no (${cell(model.mmap?.detail ?? "not probed")})`}`,
      "",
    );
    lines.push("| Transport | Phase | State | health | props | models | chat | Latency | Detail |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of model.transports) {
      lines.push(
        `| ${row.id} | ${row.phase} | ${row.status.toUpperCase()} | ${row.steps.health ?? "-"} | ${row.steps.props ?? "-"} | ${row.steps.models ?? "-"} | ${row.steps.chat ?? "-"} | ${row.latency_ms} ms | ${cell(row.detail)} |`,
      );
    }
    lines.push("");
    if (model.identity) {
      lines.push(`Identity answer (system prompt + "Who are you?"):`, "", `> ${cell(model.identity.answer) || `(${cell(model.identity.detail)})`}`, "");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function verify() {
  const failures = [];
  if (!fs.existsSync(REPORT_JSON)) throw new Error(`${REPORT_JSON} is missing; run \`node scripts/model-matrix.mjs\` first`);
  const report = JSON.parse(fs.readFileSync(REPORT_JSON, "utf8"));
  const cfg = loadConfig();
  const store = new Store(cfg.dbFile);
  const enabled = store.listModels().filter((row) => row.enabled === 1);

  const prompts = store.listPrompts();
  if (prompts.length !== 1 || prompts[0].id !== "system") {
    failures.push(`expected exactly one system prompt (id system), found ${prompts.map((row) => row.id).join(", ") || "none"}`);
  }
  const liveSha = createHash("sha256").update(prompts[0]?.content ?? "").digest("hex");
  if (report.prompt?.id !== "system") failures.push(`report prompt id is ${report.prompt?.id ?? "null"}, expected system`);
  if (report.prompt?.sha !== liveSha) failures.push(`report prompt sha ${report.prompt?.sha ?? "null"} != live ${liveSha}`);

  const admin = await gatewayHealth(ADMIN.host, ADMIN.port);
  if (!admin.up) failures.push(`gateway ${ADMIN.host}:${ADMIN.port} ${admin.detail}`);
  let legacy = null;
  try {
    const res = await requestHttp(`${LEGACY.url}/healthz`, { timeoutMs: 3000 });
    const body = JSON.parse(res.text);
    legacy = { ok: res.status === 200 && body?.ok === true && body?.service !== "lama-gateway", detail: `HTTP ${res.status}` };
  } catch (error) {
    legacy = { ok: false, detail: error.message };
  }
  // The legacy manager is reference-only and not part of the running stack;
  // a missing listener is informational, not a release failure.

  if (report.models.length !== enabled.length) failures.push(`report has ${report.models.length} models, registry has ${enabled.length}`);
  for (const model of enabled) {
    const row = report.models.find((item) => item.id === model.id);
    if (!row) {
      failures.push(`${model.id}: no report entry`);
      continue;
    }
    if (!row.loads || row.loads.length !== 2) {
      failures.push(`${model.id}: expected a load per phase (tls-off, tls-on), got ${(row.loads ?? []).map((item) => item.phase).join(", ") || "none"}`);
    }
    for (const phase of ["tls-off", "tls-on"]) {
      const load = (row.loads ?? []).find((item) => item.phase === phase);
      const unload = (row.unloads ?? []).find((item) => item.phase === phase);
      if (!load) failures.push(`${model.id}: no ${phase} load recorded`);
      else if (!load.ok) failures.push(`${model.id}: ${phase} load failed — ${load.detail}`);
      if (!unload) failures.push(`${model.id}: no ${phase} unload recorded`);
      else if (!unload.ok) failures.push(`${model.id}: ${phase} unload failed — ${unload.detail}`);
    }
    for (const id of ["http", "uds", "https"]) {
      const hits = row.transports.filter((item) => item.id === id);
      if (hits.length === 0) failures.push(`${model.id}: transport ${id} was never probed`);
      else if (!hits.some((item) => item.status === "pass")) failures.push(`${model.id}: transport ${id} did not pass — ${hits.map((item) => item.detail).join("; ")}`);
    }
  }

  if (failures.length) {
    process.stderr.write(`MATRIX-FAIL\n- ${failures.join("\n- ")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `MATRIX-OK: ${enabled.length} models, 3 transports, 1 system prompt (system v${prompts[0].version}), gateway 5252 up, legacy manager optional (9935)\n`,
  );
}

if (process.argv.includes("--verify")) {
  await verify();
} else {
  const report = await run();
  const passed = report.models.flatMap((model) => model.transports).filter((row) => row.status === "pass").length;
  const probed = report.models.flatMap((model) => model.transports).length;
  process.stdout.write(`${JSON.stringify({ report: REPORT_JSON, markdown: REPORT_MD, models: report.models.length, transports_passed: `${passed}/${probed}` }, null, 2)}\n`);
}
