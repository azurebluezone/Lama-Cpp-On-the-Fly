#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, ensureDirs } from "./config.ts";
import { detectOs } from "./os.ts";
import { Store, retryDatabaseLocked, seedStore } from "./db.ts";
import { EngineManager, resolveBinary, mmapStatus } from "./engine.ts";
import { createGatewayServer, listenGatewayServer, listenGatewayUds, gatewayHealth, gatewayUdsHealth, gatewayUrl, adminUrl } from "./gateway/server.ts";
import { createAdminRuntime } from "./admin.ts";
import { installLlama, ensureTls, tlsSupport, binaryVersion } from "./installer.ts";
import { writeEngineMcpConfig } from "./mcp/config.ts";
import { applySeeds } from "./seed.ts";
import { ensureIdentityFile } from "./identity.ts";
import { ResponseLogger } from "./logging.ts";
import { ResponseCache } from "./cache.ts";
import { LocalIndex } from "./retrieval.ts";
import { syncSystemPrompt } from "./prompt.ts";
import { installService, serviceAction, serviceAvailable } from "./service.ts";
import { clearToken, downloadFile, fetchRange, getToken, listGgufFiles, maskToken, resolveUrl, setToken } from "./hf.ts";

function usage(): void {
  process.stdout.write(`lama-clean — stock llama.cpp lifecycle manager

Usage:
  node src/main.ts setup [--service user|system]
  node src/main.ts install [--build bNNNNN] [--accel cpu|cuda|vulkan|rocm|openvino|sycl] [--force]
  node src/main.ts tls [--check]
  node src/main.ts doctor [--json]
  node src/main.ts serve
  node src/main.ts engine-run
  node src/main.ts engine load <model-id|alias> [--ttl HOURS]
  node src/main.ts engine unload
  node src/main.ts engine reload [model-id|alias] [--ttl HOURS]
  node src/main.ts engine status
  node src/main.ts adapter list
  node src/main.ts adapter <opencode|vscode|claude-code|curl> [--base-url URL] [--model NAME] [--json]
  node src/main.ts service install user|system [--gateway] [--start|--no-start]
  node src/main.ts service start|stop|restart|status user|system [--gateway]
  node src/main.ts seed
  node src/main.ts mcp
  node src/main.ts hf token set [hf_...]   (reads stdin when no argument)
  node src/main.ts hf token status|clear
  node src/main.ts hf files <owner/repo>
  node src/main.ts hf download <owner/repo> [--file NAME]
  node src/main.ts hf smoke

Environment: .env next to package.json; process.env wins.
`);
}

