/**
 * Runtime view of the engine: what is loaded, which slots are generating,
 * how many tokens the engine counted, and what is mapped into memory.
 * Every number comes from an authoritative source — /props, /slots, /metrics
 * for engine state and counters, /proc/<pid>/maps for mmap truth. /props has
 * no mmap field, and the engine log only prints hints; neither is used as a
 * substitute. Missing data stays null, never 0.
 */

import fs from "node:fs";
import path from "node:path";

export function parsePrometheus(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(-?[0-9.eE+]+)$/.exec(line.trim());
    if (!m) continue;
    out[m[1]] = (out[m[1]] || 0) + Number(m[2]);
  }
  return out;
}

/**
 * Build identity, parsed from the two sources llama.cpp actually publishes:
 *   /props.build_info        → "b11941-19ff817fb"   (build number + short commit)
 *   llama --version          → "version: 0.7.0-dev (build 11941, commit 19ff817fb)"
 * Neither string is guessed or derived from the other; `match` compares them so
 * a stale binary next to a running engine is visible instead of silent.
 */
export function parseBuildInfo(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = /^b?(\d+)-([0-9a-f]{6,40})$/i.exec(s);
  return { raw: s, build: m ? m[1] : null, commit: m ? m[2] : null };
}

export function parseBinaryVersion(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const build = /build\s+(\d+)/i.exec(s)?.[1] ?? null;
  const commit = /commit\s+([0-9a-f]{6,40})/i.exec(s)?.[1] ?? null;
  const version = /version:\s*([^\s(]+)/i.exec(s)?.[1] ?? (s.split(/\s+/)[0] || null);
  return { raw: s.split("\n")[0], version, build, commit };
}

/** Compare /props.build_info with `llama --version`; null when either is missing. */
export function versionMatch(binary, props) {
  if (!binary || !props) return null;
  if (binary.build && props.build) return binary.build === props.build && (!binary.commit || !props.commit || binary.commit.startsWith(props.commit) || props.commit.startsWith(binary.commit));
  return null;
}

export function pickProps(j) {
  if (!j || typeof j !== "object") return null;
  const g = j.default_generation_settings || {};
  return {
    model_path: j.model_path || null,
    model_alias: j.model_alias || j.alias || null,
    model_ftype: j.model_ftype || null,
    n_ctx: j.n_ctx ?? g.n_ctx ?? null,
    total_slots: j.total_slots ?? null,
    build_info: j.build_info || null,
    metrics_enabled: Boolean(j.endpoint_metrics),
    slots_enabled: Boolean(j.endpoint_slots),
    props_writable: Boolean(j.endpoint_props),
    sleeping: Boolean(j.is_sleeping),
    chat_template: typeof j.chat_template === "string"
      ? { present: true, chars: j.chat_template.length, has_tools: /tool/i.test(j.chat_template) }
      : { present: false, chars: 0, has_tools: false },
    template_caps: j.chat_template_caps || null,
    modalities: j.modalities || null,
  };
}

export function slotsSummary(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.slots) ? payload.slots : [];
  const slots = list.map((s) => ({
    id: s.id ?? null,
    processing: Boolean(s.is_processing ?? s.processing),
    n_ctx: s.n_ctx ?? null,
    n_past: s.n_past ?? s.next_token?.n_past ?? null,
    n_decoded: s.next_token?.n_decoded ?? null,
  }));
  return {
    total: slots.length,
    busy: slots.filter((s) => s.processing).length,
    idle: slots.filter((s) => !s.processing).length,
    slots,
  };
}

/**
 * Counters by their documented names (tools/server/README.md, "GET /metrics").
 * Exact keys only: the old substring match could return the `*_seconds` gauge
 * (throughput in tokens/s) as a token count, because both contain "prompt_tokens".
 * A metric that the docs do not list stays null — never 0, never guessed.
 */
export function engineCounters(prom) {
  const exact = (k) => (Object.prototype.hasOwnProperty.call(prom, k) ? prom[k] : null);
  const out = {
    prompt_tokens: exact("llamacpp:prompt_tokens_total"),
    prompt_tokens_cached: exact("llamacpp:prompt_tokens_cached_total"),
    completion_tokens: exact("llamacpp:tokens_predicted_total"),
    requests_processing: exact("llamacpp:requests_processing"),
    requests_deferred: exact("llamacpp:requests_deferred"),
    n_tokens_max: exact("llamacpp:n_tokens_max"),
    decode_total: exact("llamacpp:n_decode_total"),
    prompt_per_second: exact("llamacpp:prompt_tokens_seconds"),
    predicted_per_second: exact("llamacpp:predicted_tokens_seconds"),
    // llama.cpp documents no KV-cache gauge (README "Available metrics").
    kv_cache_usage_ratio: null,
    raw_keys: Object.keys(prom).slice(0, 40),
  };
  out.missing = ["prompt_tokens", "completion_tokens", "requests_processing", "requests_deferred", "decode_total"]
    .filter((k) => out[k] === null);
  return out;
}

/**
 * Mapped-buffer lines the engine may print at load time (older builds).
 * This is a hint, not mmap truth — the kernel's /proc/<pid>/maps is the
 * authoritative source, because /props exposes no mmap state at all.
 */
