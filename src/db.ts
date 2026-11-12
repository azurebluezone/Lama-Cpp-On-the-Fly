import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AuditRow,
  DocumentRow,
  DownloadRow,
  EngineState,
  McpRow,
  McpToolRow,
  ModelRow,
  PromptRow,
  ProviderRow,
  RequestLogInput,
  RequestLogRow,
  SessionMessageRow,
  SessionRow,
  ToolUsageRow,
  TransportRow,
} from "./types.ts";
import type { Config } from "./config.ts";
import type { OsInfo } from "./types.ts";
import { MCP_TOOLS, TOOL_USE_CASES } from "./mcp/tools.ts";

const now = (): string => new Date().toISOString();

/**
 * Boot storm: lama-gateway, lama-engine and any CLI run all open the same SQLite
 * file within milliseconds of each other. When one process is mid-write, the
 * other gets SQLITE_BUSY ("database is locked") once busy_timeout expires; after
 * an unclean reset the WAL also has to be recovered first, which is why the
 * error showed up on every reset but not on a normal service restart.
 *
 * The boot path (schema, seed rows, prompt sync, MCP config) is idempotent, so
 * the correct answer to a transient lock is a bounded retry, not a dead unit.
 */
export function isDatabaseLocked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database (is|table is) locked/i.test(message) || /SQLITE_(BUSY|LOCKED)/.test(message);
}

