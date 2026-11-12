import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { LoadMode, McpTransport, OsInfo } from "./types.ts";
import { loadIdentity } from "./identity.ts";

type Item = Record<string, unknown>;
type Section = "providers" | "transports" | "mcp_servers" | "documents" | "prompts" | "models";

const SECTIONS: Section[] = ["providers", "transports", "mcp_servers", "documents", "prompts", "models"];
const LOAD_MODES = new Set<LoadMode>(["auto", "mmap", "none", "mlock", "mmap+mlock", "dio"]);
const MCP_TRANSPORTS = new Set<McpTransport>(["stdio", "http", "sse"]);

export interface SeedReport {
  files: string[];
  identity: string;
  counts: Record<Section, number>;
  skipped: Record<Section, number>;
  warnings: string[];
}

function record(value: unknown): value is Item {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(item: Item, key: string, where: string, max = 4000): string {
  const value = item[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where}: ${key} is required`);
  if (value.length > max) throw new Error(`${where}: ${key} exceeds ${max} chars`);
  return value.trim();
}

function optionalString(item: Item, key: string, max = 4000): string | null {
  const value = item[key];
  return typeof value === "string" && value.trim() ? value.slice(0, max) : null;
}

function integer(item: Item, key: string, fallback: number, min: number, max: number, where: string): number {
  const value = item[key] === undefined || item[key] === null || item[key] === "" ? fallback : Number(item[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${where}: ${key} must be an integer ${min}..${max}`);
  return value;
}

