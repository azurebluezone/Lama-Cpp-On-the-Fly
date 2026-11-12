/**
 * SQLite store for the lama manager (node:sqlite, zero npm deps).
 *
 * Design rules (industry practice, kept small):
 *   - Every schema change is a numbered migration in MIGRATIONS; never edit
 *     an applied migration, append a new one.
 *   - system prompts are immutable versions: editing writes a new row into
 *     system_prompt_versions and moves system_prompts.current_version_id.
 *     That keeps an audit trail and makes runs reproducible.
 *   - Secrets (MCP api_key) never leave the process unmasked; list APIs return
 *     has_key instead of the value. The file is chmod 0600 on creation.
 *   - Nothing here is inferred from the UI: the DB is the source of truth,
 *     config files are generated from it.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const now = () => new Date().toISOString();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT 'global'
          CHECK (scope IN ('global','model','mcp_server','experiment')),
        current_version_id INTEGER,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_prompt_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_id INTEGER NOT NULL REFERENCES system_prompts(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        variables TEXT NOT NULL DEFAULT '[]',
        params TEXT NOT NULL DEFAULT '{}',
        checksum TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(prompt_id, version)
      );

      CREATE TABLE IF NOT EXISTS prompt_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_id INTEGER NOT NULL REFERENCES system_prompts(id) ON DELETE CASCADE,
        version_id INTEGER REFERENCES system_prompt_versions(id) ON DELETE SET NULL,
        target_type TEXT NOT NULL CHECK (target_type IN ('global','model','mcp_server')),
        target_id TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at TEXT NOT NULL,
        UNIQUE(prompt_id, target_type, target_id)
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL
          CHECK (transport IN ('stdio','http','sse','uds','openai','anthropic')),
        url TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        headers TEXT NOT NULL DEFAULT '{}',
        command TEXT NOT NULL DEFAULT '',
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        cwd TEXT NOT NULL DEFAULT '',
        timeout_ms INTEGER NOT NULL DEFAULT 30000,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        status TEXT NOT NULL DEFAULT 'untested'
          CHECK (status IN ('untested','ok','fail')),
        last_latency_ms INTEGER,
        last_detail TEXT NOT NULL DEFAULT '',
        last_checked_at TEXT,
        last_tools_count INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        input_schema TEXT NOT NULL DEFAULT '{}',
        seen_at TEXT NOT NULL,
        UNIQUE(server_id, name)
      );

      CREATE TABLE IF NOT EXISTS mcp_probes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER REFERENCES mcp_servers(id) ON DELETE SET NULL,
        ok INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT '',
        tools_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        format TEXT NOT NULL,
        stream INTEGER NOT NULL DEFAULT 0,
        tools INTEGER NOT NULL DEFAULT 0,
        prompt_version_id INTEGER REFERENCES system_prompt_versions(id) ON DELETE SET NULL,
        prompt_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        http_status INTEGER,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        ttft_ms INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        finish_reason TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        response_excerpt TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL DEFAULT 'admin',
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_runs_model_time ON chat_runs(model, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_probes_server_time ON mcp_probes(server_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_versions_prompt ON system_prompt_versions(prompt_id, version DESC);
    `,
  },
];

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(m.version, now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.version} failed: ${e.message}`);
    }
  }
  try { fs.chmodSync(file, 0o600); } catch {}
  return db;
}

const json = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const slugify = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

export function createStore(file) {
  const db = openDb(file);
  const cache = new Map();
  const q = (sql) => { if (!cache.has(sql)) cache.set(sql, db.prepare(sql)); return cache.get(sql); };
  const audit = (action, entity, entityId, detail = {}) => {
    q("INSERT INTO audit_events (actor, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)")
      .run("admin", action, entity, String(entityId ?? ""), JSON.stringify(detail), now());
  };

  /* ---------------------------------------------------------------- settings */
  const settings = {
    get(key, fallback = null) {
      const r = q("SELECT value FROM app_settings WHERE key = ?").get(key);
      return r ? r.value : fallback;
    },
    set(key, value) {
      q(`INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(key, String(value), now());
      return settings.get(key);
    },
    all() {
      return Object.fromEntries(q("SELECT key, value FROM app_settings").all().map((r) => [r.key, r.value]));
    },
  };

  /* --------------------------------------------------------- system prompts */
  const prompts = {
    list({ includeArchived = false } = {}) {
      const rows = q(`SELECT p.*, v.content, v.version AS current_version
                      FROM system_prompts p
                      LEFT JOIN system_prompt_versions v ON v.id = p.current_version_id
                      ${includeArchived ? "" : "WHERE p.is_active = 1"}
                      ORDER BY p.is_default DESC, p.name`).all();
      return rows.map((r) => ({
        ...r,
        is_default: !!r.is_default,
        is_active: !!r.is_active,
        tags: json(r.tags, []),
        bindings: q(`SELECT b.*, v.version FROM prompt_bindings b
                     LEFT JOIN system_prompt_versions v ON v.id = b.version_id
                     WHERE b.prompt_id = ? ORDER BY b.priority, b.target_type`).all(r.id)
          .map((b) => ({ ...b, enabled: !!b.enabled })),
        versions_count: q("SELECT COUNT(*) AS n FROM system_prompt_versions WHERE prompt_id = ?").get(r.id).n,
      }));
    },
    get(id) {
      const p = q(`SELECT p.*, v.content, v.version AS current_version
                   FROM system_prompts p LEFT JOIN system_prompt_versions v ON v.id = p.current_version_id
                   WHERE p.id = ?`).get(id);
      if (!p) return null;
      const versions = q("SELECT id, version, content, variables, params, checksum, note, created_at FROM system_prompt_versions WHERE prompt_id = ? ORDER BY version DESC").all(id)
        .map((v) => ({ ...v, variables: json(v.variables, []), params: json(v.params, {}) }));
      const bindings = q(`SELECT b.*, v.version FROM prompt_bindings b
                          LEFT JOIN system_prompt_versions v ON v.id = b.version_id
                          WHERE b.prompt_id = ? ORDER BY b.priority, b.target_type`).all(id)
        .map((b) => ({ ...b, enabled: !!b.enabled }));
      return {
        ...p,
        is_default: !!p.is_default,
        is_active: !!p.is_active,
        tags: json(p.tags, []),
        versions,
        versions_count: versions.length,
        bindings,
      };
    },
    create({ name, description = "", content, scope = "global", tags = [], is_default = false, note = "", variables = [], params = {} }) {
      if (!String(name || "").trim()) throw new Error("name is required");
      if (!String(content || "").trim()) throw new Error("content is required");
      const slug = slugify(name);
      db.exec("BEGIN");
      try {
        if (is_default) q("UPDATE system_prompts SET is_default = 0, updated_at = ?").run(now());
        const id = Number(q(`INSERT INTO system_prompts (name, slug, description, scope, is_default, is_active, tags, created_at, updated_at)
                             VALUES (?,?,?,?,?,1,?,?,?)`)
          .run(String(name).trim(), slug, description, scope, is_default ? 1 : 0, JSON.stringify(tags), now(), now()).lastInsertRowid);
        const versionId = Number(q(`INSERT INTO system_prompt_versions (prompt_id, version, content, variables, params, checksum, note, created_at)
                                    VALUES (?,?,?,?,?,?,?,?)`)
          .run(id, 1, content, JSON.stringify(variables), JSON.stringify(params), sha256(content), note, now()).lastInsertRowid);
        q("UPDATE system_prompts SET current_version_id = ? WHERE id = ?").run(versionId, id);
        db.exec("COMMIT");
        audit("prompt.create", "system_prompt", id, { slug, version: 1 });
        return prompts.get(id);
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    addVersion(id, { content, note = "", variables = [], params = {} }) {
      if (!String(content || "").trim()) throw new Error("content is required");
      const p = q("SELECT * FROM system_prompts WHERE id = ?").get(id);
      if (!p) throw new Error(`prompt not found: ${id}`);
      const last = q("SELECT MAX(version) AS v FROM system_prompt_versions WHERE prompt_id = ?").get(id).v || 0;
      const version = last + 1;
      db.exec("BEGIN");
      try {
        const versionId = Number(q(`INSERT INTO system_prompt_versions (prompt_id, version, content, variables, params, checksum, note, created_at)
                                    VALUES (?,?,?,?,?,?,?,?)`)
          .run(id, version, content, JSON.stringify(variables), JSON.stringify(params), sha256(content), note, now()).lastInsertRowid);
        q("UPDATE system_prompts SET current_version_id = ?, updated_at = ? WHERE id = ?").run(versionId, now(), id);
        db.exec("COMMIT");
        audit("prompt.version", "system_prompt", id, { version });
        return prompts.get(id);
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    updateMeta(id, { name, description, scope, tags, is_active }) {
      const p = q("SELECT * FROM system_prompts WHERE id = ?").get(id);
      if (!p) throw new Error(`prompt not found: ${id}`);
      q(`UPDATE system_prompts SET name = ?, slug = ?, description = ?, scope = ?, tags = ?, is_active = ?, updated_at = ? WHERE id = ?`)
        .run(
          name ?? p.name,
          name ? slugify(name) : p.slug,
          description ?? p.description,
          scope ?? p.scope,
          JSON.stringify(tags ?? json(p.tags, [])),
          is_active === undefined ? p.is_active : (is_active ? 1 : 0),
          now(), id,
        );
      audit("prompt.update", "system_prompt", id, { name: name ?? p.name });
      return prompts.get(id);
    },
    setDefault(id) {
      const p = q("SELECT id FROM system_prompts WHERE id = ?").get(id);
      if (!p) throw new Error(`prompt not found: ${id}`);
      db.exec("BEGIN");
      try {
        q("UPDATE system_prompts SET is_default = 0").run();
        q("UPDATE system_prompts SET is_default = 1, updated_at = ? WHERE id = ?").run(now(), id);
        settings.set("default_prompt_id", id);
        db.exec("COMMIT");
        audit("prompt.default", "system_prompt", id);
        return prompts.get(id);
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    archive(id) {
      q("UPDATE system_prompts SET is_active = 0, is_default = 0, updated_at = ? WHERE id = ?").run(now(), id);
      audit("prompt.archive", "system_prompt", id);
      return prompts.get(id);
    },
    /** Effective prompt for a model: model binding > global binding > default > null. */
    resolve({ model = "", mcpServer = "" } = {}) {
      const pick = (type, target) => q(`SELECT b.*, p.name, p.slug, v.content, v.version, v.id AS version_id, v.params
                                        FROM prompt_bindings b
                                        JOIN system_prompts p ON p.id = b.prompt_id AND p.is_active = 1
                                        LEFT JOIN system_prompt_versions v ON v.id = COALESCE(b.version_id, p.current_version_id)
                                        WHERE b.enabled = 1 AND b.target_type = ? AND b.target_id = ?
                                        ORDER BY b.priority LIMIT 1`).get(type, target);
      let row = null;
      if (mcpServer) row = pick("mcp_server", mcpServer);
      if (!row && model) row = pick("model", model);
      if (!row) row = pick("global", "");
      if (!row) {
        row = q(`SELECT p.name, p.slug, v.content, v.version, v.id AS version_id, v.params
                 FROM system_prompts p JOIN system_prompt_versions v ON v.id = p.current_version_id
                 WHERE p.is_active = 1 ORDER BY p.is_default DESC, p.updated_at DESC LIMIT 1`).get();
      }
      if (!row) return null;
      return { ...row, params: json(row.params, {}) };
    },
    bind(promptId, { targetType = "global", targetId = "", versionId = null, priority = 100, enabled = true }) {
      const p = q("SELECT id FROM system_prompts WHERE id = ?").get(promptId);
      if (!p) throw new Error(`prompt not found: ${promptId}`);
      q(`INSERT INTO prompt_bindings (prompt_id, version_id, target_type, target_id, priority, enabled, created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(prompt_id, target_type, target_id) DO UPDATE SET
           version_id = excluded.version_id, priority = excluded.priority,
           enabled = excluded.enabled`)
        .run(promptId, versionId, targetType, targetId, priority, enabled ? 1 : 0, now());
      audit("prompt.bind", "system_prompt", promptId, { targetType, targetId });
      return prompts.get(promptId);
    },
  };

  /* ------------------------------------------------------------------- MCP */
  const mask = ({ api_key, ...r }) => ({
    ...r,
    headers: json(r.headers, {}),
    args: json(r.args, []),
    env_keys: Object.keys(json(r.env, {})),
    has_key: Boolean(api_key),
    enabled: !!r.enabled,
    last_ok: r.status === "ok",
    tools: q("SELECT name, description FROM mcp_tools WHERE server_id = ? ORDER BY name").all(r.id),
  });
  const mcp = {
    list() {
      return q("SELECT * FROM mcp_servers ORDER BY name").all().map(mask);
    },
    get(id, { secret = false } = {}) {
      const r = q("SELECT * FROM mcp_servers WHERE id = ?").get(id);
      if (!r) return null;
      if (secret) {
        return { ...r, headers: json(r.headers, {}), args: json(r.args, []), env: json(r.env, {}), enabled: !!r.enabled };
      }
      return mask(r);
    },
    byName(name) {
      const r = q("SELECT * FROM mcp_servers WHERE name = ?").get(name);
      return r ? { ...r, headers: json(r.headers, {}), args: json(r.args, []), env: json(r.env, {}) } : null;
    },
    create(input) {
      const slug = slugify(input.name);
      if (!slug) throw new Error("name is required");
      const id = Number(q(`INSERT INTO mcp_servers
        (name, slug, transport, url, api_key, headers, command, args, env, cwd, timeout_ms, enabled, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.name, slug, input.transport, input.url || "", input.api_key || "",
        JSON.stringify(input.headers || {}), input.command || "", JSON.stringify(input.args || []),
        JSON.stringify(input.env || {}), input.cwd || "", input.timeout_ms || 30000,
        input.enabled === false ? 0 : 1, now(), now(),
      ).lastInsertRowid);
      audit("mcp.create", "mcp_server", id, { name: input.name, transport: input.transport, url: input.url || null });
      return mcp.get(id);
    },
    update(id, patch) {
      const r = q("SELECT * FROM mcp_servers WHERE id = ?").get(id);
      if (!r) throw new Error(`mcp server not found: ${id}`);
      const merged = {
        name: patch.name ?? r.name,
        slug: patch.name ? slugify(patch.name) : r.slug,
        transport: patch.transport ?? r.transport,
        url: patch.url ?? r.url,
        api_key: patch.api_key === undefined ? r.api_key : patch.api_key,
        headers: JSON.stringify(patch.headers ?? json(r.headers, {})),
        command: patch.command ?? r.command,
        args: JSON.stringify(patch.args ?? json(r.args, [])),
        env: JSON.stringify(patch.env ?? json(r.env, {})),
        cwd: patch.cwd ?? r.cwd,
        timeout_ms: patch.timeout_ms ?? r.timeout_ms,
        enabled: patch.enabled === undefined ? r.enabled : (patch.enabled ? 1 : 0),
        updated_at: now(),
      };
      q(`UPDATE mcp_servers SET name=?, slug=?, transport=?, url=?, api_key=?, headers=?, command=?, args=?,
         env=?, cwd=?, timeout_ms=?, enabled=?, updated_at=? WHERE id=?`)
        .run(merged.name, merged.slug, merged.transport, merged.url, merged.api_key, merged.headers,
          merged.command, merged.args, merged.env, merged.cwd, merged.timeout_ms, merged.enabled, merged.updated_at, id);
      audit("mcp.update", "mcp_server", id, { name: merged.name, enabled: !!merged.enabled });
      return mcp.get(id);
    },
    remove(id) {
      const r = q("SELECT name FROM mcp_servers WHERE id = ?").get(id);
      q("DELETE FROM mcp_servers WHERE id = ?").run(id);
      audit("mcp.delete", "mcp_server", id, { name: r?.name });
      return { deleted: id, name: r?.name };
    },
    recordProbe(serverId, probe) {
      db.exec("BEGIN");
      try {
        q(`INSERT INTO mcp_probes (server_id, ok, latency_ms, detail, tools_count, created_at)
           VALUES (?,?,?,?,?,?)`).run(serverId ?? null, probe.ok ? 1 : 0, probe.latency_ms || 0,
          String(probe.detail || "").slice(0, 2000), probe.tools?.length || 0, now());
        if (serverId) {
          q(`UPDATE mcp_servers SET status = ?, last_latency_ms = ?, last_detail = ?, last_checked_at = ?,
             last_tools_count = ?, updated_at = ? WHERE id = ?`)
            .run(probe.ok ? "ok" : "fail", probe.latency_ms || 0, String(probe.detail || "").slice(0, 2000),
              now(), probe.tools?.length || 0, now(), serverId);
          if (probe.ok && Array.isArray(probe.tools)) {
            q("DELETE FROM mcp_tools WHERE server_id = ?").run(serverId);
            for (const t of probe.tools) {
              q("INSERT INTO mcp_tools (server_id, name, description, input_schema, seen_at) VALUES (?,?,?,?,?)")
                .run(serverId, t.name, t.description || "", JSON.stringify(t.inputSchema || {}), now());
            }
          }
        }
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      audit(probe.ok ? "mcp.probe.ok" : "mcp.probe.fail", "mcp_server", serverId ?? "", {
        latency_ms: probe.latency_ms, detail: probe.detail, tools: probe.tools?.length || 0,
      });
      return probe;
    },
    probes(serverId, limit = 20) {
      return q("SELECT * FROM mcp_probes WHERE server_id = ? ORDER BY id DESC LIMIT ?").all(serverId, limit)
        .map((p) => ({ ...p, ok: !!p.ok }));
    },
    enabled() {
      return q("SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name").all()
        .map((r) => ({ ...r, headers: json(r.headers, {}), args: json(r.args, []), env: json(r.env, {}) }));
    },
  };

  /* -------------------------------------------------------------- chat lab */
  const runs = {
    add(run) {
      const id = Number(q(`INSERT INTO chat_runs
        (model, format, stream, tools, prompt_version_id, prompt_text, status, http_status, latency_ms, ttft_ms,
         prompt_tokens, completion_tokens, total_tokens, finish_reason, error, response_excerpt, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        run.model || "", run.format || "", run.stream ? 1 : 0, run.tools ? 1 : 0,
        run.prompt_version_id ?? null, String(run.prompt_text || "").slice(0, 8000),
        run.status || "error", run.http_status ?? null, run.latency_ms || 0, run.ttft_ms ?? null,
        run.prompt_tokens ?? null, run.completion_tokens ?? null, run.total_tokens ?? null,
        run.finish_reason || "", String(run.error || "").slice(0, 2000),
        String(run.response_excerpt || "").slice(0, 4000), now(),
      ).lastInsertRowid);
      return { ...run, id };
    },
    list(limit = 50) {
      return q("SELECT * FROM chat_runs ORDER BY id DESC LIMIT ?").all(limit)
        .map((r) => ({ ...r, stream: !!r.stream, tools: !!r.tools }));
    },
    stats() {
      const perModel = q(`SELECT model,
          COUNT(*) AS calls,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(latency_ms), 0) AS ms_sum,
          COALESCE(MAX(latency_ms), 0) AS max_ms,
          MAX(created_at) AS last
        FROM chat_runs GROUP BY model ORDER BY calls DESC`).all();
      for (const m of perModel) m.ms_avg = m.calls ? Math.round(m.ms_sum / m.calls) : 0;
      const totals = perModel.reduce((a, m) => ({
        runs: a.runs + m.calls,
        prompt_tokens: a.prompt_tokens + m.prompt_tokens,
        completion_tokens: a.completion_tokens + m.completion_tokens,
        total_tokens: a.total_tokens + m.total_tokens,
      }), { runs: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
      return { totals, models: perModel };
    },
  };

  const auditEvents = (limit = 50) =>
    q("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?").all(limit)
      .map((e) => ({ ...e, detail: json(e.detail, {}) }));

  return { file, db, settings, prompts, mcp, runs, audit: auditEvents, auditWrite: audit };
}

export { slugify, sha256 };
