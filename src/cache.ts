import { createHash } from "node:crypto";

/**
 * Proxy-layer response cache.
 *
 * An identical repeated request is answered from memory and never reaches the engine. The
 * cache is a pure in-process LRU with a TTL, so it can be dropped into the gateway without
 * touching disk or the database.
 */

/** A cached response together with its bookkeeping. */
export interface CacheEntry {
  key: string;
  value: unknown;
  /** Epoch milliseconds when the entry was stored. */
  createdAt: number;
  /** Epoch milliseconds after which the entry is considered expired. */
  expiresAt: number;
  /** Number of times the entry was served from the cache. */
  hits: number;
}

/** The logical shape of a request that can be cached. */
export interface CacheKeyParts {
  model?: string;
  protocol?: string;
  messages?: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  grammar?: string;
  extra?: unknown;
}

/** Options accepted by {@link ResponseCache}. */
export interface ResponseCacheOptions {
  /** Maximum number of live entries. Defaults to 500. */
  maxEntries?: number;
  /** Default time to live in milliseconds. Defaults to 300000 (5 minutes). */
  ttlMs?: number;
  /** Clock used for expiry checks. Injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Counters describing the cache state. */
export interface CacheStats {
  entries: number;
  maxEntries: number;
  hits: number;
  misses: number;
  /** hits / (hits + misses), or 0 when no lookup happened yet. */
  hitRate: number;
  /** Approximate size of the cached values in bytes. */
  bytes?: number;
}

/** Default maximum number of entries. */
export const DEFAULT_MAX_ENTRIES = 500;
/** Default time to live: five minutes. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Canonical value forms.
 *
 * Every value is encoded as a tagged pair whose first element names its type. Tagging is
 * what makes the encoding collision free: a plain object can never be encoded as a plain
 * object-with-a-tag, because a plain object always becomes a `["rec", ...]` node. Without the
 * tags, a `Date` and a `Map` would both degrade to `{}` and two different payloads would
 * hash to the same cache key.
 */
type Canonical =
  | ["u"]
  | ["z"]
  | ["b", boolean]
  | ["n", number]
  | ["nf", string]
  | ["s", string]
  | ["big", string]
  | ["sym", string]
  | ["fn", string]
  | ["a", Canonical[]]
  | ["rec", Record<string, Canonical>]
  | ["date", string]
  | ["regexp", string, string]
  | ["map", [Canonical, Canonical][]]
  | ["set", Canonical[]]
  | ["error", string, string]
  | ["bytes", string]
  | ["class", string, Record<string, Canonical>];

/**
 * Builds the own-key record of an object. The record has a null prototype, so a key named
 * `__proto__` becomes a normal own property instead of mutating the prototype and silently
 * disappearing from the serialized form.
 */
function canonicalRecord(source: Record<string, unknown>): Record<string, Canonical> {
  const out: Record<string, Canonical> = Object.create(null) as Record<string, Canonical>;
  for (const key of Object.keys(source).sort()) {
    out[key] = canonicalize(source[key]);
  }
  return out;
}

/**
 * Canonicalizes a value for hashing.
 *
 * - object keys are sorted, recursively
 * - arrays keep their order
 * - `undefined` and `null` stay distinguishable
 * - `Date`, `RegExp`, `Map`, `Set`, `Error`, byte views and class instances are encoded by
 *   value, so two different instances never collapse into the same form
 */
function canonicalize(value: unknown): Canonical {
  if (value === undefined) return ["u"];
  if (value === null) return ["z"];

  const type = typeof value;
  if (type === "boolean") return ["b", value as boolean];
  if (type === "number") {
    const num = value as number;
    if (!Number.isFinite(num)) return ["nf", String(num)];
    return ["n", num];
  }
  if (type === "string") return ["s", value as string];
  if (type === "bigint") return ["big", (value as bigint).toString()];
  if (type === "symbol") return ["sym", (value as symbol).description ?? ""];
  if (type === "function") return ["fn", (value as { name?: string }).name ?? ""];

  const source = value as object;
  if (Array.isArray(value)) return ["a", value.map((item) => canonicalize(item))];
  if (value instanceof Date) {
    return ["date", Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString()];
  }
  if (value instanceof RegExp) return ["regexp", value.source, value.flags];
  if (value instanceof Map) {
    const entries: [Canonical, Canonical][] = [];
    for (const [key, item] of value.entries()) entries.push([canonicalize(key), canonicalize(item)]);
    return ["map", entries];
  }
  if (value instanceof Set) {
    const items: Canonical[] = [];
    for (const item of value.values()) items.push(canonicalize(item));
    return ["set", items];
  }
  if (value instanceof Error) return ["error", value.name, value.message];
  if (value instanceof ArrayBuffer) {
    return ["bytes", Buffer.from(value).toString("base64")];
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return ["bytes", Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64")];
  }

  const proto = Object.getPrototypeOf(source);
  if (proto === Object.prototype || proto === null) {
    return ["rec", canonicalRecord(source as Record<string, unknown>)];
  }
  // A class instance is encoded by its constructor name plus its own keys, so it cannot
  // silently degrade into an empty record.
  const ctor = (source as { constructor?: { name?: string } }).constructor;
  return ["class", ctor?.name ?? "Object", canonicalRecord(source as Record<string, unknown>)];
}

/**
 * Builds the canonical payload of a request. The key order is fixed and alphabetical so the
 * serialized form only depends on the logical content, never on property insertion order.
 */
function canonicalPayload(parts: CacheKeyParts): Record<string, Canonical> {
  return {
    extra: canonicalize(parts.extra),
    grammar: canonicalize(parts.grammar),
    maxTokens: canonicalize(parts.maxTokens),
    messages: canonicalize(parts.messages),
    model: canonicalize(parts.model),
    protocol: canonicalize(parts.protocol),
    stream: canonicalize(parts.stream),
    temperature: canonicalize(parts.temperature),
  };
}

/**
 * Stable SHA-256 hex digest of a request.
 *
 * Two requests with the same logical content always produce the same key, and any meaningful
 * difference (model, protocol, message content or order, temperature, maxTokens, streaming,
 * grammar or extra payload) produces a different key.
 *
 * The canonical form is type tagged, so two payloads that differ only in their runtime type
 * cannot collide either: a `Date` never hashes like a plain record, and a payload that
 * carries a `__proto__` key keeps that key instead of losing it.
 */
export function cacheKey(parts: CacheKeyParts): string {
  const payload = JSON.stringify(canonicalPayload(parts));
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * An LRU cache with per-entry TTL.
 *
 * The insertion order of the internal map is the LRU order: the first key is the least
 * recently used entry, the last key is the most recently used one.
 */
export class ResponseCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(opts: ResponseCacheOptions = {}) {
    const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxEntries = maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Returns the entry for a key, or null when it is missing or expired.
   *
   * A hit increments the entry counter and the class counters, and slides the entry to the
   * most-recently-used end of the LRU order.
   */
  get(key: string): CacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.misses += 1;
      return null;
    }
    entry.hits += 1;
    this.hits += 1;
    // Re-insert to move the key to the end of the LRU order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /** Stores a value, honouring the per-entry ttl override and the LRU bound. */
  set(key: string, value: unknown, ttlMs?: number): void {
    const createdAt = this.now();
    const ttl = ttlMs ?? this.ttlMs;
    const entry: CacheEntry = {
      key,
      value,
      createdAt,
      expiresAt: createdAt + ttl,
      hits: 0,
    };
    // Replacing an existing key resets its age and its hit counter.
    this.entries.delete(key);
    this.entries.set(key, entry);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** True when a live (non-expired) entry exists for the key. */
  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    return entry.expiresAt > this.now();
  }

  /** Removes an entry. Returns true when a key was removed. */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * Drops every entry. The hit and miss counters stay cumulative — they measure the cache
   * over its lifetime, so only a new instance starts from zero.
   */
  clear(): void {
    this.entries.clear();
  }

  /** Removes every expired entry and returns how many were removed. */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Counters describing the cache state. */
  stats(): CacheStats {
    const lookups = this.hits + this.misses;
    let bytes = 0;
    for (const entry of this.entries.values()) {
      bytes += entry.key.length;
      try {
        bytes += JSON.stringify(entry.value)?.length ?? 0;
      } catch {
        // A value that cannot be serialized simply contributes no bytes.
      }
    }
    return {
      entries: this.entries.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      hitRate: lookups === 0 ? 0 : this.hits / lookups,
      bytes,
    };
  }
}
