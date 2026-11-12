#!/usr/bin/env node
// Client-compatibility matrix for the lama API surface: OpenAI and Anthropic
// wire formats, streaming and non-streaming, chat and forced tool-calls,
// over every active transport. Real requests, real model, stdlib only.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const ENGINE = {
  host: process.env.LAMA_ENGINE_HOST || "127.0.0.1",
  port: Number(process.env.LAMA_ENGINE_PORT || 9932),
};
const PROXY = {
  host: process.env.LAMA_GATEWAY_HOST || "127.0.0.1",
  port: Number(process.env.LAMA_GATEWAY_PORT || 5252),
};
const UDS = process.env.LAMA_UDS_SOCK || `/tmp/llama-${process.getuid?.() ?? 1000}/llama.sock`;
const TIMEOUT_MS = 90_000;

const transports = [
  { id: "http", label: `engine http://${ENGINE.host}:${ENGINE.port}`, target: { ...ENGINE } },
  { id: "uds", label: `engine unix:${UDS}`, target: { socketPath: UDS } },
  { id: "proxy", label: `gateway http://${PROXY.host}:${PROXY.port} /v1`, target: { ...PROXY } },
];

function requestOnce(target, method, path, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const mod = target.tls ? https : http;
  const options = target.socketPath
    ? { socketPath: target.socketPath, method, path }
    : { host: target.host, port: target.port, method, path, rejectUnauthorized: false };
  options.headers = {
    accept: "application/json",
    ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
  };
  options.timeout = target.timeoutMs ?? TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = mod.request(options, (res) => {
      let first = null;
      let text = "";
      res.on("data", (chunk) => {
        if (first === null) first = Date.now();
        text += chunk;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text,
          durationMs: Date.now() - started,
          firstMs: first === null ? null : first - started,
        }),
      );
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${options.timeout}ms`)));
    req.on("error", reject);
    req.end(body || undefined);
  });
}

async function request(target, method, path, payload) {
  try {
    return await requestOnce(target, method, path, payload);
  } catch (error) {
    // OpenAI and Anthropic SDKs retry connection resets by default
    // (max_retries=2); mirror one retry and mark it in the report.
    if (!["ECONNRESET", "EPIPE"].includes(String(error?.code ?? ""))) throw error;
    return { ...(await requestOnce(target, method, path, payload)), retried: true };
  }
}

function parseSse(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    let event = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length) events.push({ event, data: data.join("\n") });
  }
  return events;
}

function sseJson(events) {
  return events
    .map((e) => {
      try {
        return { event: e.event, json: JSON.parse(e.data) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function makeChecks() {
  const checks = [];
  return {
    add(name, ok, detail = "") {
      checks.push({ name, ok: Boolean(ok), detail: String(detail ?? "").slice(0, 200) });
      return Boolean(ok);
    },
    checks,
    get pass() {
      return checks.length > 0 && checks.every((c) => c.ok);
    },
  };
}

const CHAT_PROMPT = "Reply with exactly: hello from barishal";
const WEATHER_PROMPT = "Weather in Dhaka?";
const OPENAI_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};
const ANTHROPIC_TOOL = {
  name: "get_weather",
  description: "Get the current weather for a city",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

async function runCase(transport, model, kind) {
  const c = makeChecks();
  const meta = {};
  try {
    const isTool = kind.includes("tool");
    const isStream = kind.endsWith("stream");
    const isAnthropic = kind.startsWith("anthropic.");
    const path = isAnthropic ? "/v1/messages" : "/v1/chat/completions";
    const payload = isAnthropic
      ? { model, max_tokens: isTool ? 128 : 48, messages: [{ role: "user", content: isTool ? WEATHER_PROMPT : CHAT_PROMPT }] }
      : { model, max_tokens: isTool ? 128 : 32, temperature: 0, messages: [{ role: "user", content: isTool ? WEATHER_PROMPT : CHAT_PROMPT }] };
    if (isTool) {
      payload.tools = [isAnthropic ? ANTHROPIC_TOOL : OPENAI_TOOL];
      payload.tool_choice = isAnthropic
        ? { type: "function", name: "get_weather" }
        : { type: "function", function: { name: "get_weather" } };
    }
    if (isStream) payload.stream = true;

    const res = await request(transport.target, "POST", path, payload);
    meta.status = res.status;
    meta.duration_ms = res.durationMs;
    meta.first_ms = res.firstMs;
    if (res.retried) meta.retried = true;
    c.add("http 200", res.status === 200, `status ${res.status} ${res.text.slice(0, 160)}`);
    if (isStream) {
      checkStream(c, res, isTool, isAnthropic);
    } else {
      checkJson(c, res, isTool, isAnthropic);
    }
  } catch (error) {
    c.add("request completed", false, error.message);
  }
  return { kind, pass: c.pass, ...meta, checks: c.checks };
}

function checkJson(c, res, isTool, isAnthropic) {
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    /* reported below */
  }
  c.add("valid json body", json !== null, res.text.slice(0, 160));
  if (!json) return;
  if (!isAnthropic) {
    c.add("object=chat.completion", json.object === "chat.completion", json.object);
    const choice = json.choices?.[0];
    const msg = choice?.message;
    if (isTool) {
      const fn = msg?.tool_calls?.[0]?.function;
      c.add("tool_calls[0].name=get_weather", fn?.name === "get_weather", fn?.name);
      let args = null;
      try {
        args = JSON.parse(fn?.arguments ?? "");
      } catch {
        /* reported below */
      }
      c.add("arguments JSON has city", Boolean(args?.city), fn?.arguments);
      c.add("finish_reason=tool_calls", choice?.finish_reason === "tool_calls", choice?.finish_reason);
    } else {
      c.add("message.content non-empty", typeof msg?.content === "string" && msg.content.length > 0, msg?.content);
      c.add("usage.completion_tokens>0", (json.usage?.completion_tokens ?? 0) > 0, JSON.stringify(json.usage));
    }
  } else {
    c.add("type=message", json.type === "message", json.type);
    const block = json.content?.[0];
    if (isTool) {
      c.add("content[0].type=tool_use", block?.type === "tool_use", block?.type);
      c.add("tool_use.name=get_weather", block?.name === "get_weather", block?.name);
      c.add("input.city present", Boolean(block?.input?.city), JSON.stringify(block?.input));
      c.add("stop_reason=tool_use", json.stop_reason === "tool_use", json.stop_reason);
    } else {
      c.add("content[0].type=text", block?.type === "text", block?.type);
      c.add("text non-empty", typeof block?.text === "string" && block.text.length > 0, block?.text);
      c.add("usage.output_tokens>0", (json.usage?.output_tokens ?? 0) > 0, JSON.stringify(json.usage));
    }
  }
}

function checkStream(c, res, isTool, isAnthropic) {
  const sse = sseJson(parseSse(res.text));
  c.add(
    "content-type text/event-stream",
    String(res.headers["content-type"] ?? "").includes("text/event-stream"),
    res.headers["content-type"],
  );
  c.add("sse events parsed", sse.length > 0, `events=${sse.length}`);
  if (!isAnthropic) {
    const chunks = sse.filter((e) => e.json?.object === "chat.completion.chunk");
    c.add("chunk objects present", chunks.length > 1, `chunks=${chunks.length}`);
    c.add("data [DONE]", res.text.includes("data: [DONE]"));
    if (isTool) {
      let name = "";
      let raw = "";
      let finish = null;
      for (const chunk of chunks) {
        const choice = chunk.json?.choices?.[0];
        const call = choice?.delta?.tool_calls?.[0];
        if (call?.function?.name) name += call.function.name;
        if (call?.function?.arguments) raw += call.function.arguments;
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
      c.add("streamed tool name=get_weather", name.includes("get_weather"), name);
      let args = null;
      try {
        args = JSON.parse(raw);
      } catch {
        /* reported below */
      }
      c.add("streamed arguments have city", Boolean(args?.city), raw);
      c.add("stream finish_reason=tool_calls", finish === "tool_calls", finish);
    } else {
      let text = "";
      for (const chunk of chunks) {
        text += chunk.json?.choices?.[0]?.delta?.content ?? "";
      }
      c.add("streamed content non-empty", text.trim().length > 0, text);
    }
  } else {
    const events = sse.map((e) => e.json).filter(Boolean);
    const types = events.map((e) => e.type);
    c.add("message_start seen", types.includes("message_start"), types.slice(0, 3).join(","));
    c.add("message_stop seen", types.includes("message_stop"), types.slice(-2).join(","));
    if (isTool) {
      const start = events.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
      c.add("content_block_start tool_use", Boolean(start), start?.content_block?.type);
      c.add("tool_use.name=get_weather", start?.content_block?.name === "get_weather", start?.content_block?.name);
      let jsonText = "";
      for (const e of events) {
        if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta") jsonText += e.delta.partial_json ?? "";
      }
      let input = null;
      try {
        input = JSON.parse(jsonText);
      } catch {
        /* reported below */
      }
      c.add("partial_json has city", Boolean(input?.city), jsonText);
      const msgDelta = events.find((e) => e.type === "message_delta");
      c.add("stop_reason=tool_use", msgDelta?.delta?.stop_reason === "tool_use", msgDelta?.delta?.stop_reason);
    } else {
      let text = "";
      for (const e of events) {
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta") text += e.delta.text ?? "";
      }
      c.add("streamed text non-empty", text.trim().length > 0, text);
    }
  }
}

const KINDS = [
  "openai.chat",
  "openai.chat.stream",
  "openai.tool",
  "openai.tool.stream",
  "anthropic.chat",
  "anthropic.chat.stream",
  "anthropic.tool",
  "anthropic.tool.stream",
];

async function resolveModel() {
  const res = await request(ENGINE, "GET", "/v1/models", undefined);
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    /* caller reports the raw body */
  }
  const id = json?.data?.[0]?.id;
  if (!id) throw new Error(`engine not answering on ${ENGINE.host}:${ENGINE.port}: ${res.text.slice(0, 160)}`);
  return id;
}

async function probeTls() {
  try {
    const res = await request({ ...ENGINE, tls: true, timeoutMs: 3000 }, "GET", "/v1/models", undefined);
    if (res.status === 200) return { id: "https", label: `engine https://${ENGINE.host}:${ENGINE.port}`, target: { ...ENGINE, tls: true } };
    return { id: "https", reason: `engine TLS probe answered HTTP ${res.status}` };
  } catch (error) {
    return { id: "https", reason: `engine TLS off (${error.message}); enable with LAMA_TLS=1` };
  }
}