export function scanEngineLog(text) {
  const lines = String(text || "").split("\n");
  const mapped = [];
  let mappedMib = 0;
  for (const line of lines) {
    const m = /([A-Za-z0-9_]+_Mapped)\s+(?:model\s+)?buffer size\s*=\s*([\d.]+)\s*MiB/.exec(line);
    if (m) {
      mapped.push({ buffer: m[1], mib: Number(m[2]) });
      mappedMib += Number(m[2]);
    }
  }
  return {
    mapped_buffers: mapped.length,
    mapped_mib: Math.round(mappedMib * 10) / 10,
    lines: mapped,
  };
}

/**
 * mmap truth from /proc/<pid>/maps (Linux only, null elsewhere). llama.cpp
 * maps the GGUF; /props reports no mmap state, so the kernel is the only
 * honest source for how many regions of the model file are mapped, how much,
 * and whether each mapping is shared (`r--s`, MAP_SHARED) or private.
 * `mapsText` is for tests; production always reads the live file.
 */
export function scanProcessMaps(pid, modelPath, mapsText) {
  let text = mapsText;
  if (text == null) {
    if (!pid) return null;
    try { text = fs.readFileSync(`/proc/${pid}/maps`, "utf8"); } catch { return null; }
  }
  const base = path.basename(String(modelPath || "").replace(/\s+\(deleted\)$/, ""));
  const out = {
    source: mapsText == null ? `/proc/${pid}/maps` : "fixture",
    model: base || null,
    mapped_regions: 0, mapped_mib: 0,
    shared_regions: 0, shared_mib: 0,
    private_regions: 0, private_mib: 0,
    shm_segments: 0,
  };
  for (const line of String(text).split("\n")) {
    const m = /^([0-9a-f]+)-([0-9a-f]+)\s+(\S+)\s+\S+\s+\S+\s+\S+\s*(.*)$/.exec(line);
    if (!m) continue;
    const bytes = parseInt(m[2], 16) - parseInt(m[1], 16);
    const perms = m[3];
    const file = m[4].trim().replace(/\s+\(deleted\)$/, "");
    if (base && path.basename(file) === base) {
      out.mapped_regions++;
      out.mapped_mib += bytes / 1048576;
      if (perms.includes("s")) { out.shared_regions++; out.shared_mib += bytes / 1048576; }
      else { out.private_regions++; out.private_mib += bytes / 1048576; }
    }
    if (file.startsWith("/dev/shm/") || file.startsWith("/SYSV") || file === "[shm]") out.shm_segments++;
  }
  for (const k of ["mapped_mib", "shared_mib", "private_mib"]) out[k] = Math.round(out[k] * 10) / 10;
  return out;
}

/** One runtime snapshot for the UI cards. */
export function buildRuntime({ health, props, slots, prom, logText, alias, model, pid, since, expiresAt, baseUrl, udsPath, binaryVersion }) {
  const p = pickProps(props);
  const s = slotsSummary(slots);
  const counters = engineCounters(parsePrometheus(prom));
  const loaded = health === "ok";
  const bin = parseBinaryVersion(binaryVersion?.raw ?? binaryVersion ?? "");
  const fromProps = parseBuildInfo(p?.build_info);

  // mmap numbers: /proc/<pid>/maps only. The log hint is kept beside them,
  // clearly labelled, so nobody mistakes it for the count.
  const maps = scanProcessMaps(pid, model || p?.model_path);
  const hint = scanEngineLog(logText);
  const memory = {
    source: maps?.source || null,
    model: maps?.model || null,
    mapped_regions: maps ? maps.mapped_regions : null,
    mapped_mib: maps ? maps.mapped_mib : null,
    shared_regions: maps ? maps.shared_regions : null,
    shared_mib: maps ? maps.shared_mib : null,
    private_regions: maps ? maps.private_regions : null,
    private_mib: maps ? maps.private_mib : null,
    shm_segments: maps ? maps.shm_segments : null,
    log_hint: hint.mapped_buffers || hint.mapped_mib
      ? { ...hint, note: "engine log hint only — mmap truth comes from /proc/<pid>/maps" }
      : null,
  };
  if (!maps) {
    memory.note = !loaded
      ? "engine not running — no process maps to read"
      : !pid
        ? "engine pid unknown to this manager (started elsewhere) — mmap count unavailable"
        : "no /proc/<pid>/maps for this pid (non-Linux?) — mmap count unavailable";
  }
  const generating = s.busy > 0;
  return {
    engine: {
      health, base_url: baseUrl, uds: udsPath || null,
      alias: alias || p?.model_alias || null,
      model: model || p?.model_path || null,
      pid: pid ?? null, since: since || null, expires_at: expiresAt || null,
      loaded, generating,
      state: !loaded ? "not-loaded" : generating ? "generating" : "idle",
      version: {
        binary: bin,                 // llama --version (works while the engine is down)
        props: fromProps,            // /props.build_info (only while it is up)
        build: fromProps?.build || bin?.build || null,
        commit: fromProps?.commit || bin?.commit || null,
        match: versionMatch(bin, fromProps),
        source: fromProps ? "/props.build_info + llama --version" : "llama --version only (no /props.build_info)",
      },
    },
    slots: s,
    counters,
    memory,
    props: p,
    at: new Date().toISOString(),
  };
}