function real(item: Item, key: string, fallback: number, min: number, max: number, where: string): number {
  const value = item[key] === undefined || item[key] === null || item[key] === "" ? fallback : Number(item[key]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${where}: ${key} must be a number ${min}..${max}`);
  return value;
}

function metadata(item: Item): string {
  return JSON.stringify(record(item.metadata) ? item.metadata : {});
}

function idOf(item: Item, where: string): string {
  const id = string(item, "id", where, 120).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!id) throw new Error(`${where}: id normalizes to empty`);
  return id;
}

function managerUrl(cfg: Config): string {
  return `http://${cfg.gatewayHost}:${cfg.gatewayPort}`;
}

function engineUrl(cfg: Config): string {
  return `http://${cfg.engineHost}:${cfg.enginePort}`;
}

function resolveTokens(text: string, cfg: Config): string {
  return text
    .replaceAll("http://127.0.0.1:9933", managerUrl(cfg))
    .replaceAll("http://127.0.0.1:9931", engineUrl(cfg))
    .replaceAll("/tmp/llama-1000/llama.sock", cfg.udsPath);
}

function udsAvailable(cfg: Config): boolean {
  return Boolean(cfg.udsPath);
}

function seedProviders(store: Store, cfg: Config, items: unknown[], where: string, report: SeedReport): void {
  for (const [index, raw] of items.entries()) {
    if (!record(raw)) throw new Error(`${where}.providers[${index}] must be an object`);
    const id = idOf(raw, `${where}.providers[${index}]`);
    store.upsertProvider({
      id,
      name: string(raw, "name", `${where}.providers[${index}]`, 200),
      kind: "llamacpp",
      base_url: managerUrl(cfg),
      build: optionalString(raw, "build", 80),
      config_json: JSON.stringify({
        binary: cfg.llamaBin || "auto",
        load_mode: cfg.loadMode,
        accel: cfg.accel,
      }),
      metadata_json: metadata(raw),
    });
    report.counts.providers += 1;
  }
}

function seedTransports(store: Store, cfg: Config, items: unknown[], where: string, report: SeedReport): void {
  for (const [index, raw] of items.entries()) {
    if (!record(raw)) throw new Error(`${where}.transports[${index}] must be an object`);
    const id = idOf(raw, `${where}.transports[${index}]`);
    const protocol = string(raw, "protocol", `${where}.transports[${index}]`, 10);
    if (protocol !== "http" && protocol !== "https" && protocol !== "uds") {
      throw new Error(`${where}.transports[${index}]: protocol must be http, https or uds`);
    }
    const uds = protocol === "uds";
    if (uds && !udsAvailable(cfg)) {
      report.skipped.transports += 1;
      report.warnings.push(`${where}.transports[${index}]: UDS is not available on this OS; skipped`);
      continue;
    }
    if (protocol === "https" && !cfg.tls) {
      report.skipped.transports += 1;
      report.warnings.push(`${where}.transports[${index}]: engine-native TLS is disabled (LAMA_TLS=0); skipped`);
      continue;
    }
    store.upsertTransport({
      id,
      name: string(raw, "name", `${where}.transports[${index}]`, 200),
      protocol,
      host: uds ? null : cfg.engineHost,
      port: uds ? null : cfg.enginePort,
      socket_path: uds ? cfg.udsPath : null,
      tls_key: protocol === "https" ? cfg.tlsKey : null,
      tls_cert: protocol === "https" ? cfg.tlsCert : null,
      gateway_hint:
        protocol === "uds"
          ? `Symlink ${cfg.udsPath} into ${path.join(cfg.gatewayDir, "llama.sock")}; do not pass the socket path to llama.cpp as an environment variable.`
          : protocol === "https"
            ? `Base URL https://${cfg.engineHost}:${cfg.enginePort} — verify the certificate before adding it to the gateway.`
            : `Gateway provider base URL: ${managerUrl(cfg)} (the manager proxies /v1 to the engine).`,
      metadata_json: metadata(raw),
    });
    report.counts.transports += 1;
  }
}

function seedMcp(store: Store, cfg: Config, items: unknown[], where: string, report: SeedReport): void {
  for (const [index, raw] of items.entries()) {
    if (!record(raw)) throw new Error(`${where}.mcp_servers[${index}] must be an object`);
    const tag = `${where}.mcp_servers[${index}]`;
    const id = idOf(raw, tag);
    const transport = string(raw, "transport", tag, 10) as McpTransport;
    if (!MCP_TRANSPORTS.has(transport)) throw new Error(`${tag}: transport must be stdio, http or sse`);
    const args = Array.isArray(raw.args) ? raw.args.map((value) => String(value)) : [];
    const env = record(raw.env) ? Object.fromEntries(Object.entries(raw.env).map(([key, value]) => [key, String(value)])) : {};
    if (env.LAMA_WORKSPACE) env.LAMA_WORKSPACE = cfg.workspaceDir;
    store.upsertMcp({
      id,
      name: string(raw, "name", tag, 64),
      transport,
      command: transport === "stdio" ? (string(raw, "command", tag, 2000) === "node" ? process.execPath : string(raw, "command", tag, 2000)) : null,
      args_json: JSON.stringify(args.map((arg) => (arg.startsWith("src/") ? path.join(cfg.root, arg) : arg))),
      env_json: JSON.stringify(env),
      cwd: optionalString(raw, "cwd", 4000) ?? cfg.root,
      url: transport === "stdio" ? null : optionalString(raw, "url"),
      api_key_ref: optionalString(raw, "api_key_ref", 120),
      timeout_ms: integer(raw, "timeout_ms", 30000, 1000, 600000, tag),
      enabled: raw.enabled === 0 || raw.enabled === false ? 0 : 1,
      metadata_json: metadata(raw),
    });
    report.counts.mcp_servers += 1;
  }
}

function seedDocuments(store: Store, cfg: Config, items: unknown[], where: string, report: SeedReport): void {
  for (const [index, raw] of items.entries()) {
    if (!record(raw)) throw new Error(`${where}.documents[${index}] must be an object`);
    const tag = `${where}.documents[${index}]`;
    const id = idOf(raw, tag);
    const transportId = optionalString(raw, "transport_id", 120);
    if (transportId === "uds" && !udsAvailable(cfg)) {
      report.skipped.documents += 1;
      report.warnings.push(`${tag}: UDS is not available on this OS; skipped`);
      continue;
    }
    if (transportId && !store.getTransport(transportId)) throw new Error(`${tag}: unknown transport_id ${transportId}`);
    store.upsertDocument({
      id,
      slug: optionalString(raw, "slug", 120) ?? id,
      title: string(raw, "title", tag, 200),
      transport_id: transportId,
      body: resolveTokens(string(raw, "body", tag, 100000), cfg),
      verified_at: null,
      metadata_json: metadata(raw),
    });
    report.counts.documents += 1;
  }
}

function seedPrompts(store: Store, cfg: Config, items: unknown[], where: string, report: SeedReport): void {
  for (const [index, raw] of items.entries()) {
    if (!record(raw)) throw new Error(`${where}.prompts[${index}] must be an object`);
    const tag = `${where}.prompts[${index}]`;
    const id = idOf(raw, tag);
    const content = resolveTokens(string(raw, "content", tag, 20000), cfg);
    const isDefault = raw.is_default === 1 || raw.is_default === true ? 1 : 0;
    const meta = metadata(raw);
    const existing = store.getPrompt(id);
    if (existing && existing.content === content && existing.is_default === isDefault && existing.metadata_json === meta) {
      report.skipped.prompts += 1;
      continue;
    }
    store.upsertPrompt({
      id,
      name: string(raw, "name", tag, 64),
      content,
      version: 1,
      is_default: isDefault,
      metadata_json: meta,
    });
    report.counts.prompts += 1;
  }
}

function seedModels(store: Store, cfg: Config, items: unknown[], where: string, report: SeedReport): void {
  for (const [index, raw] of items.entries()) {
    if (!record(raw)) throw new Error(`${where}.models[${index}] must be an object`);
    const tag = `${where}.models[${index}]`;
    const id = idOf(raw, tag);
    const file = optionalString(raw, "file", 4000);
    const existing = store.getModel(id);
    const candidate = file ? path.resolve(cfg.modelsDir, file) : null;
    const modelPath = candidate && fs.existsSync(candidate) ? candidate : (existing?.path ?? null);
    if (!modelPath || !fs.existsSync(modelPath)) {
      report.warnings.push(`model ${id}: file not found under ${cfg.modelsDir}; row left unchanged`);
      report.skipped.models += 1;
      continue;
    }
    const loadMode = string(raw, "load_mode", tag, 20) as LoadMode;
    if (!LOAD_MODES.has(loadMode)) throw new Error(`${tag}: load_mode must be auto, mmap, none, mlock, mmap+mlock or dio`);
    store.upsertModel({
      id,
      provider_id: optionalString(raw, "provider_id", 120) ?? "llamacpp",
      name: string(raw, "name", tag, 200),
      model_id: optionalString(raw, "model_id", 200) ?? id,
      path: modelPath,
      context: integer(raw, "context", 4096, 256, 1_048_576, tag),
      max_tokens: integer(raw, "max_tokens", 1024, 1, 1_048_576, tag),
      temperature: real(raw, "temperature", 0.7, 0, 2, tag),
      quant: optionalString(raw, "quant", 40),
      load_mode: loadMode,
      ttl_hours: raw.ttl_hours === null ? null : real(raw, "ttl_hours", cfg.defaultTtlHours, 0, 720, tag),
      enabled: raw.enabled === 0 || raw.enabled === false ? 0 : 1,
      metadata_json: metadata(raw),
    });
    report.counts.models += 1;
  }
}

export function applySeeds(
  store: Store,
  cfg: Config,
  os: OsInfo,
  options: { dir?: string } = {},
): SeedReport {
  const dir = options.dir ?? path.join(cfg.root, "db", "seed");
  const report: SeedReport = {
    files: [],
    identity: "",
    counts: { providers: 0, transports: 0, mcp_servers: 0, documents: 0, prompts: 0, models: 0 },
    skipped: { providers: 0, transports: 0, mcp_servers: 0, documents: 0, prompts: 0, models: 0 },
    warnings: [],
  };
  const identity = loadIdentity(cfg.root);
  store.setIdentity(identity.name, identity.version, identity.tagline, JSON.stringify(identity));
  report.identity = `${identity.name} ${identity.version}`;
  if (!fs.existsSync(dir)) {
    report.warnings.push(`seed directory not found: ${dir}`);
    return report;
  }
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of files) {
    const file = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`${file}: invalid JSON (${(error as Error).message})`);
    }
    if (!record(parsed)) throw new Error(`${file}: seed must be an object`);
    if (parsed.schema !== "lama.seed/v1") throw new Error(`${file}: schema must be lama.seed/v1`);
    for (const section of SECTIONS) {
      const items = parsed[section];
      if (items === undefined) continue;
      if (!Array.isArray(items)) throw new Error(`${file}: ${section} must be an array`);
      if (section === "providers") seedProviders(store, cfg, items, file, report);
      if (section === "transports") seedTransports(store, cfg, items, file, report);
      if (section === "mcp_servers") seedMcp(store, cfg, items, file, report);
      if (section === "documents") seedDocuments(store, cfg, items, file, report);
      if (section === "prompts") seedPrompts(store, cfg, items, file, report);
      if (section === "models") seedModels(store, cfg, items, file, report);
    }
    report.files.push(file);
  }
  report.warnings.push(`seed identity mirrored from ${identity.name} on ${os.platform}/${os.arch}`);
  return report;
}
