import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { McpRow } from "../types.ts";

export function engineMcpConfigPath(cfg: Config): string {
  return path.join(cfg.dataDir, "mcp-servers.generated.json");
}

export function engineMcpConfig(store: Store): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const row of store.listMcp()) {
    if (!row.enabled || row.transport !== "stdio" || !row.command) continue;
    servers[row.name] = {
      command: row.command,
      args: JSON.parse(row.args_json || "[]") as string[],
      env: JSON.parse(row.env_json || "{}") as Record<string, string>,
      ...(row.cwd ? { cwd: row.cwd } : {}),
      timeout_ms: row.timeout_ms,
    };
  }
  return { mcpServers: servers };
}

export function writeEngineMcpConfig(store: Store, cfg: Config): { path: string; count: number } {
  const config = engineMcpConfig(store);
  const servers = config.mcpServers as Record<string, unknown>;
  const target = engineMcpConfigPath(cfg);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { path: target, count: Object.keys(servers).length };
}

export function mcpSummary(row: McpRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: JSON.parse(row.args_json || "[]"),
    env_keys: Object.keys(JSON.parse(row.env_json || "{}") as Record<string, unknown>),
    cwd: row.cwd,
    url: row.url,
    timeout_ms: row.timeout_ms,
    enabled: Boolean(row.enabled),
    status: row.status,
    active: Boolean(row.enabled) && row.status === "active",
    last_probe_at: row.last_probe_at,
    last_probe_detail: row.last_probe_detail,
    use_count: row.use_count,
    tools_count: row.tools_count,
  };
}