export function retryDatabaseLocked<T>(
  fn: () => T,
  options: { attempts?: number; delayMs?: number; onRetry?: (attempt: number, delay: number, error: Error) => void } = {},
): T {
  const attempts = options.attempts ?? 8;
  const delayMs = options.delayMs ?? 500;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isDatabaseLocked(error)) throw error;
      lastError = error;
      if (attempt === attempts) break;
      const delay = delayMs * attempt;
      options.onRetry?.(attempt, delay, error as Error);
      // The boot path is synchronous, so block this thread instead of juggling timers.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
  throw lastError;
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('llamacpp')),
        base_url TEXT NOT NULL,
        build TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        model_id TEXT NOT NULL,
        path TEXT,
        context INTEGER,
        max_tokens INTEGER,
        temperature REAL NOT NULL DEFAULT 0.7,
        quant TEXT,
        load_mode TEXT NOT NULL DEFAULT 'auto'
          CHECK (load_mode IN ('auto','mmap','none','mlock','mmap+mlock','dio')),
        ttl_hours REAL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider_id, model_id)
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL CHECK (transport IN ('stdio','http','sse')),
        command TEXT,
        args_json TEXT NOT NULL DEFAULT '[]',
        env_json TEXT NOT NULL DEFAULT '{}',
        cwd TEXT,
        url TEXT,
        api_key_ref TEXT,
        timeout_ms INTEGER NOT NULL DEFAULT 30000,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transports (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('http','https','uds')),
        host TEXT,
        port INTEGER,
        socket_path TEXT,
        tls_key TEXT,
        tls_cert TEXT,
        gateway_hint TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        transport_id TEXT REFERENCES transports(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        system_prompt_id TEXT REFERENCES system_prompts(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS engine_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        model_id TEXT,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'stopped'
          CHECK (status IN ('stopped','starting','running','error')),
        started_at TEXT,
        expires_at TEXT,
        load_mode TEXT NOT NULL DEFAULT 'auto',
        socket_path TEXT,
        port INTEGER,
        build TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
      CREATE INDEX IF NOT EXISTS idx_documents_transport ON documents(transport_id);
      CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at DESC);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE providers ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE models ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE mcp_servers ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE transports ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE documents ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE system_prompts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE IF NOT EXISTS system_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        tagline TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      -- Every proxied or playground request lands here; the Models and Transports views
      -- read their counters from this table instead of keeping page-local state.
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        model_id TEXT,
        model_key TEXT,
        provider_id TEXT,
        transport_id TEXT,
        protocol TEXT NOT NULL DEFAULT 'openai' CHECK (protocol IN ('openai','anthropic','other')),
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'POST',
        status INTEGER NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0,1)),
        stream INTEGER NOT NULL DEFAULT 0 CHECK (stream IN (0,1)),
        duration_ms INTEGER NOT NULL DEFAULT 0,
        first_token_ms INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        bytes INTEGER NOT NULL DEFAULT 0,
        system_prompt_id TEXT,
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_request_logs_at ON request_logs(at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model_id, at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_logs_transport ON request_logs(transport_id, at DESC);

      CREATE TABLE IF NOT EXISTS tool_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        tool TEXT NOT NULL,
        mcp_id TEXT,
        ok INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0,1)),
        duration_ms INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage(tool, at DESC);

      -- The MCP matrix: one row per advertised tool, its own on/off switch and the
      -- human explanation of what it is for. Probe results refresh the list.
      CREATE TABLE IF NOT EXISTS mcp_tools (
        id TEXT PRIMARY KEY,
        mcp_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        use_cases TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        updated_at TEXT NOT NULL,
        UNIQUE(mcp_id, name)
      );

      ALTER TABLE mcp_servers ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown','active','inactive'));
      ALTER TABLE mcp_servers ADD COLUMN last_probe_at TEXT;
      ALTER TABLE mcp_servers ADD COLUMN last_probe_detail TEXT NOT NULL DEFAULT '';
      ALTER TABLE mcp_servers ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE mcp_servers ADD COLUMN tools_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 4,
    sql: `
      -- Hugging Face downloads: the CLI and the admin API share one progress table
      -- so the admin UI shows the real bytes of a real transfer, not page state.
      CREATE TABLE IF NOT EXISTS model_downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        file TEXT NOT NULL,
        path TEXT NOT NULL,
        bytes_total INTEGER NOT NULL DEFAULT 0,
        bytes_done INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
        error TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_downloads_status ON model_downloads(status, updated_at DESC);
    `,
  },
  {
    version: 5,
    sql: `
      -- One row per delivered turn, not per SSE delta: the admin session view
      -- can reconstruct the conversation without replaying a full stream.
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
        content TEXT NOT NULL DEFAULT '',
        model_id TEXT,
        tokens INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id, id);

      -- Transport health is measured, not guessed: the admin writes these from
      -- a real probe, and the connected client count comes from live sockets.
      ALTER TABLE transports ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown','up','down'));
      ALTER TABLE transports ADD COLUMN connected_clients INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 6,
    sql: `
      -- Attribution is measured at the edge that actually accepted the request.
      -- transport_id comes from the listener; client_adapter comes from the
      -- adapter header (or a known user-agent) so the operator can see who called.
      ALTER TABLE request_logs ADD COLUMN client_adapter TEXT;
      ALTER TABLE request_logs ADD COLUMN user_agent TEXT;
      CREATE INDEX IF NOT EXISTS idx_request_logs_adapter ON request_logs(client_adapter, at DESC);
    `,
  },
];

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/\.gguf$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

export class Store {
  readonly db: DatabaseSync;
  private auditListener: ((row: AuditRow) => void) | null = null;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows and some filesystems do not support chmod; not fatal.
    }
    this.assertCompatible();
    this.migrate();
  }

  private assertCompatible(): void {
    const table = this.one<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_prompts'",
    );
    if (!table) return;
    const columns = this.all<{ name: string }>("PRAGMA table_info(system_prompts)").map((row) => row.name);
    if (!columns.includes("content") || !columns.includes("version")) {
      throw new Error(
        "this SQLite file belongs to the legacy JS manager; set LAMA_DB to a new file (the legacy schema is not migrated)",
      );
    }
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS lama_manager_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(
      this.all<{ version: number }>("SELECT version FROM lama_manager_migrations").map((row) => row.version),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO lama_manager_migrations(version, applied_at) VALUES (?, ?)").run(
          migration.version,
          now(),
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  one<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params as never[]));
  }

  setting(key: string): string | null {
    return this.one<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key)?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.run(
      "INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key,
      value,
      now(),
    );
  }

  identity(): { name: string; version: string; tagline: string; payload_json: string } | undefined {
    return this.one("SELECT name, version, tagline, payload_json FROM system_identity WHERE id = 1");
  }

  setIdentity(name: string, version: string, tagline: string, payloadJson: string): void {
    this.run(
      `INSERT INTO system_identity(id, name, version, tagline, payload_json, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         version = excluded.version,
         tagline = excluded.tagline,
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      name,
      version,
      tagline,
      payloadJson,
      now(),
    );
  }

  setAuditListener(listener: ((row: AuditRow) => void) | null): void {
    this.auditListener = listener;
  }

  audit(action: string, target = "", detail = "", actor = "system"): void {
    const at = now();
    const result = this.db
      .prepare("INSERT INTO audit_events(at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
      .run(at, actor, action, target, detail);
    if (!this.auditListener) return;
    const row = this.one<AuditRow>("SELECT * FROM audit_events WHERE id = ?", Number(result.lastInsertRowid));
    if (!row) return;
    try {
      this.auditListener(row);
    } catch {
      // A broken SSE client must never make an audit write fail.
    }
  }

  listAudit(limit = 100): AuditRow[] {
    return this.all("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?", Math.min(Math.max(limit, 1), 500));
  }

  logRequest(input: RequestLogInput): RequestLogRow {
    const at = input.at ?? now();
    const result = this.db
      .prepare(
        `INSERT INTO request_logs(
           at, model_id, model_key, provider_id, transport_id, client_adapter, user_agent,
           protocol, endpoint, method, status, ok, stream, duration_ms, first_token_ms,
           prompt_tokens, completion_tokens, bytes, system_prompt_id, detail
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at,
        input.model_id,
        input.model_key,
        input.provider_id,
        input.transport_id,
        input.client_adapter,
        input.user_agent,
        input.protocol,
        input.endpoint,
        input.method,
        input.status,
        input.ok,
        input.stream,
        input.duration_ms,
        input.first_token_ms,
        input.prompt_tokens,
        input.completion_tokens,
        input.bytes,
        input.system_prompt_id,
        input.detail,
      );
    return this.one<RequestLogRow>("SELECT * FROM request_logs WHERE id = ?", Number(result.lastInsertRowid))!;
  }

  listRequests(filter: {
    limit?: number;
    model_id?: string | null;
    transport_id?: string | null;
    protocol?: string | null;
    ok?: boolean | null;
  } = {}): RequestLogRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.model_id) {
      clauses.push("model_id = ?");
      params.push(filter.model_id);
    }
    if (filter.transport_id) {
      clauses.push("transport_id = ?");
      params.push(filter.transport_id);
    }
    if (filter.protocol) {
      clauses.push("protocol = ?");
      params.push(filter.protocol);
    }
    if (filter.ok !== undefined && filter.ok !== null) {
      clauses.push("ok = ?");
      params.push(filter.ok ? 1 : 0);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.min(Math.max(filter.limit ?? 100, 1), 1000));
    return this.all<RequestLogRow>(`SELECT * FROM request_logs${where} ORDER BY id DESC LIMIT ?`, ...params);
  }

  requestStats(hours = 0): Array<{
    model_id: string | null;
    transport_id: string | null;
    total: number;
    ok: number;
    failed: number;
    avg_ms: number;
    last_at: string | null;
    prompt_tokens: number;
    completion_tokens: number;
  }> {
    const since = hours > 0 ? new Date(Date.now() - hours * 3600_000).toISOString() : null;
    return this.all(
      `SELECT model_id, transport_id, COUNT(*) AS total,
              COALESCE(SUM(ok), 0) AS ok,
              COUNT(*) - COALESCE(SUM(ok), 0) AS failed,
              COALESCE(ROUND(AVG(duration_ms)), 0) AS avg_ms,
              MAX(at) AS last_at,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens
         FROM request_logs
         ${since ? "WHERE at >= ?" : ""}
        GROUP BY model_id, transport_id`,
      ...(since ? [since] : []),
    );
  }

  transportStats(hours = 24): Array<{
    transport_id: string | null;
    client_adapter: string | null;
    total: number;
    ok: number;
    failed: number;
    avg_ms: number;
    last_at: string | null;
  }> {
    const since = hours > 0 ? new Date(Date.now() - hours * 3600_000).toISOString() : null;
    return this.all(
      `SELECT transport_id, client_adapter, COUNT(*) AS total,
              COALESCE(SUM(ok), 0) AS ok,
              COUNT(*) - COALESCE(SUM(ok), 0) AS failed,
              COALESCE(ROUND(AVG(duration_ms)), 0) AS avg_ms,
              MAX(at) AS last_at
         FROM request_logs
         ${since ? "WHERE at >= ?" : ""}
        GROUP BY transport_id, client_adapter
        ORDER BY total DESC, last_at DESC`,
      ...(since ? [since] : []),
    );
  }

  requestSeries(hours = 24): Array<{ hour: string; total: number; ok: number; failed: number }> {
    const span = Math.min(Math.max(Math.trunc(hours), 1), 24 * 30);
    const first = new Date(Date.now() - (span - 1) * 3600_000);
    first.setMinutes(0, 0, 0);
    const rows = this.all<{ hour: string; total: number; ok: number }>(
      `SELECT strftime('%Y-%m-%dT%H:00:00Z', at) AS hour,
              COUNT(*) AS total,
              COALESCE(SUM(ok), 0) AS ok
         FROM request_logs
        WHERE at >= ?
        GROUP BY hour
        ORDER BY hour ASC`,
      first.toISOString(),
    );
    const found = new Map(rows.map((row) => [row.hour, row]));
    const series: Array<{ hour: string; total: number; ok: number; failed: number }> = [];
    for (let i = 0; i < span; i += 1) {
      const bucket = new Date(first.getTime() + i * 3600_000);
      const hour = `${bucket.toISOString().slice(0, 13)}:00:00Z`;
      const row = found.get(hour);
      const total = Number(row?.total ?? 0);
      const ok = Number(row?.ok ?? 0);
      series.push({ hour, total, ok, failed: total - ok });
    }
    return series;
  }

  logToolUsage(input: { tool: string; mcp_id?: string | null; ok: boolean; duration_ms?: number; detail?: string }): ToolUsageRow {
    const at = now();
    const result = this.db
      .prepare("INSERT INTO tool_usage(at, tool, mcp_id, ok, duration_ms, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(at, input.tool, input.mcp_id ?? null, input.ok ? 1 : 0, input.duration_ms ?? 0, input.detail ?? "");
    if (input.mcp_id) {
      this.run("UPDATE mcp_servers SET use_count = use_count + 1, updated_at = ? WHERE id = ?", now(), input.mcp_id);
    }
    return this.one<ToolUsageRow>("SELECT * FROM tool_usage WHERE id = ?", Number(result.lastInsertRowid))!;
  }

  toolUsageStats(): Array<{ tool: string; calls: number; ok: number; failed: number; last_at: string | null; avg_ms: number }> {
    return this.all(
      `SELECT tool, COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS ok,
              COUNT(*) - COALESCE(SUM(ok), 0) AS failed, MAX(at) AS last_at,
              COALESCE(ROUND(AVG(duration_ms)), 0) AS avg_ms
         FROM tool_usage GROUP BY tool ORDER BY calls DESC`,
    );
  }

  startDownload(repo: string, file: string, dest: string): DownloadRow {
    const at = now();
    const result = this.db
      .prepare("INSERT INTO model_downloads(repo, file, path, status, started_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)")
      .run(repo, file, dest, at, at);
    return this.downloadRow(Number(result.lastInsertRowid))!;
  }

  updateDownload(id: number, bytesDone: number, bytesTotal: number): void {
    this.run(
      "UPDATE model_downloads SET bytes_done = ?, bytes_total = ?, updated_at = ? WHERE id = ?",
      bytesDone,
      bytesTotal,
      now(),
      id,
    );
  }

  finishDownload(id: number, dest: string, bytes: number): void {
    this.run(
      "UPDATE model_downloads SET status = 'done', path = ?, bytes_done = ?, bytes_total = ?, finished_at = ?, updated_at = ?, error = '' WHERE id = ?",
      dest,
      bytes,
      bytes,
      now(),
      now(),
      id,
    );
  }

  failDownload(id: number, error: string): void {
    this.run(
      "UPDATE model_downloads SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
      error.slice(0, 500),
      now(),
      now(),
      id,
    );
  }

  downloadRow(id: number): DownloadRow | undefined {
    return this.one<DownloadRow>("SELECT * FROM model_downloads WHERE id = ?", id);
  }

  listDownloads(limit = 50): DownloadRow[] {
    return this.all<DownloadRow>("SELECT * FROM model_downloads ORDER BY id DESC LIMIT ?", limit);
  }

  listMcpTools(mcpId?: string): McpToolRow[] {
    return mcpId
      ? this.all<McpToolRow>("SELECT * FROM mcp_tools WHERE mcp_id = ? ORDER BY name", mcpId)
      : this.all<McpToolRow>("SELECT * FROM mcp_tools ORDER BY mcp_id, name");
  }

  upsertMcpTool(row: Omit<McpToolRow, "updated_at">): void {
    this.run(
      `INSERT INTO mcp_tools(id, mcp_id, name, description, use_cases, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         description = excluded.description,
         use_cases = CASE WHEN mcp_tools.use_cases = '' THEN excluded.use_cases ELSE mcp_tools.use_cases END,
         updated_at = excluded.updated_at`,
      row.id,
      row.mcp_id,
      row.name,
      row.description,
      row.use_cases,
      row.enabled,
      now(),
    );
  }

  toggleMcpTool(name: string, enabled: boolean): void {
    this.run("UPDATE mcp_tools SET enabled = ?, updated_at = ? WHERE name = ?", enabled ? 1 : 0, now(), name);
  }

  setMcpProbe(id: string, ok: boolean, detail: string, tools: Array<{ name: string; description?: string }>): void {
    const timestamp = now();
    const existing = this.getMcp(id);
    this.run(
      "UPDATE mcp_servers SET status = ?, last_probe_at = ?, last_probe_detail = ?, tools_count = ?, updated_at = ? WHERE id = ?",
      ok ? "active" : "inactive",
      timestamp,
      detail.slice(0, 1000),
      tools.length,
      timestamp,
      id,
    );
    if (!existing) return;
    for (const tool of tools) {
      this.upsertMcpTool({
        id: `${id}:${tool.name}`,
        mcp_id: id,
        name: tool.name,
        description: tool.description ?? "",
        use_cases: "",
        enabled: 1,
      });
    }
  }

  promptUsage(): Array<{ system_prompt_id: string | null; runs: number; last_at: string | null }> {
    return this.all(
      `SELECT system_prompt_id, COUNT(*) AS runs, MAX(at) AS last_at
         FROM request_logs WHERE system_prompt_id IS NOT NULL GROUP BY system_prompt_id`,
    );
  }

  listProviders(): ProviderRow[] {
    return this.all("SELECT * FROM providers ORDER BY id");
  }

  getProvider(id: string): ProviderRow | undefined {
    return this.one("SELECT * FROM providers WHERE id = ?", id);
  }

  upsertProvider(row: Omit<ProviderRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO providers(id, name, kind, base_url, build, config_json, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         kind = excluded.kind,
         base_url = excluded.base_url,
         build = excluded.build,
         config_json = excluded.config_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.name,
      row.kind,
      row.base_url,
      row.build,
      row.config_json,
      row.metadata_json,
      now(),
      now(),
    );
  }

  listModels(): ModelRow[] {
    return this.all("SELECT * FROM models ORDER BY name");
  }

  getModel(id: string): ModelRow | undefined {
    return this.one("SELECT * FROM models WHERE id = ?", id);
  }

  getModelByModelId(modelId: string): ModelRow | undefined {
    return this.one("SELECT * FROM models WHERE model_id = ?", modelId);
  }

  upsertModel(row: Omit<ModelRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO models(id, provider_id, name, model_id, path, context, max_tokens, temperature, quant, load_mode, ttl_hours, enabled, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider_id = excluded.provider_id,
         name = excluded.name,
         model_id = excluded.model_id,
         path = excluded.path,
         context = excluded.context,
         max_tokens = excluded.max_tokens,
         temperature = excluded.temperature,
         quant = excluded.quant,
         load_mode = excluded.load_mode,
         ttl_hours = excluded.ttl_hours,
         enabled = excluded.enabled,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.provider_id,
      row.name,
      row.model_id,
      row.path,
      row.context,
      row.max_tokens,
      row.temperature,
      row.quant,
      row.load_mode,
      row.ttl_hours,
      row.enabled,
      row.metadata_json,
      now(),
      now(),
    );
  }

  deleteModel(id: string): void {
    this.run("DELETE FROM models WHERE id = ?", id);
  }

  deleteProvider(id: string): void {
    this.run("DELETE FROM providers WHERE id = ?", id);
  }

  listMcp(): McpRow[] {
    return this.all("SELECT * FROM mcp_servers ORDER BY name");
  }

  getMcp(id: string): McpRow | undefined {
    return this.one("SELECT * FROM mcp_servers WHERE id = ?", id);
  }

  upsertMcp(
    row: Omit<
      McpRow,
      "created_at" | "updated_at" | "status" | "last_probe_at" | "last_probe_detail" | "use_count" | "tools_count"
    >,
  ): void {
    this.run(
      `INSERT INTO mcp_servers(id, name, transport, command, args_json, env_json, cwd, url, api_key_ref, timeout_ms, enabled, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         transport = excluded.transport,
         command = excluded.command,
         args_json = excluded.args_json,
         env_json = excluded.env_json,
         cwd = excluded.cwd,
         url = excluded.url,
         api_key_ref = excluded.api_key_ref,
         timeout_ms = excluded.timeout_ms,
         enabled = excluded.enabled,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.name,
      row.transport,
      row.command,
      row.args_json,
      row.env_json,
      row.cwd,
      row.url,
      row.api_key_ref,
      row.timeout_ms,
      row.enabled,
      row.metadata_json,
      now(),
      now(),
    );
  }

  deleteMcp(id: string): void {
    this.run("DELETE FROM mcp_servers WHERE id = ?", id);
  }

  listTransports(): TransportRow[] {
    return this.all("SELECT * FROM transports ORDER BY id");
  }

  getTransport(id: string): TransportRow | undefined {
    return this.one("SELECT * FROM transports WHERE id = ?", id);
  }

  upsertTransport(row: Omit<TransportRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO transports(id, name, protocol, host, port, socket_path, tls_key, tls_cert, gateway_hint, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         protocol = excluded.protocol,
         host = excluded.host,
         port = excluded.port,
         socket_path = excluded.socket_path,
         tls_key = excluded.tls_key,
         tls_cert = excluded.tls_cert,
         gateway_hint = excluded.gateway_hint,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.name,
      row.protocol,
      row.host,
      row.port,
      row.socket_path,
      row.tls_key,
      row.tls_cert,
      row.gateway_hint,
      row.metadata_json,
      now(),
      now(),
    );
  }

  listDocuments(): DocumentRow[] {
    return this.all("SELECT * FROM documents ORDER BY slug");
  }

  getDocument(id: string): DocumentRow | undefined {
    return this.one("SELECT * FROM documents WHERE id = ?", id);
  }

  getDocumentBySlug(slugValue: string): DocumentRow | undefined {
    return this.one("SELECT * FROM documents WHERE slug = ?", slugValue);
  }

  upsertDocument(row: Omit<DocumentRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO documents(id, slug, title, transport_id, body, verified_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         slug = excluded.slug,
         title = excluded.title,
         transport_id = excluded.transport_id,
         body = excluded.body,
         verified_at = excluded.verified_at,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.slug,
      row.title,
      row.transport_id,
      row.body,
      row.verified_at,
      row.metadata_json,
      now(),
      now(),
    );
  }

  markDocumentVerified(id: string, detail: string): void {
    this.run("UPDATE documents SET verified_at = ?, updated_at = ? WHERE id = ?", now(), now(), id);
    this.audit("document.verify", id, detail);
  }

  deleteDocument(id: string): void {
    this.run("DELETE FROM documents WHERE id = ?", id);
  }

  listPrompts(): PromptRow[] {
    return this.all("SELECT * FROM system_prompts ORDER BY name");
  }

  getPrompt(id: string): PromptRow | undefined {
    return this.one("SELECT * FROM system_prompts WHERE id = ?", id);
  }

  defaultPrompt(): PromptRow | undefined {
    return this.one("SELECT * FROM system_prompts WHERE is_default = 1 LIMIT 1");
  }

  upsertPrompt(row: Omit<PromptRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO system_prompts(id, name, content, version, is_default, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         content = excluded.content,
         version = system_prompts.version + 1,
         is_default = excluded.is_default,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      row.id,
      row.name,
      row.content,
      row.version,
      row.is_default,
      row.metadata_json,
      now(),
      now(),
    );
  }

  deletePrompt(id: string): void {
    this.run("DELETE FROM system_prompts WHERE id = ?", id);
  }

  getSession(id: string): SessionRow | undefined {
    return this.one("SELECT * FROM sessions WHERE id = ?", id);
  }

  listSessions(): SessionRow[] {
    return this.all("SELECT * FROM sessions ORDER BY updated_at DESC");
  }

  listSessionMessages(sessionId: string, limit = 200): SessionMessageRow[] {
    return this.all(
      "SELECT * FROM session_messages WHERE session_id = ? ORDER BY id ASC LIMIT ?",
      sessionId,
      Math.min(Math.max(limit, 1), 1000),
    );
  }

  addSessionMessage(input: Omit<SessionMessageRow, "id" | "created_at">): SessionMessageRow {
    const at = now();
    const result = this.db
      .prepare(
        `INSERT INTO session_messages(session_id, role, content, model_id, tokens, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.session_id,
        input.role,
        input.content,
        input.model_id,
        input.tokens,
        input.metadata_json,
        at,
      );
    return this.one<SessionMessageRow>("SELECT * FROM session_messages WHERE id = ?", Number(result.lastInsertRowid))!;
  }

  upsertSession(row: Omit<SessionRow, "created_at" | "updated_at">): void {
    this.run(
      `INSERT INTO sessions(id, title, model_id, system_prompt_id, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         model_id = excluded.model_id,
         system_prompt_id = excluded.system_prompt_id,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
      row.id,
      row.title,
      row.model_id,
      row.system_prompt_id,
      now(),
      now(),
      row.expires_at,
    );
  }

  deleteSession(id: string): void {
    this.run("DELETE FROM sessions WHERE id = ?", id);
  }

  deleteRequest(id: number): number {
    const result = this.db.prepare("DELETE FROM request_logs WHERE id = ?").run(id);
    return Number(result.changes);
  }

  clearRequests(): number {
    const result = this.db.prepare("DELETE FROM request_logs").run();
    return Number(result.changes);
  }

  engineState(): EngineState {
    const row = this.one<{
      model_id: string | null;
      pid: number | null;
      status: EngineState["status"];
      started_at: string | null;
      expires_at: string | null;
      load_mode: EngineState["load_mode"];
      socket_path: string | null;
      port: number | null;
      build: string | null;
      last_error: string | null;
      updated_at: string;
    }>("SELECT * FROM engine_state WHERE id = 1");
    if (!row) {
      return {
        model_id: null,
        pid: null,
        status: "stopped",
        started_at: null,
        expires_at: null,
        load_mode: "auto",
        socket_path: null,
        port: null,
        build: null,
        mmap: null,
        last_error: null,
        updated_at: now(),
      };
    }
    return { ...row, mmap: null };
  }

  setEngineState(state: Omit<EngineState, "updated_at" | "mmap">): void {
    this.run(
      `INSERT INTO engine_state(id, model_id, pid, status, started_at, expires_at, load_mode, socket_path, port, build, last_error, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         model_id = excluded.model_id,
         pid = excluded.pid,
         status = excluded.status,
         started_at = excluded.started_at,
         expires_at = excluded.expires_at,
         load_mode = excluded.load_mode,
         socket_path = excluded.socket_path,
         port = excluded.port,
         build = excluded.build,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      state.model_id,
      state.pid,
      state.status,
      state.started_at,
      state.expires_at,
      state.load_mode,
      state.socket_path,
      state.port,
      state.build,
      state.last_error,
      now(),
    );
  }
}

function curl(engineUrl: string, pathPart: string, body: string): string {
  return `curl -sS ${engineUrl}${pathPart} \\\n  -H 'content-type: application/json' \\\n  -d '${body}'`;
}

function curlUds(socket: string, pathPart: string, body: string): string {
  return `curl -sS --unix-socket ${socket} http://localhost${pathPart} \\\n  -H 'content-type: application/json' \\\n  -d '${body}'`;
}

export function seedStore(store: Store, cfg: Config, os: OsInfo): void {
  const seedVersion = "1";
  store.upsertProvider({
    id: "llamacpp",
    name: "llama.cpp (stock)",
    kind: "llamacpp",
    base_url: cfg.engineUrl,
    build: null,
    config_json: JSON.stringify({ binary: cfg.llamaBin || "auto", load_mode: cfg.loadMode, accel: cfg.accel }),
    metadata_json: "{}",
  });

  // The cert pair is shared with the Caddy edge, so file presence alone does
  // not mean the engine speaks TLS. Only seed the engine-native https row when
  // LAMA_TLS actually starts the engine with --ssl-key-file/--ssl-cert-file.
  const tlsPresent = cfg.tls && fs.existsSync(cfg.tlsKey) && fs.existsSync(cfg.tlsCert);
  store.upsertTransport({
    id: "http",
    name: "HTTP loopback",
    protocol: "http",
    host: cfg.engineHost,
    port: cfg.enginePort,
    socket_path: null,
    tls_key: null,
    tls_cert: null,
    gateway_hint: `Base URL: http://${cfg.gatewayHost}:${cfg.gatewayPort} — add this as the gateway's HTTP provider URL. The gateway is a separate connection; do not pass this as an environment variable to llama.cpp.`,
    metadata_json: "{}",
  });
  if (tlsPresent) {
    store.upsertTransport({
      id: "https",
      name: "HTTPS loopback (engine-native TLS)",
      protocol: "https",
      host: cfg.engineHost,
      port: cfg.enginePort,
      socket_path: null,
      tls_key: cfg.tlsKey,
      tls_cert: cfg.tlsCert,
      gateway_hint: `Base URL: https://${cfg.engineHost}:${cfg.enginePort} — verify the certificate chain before adding it to the gateway. Stock binaries need an OpenSSL build for this.`,
      metadata_json: "{}",
    });
  }
  if (cfg.udsPath) {
    store.upsertTransport({
      id: "uds",
      name: "Unix domain socket",
      protocol: "uds",
      host: null,
      port: null,
      socket_path: cfg.udsPath,
      tls_key: null,
      tls_cert: null,
      gateway_hint: `Do not copy a path from this file into the gateway config. Create a symlink in the gateway folder: ${path.join(cfg.gatewayDir, "llama.sock")} -> ${cfg.udsPath}. Then the gateway uses http://localhost/v1 over that socket.`,
      metadata_json: "{}",
    });
  }

  store.upsertDocument({
    id: "openai-http",
    slug: "openai-http",
    title: "OpenAI chat completions over HTTP",
    transport_id: "http",
    body: curl(
      cfg.engineUrl,
      "/v1/chat/completions",
      '{"model":"MODEL_ID","messages":[{"role":"user","content":"hello"}],"max_tokens":64}',
    ),
    verified_at: null,
    metadata_json: "{}",
  });
  store.upsertDocument({
    id: "anthropic-http",
    slug: "anthropic-http",
    title: "Anthropic Messages over HTTP",
    transport_id: "http",
    body: curl(
      cfg.engineUrl,
      "/v1/messages",
      '{"model":"MODEL_ID","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}',
    ),
    verified_at: null,
    metadata_json: "{}",
  });
  if (cfg.udsPath) {
    store.upsertDocument({
      id: "openai-uds",
      slug: "openai-uds",
      title: "OpenAI chat completions over UDS",
      transport_id: "uds",
      body: curlUds(
        cfg.udsPath,
        "/v1/chat/completions",
        '{"model":"MODEL_ID","messages":[{"role":"user","content":"hello"}],"max_tokens":64}',
      ),
      verified_at: null,
      metadata_json: "{}",
    });
    store.upsertDocument({
      id: "anthropic-uds",
      slug: "anthropic-uds",
      title: "Anthropic Messages over UDS",
      transport_id: "uds",
      body: curlUds(
        cfg.udsPath,
        "/v1/messages",
        '{"model":"MODEL_ID","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}',
      ),
      verified_at: null,
      metadata_json: "{}",
    });
  }

  if (!store.defaultPrompt()) {
    // Bootstrap only: prompts/lama-system.md wins on the next syncSystemPrompt().
    // There is exactly one system prompt (id "system") for every model.
    store.upsertPrompt({
      id: "system",
      name: "system",
      content:
        "You are the assistant served by lama, a local llama.cpp engine owned by Sahon Srabon (Developer Zone). Identity is fixed. Answer in the user's language, never invent tool output, and say when you do not know.",
      version: 1,
      is_default: 1,
      metadata_json: "{}",
    });
  }

  if (!store.getMcp("lama-tools")) {
    store.upsertMcp({
      id: "lama-tools",
      name: "lama-tools",
      transport: "stdio",
      command: process.execPath,
      args_json: JSON.stringify([path.join(cfg.root, "src", "mcp", "server.ts")]),
      env_json: JSON.stringify({ LAMA_WORKSPACE: cfg.workspaceDir, LAMA_ENV_FILE: cfg.envFile }),
      cwd: cfg.root,
      url: null,
      api_key_ref: null,
      timeout_ms: 30000,
      enabled: 1,
      metadata_json: "{}",
    });
  }

  // The matrix needs a row per advertised tool before the first probe, so the UI can show
  // on/off switches and use cases immediately after setup.
  for (const tool of MCP_TOOLS) {
    store.upsertMcpTool({
      id: `lama-tools:${tool.name}`,
      mcp_id: "lama-tools",
      name: tool.name,
      description: tool.description,
      use_cases: TOOL_USE_CASES[tool.name] ?? "",
      enabled: 1,
    });
  }
  store.run(
    "UPDATE mcp_servers SET tools_count = (SELECT COUNT(*) FROM mcp_tools WHERE mcp_id = mcp_servers.id) WHERE id = 'lama-tools'",
  );

  if (fs.existsSync(cfg.modelsDir)) {
    for (const entry of fs.readdirSync(cfg.modelsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) continue;
      const modelId = slug(entry.name);
      const filePath = path.join(cfg.modelsDir, entry.name);
      const existing = store.getModel(modelId);
      if (existing) continue;
      // models carries UNIQUE(provider_id, model_id): a file registered under a
      // custom row id must not be seeded a second time or every boot crashes.
      const claimed = store
        .listModels()
        .find((row) => row.path === filePath || (row.provider_id === "llamacpp" && row.model_id === modelId));
      if (claimed) continue;
      store.upsertModel({
        id: modelId,
        provider_id: "llamacpp",
        name: entry.name.replace(/\.gguf$/i, ""),
        model_id: modelId,
        path: filePath,
        context: 4096,
        max_tokens: 1024,
        temperature: 0.7,
        quant: null,
        load_mode: "auto",
        ttl_hours: cfg.defaultTtlHours,
        enabled: 1,
        metadata_json: "{}",
      });
    }
  }

  store.setSetting("seed_version", seedVersion);
  store.setSetting("seeded_os", JSON.stringify({ platform: os.platform, arch: os.arch, distro: os.distro }));
  if (!store.setting("admin_token_generated")) {
    store.setSetting("admin_token_generated", cfg.adminToken ? "external" : "missing");
  }
}