async function main() {
  const model = await resolveModel();
  console.log(`model: ${model}`);
  const skipped = [];
  const tls = await probeTls();
  if (tls.reason) skipped.push({ id: tls.id, reason: tls.reason });
  else transports.push(tls);

  const results = [];
  for (const transport of transports) {
    for (const kind of KINDS) {
      const result = await runCase(transport, model, kind);
      results.push({ transport: transport.id, ...result });
      const mark = result.pass ? "PASS" : "FAIL";
      const failedChecks = result.checks.filter((c) => !c.ok);
      console.log(`${mark} ${transport.id.padEnd(6)} ${kind.padEnd(22)} ${result.duration_ms ?? "-"}ms${failedChecks.length ? ` ${JSON.stringify(failedChecks)}` : ""}`);
    }
  }

  const failed = results.filter((r) => !r.pass);
  const report = {
    at: new Date().toISOString(),
    model,
    transports: transports.map((t) => t.id),
    skipped,
    cases: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  const outDir = new URL("../data/", import.meta.url);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(new URL("compat-matrix.json", outDir), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ cases: report.cases, passed: report.passed, failed: report.failed, skipped }, null, 2));
  console.log(failed.length === 0 ? "COMPAT_PASS" : "COMPAT_FAIL");
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`compat matrix failed to start: ${error.message}`);
  process.exitCode = 1;
});
