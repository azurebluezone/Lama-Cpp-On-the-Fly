#!/usr/bin/env node
// Proof for the user-friendly zero-downtime reload UI.
//
// It checks three layers, in order:
//   1. real_file  - the admin UI contains the hero panel markers and the styles;
//   2. live       - GET /api/engine/relay returns the shape the panel renders;
//   3. real_run   - a real OpenAI SSE stream runs through the stable gateway
//                   (5252) while POST /api/engine/reload fires; polling the relay must
//                   show phase=draining and inflight.processing >= 1 from the
//                   old engine before its pid disappears.
//
// ENGINE_UI_PASS only when every check held in this run.
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

function request(method, path, body, timeoutMs = 60_000) {
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

// One real streaming completion through the stable proxy. onFirstDelta fires
// once, as soon as the model emits its first content delta.
function streamOnce(onFirstDelta) {
  const raw = JSON.stringify({
    model: "qwen2.5-0.5b",
    stream: true,
    max_tokens: 140,
    temperature: 0.3,
    messages: [
      { role: "user", content: "Repeat the word lama 80 times, separated by spaces. Output nothing else." },
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

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

// --- 1. file markers -------------------------------------------------------
const html = fs.readFileSync(`${ROOT}web/index.html`, "utf8");
const app = fs.readFileSync(`${ROOT}web/app.js`, "utf8");
const css = fs.readFileSync(`${ROOT}web/style.css`, "utf8");
check(
  html.includes('id="relayPanel"') &&
    html.includes('id="relayReload"') &&
    html.includes('id="relaySteps"') &&
    html.includes("data-copy="),
  "web/index.html has #relayPanel, #relayReload, #relaySteps and data-copy controls",
);
check(
  app.includes("/api/engine/relay") && app.includes("function startReload") && app.includes("function relayStep"),
  "web/app.js polls /api/engine/relay and shares startReload() across reload buttons",
);
check(
  css.includes(".relay-hero") && css.includes("prefers-reduced-motion") && css.includes(".relay-steps"),
  "web/style.css styles the hero timeline and honours prefers-reduced-motion",
);

// --- 2. served page + relay shape -----------------------------------------
const served = await request("GET", "/", undefined, 10_000);
check(
  served.status === 200 && served.text.includes('id="relayPanel"'),
  `GET / serves the hero panel (HTTP ${served.status}, ${served.text.length} bytes)`,
);

const before = await request("GET", "/api/engine/relay", undefined, 10_000);
check(before.status === 200 && !!before.json, `GET /api/engine/relay HTTP ${before.status} (${before.ms}ms)`);
const first = before.json ?? {};
check(
  ["idle", "warming", "draining"].includes(first.phase),
  `relay phase is one of idle|warming|draining (${first.phase})`,
);
check(
  typeof first.inflight?.processing === "number" && !!first.stable?.openai_base_url && !!first.stable?.uds_path,
  `relay carries inflight.processing and stable endpoints (${first.stable?.openai_base_url})`,
);
check(
  first.active?.status === "running" && Number.isInteger(first.active?.pid) && Number.isInteger(first.active?.port),
  `relay reports the active engine (pid ${first.active?.pid} port ${first.active?.port})`,
);

const oldPid = first.active?.pid;
const oldPort = first.active?.port;
if (first.active?.status !== "running" || !oldPid) {
  console.log(JSON.stringify({ before: first }, null, 2));
  console.log("ENGINE_UI_FAIL");
  process.exit(1);
}

// --- 3. real reload while a real stream is in flight ----------------------
const samples = [];
let polling = true;
let pollingBusy = false;
const poll = setInterval(() => {
  if (!polling || pollingBusy) return;
  pollingBusy = true;
  void request("GET", "/api/engine/relay", undefined, 4000)
    .then((res) => {
      if (res.status === 200 && res.json) samples.push({ at: Date.now(), ...res.json });
    })
    .catch(() => {
      // A transient miss while the engine swaps is fine; other ticks cover it.
    })
    .finally(() => {
      pollingBusy = false;
    });
}, 200);

let reload = null;
let reloadFiredAt = 0;
const fireReload = () => {
  reloadFiredAt = Date.now();
  void request("POST", "/api/engine/reload", {}, 90_000).then((res) => {
    reload = res;
  });
};

let stream = await streamOnce(fireReload);
if (!stream.ok && stream.chunks === 0) {
  console.log(`RETRY stream failed before the first delta: ${stream.error ?? "no content"}`);
  stream = await streamOnce(fireReload);
  stream.retried = true;
}
const streamEndedAt = Date.now();

// Wait for the reload verdict (the API answers only after warm-up + drain).
const reloadDeadline = Date.now() + 90_000;
while (!reload && Date.now() < reloadDeadline) await sleep(200);
const reloadResult = reload ?? { status: 0, text: "no response", ms: Date.now() - reloadFiredAt };

// Keep polling until the relay reaches idle and the old pid is gone.
let finalRelay = null;
const settleDeadline = Date.now() + 30_000;
while (Date.now() < settleDeadline) {
  const res = await request("GET", "/api/engine/relay", undefined, 4000);
  if (res.status === 200 && res.json) finalRelay = res.json;
  if (finalRelay?.phase === "idle" && oldPid && !alive(oldPid)) break;
  await sleep(250);
}
polling = false;
clearInterval(poll);
await sleep(250); // let an in-flight poll land before the verdict

const swapSample = samples.find(
  (sample) => sample.active?.pid && sample.active.pid !== oldPid && sample.at <= streamEndedAt + 500,
);
const drainSamples = samples.filter((sample) => sample.phase === "draining");
const busyDrain = drainSamples.filter(
  (sample) => typeof sample.inflight?.processing === "number" && sample.inflight.processing >= 1,
);
const newPid = finalRelay?.active?.pid ?? null;
const newPort = finalRelay?.active?.port ?? null;
let oldGone = !alive(oldPid);
for (let i = 0; i < 40 && !oldGone; i++) {
  await sleep(250);
  oldGone = !alive(oldPid);
}

const stableAfter = await request("POST", "/v1/chat/completions", {
  model: "qwen2.5-0.5b",
  max_tokens: 4,
  messages: [{ role: "user", content: "Say ok" }],
}, 30_000);

check(stream.ok, `stream survived the reload (${stream.chunks} chunks, ${stream.content_len} chars, ${stream.total_ms}ms)`);
check(reloadResult.status === 200, `POST /api/engine/reload HTTP ${reloadResult.status} (${reloadResult.ms}ms)`);
check(!!swapSample, `relay saw a new pid while the stream was open (${oldPid} -> ${swapSample?.active?.pid ?? "?"})`);
check(drainSamples.length > 0, `relay reported phase=draining (${drainSamples.length} samples)`);
check(
  busyDrain.length > 0,
  `draining samples show inflight.processing >= 1 (${busyDrain
    .slice(0, 3)
    .map((sample) => `p=${sample.inflight?.processing} old=${sample.draining?.processing}`)
    .join(", ")})`,
);
check(
  Number.isInteger(newPid) && newPid !== oldPid && newPort !== oldPort,
  `relay ends on the new engine (pid ${oldPid}:${oldPort} -> ${newPid}:${newPort})`,
);
check(oldGone, `old engine pid ${oldPid} is gone`);
check(
  finalRelay?.last_swap?.old_pid === oldPid && finalRelay?.last_swap?.new_pid === newPid,
  `last_swap audit fields name the real swap (${JSON.stringify(finalRelay?.last_swap ?? null)})`,
);
check(
  finalRelay?.last_drain?.old_pid === oldPid,
  `last_drain names the retired pid (${JSON.stringify(finalRelay?.last_drain ?? null)})`,
);
check(
  stableAfter.status === 200 && !!stableAfter.json?.choices?.[0]?.message,
  `stable proxy still serves a completion after the swap (HTTP ${stableAfter.status})`,
);

const summary = {
  old_pid: oldPid,
  old_port: oldPort,
  new_pid: newPid,
  new_port: newPort,
  stream: {
    retried: !!stream.retried,
    saw_done: stream.saw_done,
    content_len: stream.content_len,
    chunks: stream.chunks,
    total_ms: stream.total_ms,
  },
  reload: { status: reloadResult.status, ms: reloadResult.ms },
  samples: samples.length,
  draining_samples: drainSamples.length,
  draining_busy_samples: busyDrain.length,
  swap_sample: swapSample ? { at: swapSample.at, pid: swapSample.active?.pid, port: swapSample.active?.port } : null,
  relay_final: finalRelay,
  stable_after: { status: stableAfter.status },
  failures,
};
console.log(JSON.stringify(summary, null, 2));
const pass = failures.length === 0;
console.log(pass ? "ENGINE_UI_PASS" : "ENGINE_UI_FAIL");
if (!pass) process.exitCode = 1;
