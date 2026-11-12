import assert from "node:assert/strict";
import test from "node:test";
import { ResponseCache, cacheKey } from "../src/cache.ts";
import type { CacheKeyParts } from "../src/cache.ts";
import { LocalIndex, defaultTokenizer } from "../src/retrieval.ts";
import type { IndexDocument } from "../src/retrieval.ts";

/**
 * Two capabilities are pinned here:
 *
 * 1. the local in-memory index — a large corpus stays in the proxy and only the matching
 *    records are handed to the model,
 * 2. the proxy layer cache — an identical repeated request never reaches the engine.
 */

// ---------------------------------------------------------------------------------------
// LocalIndex
// ---------------------------------------------------------------------------------------

test("search returns the relevant document with a higher score than an unrelated one", () => {
  const index = new LocalIndex();
  index.upsert({ id: "a", text: "gateway caches repeated requests" });
  index.upsert({ id: "b", text: "gateway forwards requests upstream" });

  const hits = index.search("gateway caches");
  assert.equal(hits.length, 2);

  const relevant = hits.find((hit) => hit.doc.id === "a");
  const unrelated = hits.find((hit) => hit.doc.id === "b");
  assert.ok(relevant);
  assert.ok(unrelated);
  assert.ok(relevant.score > unrelated.score);
  assert.ok(relevant.score > 0);
});

test("a document that shares no term with the query is not returned", () => {
  const index = new LocalIndex();
  index.upsert({ id: "a", text: "llama server restart procedure" });
  index.upsert({ id: "b", text: "chocolate cake recipe" });

  const hits = index.search("llama server");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.doc.id, "a");
});

test("the default search limit is 2 and an explicit limit is honoured", () => {
  const index = new LocalIndex();
  for (const id of ["a", "b", "c", "d"]) {
    index.upsert({ id, text: `gateway ${id} handles the llama server request` });
  }

  assert.equal(index.search("gateway").length, 2);
  assert.equal(index.search("gateway", 1).length, 1);
  assert.equal(index.search("gateway", 4).length, 4);
  assert.equal(index.search("gateway", 0).length, 0);
});

test("remove drops a document and clear drops everything", () => {
  const index = new LocalIndex();
  index.upsert({ id: "a", text: "alpha beta gamma" });
  index.upsert({ id: "b", text: "beta delta" });
  assert.equal(index.size(), 2);

  assert.equal(index.remove("a"), true);
  assert.equal(index.remove("a"), false);
  assert.equal(index.size(), 1);
  assert.equal(index.search("alpha").length, 0);
  assert.equal(index.search("beta").length, 1);

  index.clear();
  assert.equal(index.size(), 0);
  assert.equal(index.search("beta").length, 0);
  assert.deepEqual(index.stats(), { docs: 0, tokens: 0, postings: 0 });
});

test("re-upserting an id replaces the old postings instead of doubling them", () => {
  const index = new LocalIndex();
  index.upsert({ id: "a", text: "alpha beta" });
  index.upsert({ id: "a", text: "gamma delta" });

  assert.equal(index.size(), 1);
  assert.equal(index.search("alpha").length, 0);
  assert.equal(index.search("gamma").length, 1);
  assert.equal(index.stats().postings, 2);
});

test("the default tokenizer drops stopwords and short tokens", () => {
  assert.deepEqual(defaultTokenizer("The quick brown fox"), ["quick", "brown", "fox"]);
  assert.deepEqual(defaultTokenizer("a of the and it"), []);
  assert.deepEqual(defaultTokenizer("x y z alpha"), ["alpha"]);
  assert.deepEqual(defaultTokenizer(""), []);
});

test("an injectable tokenizer is honoured", () => {
  const split = (text: string): string[] => text.split(/\s+/).filter((token) => token.length > 0);
  const index = new LocalIndex({ tokenize: split });
  index.upsert({ id: "a", text: "x y" });
  index.upsert({ id: "b", text: "alpha beta" });

  // "x" is dropped by the default tokenizer but kept by the injected one.
  assert.equal(index.search("x").length, 1);
  assert.equal(index.search("x")[0]?.doc.id, "a");
  assert.equal(index.stats().tokens, 4);
});

