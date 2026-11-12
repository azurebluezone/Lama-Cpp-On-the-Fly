import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ensureTls, relinkLocalSymlinks, shipsAssets, tlsSupport } from "../src/installer.ts";
import { EngineManager, buildEngineArgs, resolveBinary, resolveModel } from "../src/engine.ts";
import { Store, seedStore } from "../src/db.ts";
import { testConfig, testOs } from "./helpers.ts";

const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

test("ensureTls generates a matching cert/key once, then reuses it", { skip: !openssl }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-tls-"));
  const cfg = testConfig(root);
  const first = ensureTls(cfg);
  assert.equal(first.ok, true, first.detail);
  assert.equal(first.generated, true);
  const second = ensureTls(cfg);
  assert.equal(second.ok, true, second.detail);
  assert.equal(second.generated, false);
});

test("ensureTls detects a certificate/key mismatch", { skip: !openssl }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-tls-"));
  const cfg = testConfig(root);
  assert.equal(ensureTls(cfg).ok, true);
  // Replace the key with a fresh one that does not belong to the certificate.
  const other = path.join(root, "other-key.pem");
  const result = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=other", "-keyout", other, "-out", path.join(root, "other-cert.pem")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  fs.copyFileSync(other, cfg.tlsKey);
  const checked = ensureTls(cfg);
  assert.equal(checked.ok, false);
  assert.match(checked.detail, /do not match/);
});

test("resolveBinary accepts the unified llama binary and adds the serve prefix", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-bin-"));
  const binary = path.join(root, "llama");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const cfg = testConfig(root);
  cfg.llamaBin = "";
  const previous = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${previous ?? ""}`;
  try {
    const resolved = resolveBinary(cfg);
    assert.equal(resolved.command, binary);
    assert.deepEqual(resolved.prefix, ["serve"]);
  } finally {
    process.env.PATH = previous;
  }
});


test("resolveBinary finds the project bin link created by install:llama", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-bin-"));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, "llama-server");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const cfg = testConfig(root);
  cfg.llamaBin = "";
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  // Hide any real PATH or ~/.local/bin install so only <root>/bin can answer.
  process.env.PATH = "/nonexistent";
  process.env.HOME = root;
  try {
    const resolved = resolveBinary(cfg);
    assert.equal(resolved.command, binary);
    assert.deepEqual(resolved.prefix, []);
  } finally {
    process.env.PATH = savedPath;
    process.env.HOME = savedHome;
  }
});

test("resolveBinary prefers the project bin over an ambient PATH binary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-bin-"));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bundled = path.join(binDir, "llama");
  fs.writeFileSync(bundled, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // A second llama sits on PATH: the project-local one must still win, otherwise the
  // same dist artifact runs a different engine depending on the machine it lands on.
  const ambient = fs.mkdtempSync(path.join(os.tmpdir(), "lama-ambient-"));
  fs.writeFileSync(path.join(ambient, "llama"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const cfg = testConfig(root);
  cfg.llamaBin = "";
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  // Keep /usr/bin reachable so `which` itself still runs: only the llama on PATH differs.
  process.env.PATH = `${ambient}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  process.env.HOME = root; // hide any ~/.local/bin install
  try {
    const resolved = resolveBinary(cfg);
    assert.equal(resolved.command, bundled);
    assert.deepEqual(resolved.prefix, ["serve"]);
  } finally {
    process.env.PATH = savedPath;
    process.env.HOME = savedHome;
    fs.rmSync(ambient, { recursive: true, force: true });
  }
});

test("resolveBinary honours an explicit override and fails loudly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-bin-"));
  const cfg = testConfig(root);
  cfg.llamaBin = path.join(root, "missing-binary");
  assert.throws(() => resolveBinary(cfg), /llama binary not found/);
});

test("buildEngineArgs serves HTTP and UDS in one stock command", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-args-"));
  const cfg = testConfig(root);
  const model = path.join(root, "model.gguf");
  fs.writeFileSync(model, "not a real model");
  const binary = path.join(root, "llama-server");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  cfg.llamaBin = binary;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.dataDir, "mcp-servers.generated.json"), '{"mcpServers":{"x":{"command":"y"}}}');
  const built = buildEngineArgs(cfg, {
    id: "m1",
    provider_id: "llamacpp",
    name: "m1",
    model_id: "m1",
    path: model,
    context: 2048,
    max_tokens: 128,
    temperature: 0.7,
    quant: null,
    load_mode: "auto" as const,
    ttl_hours: 1,
    enabled: 1,
    metadata_json: "{}",
    created_at: "",
    updated_at: "",
  });
  assert.equal(built.command, binary);
  assert.equal(built.args[built.args.indexOf("--host") + 1], `127.0.0.1,${cfg.udsPath}`);
  assert.ok(built.args.includes("--jinja"));
  assert.ok(built.args.includes("--mcp-servers-config"));
  assert.equal(built.args[built.args.indexOf("--port") + 1], "19931");
});

