#!/usr/bin/env node
// Reload continuity: send real chat requests through the stable gateway proxy
// while the engine restarts underneath. Real model, stdlib only.
import fs from "node:fs";
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 5252;
const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const token = /^LAMA_ADMIN_TOKEN=(.*)$/m.exec(env)?.[1]?.trim() ?? "";

function post(path, body, headers = {}) {
  const raw = JSON.stringify(body);
  const started = Date.now();
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        method: "POST",
        path,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw), ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, text, ms: Date.now() - started }));
      },
    );
    req.on("error", (error) => resolve({ status: 0, text: error.message, ms: Date.now() - started }));
    req.end(raw);
  });
}

const body = {
  model: "qwen2.5-0.5b",
  max_tokens: 16,
  messages: [{ role: "user", content: "Reply with one word: ok" }],
};

const results = [];
let reloadPromise = null;
for (let i = 1; i <= 16; i++) {
  if (i === 5) {
    reloadPromise = post("/api/engine/reload", {}, token ? { authorization: `Bearer ${token}` } : {});
  }
  const res = await post("/v1/chat/completions", body);
  let ok = res.status === 200;
  try {
    const json = JSON.parse(res.text);
    ok = ok && typeof json.choices?.[0]?.message?.content === "string";
  } catch {
    ok = false;
  }
  results.push({ i, status: res.status, ok, ms: res.ms });
  console.log(`${ok ? "PASS" : "FAIL"} request ${String(i).padStart(2)} status=${res.status} ${res.ms}ms${ok ? "" : ` ${res.text.slice(0, 120)}`}`);
}

const reload = reloadPromise ? await reloadPromise : { status: 0, text: "not fired" };
const final = await post("/v1/chat/completions", body);
const failed = results.filter((row) => !row.ok);
const maxMs = Math.max(...results.map((row) => row.ms));
const pass = failed.length === 0 && reload.status === 200 && final.status === 200;
console.log(
  JSON.stringify(
    { requests: results.length, failed: failed.length, max_ms: maxMs, reload_status: reload.status, final_status: final.status },
    null,
    2,
  ),
);
console.log(pass ? "CONTINUITY_PASS" : "CONTINUITY_FAIL");
if (!pass) process.exitCode = 1;