test("BM25 scoring is deterministic and ranks by score", () => {
  const index = new LocalIndex();
  index.upsert({ id: "a", text: "server token budget" });
  index.upsert({ id: "b", text: "server token budget server token budget" });
  index.upsert({ id: "c", text: "server token budget extra" });

  const first = index.search("server token budget", 3);
  const second = index.search("server token budget", 3);
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);

  for (let i = 1; i < first.length; i += 1) {
    assert.ok((first[i - 1]?.score ?? 0) >= (first[i]?.score ?? 0));
  }
  // A term that repeats in the document raises its term frequency.
  assert.equal(first[0]?.doc.id, "b");
});

test("stats reports documents, tokens and postings", () => {
  const index = new LocalIndex();
  index.upsert({ id: "a", text: "alpha alpha beta" });
  index.upsert({ id: "b", text: "beta gamma" });

  const stats = index.stats();
  assert.equal(stats.docs, 2);
  assert.equal(stats.tokens, 5);
  assert.equal(stats.postings, 4);
});

test("the index holds a 30000 document corpus and finds a rare term through its posting list", (t) => {
  const index = new LocalIndex();
  const corpus = 30000;
  const buildStart = performance.now();
  for (let i = 0; i < corpus; i += 1) {
    index.upsert({
      id: `doc-${i}`,
      text: `record ${i} mentions the standard gateway routing and token budget rules`,
    });
  }
  const buildMs = performance.now() - buildStart;

  index.upsert({ id: "needle", text: "zeppelin quantum marker" });

  const queryStart = performance.now();
  const hits = index.search("zeppelin quantum marker");
  const queryMs = performance.now() - queryStart;

  t.diagnostic(`indexed ${corpus} documents in ${buildMs.toFixed(1)}ms, query took ${queryMs.toFixed(1)}ms`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.doc.id, "needle");
  assert.equal(index.size(), corpus + 1);

  // A common term still resolves, and the scan stays proportional to the posting list.
  const commonStart = performance.now();
  const common = index.search("gateway routing");
  const commonMs = performance.now() - commonStart;
  t.diagnostic(`common-term query over ${corpus} documents took ${commonMs.toFixed(1)}ms`);
  assert.equal(common.length, 2);
});

test("maxDocs evicts the oldest document when the corpus grows past the bound", () => {
  const index = new LocalIndex({ maxDocs: 2 });
  index.upsert({ id: "a", text: "alpha" });
  index.upsert({ id: "b", text: "beta" });
  index.upsert({ id: "c", text: "gamma" });

  assert.equal(index.size(), 2);
  assert.equal(index.search("alpha").length, 0);
  assert.equal(index.search("gamma").length, 1);
});

// ---------------------------------------------------------------------------------------
// ResponseCache
// ---------------------------------------------------------------------------------------

test("get returns null on a miss", () => {
  const cache = new ResponseCache();
  assert.equal(cache.get("missing"), null);
  assert.equal(cache.stats().misses, 1);
  assert.equal(cache.stats().hits, 0);
});

test("set and get returns the stored value", () => {
  const cache = new ResponseCache();
  cache.set("k", { answer: 42 });
  const entry = cache.get("k");
  assert.ok(entry);
  assert.deepEqual(entry.value, { answer: 42 });
  assert.equal(entry.key, "k");
  assert.equal(entry.hits, 1);
});

test("a hit increments the entry counter and the stats counter", () => {
  const cache = new ResponseCache();
  cache.set("k", "v");
  cache.get("k");
  cache.get("k");

  assert.equal(cache.get("k")?.hits, 3);
  assert.equal(cache.stats().hits, 3);
  assert.equal(cache.stats().misses, 0);
  assert.equal(cache.stats().entries, 1);
});