test("CPU accel forces --device none so an incomplete GPU driver cannot break the load", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-device-"));
  const cfg = testConfig(root);
  const model = path.join(root, "model.gguf");
  fs.writeFileSync(model, "not a real model");
  const binary = path.join(root, "llama");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  cfg.llamaBin = binary;
  const row = {
    id: "m1",
    provider_id: "llamacpp",
    name: "m1",
    model_id: "m1",
    path: model,
    context: 2048,
    max_tokens: 128,
    temperature: 0.7,
    quant: null,
    load_mode: "auto" as const,
    ttl_hours: 1,
    enabled: 1,
    metadata_json: "{}",
    created_at: "",
    updated_at: "",
  };
  const cpu = buildEngineArgs(cfg, row);
  assert.equal(cpu.args[cpu.args.indexOf("--device") + 1], "none");
  cfg.accel = "vulkan";
  const gpu = buildEngineArgs(cfg, row);
  assert.equal(gpu.args.includes("--device"), false);
});

test("tlsSupport reports static binaries as undetermined instead of guessing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-ldd-"));
  const binary = path.join(root, "llama");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = tlsSupport(binary, {
    platform: "linux",
    arch: "x64",
    distro: "test",
    distroVersion: "",
    glibc: null,
    isRoot: false,
    serviceManager: "systemd",
    home: root,
    pathSep: "/",
  });
  assert.equal(result.supported, null);
  // ldd exits 1 on a static binary; the detail must still say why, not paste raw ldd output.
  assert.match(result.detail, /statically linked/);
  assert.doesNotMatch(result.detail, /^not a dynamic executable$/);
});

test("engine load names the model ids that do exist instead of a dead end", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-model-"));
  fs.mkdirSync(path.join(root, "models"), { recursive: true });
  fs.writeFileSync(path.join(root, "models", "tiny-model.Q4_K_M.gguf"), "not a real model");
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  seedStore(store, cfg, testOs());
  const engine = new EngineManager(store, cfg, testOs());
  assert.equal(store.listModels()[0]?.model_id, "tiny-model-q4-k-m");
  await assert.rejects(engine.start("<model-id>"), (error: Error) => {
    assert.match(error.message, /unknown model: <model-id>/);
    assert.match(error.message, /available models: tiny-model-q4-k-m/);
    return true;
  });
});

test("engine resolves a model by the public alias, not only the row id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-alias-"));
  const cfg = testConfig(root);
  const store = new Store(cfg.dbFile);
  fs.mkdirSync(cfg.modelsDir, { recursive: true });
  seedStore(store, cfg, testOs());
  const file = path.join(root, "m.gguf");
  fs.writeFileSync(file, "not a real model");
  // The UI, /v1/models and `engine load` users see the alias; the row id is a slug.
  store.upsertModel({
    id: "row-id",
    provider_id: "llamacpp",
    name: "Row",
    model_id: "public.alias",
    path: file,
    context: 2048,
    max_tokens: 128,
    temperature: 0.7,
    quant: null,
    load_mode: "auto" as const,
    ttl_hours: 1,
    enabled: 1,
    metadata_json: "{}",
  });
  assert.equal(resolveModel(store, "public.alias")?.id, "row-id");
  assert.equal(resolveModel(store, "row-id")?.model_id, "public.alias");
  assert.equal(resolveModel(store, "missing"), undefined);
});

test("shipsAssets skips a release that is still uploading and names the gap", () => {
  const os = testOs();
  // b11985 on GitHub had only the cudart companions — no CPU tarball yet.
  assert.equal(shipsAssets("b11985", ["cudart-llama-b11985-bin-ubuntu-cuda-13.4-x64.tar.gz"], os, "cpu"), false);
  assert.equal(shipsAssets("b11982", ["llama-b11982-bin-ubuntu-x64.tar.gz"], os, "cpu"), true);
  assert.equal(
    shipsAssets("b11982", ["llama-b11982-bin-ubuntu-cuda-13.4-x64.tar.gz"], os, "cuda"),
    false,
    "cuda must refuse without its cudart companion",
  );
  assert.equal(shipsAssets("b11982", ["llama-b11982-bin-macos-x64.tar.gz"], os, "cpu"), false, "wrong platform asset is not a match");
});

test("relinkLocalSymlinks repairs the absolute links fs.cpSync leaves behind", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lama-symlink-"));
  const temp = path.join(root, "temp", "llama-b0");
  const installDir = path.join(root, "bin", "llama", "b0");
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(path.join(temp, "libllama-common.so.0.8.0"), "elf");
  fs.symlinkSync("libllama-common.so.0.8.0", path.join(temp, "libllama-common.so.0")); // as the archive ships it
  fs.cpSync(temp, installDir, { recursive: true });
  fs.rmSync(path.join(root, "temp"), { recursive: true, force: true }); // install cleans its staging dir
  const link = path.join(installDir, "libllama-common.so.0");
  assert.equal(path.isAbsolute(fs.readlinkSync(link)), true, "cpSync absolutized the link");
  assert.equal(fs.existsSync(link), false, "and it dangles once the temp dir is gone");
  assert.equal(relinkLocalSymlinks(installDir), 1);
  assert.equal(fs.readlinkSync(link), "libllama-common.so.0.8.0");
  assert.equal(fs.existsSync(link), true);
});