function ensureAdminToken(cfg: ReturnType<typeof loadConfig>): string {
  if (cfg.adminToken) return cfg.adminToken;
  if (process.env.LAMA_ADMIN_TOKEN) return process.env.LAMA_ADMIN_TOKEN;
  const token = randomBytes(32).toString("base64url");
  fs.appendFileSync(cfg.envFile, `LAMA_ADMIN_TOKEN=${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(cfg.envFile, 0o600);
  } catch {
    // chmod is not available on every platform
  }
  cfg.adminToken = token;
  return token;
}

function setupEnvFile(cfg: ReturnType<typeof loadConfig>): void {
  if (!fs.existsSync(cfg.envFile)) {
    // Portable by design: no absolute paths, no comments. Every path is derived from the
    // project root at runtime, so the same file works in any folder, on any user, on any OS.
    const content = `LAMA_ENGINE_HOST=${cfg.engineHost}
LAMA_ENGINE_PORT=${cfg.enginePort}
LAMA_GATEWAY_HOST=${cfg.gatewayHost}
LAMA_GATEWAY_PORT=${cfg.gatewayPort}
LAMA_GATEWAY_ENGINE=${cfg.gatewayEngine}
LAMA_GATEWAY_ORIGINS=${cfg.gatewayOrigins.join(",")}
LAMA_TLS_PORT=${cfg.tlsPort}
LAMA_LOAD_MODE=${cfg.loadMode}
LAMA_ACCEL=${cfg.accel}
LAMA_SERVICE_MODE=${cfg.serviceMode}
LAMA_TLS=0
LAMA_DEFAULT_TTL_HOURS=${cfg.defaultTtlHours}
`;
    fs.writeFileSync(cfg.envFile, content, { mode: 0o600 });
  } else {
    try {
      fs.chmodSync(cfg.envFile, 0o600);
    } catch {
      // best effort
    }
  }
  ensureAdminToken(cfg);
}

async function main(): Promise<void> {
  // `node src/main.ts doctor | head -3` closes the pipe early; without this the
  // process dies with an EPIPE stack trace instead of a clean exit.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }

  const cfg = loadConfig();
  const os = detectOs();
  ensureDirs(cfg);
  // The manifest is immutable: create it if missing and force 0444 on every boot.
  ensureIdentityFile(cfg.root);
  // At boot lama-gateway and lama-engine both run this bootstrap against one SQLite file.
  // A transient lock must delay the start, not fail the unit (that was the reset-time
  // "lama: database is locked" crash loop).
  let retries = 0;
  const boot = retryDatabaseLocked(
    () => {
      const opened = new Store(cfg.dbFile);
      seedStore(opened, cfg, os);
      syncSystemPrompt(opened, cfg);
      const report = applySeeds(opened, cfg, os);
      writeEngineMcpConfig(opened, cfg);
      return { store: opened, report };
    },
    {
      onRetry: (attempt, delay) => {
        retries = attempt;
        // Informational, not an error: another lama process holds the SQLite write lock.
        // The raw SQLite message is only surfaced if every retry is exhausted.
        process.stderr.write(`lama: manager.db busy at boot (another process holds the SQLite lock) — attempt ${attempt}, retrying in ${delay}ms\n`);
      },
    },
  );
  if (retries) process.stderr.write(`lama: database lock cleared after ${retries} retr${retries === 1 ? "y" : "ies"}\n`);
  const store = boot.store;
  const seedReport = boot.report;
  const engine = new EngineManager(store, cfg, os);

  if (command === "setup") {
    setupEnvFile(cfg);
    const identityFile = ensureIdentityFile(cfg.root);
    const seedReport = applySeeds(store, cfg, os);
    const result = {
      config: cfg.envFile,
      identity: identityFile,
      db: cfg.dbFile,
      models: cfg.modelsDir,
      uds: cfg.udsPath,
      gateway: gatewayUrl(cfg),
      admin: adminUrl(cfg),
      seeds: { files: seedReport.files.length, counts: seedReport.counts, warnings: seedReport.warnings },
    };
    if (rest.includes("--service")) {
      const index = rest.indexOf("--service");
      const mode = rest[index + 1] === "system" ? "system" : "user";
      const engineUnit = installService(cfg, os, mode, "engine");
      const gatewayUnit = installService(cfg, os, mode, "gateway");
      process.stdout.write(`${JSON.stringify({ ...result, services: { engine: engineUnit, gateway: gatewayUnit } }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`gateway token: see ${cfg.envFile} (LAMA_ADMIN_TOKEN)\n`);
    return;
  }

  if (command === "seed") {
    const report = applySeeds(store, cfg, os);
    const sync = writeEngineMcpConfig(store, cfg);
    process.stdout.write(
      `${JSON.stringify(
        { db: cfg.dbFile, identity: report.identity, counts: report.counts, skipped: report.skipped, warnings: report.warnings, models: store.listModels().length, mcp: sync, build: engine.binaryVersion() },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === "install") {
    const buildIndex = rest.indexOf("--build");
    const accelIndex = rest.indexOf("--accel");
    const build = buildIndex >= 0 ? rest[buildIndex + 1] : cfg.build;
    const accel = (accelIndex >= 0 ? rest[accelIndex + 1] : cfg.accel) as "cpu" | "cuda" | "vulkan" | "rocm" | "openvino" | "sycl";
    const result = await installLlama(cfg, os, { build: build ?? null, accel, force: rest.includes("--force") });
    const provider = store.getProvider("llamacpp");
    if (provider) {
      store.upsertProvider({ ...provider, base_url: cfg.engineUrl, build: result.tag, config_json: JSON.stringify({ binary: result.binary, load_mode: cfg.loadMode, accel }) });
    }
    store.audit("install", result.tag, result.binary, "cli");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "tls") {
    if (rest.includes("--check")) {
      const result = ensureTls(cfg);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    const result = ensureTls(cfg);
    const support = resolveBinary(cfg);
    const linked = tlsSupport(support.command, os);
    process.stdout.write(`${JSON.stringify({ ...result, linkage: linked }, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "doctor") {
    let binary: string | null = null;
    let version: string | null = null;
    let linkage: { supported: boolean | null; detail: string } = { supported: null, detail: "binary not found" };
    try {
      const resolved = resolveBinary(cfg);
      binary = resolved.command;
      version = binaryVersion(binary);
      linkage = tlsSupport(binary, os);
    } catch (error) {
      linkage = { supported: null, detail: (error as Error).message };
    }
    const status = await engine.status();
    const gateway = await gatewayHealth(cfg.gatewayHost, cfg.gatewayPort);
    const gatewayUds = await gatewayUdsHealth(cfg.gatewayUdsPath);
    const admin = gateway;
    const report = {
      labels: {
        os: "SOURCE_VERIFIED",
        db: "SOURCE_VERIFIED",
        binary: binary ? "LIVE_PROBE_PASSED" : "NOT_TESTED",
        tls: linkage.supported === null ? "UNVERIFIED" : "SOURCE_VERIFIED",
        engine: status.status === "running" ? "LIVE_PROBE_PASSED" : "NOT_TESTED",
        gateway: gateway.up ? "LIVE_PROBE_PASSED" : "NOT_TESTED",
        gateway_uds: gatewayUds.up ? "LIVE_PROBE_PASSED" : "NOT_TESTED",
        admin: admin.up ? "LIVE_PROBE_PASSED" : "NOT_TESTED",
      },
      os,
      paths: {
        root: cfg.root,
        db: cfg.dbFile,
        models: cfg.modelsDir,
        uds: cfg.udsPath,
        gateway_uds: cfg.gatewayUdsPath,
        gateway: gatewayUrl(cfg),
        admin: adminUrl(cfg),
      },
      binary: { path: binary, version, tls: linkage },
      service: { mode: store.setting("service_mode") ?? cfg.serviceMode, available: serviceAvailable(os) },
      engine: status,
      gateway: { url: gatewayUrl(cfg), up: gateway.up, detail: gateway.detail },
      gateway_uds: { path: cfg.gatewayUdsPath, up: gatewayUds.up, detail: gatewayUds.detail },
      admin: { url: adminUrl(cfg), up: admin.up, detail: "mounted in the gateway" },
      counts: { models: store.listModels().length, mcp: store.listMcp().length, transports: store.listTransports().length, documents: store.listDocuments().length, prompts: store.listPrompts().length },
      warnings: cfg.warnings,
    };
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(`os        ${os.platform}/${os.arch} ${os.distro} ${os.distroVersion} glibc=${os.glibc ?? "n/a"}\n`);
      process.stdout.write(`binary    ${binary ?? "NOT FOUND"} ${version ?? ""}\n`);
      process.stdout.write(`tls       ${linkage.supported === null ? "unknown" : linkage.supported ? "linked" : "not linked"} — ${linkage.detail}\n`);
      process.stdout.write(`engine    ${status.status} pid=${status.pid ?? "-"} mmap=${status.mmap?.mapped ? "yes" : "no"}\n`);
      process.stdout.write(`db        ${cfg.dbFile} models=${report.counts.models} mcp=${report.counts.mcp} docs=${report.counts.documents}\n`);
      process.stdout.write(`gateway   ${gatewayUrl(cfg)} ${gateway.up ? "up" : "down"} — ${gateway.detail}\n`);
      if (cfg.gatewayUdsPath) process.stdout.write(`gateway+  ${cfg.gatewayUdsPath} ${gatewayUds.up ? "up" : "down"} — ${gatewayUds.detail}\n`);
      process.stdout.write(`admin     ${adminUrl(cfg)} ${admin.up ? "up" : "down"} — mounted in the gateway\n`);
      if (cfg.warnings.length) process.stdout.write(`warnings  ${cfg.warnings.join("; ")}\n`);
    }
    if (!binary) process.exitCode = 1;
    return;
  }

  if (command === "serve") {
    // One process, one listener per transport. The admin API is a route tree of
    // the gateway, not a second server: both TCP and UDS share one admin runtime.
    const logger = new ResponseLogger(cfg);
    const cache = new ResponseCache();
    const index = new LocalIndex();
    const adminRuntime = createAdminRuntime({ store, cfg, os, engine, logger, cache, index });
    const server = createGatewayServer({
      store, cfg, os, engine, adminRuntime, transportId: "http", logger, cache, index,
    });
    const udsServer = cfg.gatewayUdsPath
      ? createGatewayServer({
          store, cfg, os, engine, adminRuntime, transportId: "uds", logger, cache, index,
        })
      : null;
    try {
      await listenGatewayServer(server, cfg.gatewayHost, cfg.gatewayPort);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      const owner = failure.code === "EADDRINUSE" ? await gatewayHealth(cfg.gatewayHost, cfg.gatewayPort) : { up: false, detail: "" };
      if (owner.up) {
        // Idempotent: a second unit (or a manual run) must not crash-loop the journal.
        process.stderr.write(`lama: gateway already running at ${gatewayUrl(cfg)} (${owner.detail}); nothing to do\n`);
        return;
      }
      process.stderr.write(`lama: ${failure.message}\n`);
      if (owner.detail) process.stderr.write(`lama: the port answers, but not as lama-gateway — ${owner.detail}\n`);
      process.exit(1);
    }
    if (udsServer) {
      try {
        await listenGatewayUds(udsServer, cfg.gatewayUdsPath);
      } catch (error) {
        process.stderr.write(`lama: ${error instanceof Error ? error.message : String(error)}\n`);
        server.close();
        process.exit(1);
      }
    }
    process.stdout.write(`lama gateway: ${gatewayUrl(cfg)}\n`);
    process.stdout.write(`lama admin:   ${adminUrl(cfg)} (mounted in the gateway; operator token required)\n`);
    if (udsServer) process.stdout.write(`lama gateway+ ${cfg.gatewayUdsPath} (UDS, same routes)\n`);
    process.stdout.write(`engine: ${cfg.engineUrl} via ${cfg.gatewayEngine} (engine UDS ${cfg.udsPath || "disabled"})\n`);
    if (!cfg.adminToken && !cfg.apiKey) {
      process.stdout.write("warning: no LAMA_ADMIN_TOKEN or LAMA_API_KEY; the admin API is locked. Run `npm run setup` to mint the operator token.\n");
    }
    if (cfg.apiAuth === "open") process.stdout.write("warning: LAMA_API_KEY=false; /v1 accepts any client without a token\n");
    else if (cfg.apiAuth === "loopback") process.stdout.write("warning: loopback only; no token required from 127.0.0.1\n");
    engine.startExpiryLoop();
    // The engine child lives in this process's cgroup, so a control-plane
    // restart kills it. Resume the model that was running before the restart,
    // unless its TTL already expired.
    const persisted = store.engineState();
    if (persisted.status === "running" && persisted.expires_at && Date.parse(persisted.expires_at) > Date.now()) {
      const model = persisted.model_id ? store.getModel(persisted.model_id) : undefined;
      if (model) {
        void engine.start(model.model_id).catch((error: unknown) => {
          process.stderr.write(`lama: engine resume failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }
    }
    const servers = udsServer ? [server, udsServer] : [server];
    const close = (): void => {
      engine.stopExpiryLoop();
      let pending = servers.length;
      const done = (): void => {
        pending -= 1;
        if (pending <= 0) process.exit(0);
      };
      for (const listener of servers) listener.close(done);
      // Streaming/SSE clients keep the server open, which used to make systemd
      // SIGKILL us after TimeoutStopSec=20. Drop idle sockets now, then force
      // the remaining streams closed after a short grace period.
      for (const listener of servers) listener.closeIdleConnections();
      const force = setTimeout(() => {
        for (const listener of servers) listener.closeAllConnections();
        process.exit(0);
      }, 2000);
      force.unref();
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    return;
  }

  if (command === "engine-run") {
    await engine.runForeground();
    return;
  }

  if (command === "engine") {
    const action = rest[0];
    if (action === "load") {
      const modelId = rest[1];
      if (!modelId) throw new Error("engine load needs a model id");
      const ttlIndex = rest.indexOf("--ttl");
      const ttl = ttlIndex >= 0 ? Number(rest[ttlIndex + 1]) : undefined;
      process.stdout.write(`${JSON.stringify(await engine.start(modelId, ttl), null, 2)}\n`);
      return;
    }
    if (action === "unload") {
      process.stdout.write(`${JSON.stringify(await engine.stop(), null, 2)}\n`);
      return;
    }
    if (action === "reload") {
      const ttlIndex = rest.indexOf("--ttl");
      const ttl = ttlIndex >= 0 ? Number(rest[ttlIndex + 1]) : undefined;
      process.stdout.write(`${JSON.stringify(await engine.reload(rest[1], ttl), null, 2)}\n`);
      return;
    }
    if (action === "status") {
      process.stdout.write(`${JSON.stringify(await engine.status(), null, 2)}\n`);
      return;
    }
    throw new Error("engine action must be load, unload, reload or status");
  }

  if (command === "service") {
    const action = rest[0];
    const mode = rest.includes("system") ? "system" : "user";
    const kind = rest.includes("--gateway") ? "gateway" : "engine";
    if (action === "install") {
      // engine: enable-only by default (the manager loads models on demand);
      // gateway: start now, since it is the single human + client entry point.
      const start = rest.includes("--no-start") ? false : rest.includes("--start") ? true : undefined;
      const result = installService(cfg, os, mode, kind, start === undefined ? {} : { start });
      if (result.ok) {
        store.setSetting("service_mode", mode);
        // Keep .env in sync so every CLI run (including engine load) uses the
        // same scope as the unit that was actually installed.
        const envText = fs.existsSync(cfg.envFile) ? fs.readFileSync(cfg.envFile, "utf8") : "";
        const line = `LAMA_SERVICE_MODE=${mode}`;
        const next = /^LAMA_SERVICE_MODE=.*$/m.test(envText)
          ? envText.replace(/^LAMA_SERVICE_MODE=.*$/m, line)
          : `${envText.trimEnd()}${envText.trim() ? "\n" : ""}${line}\n`;
        fs.writeFileSync(cfg.envFile, next, { mode: 0o600 });
      }
      store.audit("service.install", `${kind}/${mode}`, result.detail, "cli");
      process.stdout.write(`${JSON.stringify({ kind, mode, ...result }, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (action === "start" || action === "stop" || action === "restart" || action === "status") {
      const result = serviceAction(os, mode, action, kind);
      store.audit(`service.${action}`, `${kind}/${mode}`, result.detail, "cli");
      process.stdout.write(`${JSON.stringify({ kind, mode, action, ...result }, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    throw new Error("service action must be install, start, stop, restart or status");
  }

  if (command === "adapter") {
    const { runAdapterCli } = await import("./adapters/cli.ts");
    await runAdapterCli(rest);
    return;
  }

  if (command === "mcp") {
    await import("./mcp/server.ts");
    return;
  }

  if (command === "hf") {
    const action = rest[0];
    if (action === "token") {
      const sub = rest[1];
      if (sub === "set") {
        let token = rest[2]?.trim() ?? "";
        if (!token && !process.stdin.isTTY) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          token = Buffer.concat(chunks).toString("utf8").trim();
        }
        if (!token) throw new Error("hf token set needs a token (argument or stdin)");
        setToken(store, token);
        store.audit("hf.token.set", maskToken(token), "cli");
        process.stdout.write(`${JSON.stringify({ set: true, preview: maskToken(token) }, null, 2)}\n`);
        return;
      }
      if (sub === "status") {
        const token = getToken(store);
        process.stdout.write(`${JSON.stringify({ set: Boolean(token), preview: token ? maskToken(token) : null }, null, 2)}\n`);
        return;
      }
      if (sub === "clear") {
        clearToken(store);
        store.audit("hf.token.clear", "", "cli");
        process.stdout.write(`${JSON.stringify({ set: false }, null, 2)}\n`);
        return;
      }
      throw new Error("hf token action must be set, status or clear");
    }

    if (action === "files") {
      const repo = rest[1];
      if (!repo) throw new Error("hf files needs a repo id, e.g. Qwen/Qwen2.5-0.5B-Instruct-GGUF");
      const files = await listGgufFiles(repo, getToken(store));
      process.stdout.write(`${JSON.stringify({ repo, files }, null, 2)}\n`);
      return;
    }

    if (action === "download") {
      const repo = rest[1];
      if (!repo) throw new Error("hf download needs a repo id, e.g. Qwen/Qwen2.5-0.5B-Instruct-GGUF");
      const token = getToken(store);
      const fileIndex = rest.indexOf("--file");
      let file = fileIndex >= 0 ? (rest[fileIndex + 1] ?? "") : "";
      if (!file) {
        const files = await listGgufFiles(repo, token);
        const first = files[0];
        if (files.length === 1 && first) file = first.path;
        else throw new Error(`${repo} has ${files.length} GGUF files; pass --file <name> (see: node src/main.ts hf files ${repo})`);
      }
      let lastWrite = 0;
      const result = await downloadFile(repo, file, cfg.modelsDir, token, (done, total) => {
        const stamp = Date.now();
        if (stamp - lastWrite < 1000 || !total) return;
        lastWrite = stamp;
        process.stderr.write(`\rdownloading ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`);
      });
      process.stderr.write("\n");
      store.audit("hf.download", `${repo}/${file}`, result.path, "cli");
      process.stdout.write(`${JSON.stringify({ repo, file, ...result }, null, 2)}\n`);
      return;
    }

    if (action === "smoke") {
      const token = getToken(store);
      const report: Record<string, unknown> = {
        migration: 0,
        hf_reachable: false,
        gguf_files: 0,
        range_bytes: 0,
        token: { set: Boolean(token), preview: token ? maskToken(token) : null },
      };
      const migration = store.one<{ v: number | null }>("SELECT MAX(version) AS v FROM lama_manager_migrations");
      report.migration = migration?.v ?? 0;
      const repo = "Qwen/Qwen2.5-0.5B-Instruct-GGUF";
      try {
        const files = await listGgufFiles(repo, token);
        report.hf_reachable = true;
        report.gguf_files = files.length;
        if (files.length > 0) {
          const first = files[0]!;
          report.sample_file = first.path;
          report.range_bytes = await fetchRange(resolveUrl(repo, first.path), token, 1024);
        }
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
      }
      const pass =
        Number(report.migration) >= 5 &&
        report.hf_reachable === true &&
        Number(report.gguf_files) >= 1 &&
        report.range_bytes === 1024;
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(pass ? "HF_CLI_PASS\n" : "HF_CLI_FAIL\n");
      if (!pass) process.exitCode = 1;
      return;
    }

    throw new Error("hf action must be token, files, download or smoke");
  }

  usage();
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`lama: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