test("an expired entry returns null", () => {
  let clock = 0;
  const cache = new ResponseCache({ ttlMs: 1000, now: () => clock });
  cache.set("k", "v");

  clock = 999;
  assert.ok(cache.get("k"));

  clock = 1000;
  assert.equal(cache.get("k"), null);
  assert.equal(cache.stats().entries, 0);
});

test("LRU eviction drops the oldest entry once maxEntries is reached", () => {
  const cache = new ResponseCache({ maxEntries: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);

  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.get("a"), null);
  assert.ok(cache.get("b"));
  assert.ok(cache.get("c"));
});

test("a get slides an entry to the most recently used end of the LRU order", () => {
  const cache = new ResponseCache({ maxEntries: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a");
  cache.set("c", 3);

  assert.ok(cache.get("a"));
  assert.equal(cache.get("b"), null);
  assert.ok(cache.get("c"));
});

test("a per-entry ttl override wins over the default ttl", () => {
  let clock = 0;
  const cache = new ResponseCache({ ttlMs: 100, now: () => clock });
  cache.set("short", "v");
  cache.set("long", "v", 1000);

  clock = 200;
  assert.equal(cache.get("short"), null);
  assert.ok(cache.get("long"));

  clock = 1000;
  assert.equal(cache.get("long"), null);
});

test("hitRate is hits over total lookups", () => {
  const cache = new ResponseCache();
  assert.equal(cache.stats().hitRate, 0);

  cache.set("k", "v");
  cache.get("k");
  cache.get("k");
  cache.get("miss");

  const stats = cache.stats();
  assert.equal(stats.hits, 2);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRate, 2 / 3);
});

test("has, delete and clear work", () => {
  let clock = 0;
  const cache = new ResponseCache({ ttlMs: 100, now: () => clock });
  cache.set("k", "v");

  assert.equal(cache.has("k"), true);
  assert.equal(cache.has("other"), false);
  assert.equal(cache.delete("k"), true);
  assert.equal(cache.delete("k"), false);
  assert.equal(cache.has("k"), false);

  cache.set("a", 1);
  cache.set("b", 2);
  cache.clear();
  assert.equal(cache.stats().entries, 0);
});

test("prune removes expired entries and reports how many were removed", () => {
  let clock = 0;
  const cache = new ResponseCache({ ttlMs: 100, now: () => clock });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3, 1000);

  clock = 200;
  assert.equal(cache.prune(), 2);
  assert.equal(cache.stats().entries, 1);
  assert.ok(cache.get("c"));
  assert.equal(cache.prune(), 0);
});

// ---------------------------------------------------------------------------------------
// cacheKey
// ---------------------------------------------------------------------------------------

const baseRequest: CacheKeyParts = {
  model: "lama-3.1-8b",
  protocol: "openai",
  messages: [
    { role: "system", content: "You are lama." },
    { role: "user", content: "Summarize the gateway log." },
  ],
  temperature: 0.2,
  maxTokens: 256,
  stream: false,
};

