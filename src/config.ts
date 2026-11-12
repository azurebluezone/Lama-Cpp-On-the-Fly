import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  root: string;
  dataDir: string;
  modelsDir: string;
  logsDir: string;
  runDir: string;
  certsDir: string;
  webDir: string;
  workspaceDir: string;
  dbFile: string;
  stateFile: string;
  lockFile: string;
  pidFile: string;
  envFile: string;
  adminToken: string;
  gatewayHost: string;
  gatewayPort: number;
  gatewayEngine: "http" | "https" | "uds";
  gatewayUdsPath: string;
  tlsPort: number;
  gatewayOrigins: string[];
  apiKey: string;
  apiAuth: "loopback" | "open" | "required";
  engineApiKey: string;
  engineHost: string;
  enginePort: number;
  engineUrl: string;
  udsPath: string;
  llamaBin: string;
  loadMode: string;
  accel: string;
  build: string | null;
  tlsKey: string;
  tlsCert: string;
  tls: boolean;
  serviceMode: "none" | "user" | "system";
  gatewayDir: string;
  defaultTtlHours: number;
  warnings: string[];
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function number(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export type ApiAuthMode = "loopback" | "open" | "required";

function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "localhost" || value === "[::1]";
}

/** Read the persisted proxy token, generating one on first use. Never logs it. */
function apiTokenFrom(file: string): string {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // missing file means "generate below"
  }
  const token = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on filesystems without POSIX modes
  }
  return token;
}

/**
 * LAMA_API_KEY is a three-state switch, not only a secret:
 *   false / off / none / 0     -> open: no token at all, even from the LAN
 *   true / on / required       -> a token is required, loopback included
 *   empty / unset              -> loopback needs nothing; a non-loopback bind
 *                                 generates and persists one automatically
 *   any other value            -> that value is the token
 */
export function resolveApiKey(
  raw: string,
  bindHost: string,
  tokenFile: string,
): { apiKey: string; apiAuth: ApiAuthMode } {
  const value = raw.trim();
  if (/^(false|off|none|no|0)$/i.test(value)) return { apiKey: "", apiAuth: "open" };
  if (/^(true|on|yes|1|required|auto|random)$/i.test(value)) {
    return { apiKey: apiTokenFrom(tokenFile), apiAuth: "required" };
  }
  if (value) return { apiKey: value, apiAuth: "required" };
  if (isLoopbackHost(bindHost)) return { apiKey: "", apiAuth: "loopback" };
  return { apiKey: apiTokenFrom(tokenFile), apiAuth: "required" };
}

