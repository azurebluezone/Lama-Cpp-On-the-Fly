import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT, loadConfig, resolveApiKey } from "../src/config.ts";

const KEYS = [
  "LAMA_HOME",
  "LAMA_DATA_DIR",
  "LAMA_MODELS_DIR",
  "LAMA_DB",
  "LAMA_WEB_DIR",
  "LAMA_UDS_SOCK",
  "LAMA_GATEWAY_PORT",
  "LAMA_GATEWAY_ENGINE",
  "LAMA_GATEWAY_UDS",
  "LAMA_ENGINE_PORT",
  "LAMA_LLAMA_BIN",
];

function withEnvFile(lines: string[], run: (cfg: ReturnType<typeof loadConfig>) => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lama-config-"));
  const file = path.join(dir, "env");
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  process.env.LAMA_ENV_FILE = file;
  try {
    run(loadConfig());
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.LAMA_ENV_FILE;
  }
}

test("a tunables-only env file derives every path from the project root", () => {
  // This is the .env shape setup writes: no absolute paths, no comments.
  withEnvFile(["LAMA_ENGINE_PORT=9931", "LAMA_GATEWAY_PORT=5252", "LAMA_GATEWAY_ENGINE=uds", "LAMA_TLS=0"], (cfg) => {
    assert.equal(cfg.root, ROOT);
    assert.equal(cfg.dataDir, path.join(ROOT, "data"));
    assert.equal(cfg.dbFile, path.join(ROOT, "data", "manager.db"));
    assert.equal(cfg.modelsDir, path.join(ROOT, "models"));
    assert.equal(cfg.webDir, path.join(ROOT, "web"));
    assert.equal(cfg.envFile, process.env.LAMA_ENV_FILE);
    assert.equal(cfg.gatewayPort, 5252);
    assert.equal(cfg.gatewayEngine, "uds");
    assert.equal(cfg.gatewayUdsPath, path.join(cfg.runDir, "gateway.sock"));
    assert.equal(cfg.udsPath, path.join(os.tmpdir(), `llama-${process.getuid?.() ?? "user"}`, "llama.sock"));
    assert.equal(cfg.llamaBin, "", "no hardcoded binary path; resolveBinary finds it");
  });
});

test("an explicit empty LAMA_UDS_SOCK disables the unix socket (Windows shape)", () => {
  withEnvFile(["LAMA_UDS_SOCK="], (cfg) => {
    assert.equal(cfg.udsPath, "");
  });
});

test("a relative root override resolves against the working directory, not a home path", () => {
  withEnvFile(["LAMA_HOME=./tmp-root"], (cfg) => {
    assert.equal(cfg.root, path.resolve("./tmp-root"));
    assert.equal(cfg.dataDir, path.resolve("./tmp-root", "data"));
  });
});

test("LAMA_API_KEY=false opens the proxy without a token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lama-apikey-"));
  const file = path.join(dir, "api-token");
  const resolved = resolveApiKey("false", "0.0.0.0", file);
  assert.deepEqual(resolved, { apiKey: "", apiAuth: "open" });
  assert.equal(fs.existsSync(file), false, "open mode must not create a token file");
});

test("an empty LAMA_API_KEY stays token-free on loopback and self-generates when bound to the LAN", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lama-apikey-"));
  const file = path.join(dir, "api-token");
  assert.deepEqual(resolveApiKey("", "127.0.0.1", file), { apiKey: "", apiAuth: "loopback" });
  assert.equal(fs.existsSync(file), false, "loopback mode needs no token file");

  const remote = resolveApiKey("  ", "0.0.0.0", file);
  assert.equal(remote.apiAuth, "required");
  assert.ok(remote.apiKey.length >= 24, "a real random token was generated");
  assert.equal(fs.readFileSync(file, "utf8").trim(), remote.apiKey);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(resolveApiKey("", "0.0.0.0", file).apiKey, remote.apiKey, "the token persists across reloads");
});

test("LAMA_API_KEY=true requires a token even on loopback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lama-apikey-"));
  const file = path.join(dir, "api-token");
  const resolved = resolveApiKey("true", "127.0.0.1", file);
  assert.equal(resolved.apiAuth, "required");
  assert.ok(resolved.apiKey.length >= 24);
});

test("an explicit LAMA_API_KEY value is used verbatim", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lama-apikey-"));
  const file = path.join(dir, "api-token");
  assert.deepEqual(resolveApiKey("house-key-123", "127.0.0.1", file), {
    apiKey: "house-key-123",
    apiAuth: "required",
  });
  assert.equal(fs.existsSync(file), false);
});
