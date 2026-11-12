#!/usr/bin/env node
// Proof for the gateway faces a real client uses, plus the dashboard totals.
//
//   1. real_file/real_run - /api/state totals equal request_logs: every raw row
//      (request_totals) and every per-model row (the transport-grouping fix);
//   2. live - GET /v1/models, POST /v1/chat/completions with tools, a real
//      Anthropic SSE stream and a tool_use block, all through the stable proxy
//      on whichever model is loaded right now.
//
// LAMA_API_PASS only when every check holds in this run.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.LAMA_GATEWAY_PORT || 5252);
const BASE = `http://${HOST}:${PORT}`;
const envFile = path.join(ROOT, ".env");
const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
const adminToken = process.env.LAMA_ADMIN_TOKEN || /^LAMA_ADMIN_TOKEN=(.*)$/m.exec(env)?.[1]?.trim() || "";
const failures = [];
const check = (ok, text) => {
  if (!ok) failures.push(text);
  console.log(`${ok ? "PASS" : "FAIL"} ${text}`);
  return ok;
};

function request(method, pathname, body, timeoutMs = 300_000, headers = {}) {
  const raw = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const begin = Date.now();
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        method,
        path: pathname,
        headers: {
          ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
          ...(raw ? { "content-type": "application/json", "content-length": Buffer.byteLength(raw) } : {}),
          ...headers,
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", (error) => resolve({ status: 0, text: error.message, json: null, ms: Date.now() - begin }));
    req.end(raw ?? undefined);
  });
}

// --- 1. dashboard totals vs the real table --------------------------------
const db = new DatabaseSync(path.join(ROOT, "data", "manager.db"), { readOnly: true });
const countRows = () => db.prepare("SELECT COUNT(*) AS c FROM request_logs").get().c;
const countPerModel = () =>
  new Map(
    db
      .prepare("SELECT model_id, COUNT(*) AS c FROM request_logs WHERE model_id IS NOT NULL GROUP BY model_id")
      .all()
      .map((row) => [row.model_id, row.c]),
  );
// Live traffic (the UI, other clients) can land between the two reads, so the
// dashboard snapshot must sit inside the before/after window, not equal one end.
const beforeTotal = countRows();
const beforeModels = countPerModel();
const state = await request("GET", "/api/state", undefined, 30_000);
const afterTotal = countRows();
const afterModels = countPerModel();

check(state.status === 200 && !!state.json, `GET /api/state HTTP ${state.status} (${state.ms}ms)`);
const totals = state.json?.request_totals ?? null;
check(
  typeof totals?.total === "number" && totals.total >= beforeTotal && totals.total <= afterTotal,
  `dashboard total sits inside the real request_logs window (${totals?.total} in [${beforeTotal}, ${afterTotal}])`,
);
check(afterTotal > 20, `request_logs has more than the frozen 20 rows (${afterTotal})`);
const perModelOk = state.json?.models?.every((model) => {
  const seen = model.stats?.total ?? 0;
  if (seen === 0) return true;
  const min = beforeModels.get(model.id) ?? 0;
  const max = afterModels.get(model.id) ?? 0;
  return seen >= min && seen <= max;
});
check(
  perModelOk,
  `every per-model total matches its request_logs rows (${state.json?.models
    ?.map((model) => `${model.id}=${model.stats?.total ?? 0}`)
    .join(", ")})`,
);

// --- 2. the model a client would actually get -----------------------------
const models = await request("GET", "/v1/models", undefined, 30_000);
check(models.status === 200 && !!models.json, `GET /v1/models HTTP ${models.status} (${models.ms}ms)`);
const alias = models.json?.data?.[0]?.id || models.json?.models?.[0]?.name || null;
check(typeof alias === "string" && alias.length > 0, `active model alias is served (${alias})`);
if (!alias) {
  console.log("LAMA_API_FAIL");
  process.exit(1);
}