export function loadConfig(): Config {
  const envFile = process.env.LAMA_ENV_FILE || path.join(ROOT, ".env");
  const fileEnv = parseEnvFile(envFile);
  const env = (key: string): string | undefined => {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) return process.env[key];
    return fileEnv[key];
  };

  const root = path.resolve(env("LAMA_HOME") || ROOT);
  const dataDir = path.resolve(env("LAMA_DATA_DIR") || path.join(root, "data"));
  const modelsDir = path.resolve(env("LAMA_MODELS_DIR") || path.join(root, "models"));
  const logsDir = path.resolve(env("LAMA_LOG_DIR") || path.join(root, "logs"));
  const runDir = path.resolve(env("LAMA_RUN_DIR") || path.join(root, "run"));
  const certsDir = path.resolve(env("LAMA_CERTS_DIR") || path.join(root, "certs"));
  const webDir = path.resolve(env("LAMA_WEB_DIR") || path.join(root, "web"));
  const workspaceDir = path.resolve(env("LAMA_WORKSPACE") || path.join(root, "workspace"));

  const engineHost = env("LAMA_ENGINE_HOST") || "127.0.0.1";
  const enginePort = number(env("LAMA_ENGINE_PORT"), 9932);
  const gatewayHost = env("LAMA_GATEWAY_HOST") || "127.0.0.1";
  const gatewayPort = number(env("LAMA_GATEWAY_PORT"), 5252);
  const gatewayEngineRaw = (env("LAMA_GATEWAY_ENGINE") || "http").trim().toLowerCase();
  const gatewayEngine: Config["gatewayEngine"] =
    gatewayEngineRaw === "uds" || gatewayEngineRaw === "https" ? gatewayEngineRaw : "http";
  const tlsPort = number(env("LAMA_TLS_PORT"), 9931);
  const gatewayOrigins = (env("LAMA_GATEWAY_ORIGINS") ||
    "https://lama.local,https://localhost,http://localhost:5252,http://127.0.0.1:5252")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  // Portability rule: .env carries tunables, never absolute paths. Everything else is
  // derived from the project root, and the socket lives in the OS temp dir of this user.
  // Windows has no unix sockets, so an empty value disables the UDS transport there.
  const udsOverride = env("LAMA_UDS_SOCK");
  const udsPath =
    udsOverride === undefined
      ? process.platform === "win32"
        ? ""
        : path.join(
            os.tmpdir(),
            `llama-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
            "llama.sock",
          )
      : udsOverride.trim() === ""
        ? ""
        : path.resolve(udsOverride);

  // The gateway is a client-facing listener in its own right. Keep its socket
  // separate from the engine socket, otherwise both would unlink each other.
  const gatewayUdsOverride = env("LAMA_GATEWAY_UDS");
  const gatewayUdsPath =
    gatewayUdsOverride === undefined
      ? process.platform === "win32"
        ? ""
        : path.join(runDir, "gateway.sock")
      : gatewayUdsOverride.trim() === ""
        ? ""
        : path.resolve(gatewayUdsOverride);

  const warnings: string[] = [];
  // Both listeners unlink their socket on bind; sharing one path would delete
  // the engine socket under it, so the gateway socket yields.
  let gatewayUds = gatewayUdsPath;
  if (gatewayUds && gatewayUds === udsPath) {
    warnings.push("LAMA_GATEWAY_UDS equals LAMA_UDS_SOCK; gateway UDS is disabled to protect the engine socket");
    gatewayUds = "";
  }
  if (gatewayPort === enginePort) {
    warnings.push("LAMA_GATEWAY_PORT equals LAMA_ENGINE_PORT; the gateway cannot bind while the engine owns that port");
  }
  const apiTokenFile = path.join(dataDir, "api-token");
  const rawApiKey = (env("LAMA_API_KEY") || "").trim();
  const adminToken = env("LAMA_ADMIN_TOKEN") || "";
  const resolved = resolveApiKey(rawApiKey, gatewayHost, apiTokenFile);
  const switchOnly = !rawApiKey || /^(true|on|yes|1|required|auto|random)$/i.test(rawApiKey);
  const apiKey = resolved.apiAuth === "required" && adminToken && switchOnly ? adminToken : resolved.apiKey;
  const apiAuth = resolved.apiAuth;
  if (apiAuth === "open") {
    warnings.push("LAMA_API_KEY=false: /v1 accepts any client without a token; use only on a trusted network");
  } else if (apiAuth === "required" && adminToken && switchOnly) {
    warnings.push("LAMA_ADMIN_TOKEN is the single bearer token for the gateway and admin; send it as Authorization: Bearer or x-api-key");
  } else if (apiAuth === "required" && (!rawApiKey || /^(true|on|yes|1|required|auto|random)$/i.test(rawApiKey))) {
    warnings.push(
      `LAMA_API_KEY generated a token in ${apiTokenFile} (mode 600); send it as Authorization: Bearer or x-api-key`,
    );
  }
  const serviceModeRaw = (env("LAMA_SERVICE_MODE") || "none").toLowerCase();
  const serviceMode: Config["serviceMode"] =
    serviceModeRaw === "user" || serviceModeRaw === "system" ? serviceModeRaw : "none";

  if (fs.existsSync(envFile)) {
    try {
      const mode = fs.statSync(envFile).mode & 0o777;
      if (mode & 0o077) warnings.push(`${envFile} is readable by group/others (mode ${mode.toString(8)}); chmod 600 recommended`);
    } catch {
      // stat failure is reported by the caller when it reads the file
    }
  }

  return {
    root,
    dataDir,
    modelsDir,
    logsDir,
    runDir,
    certsDir,
    webDir,
    workspaceDir,
    dbFile: path.resolve(env("LAMA_DB") || path.join(dataDir, "manager.db")),
    stateFile: path.join(dataDir, "engine.json"),
    lockFile: path.join(dataDir, "engine.lock"),
    pidFile: path.join(runDir, "engine.pid"),
    envFile,
    adminToken,
    gatewayHost,
    gatewayPort,
    gatewayEngine,
    gatewayUdsPath: gatewayUds,
    tlsPort,
    gatewayOrigins,
    apiKey,
    apiAuth,
    engineApiKey: env("LAMA_ENGINE_API_KEY") || "",
    engineHost,
    enginePort,
    engineUrl: env("LAMA_ENGINE_URL") || `http://${engineHost}:${enginePort}`,
    udsPath,
    llamaBin: env("LAMA_LLAMA_BIN") || "",
    loadMode: env("LAMA_LOAD_MODE") || "auto",
    accel: (env("LAMA_ACCEL") || "cpu").toLowerCase(),
    build: env("LAMA_LLAMA_BUILD") || null,
    tlsKey: path.resolve(env("LAMA_SSL_KEY") || path.join(certsDir, "localhost-key.pem")),
    tlsCert: path.resolve(env("LAMA_SSL_CERT") || path.join(certsDir, "localhost-cert.pem")),
    // One flag decides engine args, transport choice and admin proxy protocol.
    // Reading process.env directly made a .env value invisible to short-lived CLI runs.
    tls: flag(env("LAMA_TLS"), false),
    serviceMode,
    gatewayDir: path.resolve(env("LAMA_GATEWAY_DIR") || path.join(root, "gateway")),
    defaultTtlHours: number(env("LAMA_DEFAULT_TTL_HOURS"), 4),
    warnings,
  };
}

export function ensureDirs(cfg: Config): void {
  for (const dir of [
    cfg.dataDir,
    cfg.modelsDir,
    cfg.logsDir,
    cfg.runDir,
    cfg.certsDir,
    cfg.webDir,
    cfg.workspaceDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function envFlag(name: string, fallback = false): boolean {
  return flag(process.env[name], fallback);
}
