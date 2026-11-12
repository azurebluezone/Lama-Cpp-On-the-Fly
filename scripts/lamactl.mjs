#!/usr/bin/env node
/**
 * lamactl — CLI for the lama management wrapper. Node built-ins only.
 *
 *   lamactl status                manager + llama server state
 *   lamactl models                scanned GGUF list
 *   lamactl load <name> [ctx]     load a model (name = model list name or full path)
 *   lamactl unload                stop the llama server
 *   lamactl download <repo> <file>  fetch a GGUF into LAMA_MODELS_DIR
 *   lamactl logs [n]              tail the management log
 *   lamactl requests [n]          tail the request log
 *
 * Reads LAMA_MGMT_BASE_URL / LAMA_MGMT_KEY from <lama>/.env, falls back to
 * http://127.0.0.1:5252 and no key.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const LAMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const line of fs.readFileSync(path.join(LAMA, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;

const BASE = (env.LAMA_MGMT_BASE_URL || `http://${env.LAMA_MGMT_HOST || "127.0.0.1"}:${env.LAMA_MGMT_PORT || 5252}`).replace(/\/+$/, "");
const KEY = env.LAMA_API_KEY || "";
const headers = KEY ? { Authorization: `Bearer ${KEY}` } : {};
const [, , cmd, ...rest] = process.argv;

const call = async (p, init = {}) => {
  const res = await fetch(BASE + p, { ...init, headers: { ...headers, "content-type": "application/json" } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) { process.stderr.write(`error ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}\n`); process.exit(1); }
  return body;
};

const MB = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

async function main() {
  switch (cmd) {
    case "status": {
      const s = await call("/api/status");
      process.stdout.write(`manager : ${s.mgmt.uptime_s}s up, node ${s.mgmt.node}\n`);
      process.stdout.write(`llama   : ${s.llama.health}${s.llama.alias ? ` (${s.llama.alias}, ${s.llama.model})` : ""}\n`);
      process.stdout.write(`base    : ${s.llama.base_url}\n`);
      break;
    }
    case "models": {
      const { models, dirs } = await call("/api/models");
      process.stdout.write(`scan dirs:\n  - ${dirs.join("\n  - ")}\n`);
      for (const m of models) process.stdout.write(`${m.name.padEnd(46)} ${MB(m.size).padStart(10)}  [${m.source}] ${m.path}\n`);
      if (!models.length) process.stdout.write("(no .gguf found)\n");
      break;
    }
    case "load": {
      const [name, ctx] = rest;
      if (!name) { process.stderr.write("usage: lamactl load <name> [ctx]\n"); process.exit(2); }
      process.stdout.write(`loading ${name} ... (4 threads; small models ~20s, 4B ~60s)\n`);
      const r = await call("/api/load", { method: "POST", body: JSON.stringify({ name, ctx: Number(ctx) || undefined }) });
      process.stdout.write(`loaded: ${r.alias} pid=${r.pid} base=${r.base_url}\n`);
      break;
    }
    case "unload": {
      const r = await call("/api/unload", { method: "POST", body: "{}" });
      process.stdout.write(`unloaded (was ${r.was || "none"}, signal=${r.signal})\n`);
      break;
    }
    case "download": {
      const [repo, file] = rest;
      if (!repo || !file) { process.stderr.write("usage: lamactl download <org/repo> <file.gguf[:quant]>\n"); process.exit(2); }
      process.stdout.write(`downloading ${repo}/${file} ...\n`);
      const r = await call("/api/download", { method: "POST", body: JSON.stringify({ repo, file }) });
      process.stdout.write(`saved: ${r.path} (${MB(r.size)})\n`);
      break;
    }
    case "logs": {
      const n = Number(rest[0]) || 10;
      for (const line of (await call(`/api/logs?n=${n}`)).lines) process.stdout.write(`${line}\n`);
      break;
    }
    case "requests": {
      const n = Number(rest[0]) || 10;
      for (const line of (await call(`/api/requests?n=${n}`)).lines) process.stdout.write(`${line}\n`);
      break;
    }
    default:
      process.stdout.write(
        fs.readFileSync(path.join(LAMA, "docs", "legacy-server-manager.md"), "utf8").split("## lamactl")[1]?.split("## ")[0]
          || "see docs/legacy-server-manager.md\n",
      );
  }
}
main().catch((e) => { process.stderr.write(`${e.cause?.code === "ECONNREFUSED" ? `manager not reachable at ${BASE}` : e.message}\n`); process.exit(1); });
