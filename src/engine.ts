import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { Config } from "./config.ts";
import type { EngineState, MmapStatus, ModelRow, OsInfo, ToolCall, TransportRow } from "./types.ts";
import type { Store } from "./db.ts";
import { request, requestUds } from "./transport/index.ts";
import { grammarFileFor } from "./grammar.ts";
import { serviceAction, servicePid } from "./service.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Last useful log lines: a startup failure should quote the engine, not a generic timeout. */
function logTail(file: string, lines = 8): string {
  try {
    const rows = fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
    return rows.slice(-lines).map((row) => row.trim()).filter(Boolean).join(" | ");
  } catch {
    return "log unavailable";
  }
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function splitArgs(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of value.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

export function resolveBinary(cfg: Config): { command: string; prefix: string[] } {
  // LAMA_LLAMA_BIN is an explicit override: if it is set, only that path/name is accepted.
  // Otherwise accept both stock layouts — the current release ships the unified `llama`
  // binary (with the `serve` subcommand) and older trees ship `llama-server`.
  const explicit = Boolean(cfg.llamaBin);
  const names = process.platform === "win32" ? ["llama.exe", "llama-server.exe"] : ["llama", "llama-server"];
  // Precedence, most specific first: the project-local engine, then an ambient PATH
  // install, then the per-user install location the stock release script uses
  // (`~/.local/bin` on POSIX, `%LOCALAPPDATA%\llama` on Windows).
  const homeBin =
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "llama")
      : path.join(os.homedir(), ".local", "bin");
  // `npm run install:llama` links the stock binary into <root>/bin, and `build:dist`
  // bundles it at <root>/bin too. Those are pinned to this install, so they win over
  // whatever happens to sit on PATH — otherwise the same dist would run a different
  // engine depending on the machine it lands on.
  const projectBin = path.join(cfg.root, "bin");
  const candidates = explicit
    ? [cfg.llamaBin]
    : [
        ...names.map((name) => path.join(projectBin, name)),
        ...names,
        ...names.map((name) => path.join(homeBin, name)),
      ];
  const locate = (candidate: string): string | null =>
    candidate.includes(path.sep) || candidate.endsWith(".exe")
      ? fs.existsSync(candidate)
        ? candidate
        : null
      : (() => {
          const result = spawnSync(process.platform === "win32" ? "where" : "which", [candidate], {
            encoding: "utf8",
            timeout: 5000,
          });
          return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null;
        })();
  const found = candidates.map(locate).find((value): value is string => Boolean(value));
  if (!found) {
    throw new Error(
      `llama binary not found (tried ${candidates.join(", ")}). Run \`npm run install:llama\`, add it to PATH, or set LAMA_LLAMA_BIN to the stock binary path.`,
    );
  }
  const base = path.basename(found).toLowerCase();
  return { command: found, prefix: base === "llama" || base === "llama.exe" ? ["serve"] : [] };
}

/** Blue-green instances get their own socket file; llama.cpp only binds paths ending in ".sock". */
export function spareUds(base: string, port: number): string {
  return base.endsWith(".sock") ? `${base.slice(0, -5)}-${port}.sock` : `${base}-${port}.sock`;
}

/**
 * A model may pin one llama.cpp built-in chat template alias
 * (metadata chat_template_builtin). Without an alias llama.cpp keeps the model's
 * own GGUF metadata template, which is the safe default: an alias only works when
 * this build really resolves that name, otherwise llama.cpp takes the alias
 * string as the jinja source and sends that string as the whole prompt.
 */
function chatTemplateAliasOf(model: ModelRow): string | null {
  try {
    const meta = JSON.parse(model.metadata_json) as { chat_template_builtin?: unknown };
    return typeof meta.chat_template_builtin === "string" && meta.chat_template_builtin.trim()
      ? meta.chat_template_builtin.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Did llama.cpp resolve the requested chat template alias?
 * `literal` means the engine still holds the alias verbatim: the name did not
 * resolve and would be sent as the prompt instead of the conversation.
 */
export function chatTemplateResolved(
  props: Record<string, unknown>,
  alias: string,
): { ok: boolean; resolved: string | null; literal: boolean } {
  const template = typeof props.chat_template === "string" ? props.chat_template : "";
  if (!template.trim()) return { ok: false, resolved: null, literal: false };
  return { ok: true, resolved: template, literal: template === alias };
}

export function buildEngineArgs(
  cfg: Config,
  model: ModelRow,
  options: { forceLoadMode?: string; tls?: boolean; port?: number; udsPath?: string | null } = {},
): { command: string; args: string[]; logFile: string } {
  if (!model.path) throw new Error(`model ${model.id} has no path`);
  const modelPath = path.resolve(model.path);
  if (!fs.existsSync(modelPath)) throw new Error(`model file not found: ${modelPath}`);
  const binary = resolveBinary(cfg);
  const loadMode = options.forceLoadMode ?? model.load_mode ?? cfg.loadMode;
  const host = process.env.LAMA_ENGINE_HOST || cfg.engineHost;
  const port = String(options.port ?? process.env.LAMA_ENGINE_PORT ?? cfg.enginePort);
  // Empty socket path means "no UDS on this OS"; the TCP listener still works.
  const uds = (options.udsPath !== undefined ? options.udsPath ?? "" : process.env.LAMA_UDS_SOCK ?? cfg.udsPath).trim();
  if (uds) fs.mkdirSync(path.dirname(uds), { recursive: true, mode: 0o700 });

  const args = [
    ...binary.prefix,
    "--model",
    modelPath,
    "--alias",
    model.model_id,
    "--host",
    uds ? `${host},${uds}` : host,
    "--port",
    port,
    "--ctx-size",
    String(model.context ?? 4096),
    "--n-predict",
    String(model.max_tokens ?? 1024),
    "--threads",
    // All cores by default. The engine used to leave one core for the desktop,
    // but on a busy machine the engine then waited for a core it could have
    // had: generation ran at about 145 ms per token while the process used
    // only a third of its share.
    String(Number(process.env.LAMA_THREADS) || os.cpus().length),
    "--parallel",
    String(Number(process.env.LAMA_PARALLEL) || 1),
    "--jinja",
    "--no-webui",
    "--metrics",
  ];

  if (loadMode && loadMode !== "auto") args.push("--load-mode", loadMode);
  // Prompt reuse: a follow-up turn that repeats the earlier prompt is served
  // from the KV cache instead of being evaluated again. Measured on this
  // machine: the same 1556-token prompt took 106890 ms to evaluate without it,
  // and 88 ms with it. The chunk size is the minimum number of tokens that
  // may be reused; below it the cache is not worth the bookkeeping.
  const cacheReuse = Number(process.env.LAMA_CACHE_REUSE || 256);
  if (Number.isFinite(cacheReuse) && cacheReuse > 0) {
    args.push("--cache-reuse", String(Math.trunc(cacheReuse)));
  }
  // Only a llama.cpp built-in alias may be pinned. No alias means the engine keeps
  // the model's own GGUF metadata template, which llama.cpp renders correctly.
  const templateAlias = chatTemplateAliasOf(model);
  if (templateAlias) args.push("--chat-template", templateAlias);
  // A model that declares a grammar is constrained natively by llama.cpp for every
  // request to that model. A broken grammar must stop the load loudly.
  const grammarFile = grammarFileFor(cfg, model);
  if (grammarFile) args.push("--grammar-file", grammarFile);
  const tls = options.tls ?? cfg.tls;
  if (tls) {
    if (!fs.existsSync(cfg.tlsKey) || !fs.existsSync(cfg.tlsCert)) {
      throw new Error(`TLS requested but key/cert missing: ${cfg.tlsKey}, ${cfg.tlsCert}`);
    }
    args.push("--ssl-key-file", cfg.tlsKey, "--ssl-cert-file", cfg.tlsCert);
  }
  if (cfg.engineApiKey) args.push("--api-key", cfg.engineApiKey);
  const extra = splitArgs(process.env.LAMA_LLAMA_ARGS || "");
  // A Vulkan build auto-picks the only adapter even when the operator chose the
  // CPU target. On old Intel Haswell that device lacks 16-bit storage and the
  // whole model load dies with "Unsupported device". `--device none` keeps the
  // recorded LAMA_ACCEL=cpu honest and still lets LAMA_LLAMA_ARGS override it.
  const devicePinned = extra.some((arg) => arg === "--device" || arg === "-dev" || arg.startsWith("--device="));
  if (cfg.accel === "cpu" && !devicePinned) args.push("--device", "none");
  if (extra.length) args.push(...extra);
  const mcpConfig = path.join(cfg.dataDir, "mcp-servers.generated.json");
  if (fs.existsSync(mcpConfig) && fs.statSync(mcpConfig).size > 24) {
    args.push("--mcp-servers-config", mcpConfig);
  }

  return {
    command: binary.command,
    args,
    logFile: path.join(cfg.logsDir, `engine-${model.id}.log`),
  };
}

export function mmapStatus(pid: number | null, modelPath: string | null): MmapStatus {
  if (!pid || !modelPath) {
    return { mapped: false, perms: null, bytes: null, source: "unavailable", detail: "no pid/model" };
  }
  if (process.platform !== "linux") {
    return {
      mapped: false,
      perms: null,
      bytes: null,
      source: "unavailable",
      detail: `mmap proof is implemented for /proc on Linux; ${process.platform} needs a platform-specific probe`,
    };
  }
  try {
    const maps = fs.readFileSync(`/proc/${pid}/maps`, "utf8");
    const base = path.basename(modelPath);
    let bytes = 0;
    let perms: string | null = null;
    for (const line of maps.split(/\r?\n/)) {
      if (!line.includes(base)) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const range = parts[0] ?? "";
      const [start, end] = range.split("-").map((value) => Number.parseInt(value, 16));
      if (!start || !end) continue;
      bytes += Math.max(0, end - start);
      perms = perms ?? (parts[1] ?? null);
    }
    return {
      mapped: bytes > 0,
      perms,
      bytes,
      source: "proc-maps",
      detail: bytes > 0 ? `${base} present in /proc/${pid}/maps` : `${base} not found in /proc/${pid}/maps`,
    };
  } catch (error) {
    return {
      mapped: false,
      perms: null,
      bytes: null,
      source: "unavailable",
      detail: (error as NodeJS.ErrnoException).code === "EACCES" ? "permission denied reading /proc maps" : (error as Error).message,
    };
  }
}

export interface EngineProgress {
  phase: "loading" | "waiting" | "running" | "stopping" | "stopped" | "reloading" | "error";
  model_id: string | null;
  detail: string;
  elapsed_ms: number;
  at: string;
}

/**
 * A model is addressable by its row id (slug of the file name) and by the public
 * alias (models.model_id) that the UI and /v1/models show. `engine load <model-id>`
 * must accept both, or the name the operator actually sees is "unknown".
 */
export function resolveModel(store: Store, key: string): ModelRow | undefined {
  return store.getModel(key) ?? store.getModelByModelId(key);
}

/**
 * The built-in http/https rows point at the default engine port. A blue-green
 * reload moves the live engine to the spare port, so callers using those rows
 * must follow engine_state.port. User-created transports keep their endpoint.
 */
export function liveTransport(store: Store, cfg: Config, transport: TransportRow): TransportRow {
  if (transport.protocol === "uds") return transport;
  if (transport.id !== "http" && transport.id !== "https") return transport;
  if (transport.host !== cfg.engineHost || transport.port !== cfg.enginePort) return transport;
  const state = store.engineState();
  if (state.status !== "running" || !state.port) return transport;
  return { ...transport, port: state.port };
}

export class EngineManager {
  private readonly store: Store;
  private readonly cfg: Config;
  private readonly os: OsInfo;
  private timer: NodeJS.Timeout | null = null;
  private progressListener: ((event: EngineProgress) => void) | null = null;
  private progressStarted = 0;

  constructor(store: Store, cfg: Config, os: OsInfo) {
    this.store = store;
    this.cfg = cfg;
    this.os = os;
  }

  setProgressListener(listener: ((event: EngineProgress) => void) | null): void {
    this.progressListener = listener;
  }

  private emit(phase: EngineProgress["phase"], modelId: string | null, detail: string): void {
    if (!this.progressListener) return;
    try {
      this.progressListener({
        phase,
        model_id: modelId,
        detail,
        elapsed_ms: this.progressStarted ? Date.now() - this.progressStarted : 0,
        at: new Date().toISOString(),
      });
    } catch {
      // A broken listener must never interrupt a model load.
    }
  }

  private transport(preferUds = false): { protocol: "http" | "https" | "uds"; host: string | null; port: number | null; socket_path: string | null } {
    if (preferUds && this.cfg.udsPath) {
      return { protocol: "uds", host: null, port: null, socket_path: this.cfg.udsPath };
    }
    const https = this.cfg.tls;
    return {
      protocol: https ? "https" : "http",
      host: this.cfg.engineHost,
      port: this.cfg.enginePort,
      socket_path: null,
    };
  }

  async health(): Promise<{ ok: boolean; status: number | null; detail: string }> {
    for (const preferUds of [false, true]) {
      try {
        const res = await request(this.transport(preferUds), "/health", {
          timeoutMs: 3000,
          allowSelfSigned: process.env.LAMA_TLS_INSECURE === "1",
        });
        if (res.status === 200) return { ok: true, status: 200, detail: "health 200" };
        return { ok: false, status: res.status, detail: `health ${res.status}` };
      } catch (error) {
        if (preferUds) return { ok: false, status: null, detail: (error as Error).message };
      }
    }
    return { ok: false, status: null, detail: "unreachable" };
  }

  /** Probe one specific port: the blue-green warm-up engine is not active yet. */
  private async healthAt(port: number): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await request(
        { protocol: this.cfg.tls ? "https" : "http", host: this.cfg.engineHost, port, socket_path: null },
        "/health",
        { timeoutMs: 2000, allowSelfSigned: process.env.LAMA_TLS_INSECURE === "1" },
      );
      return { ok: res.status === 200, detail: `health ${res.status}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  /**
   * Real llama.cpp gauges for any instance, including a draining one that is no
   * longer the active proxy target. Null means "not measurable", never zero.
   */
  async liveLoad(port: number | null | undefined): Promise<{
    processing: number | null;
    deferred: number | null;
    reachable: boolean;
  }> {
    if (!port) return { processing: null, deferred: null, reachable: false };
    try {
      const res = await request(
        { protocol: this.cfg.tls ? "https" : "http", host: this.cfg.engineHost, port, socket_path: null },
        "/metrics",
        { timeoutMs: 1200, allowSelfSigned: process.env.LAMA_TLS_INSECURE === "1" },
      );
      if (res.status !== 200) return { processing: null, deferred: null, reachable: false };
      const processing = /llamacpp:requests_processing\s+(\d+)/.exec(res.text);
      const deferred = /llamacpp:requests_deferred\s+(\d+)/.exec(res.text);
      return {
        processing: processing ? Number(processing[1]) : null,
        deferred: deferred ? Number(deferred[1]) : null,
        reachable: true,
      };
    } catch {
      return { processing: null, deferred: null, reachable: false };
    }
  }

  /** Drain signal: how many requests the old engine is still processing. */
  private async requestsProcessing(port: number): Promise<number | null> {
    return (await this.liveLoad(port)).processing;
  }

  /**
   * One cheap snapshot for the admin UI (about 1s polling): stored state, the
   * supervisor's phase marker, real gauges on active + draining ports, and the
   * last swap facts. No /proc mmap scan, no model table read.
   */
  async relayStatus(): Promise<{
    phase: "idle" | "warming" | "draining";
    reloading: boolean;
    model_id: string | null;
    active: {
      pid: number | null;
      port: number | null;
      status: string;
      alive: boolean;
      started_at: string | null;
      expires_at: string | null;
      processing: number | null;
      deferred: number | null;
    };
    warming: { since: string | null; port: number | null } | null;
    draining: {
      old_pid: number | null;
      old_port: number;
      since: string | null;
      processing: number | null;
      deferred: number | null;
      alive: boolean;
    } | null;
    inflight: { processing: number | null; deferred: number | null };
    last_swap: {
      at: string;
      old_pid: number | null;
      old_port: number | null;
      new_pid: number | null;
      new_port: number | null;
    } | null;
    last_drain: { at: string; old_pid: number | null } | null;
    last_error: string | null;
    stable: {
      gateway_host: string;
      gateway_port: number;
      base_url: string;
      openai_base_url: string;
      models_url: string;
      uds_path: string | null;
    };
    checked_at: string;
  }> {
    type Marker = {
      phase?: "warming" | "draining" | "idle";
      at?: string;
      model_id?: string;
      old_pid?: number | null;
      old_port?: number | null;
      new_pid?: number | null;
      new_port?: number | null;
      error?: string;
    };
    const state = this.store.engineState();
    let marker: Marker = {};
    try {
      const raw = this.store.setting("engine_relay");
      if (raw) marker = JSON.parse(raw) as Marker;
    } catch {
      marker = {};
    }
    // A marker older than the longest legal reload, or a draining marker whose
    // old pid is already dead, is history - never a stuck UI.
    const markerAt = marker.at ? Date.parse(marker.at) : Number.NaN;
    const markerFresh = Number.isFinite(markerAt) && Date.now() - markerAt < 15 * 60_000;
    let storedPhase: "idle" | "warming" | "draining" =
      markerFresh && (marker.phase === "warming" || marker.phase === "draining") ? marker.phase : "idle";
    if (storedPhase === "draining" && !isAlive(marker.old_pid ?? null)) storedPhase = "idle";
    const phase: "idle" | "warming" | "draining" = storedPhase === "idle" && this.reloading ? "warming" : storedPhase;

    const activePort = state.port ?? this.cfg.enginePort;
    const activeAlive = Boolean(state.pid && isAlive(state.pid));
    const activeLive =
      activeAlive && state.status === "running"
        ? await this.liveLoad(activePort)
        : { processing: null, deferred: null, reachable: false };
    const drainAlive =
      phase === "draining" &&
      !!marker.old_port &&
      marker.old_port !== activePort &&
      isAlive(marker.old_pid ?? null);
    const oldLive = drainAlive
      ? await this.liveLoad(marker.old_port ?? null)
      : { processing: null, deferred: null, reachable: false };
    const count = (values: Array<number | null>): number | null => {
      const known = values.filter((value): value is number => typeof value === "number");
      return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
    };
    const events = this.store.listAudit(80);
    const swapRow = events.find((row) => row.action === "engine.swap");
    const drainRow = events.find((row) => row.action === "engine.drain");
    const field = (detail: string, key: string): number | null => {
      const match = new RegExp(`${key}=(-?\\d+)`).exec(detail);
      return match ? Number(match[1]) : null;
    };
    const base = `http://${this.cfg.gatewayHost}:${this.cfg.gatewayPort}`;
    return {
      phase,
      reloading: this.reloading || phase === "warming" || phase === "draining",
      model_id: state.model_id ?? marker.model_id ?? null,
      active: {
        pid: state.pid,
        port: state.port,
        status: state.status,
        alive: activeAlive,
        started_at: state.started_at,
        expires_at: state.expires_at,
        processing: activeLive.processing,
        deferred: activeLive.deferred,
      },
      warming: phase === "warming" ? { since: marker.at ?? null, port: marker.new_port ?? null } : null,
      draining:
        phase === "draining"
          ? {
              old_pid: marker.old_pid ?? null,
              old_port: marker.old_port ?? activePort,
              since: marker.at ?? null,
              processing: oldLive.processing,
              deferred: oldLive.deferred,
              alive: drainAlive,
            }
          : null,
      inflight: {
        processing: count([activeLive.processing, drainAlive ? oldLive.processing : null]),
        deferred: count([activeLive.deferred, drainAlive ? oldLive.deferred : null]),
      },
      last_swap: swapRow
        ? {
            at: swapRow.at,
            old_pid: field(swapRow.detail, "old_pid"),
            old_port: field(swapRow.detail, "old_port"),
            new_pid: field(swapRow.detail, "new_pid"),
            new_port: field(swapRow.detail, "new_port"),
          }
        : null,
      last_drain: drainRow ? { at: drainRow.at, old_pid: field(drainRow.detail, "old_pid") } : null,
      last_error: marker.error ?? state.last_error ?? null,
      stable: {
        gateway_host: this.cfg.gatewayHost,
        gateway_port: this.cfg.gatewayPort,
        base_url: base,
        openai_base_url: `${base}/v1`,
        models_url: `${base}/v1/models`,
        uds_path: this.cfg.udsPath,
      },
      checked_at: new Date().toISOString(),
    };
  }

  async props(): Promise<Record<string, unknown> | null> {
    for (const preferUds of [false, true]) {
      try {
        const res = await request(this.transport(preferUds), "/props", {
          timeoutMs: 3000,
          allowSelfSigned: process.env.LAMA_TLS_INSECURE === "1",
        });
        if (res.status === 200) return JSON.parse(res.text) as Record<string, unknown>;
      } catch {
        // try the next transport
      }
    }
    return null;
  }

  binaryVersion(): string | null {
    try {
      const binary = resolveBinary(this.cfg);
      const result = spawnSync(binary.command, [...binary.prefix, "--version"], { encoding: "utf8", timeout: 10_000 });
      if (result.status === 0) return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? null;
      const version = spawnSync(binary.command, [...binary.prefix, "version"], { encoding: "utf8", timeout: 10_000 });
      return version.status === 0 ? (version.stdout || version.stderr).trim().split(/\r?\n/)[0] ?? null : null;
    } catch {
      return null;
    }
  }

  private lock(): void {
    fs.mkdirSync(this.cfg.dataDir, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
    try {
      const fd = fs.openSync(this.cfg.lockFile, "wx", 0o600);
      fs.writeFileSync(fd, payload);
      fs.closeSync(fd);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      const current = JSON.parse(fs.readFileSync(this.cfg.lockFile, "utf8")) as { pid?: number };
      if (current.pid && current.pid !== process.pid && isAlive(current.pid)) {
        throw new Error(`engine is already managed by pid ${current.pid}`);
      }
    } catch (error) {
      if ((error as Error).message.startsWith("engine is already")) throw error;
    }
    fs.rmSync(this.cfg.lockFile, { force: true });
    const fd = fs.openSync(this.cfg.lockFile, "wx", 0o600);
    fs.writeFileSync(fd, payload);
    fs.closeSync(fd);
  }

  private unlock(): void {
    try {
      const current = JSON.parse(fs.readFileSync(this.cfg.lockFile, "utf8")) as { pid?: number };
      if (!current.pid || current.pid === process.pid) fs.rmSync(this.cfg.lockFile, { force: true });
    } catch {
      fs.rmSync(this.cfg.lockFile, { force: true });
    }
  }

  private serviceMode(): "none" | "user" | "system" {
    // An explicit LAMA_SERVICE_MODE always wins (CLI/env is the operator's voice).
    if (this.cfg.serviceMode !== "none") return this.cfg.serviceMode;
    const fromDb = this.store.setting("service_mode");
    if (fromDb === "user" || fromDb === "system") return fromDb;
    if (fromDb === "none") {
      // A stale "none" must not create a second spawner while a systemd unit is
      // already running the engine: defer to the live unit (config drift guard).
      if (servicePid(this.os, "user") || servicePid(this.os, "system")) {
        return servicePid(this.os, "user") ? "user" : "system";
      }
      return "none";
    }
    if (servicePid(this.os, "user")) return "user";
    if (servicePid(this.os, "system")) return "system";
    return this.cfg.serviceMode;
  }

  async status(): Promise<EngineState> {
    const state = this.store.engineState();
    const pid = state.pid && isAlive(state.pid) ? state.pid : null;
    const health = await this.health();
    const model = state.model_id ? this.store.getModel(state.model_id) : undefined;
    return {
      ...state,
      pid,
      status: health.ok ? "running" : pid ? "starting" : "stopped",
      mmap: pid ? mmapStatus(pid, model?.path ?? null) : null,
    };
  }

  async start(modelId: string, ttlHours?: number | null): Promise<EngineState> {
    const model = resolveModel(this.store, modelId);
    if (!model) {
      // The CLI usage line says `<model-id>`; listing the real ids turns that
      // copy/paste mistake into a self-service fix instead of a dead end.
      const available = this.store.listModels().map((row) => row.model_id);
      const hint = available.length
        ? `available models: ${available.join(", ")}`
        : "no models registered; run `node src/main.ts seed` or add one in the admin UI";
      throw new Error(`unknown model: ${modelId} (${hint})`);
    }
    if (!model.path) throw new Error(`model ${modelId} has no file path`);
    const current = await this.status();
    if (current.status === "running") await this.stop();
    this.lock();
    // A systemd cgroup restart SIGKILLs the engine and leaves its UDS file
    // behind; llama-server refuses to bind an existing path. Remove a stale
    // socket only when nothing answers on it.
    if (this.cfg.udsPath && fs.existsSync(this.cfg.udsPath)) {
      let socketLive = false;
      try {
        const probe = await requestUds(this.cfg.udsPath, "/health", { timeoutMs: 1000 });
        socketLive = probe.status === 200;
      } catch {
        socketLive = false;
      }
      if (!socketLive) {
        try {
          fs.rmSync(this.cfg.udsPath, { force: true });
        } catch {
          // socket removal is best effort
        }
      }
    }
    const hours = ttlHours === undefined ? model.ttl_hours : ttlHours;
    const expiresAt = hours && hours > 0 ? new Date(Date.now() + hours * 3600_000).toISOString() : null;
    const base: Omit<EngineState, "updated_at" | "mmap"> = {
      model_id: model.id,
      pid: null,
      status: "starting",
      started_at: new Date().toISOString(),
      expires_at: expiresAt,
      load_mode: model.load_mode,
      socket_path: this.cfg.udsPath,
      port: this.cfg.enginePort,
      build: this.binaryVersion(),
      last_error: null,
    };
    this.store.setEngineState(base);
    this.store.audit("engine.start", model.id, `load_mode=${model.load_mode} ttl=${hours ?? "none"}`);
    this.progressStarted = Date.now();
    this.emit("loading", model.id, "writing engine state and starting the process");

    let logFile: string | null = null;
    try {
      const mode = this.serviceMode();
      if (mode === "user" || mode === "system") {
        const result = serviceAction(this.os, mode, "restart");
        if (!result.ok) throw new Error(`systemctl restart failed: ${result.detail}`);
      } else {
        const pre = await this.health();
        if (pre.ok) {
          // Something already serves this port (a systemd unit or another
          // spawner): adopt it instead of spawning a duplicate that cannot bind.
          const adopted = servicePid(this.os, "user") ?? servicePid(this.os, "system");
          this.store.setEngineState({ ...base, pid: adopted, status: "running" });
          this.store.audit("engine.adopt", model.id, `pid=${adopted ?? "unknown"}`);
          this.emit("running", model.id, "adopted an already healthy engine");
          return this.status();
        }
        const { command, args, logFile: engineLog } = buildEngineArgs(this.cfg, model);
        logFile = engineLog;
        fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
        const out = fs.openSync(logFile, "a", 0o600);
        const child = spawn(command, args, {
          detached: true,
          stdio: ["ignore", out, out],
          env: process.env,
        });
        child.unref();
        fs.closeSync(out);
        if (!child.pid) throw new Error("failed to spawn llama-server");
        this.store.setEngineState({ ...base, pid: child.pid });
      }

      const deadline = Date.now() + 180_000;
      let last = "not started";
      while (Date.now() < deadline) {
        const state = this.store.engineState();
        // The child can die in the first second (bad device, bad flag, missing
        // shared lib). Waiting the full 180s only hides the engine's own log.
        if (mode === "none" && state.pid && !isAlive(state.pid)) {
          throw new Error(`engine exited during startup: ${logFile ? logTail(logFile) : last}`);
        }
        const health = await this.health();
        if (health.ok) {
          // /tmp/llama-<uid>/ is 0700 (created above); the socket itself must stay 0660
          // so only this user (and root) can connect, even though /tmp is world-writable.
          if (this.cfg.udsPath) {
            try {
              fs.chmodSync(path.dirname(this.cfg.udsPath), 0o700);
              fs.chmodSync(this.cfg.udsPath, 0o660);
            } catch {
              // engine may not have created the socket yet on exotic platforms
            }
          }
          const state = this.store.engineState();
          const unitPid = servicePid(this.os, "user") ?? servicePid(this.os, "system");
          // Health can come from a foreign process that owns the same port.
          // Never report "running" while the engine we started is already dead.
          if (state.pid && !isAlive(state.pid) && !unitPid) {
            throw new Error(
              `spawned engine exited immediately; /health is answered by another process on ${this.cfg.engineHost}:${this.cfg.enginePort}`,
            );
          }
          const pid = state.pid && isAlive(state.pid) ? state.pid : unitPid;
          const running: Omit<EngineState, "updated_at" | "mmap"> = {
            ...base,
            pid,
            status: "running",
            build: this.binaryVersion(),
          };
          this.store.setEngineState(running);
          this.store.audit("engine.running", model.id, `pid=${pid ?? "unknown"}`);
          this.emit("running", model.id, `healthy after ${Math.round((Date.now() - this.progressStarted) / 1000)}s`);
          return this.status();
        }
        last = health.detail;
        this.emit("waiting", model.id, health.detail);
        await sleep(1000);
      }
      throw new Error(`engine did not become healthy within 180s: ${last}`);
    } catch (error) {
      this.emit("error", model.id, (error as Error).message);
      await this.stop();
      this.store.setEngineState({ ...base, status: "error", last_error: (error as Error).message });
      this.store.audit("engine.error", model.id, (error as Error).message);
      throw error;
    }
  }

  async stop(): Promise<EngineState> {
    const state = this.store.engineState();
    if (state.model_id) this.emit("stopping", state.model_id, "stopping the engine process");
    const mode = this.serviceMode();
    if (mode === "user" || mode === "system") {
      serviceAction(this.os, mode, "stop");
    }
    const pid = state.pid && isAlive(state.pid) ? state.pid : null;
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && isAlive(pid)) await sleep(250);
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    if (this.cfg.udsPath) {
      // Never unlink a socket that still answers: reload/stop from a second
      // process used to delete a live engine's UDS and left it half-dead.
      let socketLive = false;
      try {
        const probe = await requestUds(this.cfg.udsPath, "/health", { timeoutMs: 1500 });
        socketLive = probe.status === 200;
      } catch {
        socketLive = false;
      }
      if (socketLive && !isAlive(pid)) {
        // The serving process is unknown to this manager (e.g. a systemd unit).
        return this.status();
      }
      try {
        fs.rmSync(this.cfg.udsPath, { force: true });
      } catch {
        // socket removal is best effort
      }
    }
    this.store.setEngineState({
      model_id: null,
      pid: null,
      status: "stopped",
      started_at: null,
      expires_at: null,
      load_mode: state.load_mode,
      socket_path: null,
      port: this.cfg.enginePort,
      build: state.build,
      last_error: null,
    });
    this.store.audit("engine.stop", state.model_id ?? "", `pid=${pid ?? "none"}`);
    this.unlock();
    this.progressStarted = 0;
    this.emit("stopped", null, "engine stopped");
    return this.status();
  }

  private reloading = false;

  isReloading(): boolean {
    return this.reloading;
  }

  async reload(modelId?: string, ttlHours?: number | null): Promise<EngineState> {
    const state = this.store.engineState();
    const target = modelId ?? state.model_id;
    if (!target) throw new Error("no model selected for reload");
    this.progressStarted = Date.now();
    this.emit("reloading", target, "reload requested");
    this.reloading = true;
    try {
      if (this.serviceMode() !== "none") {
        // The systemd supervisor owns the child processes, so it performs the
        // blue-green swap: warm up on the spare port, switch the proxy target,
        // drain the old engine, then stop it. We wait for its verdict.
        const id = randomUUID();
        try {
          this.store.setSetting(
            "engine_reload_request",
            JSON.stringify({ id, model_id: target, ttl_hours: ttlHours ?? null, at: new Date().toISOString() }),
          );
          const deadline = Date.now() + 300_000;
          while (Date.now() < deadline) {
            const raw = this.store.setting(`engine_reload:${id}`);
            if (raw) {
              const result = JSON.parse(raw) as { ok: boolean; error?: string };
              if (!result.ok) throw new Error(result.error ?? "blue-green reload failed");
              return this.status();
            }
            await sleep(400);
          }
          throw new Error("blue-green reload timed out; the supervisor did not answer");
        } finally {
          // A client that timed out never reads the verdict; do not leak keys.
          this.store.setSetting(`engine_reload:${id}`, "");
        }
      }
      await this.stop();
      return await this.start(target, ttlHours);
    } finally {
      this.reloading = false;
    }
  }

  startExpiryLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void (async () => {
        const state = this.store.engineState();
        if (state.status !== "running" || !state.expires_at) return;
        if (Date.parse(state.expires_at) > Date.now()) return;
        this.store.audit("engine.expire", state.model_id ?? "", state.expires_at);
        await this.stop();
      })().catch(() => {
        // expiry failures must never crash the admin server
      });
    }, 30_000);
    this.timer.unref();
  }

  stopExpiryLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read one pending blue-green request; the key is cleared so it runs once. */
  private pendingReload(): { id: string; model_id: string; ttl_hours: number | null } | null {
    const raw = this.store.setting("engine_reload_request");
    if (!raw) return null;
    this.store.setSetting("engine_reload_request", "");
    try {
      const parsed = JSON.parse(raw) as { id?: string; model_id?: string; ttl_hours?: number | null };
      if (!parsed.id || !parsed.model_id) return null;
      return { id: parsed.id, model_id: parsed.model_id, ttl_hours: parsed.ttl_hours ?? null };
    } catch {
      return null;
    }
  }

  /** Supervisor-side blue-green: warm up, switch, drain, then stop the old child. */
  private async blueGreen(
    request: { id: string; model_id: string; ttl_hours: number | null },
    oldChild: ReturnType<typeof spawn>,
    oldState: EngineState,
  ): Promise<ReturnType<typeof spawn> | null> {
    const report = (ok: boolean, error = ""): void => {
      this.store.setSetting(`engine_reload:${request.id}`, JSON.stringify({ ok, error }));
      if (!ok) {
        // The UI polls this marker; a failed warm-up must leave it idle, not
        // "warming" forever.
        this.store.setSetting(
          "engine_relay",
          JSON.stringify({ phase: "idle", at: new Date().toISOString(), model_id: request.model_id, error }),
        );
      }
    };
    const model = this.store.getModel(request.model_id);
    if (!model?.path) {
      report(false, `model ${request.model_id} has no file path`);
      return null;
    }
    const oldPort = oldState.port ?? this.cfg.enginePort;
    // The spare port must never collide with the gateway listener.
    const sparePort = this.cfg.enginePort + 1 === this.cfg.gatewayPort ? this.cfg.enginePort + 2 : this.cfg.enginePort + 1;
    const newPort = oldPort === this.cfg.enginePort ? sparePort : this.cfg.enginePort;
    const newUds = this.cfg.udsPath ? spareUds(this.cfg.udsPath, newPort) : null;
    const hours = request.ttl_hours ?? model.ttl_hours;
    const expiresAt = hours && hours > 0 ? new Date(Date.now() + hours * 3600_000).toISOString() : null;
    // Phase marker for the admin UI. The supervisor is a separate process, so
    // the UI cannot see its in-memory state; app_settings is the channel.
    this.store.setSetting(
      "engine_relay",
      JSON.stringify({
        phase: "warming",
        at: new Date().toISOString(),
        model_id: model.id,
        old_pid: oldChild.pid ?? null,
        old_port: oldPort,
        new_port: newPort,
      }),
    );
    if ((await this.healthAt(newPort)).ok) {
      // Never adopt a listener we did not spawn; that is how a probe on the
      // spare port once got mistaken for the warm-up engine.
      report(false, `spare port ${newPort} already has a healthy listener`);
      return null;
    }
    if (newUds) {
      try {
        // llama.cpp refuses to bind over a socket file left by a dead instance.
        fs.rmSync(newUds, { force: true });
      } catch {
        // best effort
      }
    }
    const { command, args, logFile } = buildEngineArgs(this.cfg, model, { port: newPort, udsPath: newUds });
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    const out = fs.openSync(logFile, "a", 0o600);
    const next = spawn(command, args, { stdio: ["ignore", out, out], env: process.env });
    fs.closeSync(out);
    if (!next.pid) {
      report(false, "failed to spawn the warm-up engine");
      return null;
    }
    this.emit("loading", model.id, `blue-green warm-up on port ${newPort}`);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (next.exitCode !== null || !isAlive(next.pid)) {
        // Bind failure (for example a socket path llama.cpp refuses) must abort
        // at once: waiting out the deadline made the reload API hang, and a
        // foreign listener on the port could satisfy the health probe.
        report(false, `warm-up engine exited with ${next.exitCode}`);
        if (newUds) {
          try {
            fs.rmSync(newUds, { force: true });
          } catch {
            // socket may not exist
          }
        }
        return null;
      }
      if ((await this.healthAt(newPort)).ok) break;
      await sleep(500);
    }
    if (Date.now() >= deadline || !isAlive(next.pid)) {
      try {
        next.kill("SIGKILL");
      } catch {
        // already gone
      }
      report(false, `warm-up engine never became healthy on port ${newPort}`);
      return null;
    }
    if (newUds) {
      try {
        fs.chmodSync(path.dirname(newUds), 0o700);
        fs.chmodSync(newUds, 0o660);
      } catch {
        // exotic platforms may not create a UDS
      }
    }
    this.store.setEngineState({
      model_id: model.id,
      pid: next.pid,
      status: "running",
      started_at: new Date().toISOString(),
      expires_at: expiresAt,
      load_mode: model.load_mode,
      socket_path: this.cfg.udsPath,
      port: newPort,
      build: this.binaryVersion(),
      last_error: null,
    });
    this.store.audit(
      "engine.swap",
      model.id,
      `old_pid=${oldChild.pid} old_port=${oldPort} new_pid=${next.pid} new_port=${newPort}`,
    );
    this.emit("running", model.id, `blue-green switch to port ${newPort}`);
    this.store.setSetting(
      "engine_relay",
      JSON.stringify({
        phase: "draining",
        at: new Date().toISOString(),
        model_id: model.id,
        old_pid: oldChild.pid ?? null,
        old_port: oldPort,
        new_pid: next.pid ?? null,
        new_port: newPort,
      }),
    );
    // Drain: keep the old engine alive until it has no request in flight.
    const drainDeadline = Date.now() + Number(process.env.LAMA_DRAIN_MS || 120_000);
    while (Date.now() < drainDeadline) {
      const busy = await this.requestsProcessing(oldPort);
      if (busy === 0) break;
      if (busy === null) {
        await sleep(3000);
        break;
      }
      await sleep(250);
    }
    try {
      oldChild.kill("SIGTERM");
    } catch {
      // already gone
    }
    const stopDeadline = Date.now() + 10_000;
    while (Date.now() < stopDeadline && oldChild.exitCode === null) await sleep(250);
    if (oldChild.exitCode === null) {
      try {
        oldChild.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    this.store.audit("engine.drain", model.id, `old_pid=${oldChild.pid} stopped after drain`);
    this.store.setSetting(
      "engine_relay",
      JSON.stringify({ phase: "idle", at: new Date().toISOString(), model_id: model.id }),
    );
    // Each blue-green instance binds "<stable>.<port>"; the old file would be a
    // stale socket for the next warm-up on that port, so remove it after exit.
    if (this.cfg.udsPath) {
      try {
        fs.rmSync(spareUds(this.cfg.udsPath, oldPort), { force: true });
      } catch {
        // already gone
      }
    }
    // The stable UDS path was the old engine's socket; point it at the new
    // engine so clients using the original path follow the swap.
    if (this.cfg.udsPath && newUds) {
      try {
        fs.rmSync(this.cfg.udsPath, { force: true });
        fs.symlinkSync(newUds, this.cfg.udsPath);
      } catch (error) {
        this.store.audit("engine.uds", model.id, (error as Error).message);
      }
    }
    report(true);
    return next;
  }

  async runForeground(): Promise<never> {
    // Supervisor mode: this process is the systemd unit body. It stays alive,
    // waits for the manager to select a model in engine_state, spawns the stock
    // binary, and idles again when that child exits. No model selected at boot
    // means "idle", not "crash loop".
    let stopping = false;
    let current: ReturnType<typeof spawn> | null = null;
    const forward = (signal: NodeJS.Signals): void => {
      stopping = true;
      if (current?.pid) {
        try {
          current.kill(signal);
        } catch {
          // child already exited
        }
      }
    };
    process.on("SIGTERM", () => forward("SIGTERM"));
    process.on("SIGINT", () => forward("SIGINT"));

    // A previous supervisor may have died mid-reload. Do not let the UI inherit
    // a stale warming/draining marker across a process restart.
    this.store.setSetting(
      "engine_relay",
      JSON.stringify({ phase: "idle", at: new Date().toISOString(), model_id: this.store.engineState().model_id }),
    );

    while (!stopping) {
      let state = this.store.engineState();
      if (!state.model_id) {
        await sleep(3000);
        continue;
      }
      // The admin API and the CLI each spawn their own engine. If one of them
      // already answers on the port, this supervisor stands down: deleting the
      // "stale" socket would unlink the live engine's unix listener.
      const health = await this.health().catch(() => null);
      // After a blue-green swap the live engine listens on engine_state.port,
      // which may be the spare port when the unix socket is disabled.
      const spare =
        !health?.ok && state.port && state.port !== this.cfg.enginePort
          ? await this.healthAt(state.port).catch(() => null)
          : null;
      if (health?.ok || spare?.ok) {
        await sleep(3000);
        continue;
      }
      const model = this.store.getModel(state.model_id);
      if (!model || !model.path) {
        process.stderr.write(`engine-run: model ${state.model_id} has no file path; idle\n`);
        await sleep(3000);
        continue;
      }
      const { command, args } = buildEngineArgs(this.cfg, model);
      // A killed engine leaves its socket file behind; llama.cpp refuses to bind over it.
      // Never unlink a socket that still answers: /health can time out while a busy
      // engine evaluates a long prompt, and deleting its listener breaks UDS for
      // everyone even though the process is alive.
      if (this.cfg.udsPath) {
        const live = await requestUds(this.cfg.udsPath, "/health", { timeoutMs: 1500 })
          .then((res) => res.status === 200)
          .catch(() => false);
        if (live) {
          await sleep(3000);
          continue;
        }
        try {
          // After a blue-green swap the stable path is a symlink to the active
          // engine's socket. If the supervisor restarted and that engine is gone,
          // the dangling link still makes bind() fail, so unlink the link itself.
          if (fs.lstatSync(this.cfg.udsPath).isSymbolicLink()) {
            fs.rmSync(this.cfg.udsPath, { force: true });
          } else if (fs.statSync(this.cfg.udsPath).isSocket()) {
            fs.rmSync(this.cfg.udsPath, { force: true });
          }
        } catch {
          // missing path or best-effort removal; bind failure surfaces in the engine log
        }
      }
      this.store.audit("engine.foreground", model.id, `${command} ${args.join(" ")}`);
      let child = spawn(command, args, { stdio: "inherit", env: process.env });
      current = child;
      if (child.pid) {
        this.store.setEngineState({
          ...state,
          pid: child.pid,
          port: this.cfg.enginePort,
          socket_path: this.cfg.udsPath,
          status: "starting",
        });
      }
      // The engine creates the socket with the ambient umask; tighten it as soon as it
      // appears, because the unit can be started by systemd without going through start().
      if (this.cfg.udsPath) {
        const deadline = Date.now() + 15_000;
        while (!stopping && Date.now() < deadline && !fs.existsSync(this.cfg.udsPath)) {
          await sleep(200);
        }
        try {
          fs.chmodSync(path.dirname(this.cfg.udsPath), 0o700);
          fs.chmodSync(this.cfg.udsPath, 0o660);
        } catch {
          // socket or dir missing; the bind error already surfaced in the engine log
        }
      }
      // The stored state is what the proxy reads before routing. A supervisor
      // boot leaves it at "starting" unless somebody writes the healthy result,
      // and before this the admin API waited 120s on a perfectly healthy engine.
      const readyDeadline = Date.now() + 60_000;
      let ready = false;
      while (!stopping && Date.now() < readyDeadline && child.exitCode === null) {
        if ((await this.health()).ok) {
          ready = true;
          break;
        }
        await sleep(300);
      }
      if (ready) {
        this.store.setEngineState({
          ...state,
          pid: child.pid ?? null,
          port: this.cfg.enginePort,
          socket_path: this.cfg.udsPath,
          status: "running",
        });
        this.store.audit("engine.running", model.id, `pid=${child.pid ?? "unknown"}`);
      }
      // The local snapshot predates the spawn (it may still carry the previous
      // blue-green port); reload decisions must read the row we just wrote.
      state = this.store.engineState();
      let exitCode: number | null = null;
      let handingOver = false;
      const track = (proc: ReturnType<typeof spawn>): void => {
        proc.on("exit", (code, signal) => {
          if (!handingOver && proc === child) exitCode = code ?? (signal ? 1 : 0);
        });
      };
      track(child);
      while (!stopping && exitCode === null) {
        // The exit event can be missed when a process dies before the listener is
        // attached (warm-up handover); the child object is the reliable source.
        if (child.exitCode !== null) {
          exitCode = child.exitCode;
          break;
        }
        const request = this.pendingReload();
        if (request) {
          handingOver = true;
          const next = await this.blueGreen(request, child, state);
          if (next) {
            child = next;
            current = next;
            state = this.store.engineState();
            exitCode = null;
            track(next);
          } else {
            this.store.audit("engine.reload", request.model_id, "blue-green failed; old engine kept");
          }
          handingOver = false;
          continue;
        }
        await sleep(300);
      }
      const code = exitCode ?? 0;
      current = null;
      this.store.setEngineState({
        ...state,
        pid: null,
        status: code === 0 ? "stopped" : "error",
        last_error: code === 0 ? null : `engine exited with ${code}`,
      });
      if (stopping) break;
      if (code === 0) {
        await sleep(1000);
        continue;
      }
      // Non-zero exit: wait for the manager to write a new state before retrying.
      // A blind retry loop would respawn a broken engine forever and bury the error.
      const failedAt = this.store.engineState().updated_at;
      for (;;) {
        if (stopping) break;
        await sleep(2000);
        if (this.store.engineState().updated_at !== failedAt) break;
      }
    }
    process.exit(0);
  }
}

export function toolCallSummary(calls: ToolCall[]): string {
  return calls.map((call) => `${call.name}(${Object.keys(call.arguments).join(",")})`).join(", ");
}