// OpenAI surface with a real tool call. Reasoning models spend tokens on
// thinking first, so the budget is deliberately generous.
const openai = await request(
  "POST",
  "/v1/chat/completions",
  {
    model: alias,
    max_tokens: 260,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ],
    tool_choice: "auto",
    messages: [{ role: "user", content: "What is the weather in Dhaka? Use the tool." }],
  },
  300_000,
);
check(openai.status === 200, `POST /v1/chat/completions HTTP ${openai.status} (${openai.ms}ms)`);
const toolCall = openai.json?.choices?.[0]?.message?.tool_calls?.[0];
let toolArgs = null;
try {
  toolArgs = toolCall ? JSON.parse(toolCall.function.arguments) : null;
} catch {
  toolArgs = null;
}
check(
  toolCall?.function?.name === "get_weather" && toolArgs?.city === "Dhaka",
  `OpenAI tool call is real (${toolCall?.function?.name ?? "none"} ${toolCall?.function?.arguments ?? ""})`,
);

// Anthropic streaming surface.
const stream = await new Promise((resolve) => {
  const payload = JSON.stringify({
    model: alias,
    max_tokens: 96,
    stream: true,
    messages: [{ role: "user", content: "Count from 1 to 5." }],
  });
  const begin = Date.now();
  let text = "";
  let first = 0;
  const req = http.request(
    {
      host: HOST,
      port: PORT,
      method: "POST",
      path: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "anthropic-version": "2023-06-01",
        "x-api-key": "local-client",
        ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
      },
    },
    (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (!first) first = Date.now() - begin;
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, first, ms: Date.now() - begin }));
    },
  );
  req.setTimeout(300_000, () => req.destroy(new Error("stream timeout")));
  req.on("error", (error) => resolve({ status: 0, text: error.message, first: 0, ms: Date.now() - begin }));
  req.end(payload);
});
const eventTypes = new Set([...stream.text.matchAll(/"type":"([a-z_]+)"/g)].map((match) => match[1]));
check(stream.status === 200, `POST /v1/messages (stream) HTTP ${stream.status}, first byte ${stream.first}ms`);
check(
  eventTypes.has("message_start") && eventTypes.has("content_block_delta") && eventTypes.has("message_stop"),
  `Anthropic SSE carries message_start/content_block_delta/message_stop (${stream.text.split("\n").filter((line) => line.startsWith("event:")).length} events)`,
);

// Anthropic tool_use block, the shape agent clients parse.
const anthropic = await request(
  "POST",
  "/v1/messages",
  {
    model: alias,
    max_tokens: 260,
    tools: [
      {
        name: "get_weather",
        description: "Get weather for a city",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ],
    messages: [{ role: "user", content: "What is the weather in Dhaka? Use the tool." }],
  },
  300_000,
  { "anthropic-version": "2023-06-01", "x-api-key": "local-client" },
);
check(anthropic.status === 200, `POST /v1/messages (tool) HTTP ${anthropic.status} (${anthropic.ms}ms)`);
const toolUse = (anthropic.json?.content ?? []).find((block) => block.type === "tool_use");
check(
  toolUse?.name === "get_weather" && toolUse?.input?.city === "Dhaka",
  `Anthropic tool_use block is real (${JSON.stringify(toolUse?.input ?? null)})`,
);

const summary = {
  db_rows: afterTotal,
  dashboard: totals,
  model: alias,
  openai: { status: openai.status, ms: openai.ms, tool: toolCall?.function?.arguments ?? null },
  anthropic_stream: { status: stream.status, first_byte_ms: stream.first, total_ms: stream.ms, events: eventTypes.size },
  anthropic_tool: { status: anthropic.status, ms: anthropic.ms, input: toolUse?.input ?? null },
  failures,
};
console.log(JSON.stringify(summary, null, 2));
const pass = failures.length === 0;
console.log(pass ? "LAMA_API_PASS" : "LAMA_API_FAIL");
if (!pass) process.exitCode = 1;