test("the cache key is stable for the same logical request", () => {
  const first = cacheKey(baseRequest);
  const second = cacheKey({ ...baseRequest });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("the cache key does not depend on the property insertion order", () => {
  const shuffled: CacheKeyParts = {
    stream: false,
    maxTokens: 256,
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are lama." },
      { role: "user", content: "Summarize the gateway log." },
    ],
    protocol: "openai",
    model: "lama-3.1-8b",
  };
  assert.equal(cacheKey(shuffled), cacheKey(baseRequest));
});

test("the cache key differs for every meaningful variation", () => {
  const base = cacheKey(baseRequest);
  const variants: Array<[string, CacheKeyParts]> = [
    ["model", { ...baseRequest, model: "lama-3.1-70b" }],
    ["protocol", { ...baseRequest, protocol: "anthropic" }],
    ["temperature", { ...baseRequest, temperature: 0.7 }],
    ["maxTokens", { ...baseRequest, maxTokens: 512 }],
    ["stream", { ...baseRequest, stream: true }],
    ["grammar", { ...baseRequest, grammar: "root ::= \"yes\"" }],
    ["message content", { ...baseRequest, messages: [{ role: "user", content: "Summarize the gateway log." }] }],
    [
      "message order",
      {
        ...baseRequest,
        messages: [
          { role: "user", content: "Summarize the gateway log." },
          { role: "system", content: "You are lama." },
        ],
      },
    ],
    ["extra", { ...baseRequest, extra: { tools: ["read_file"] } }],
  ];

  for (const [label, variant] of variants) {
    assert.notEqual(cacheKey(variant), base, `${label} must produce a different key`);
  }
});

test("an absent field and a present field are different keys", () => {
  const withoutTemperature: CacheKeyParts = { model: "lama-3.1-8b" };
  assert.notEqual(cacheKey(withoutTemperature), cacheKey({ model: "lama-3.1-8b", temperature: 0 }));
  assert.notEqual(cacheKey(withoutTemperature), cacheKey({ model: "lama-3.1-8b", temperature: 0.2 }));
  assert.notEqual(cacheKey(withoutTemperature), cacheKey({ model: "lama-3.1-8b", grammar: "" }));
  assert.notEqual(cacheKey(withoutTemperature), cacheKey({ model: "lama-3.1-8b", stream: false }));
});

test("the cache key ignores the order of the keys inside an extra payload", () => {
  const first = cacheKey({ ...baseRequest, extra: { a: 1, b: { c: 2, d: 3 } } });
  const second = cacheKey({ ...baseRequest, extra: { b: { d: 3, c: 2 }, a: 1 } });
  assert.equal(first, second);
});

test("distinct extra payloads never collide", () => {
  const withProto = (value: unknown): Record<string, unknown> =>
    Object.defineProperty({}, "__proto__", { value, enumerable: true });

  const pairs: Array<[unknown, unknown]> = [
    [new Date(0), new Date(86400000)],
    [new Map([["a", 1]]), new Map([["a", 2]])],
    [new Set([1]), new Set([2])],
    [withProto({ x: 1 }), withProto({ x: 2 })],
    [{ a: 1 }, { a: "1" }],
    [[1], ["1"]],
    [null, undefined],
  ];

  for (const [left, right] of pairs) {
    assert.notEqual(
      cacheKey({ ...baseRequest, extra: left }),
      cacheKey({ ...baseRequest, extra: right }),
      `payloads must not collide: ${String(left)} vs ${String(right)}`,
    );
  }
});

test("a __proto__ key survives the canonicalization", () => {
  const withProto = (value: unknown): Record<string, unknown> =>
    Object.defineProperty({}, "__proto__", { value, enumerable: true });

  assert.notEqual(
    cacheKey({ ...baseRequest, extra: withProto({ x: 1 }) }),
    cacheKey({ ...baseRequest, extra: withProto({ x: 2 }) }),
  );
  // The same payload keeps the same key.
  assert.equal(
    cacheKey({ ...baseRequest, extra: withProto({ x: 1 }) }),
    cacheKey({ ...baseRequest, extra: withProto({ x: 1 }) }),
  );
});

// ---------------------------------------------------------------------------------------
// The two capabilities together
// ---------------------------------------------------------------------------------------

test("a repeated request is answered from the cache and the corpus stays local", () => {
  const corpus: IndexDocument[] = Array.from({ length: 5000 }, (_, i) => ({
    id: `doc-${i}`,
    text: `record ${i} about gateway routing rules`,
    meta: { i },
  }));

  const index = new LocalIndex();
  for (const doc of corpus) index.upsert(doc);

  const cache = new ResponseCache();
  const request: CacheKeyParts = { model: "lama-3.1-8b", messages: [{ role: "user", content: "routing" }] };

  let engineCalls = 0;
  const ask = (): string => {
    const key = cacheKey(request);
    const hit = cache.get(key);
    if (hit) return hit.value as string;
    engineCalls += 1;
    const context = index.search("routing", 2).map((hit) => hit.doc.text).join("\n");
    const answer = `answer:${context.length}`;
    cache.set(key, answer);
    return answer;
  };

  const first = ask();
  const second = ask();
  assert.equal(first, second);
  assert.equal(engineCalls, 1);
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 1);
});
