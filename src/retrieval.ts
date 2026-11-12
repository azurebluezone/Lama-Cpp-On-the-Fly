/**
 * Local in-memory index and retrieval.
 *
 * The point of this module is that a large corpus (tens of thousands of records) never has to
 * be pushed into the model. The corpus lives in the proxy, is tokenized once, and is kept in an
 * inverted index. When a request arrives only the one or two records that actually match are
 * handed to the engine.
 *
 * Retrieval is pure local work: tokenize the query, walk the posting lists of the query terms
 * and score the touched documents with BM25. There is no model round-trip and no I/O.
 */

/** A single indexed record. */
export interface IndexDocument {
  id: string;
  text: string;
  meta?: Record<string, unknown>;
}

/** A scored search result. */
export interface SearchHit {
  doc: IndexDocument;
  score: number;
}

/** Aggregate counters of the index. */
export interface IndexStats {
  /** Number of stored documents. */
  docs: number;
  /** Total number of tokens indexed (sum of document lengths). */
  tokens: number;
  /** Number of (token, document) pairs held in the inverted index. */
  postings: number;
}

/** Splits a text into index terms. */
export type Tokenizer = (text: string) => string[];

/** Options accepted by {@link LocalIndex}. */
export interface LocalIndexOptions {
  /** Maximum number of documents kept in the index. Defaults to 50000. */
  maxDocs?: number;
  /** Tokenizer used for both documents and queries. Defaults to {@link defaultTokenizer}. */
  tokenize?: Tokenizer;
}

/** BM25 term-frequency saturation parameter. */
export const BM25_K1 = 1.2;
/** BM25 length-normalization parameter. */
export const BM25_B = 0.75;
/** Default number of documents returned by {@link LocalIndex.search}. */
export const DEFAULT_SEARCH_LIMIT = 2;
/** Default upper bound on the number of indexed documents. */
export const DEFAULT_MAX_DOCS = 50000;

/**
 * Small English stopword list. Keeping it small matters: aggressive stopword removal hurts
 * recall on short queries, and the owner wants a retrieval step that is predictable.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "no",
  "not",
  "of",
  "on",
  "or",
  "such",
  "than",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

/**
 * Default tokenizer: lowercase, split on non-alphanumeric characters, drop terms shorter than
 * two characters and drop a small English stopword list. Unicode aware, so non-latin scripts
 * are tokenized instead of being silently discarded.
 */
export function defaultTokenizer(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** Internal per-document bookkeeping. */
interface DocRecord {
  doc: IndexDocument;
  /** Total number of tokens in the document (with repetitions). */
  length: number;
  /** Unique terms of the document, used to unlink postings on removal. */
  terms: string[];
}

/**
 * An inverted index over a local corpus with BM25 ranking.
 *
 * The index is a `Map<token, Map<docId, termFrequency>>`. A query only touches the posting
 * lists of its own terms, so the cost of a lookup is proportional to the number of documents
 * that actually mention the query terms, not to the size of the corpus.
 *
 * Terms are matched exactly: there is no stemming, no lemmatization and no fuzzy matching.
 * A query therefore has to use the same words as the corpus, which keeps the module free of
 * dependencies and its scores reproducible.
 */
export class LocalIndex {
  private readonly maxDocs: number;
  private readonly tokenize: Tokenizer;
  private readonly docs = new Map<string, DocRecord>();
  private readonly postings = new Map<string, Map<string, number>>();
  private totalTokens = 0;
  private postingCount = 0;

  constructor(opts: LocalIndexOptions = {}) {
    const maxDocs = opts.maxDocs ?? DEFAULT_MAX_DOCS;
    this.maxDocs = maxDocs > 0 ? Math.floor(maxDocs) : DEFAULT_MAX_DOCS;
    this.tokenize = opts.tokenize ?? defaultTokenizer;
  }

  /**
   * Stores a document and refreshes its postings. Re-upserting an existing id replaces the
   * previous text and its postings. When the corpus grows past `maxDocs` the oldest document
   * is dropped.
   */
  upsert(doc: IndexDocument): void {
    if (this.docs.has(doc.id)) this.remove(doc.id);

    const tokens = this.tokenize(doc.text);
    const terms: string[] = [];
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      const seen = frequencies.get(token);
      if (seen === undefined) {
        frequencies.set(token, 1);
        terms.push(token);
      } else {
        frequencies.set(token, seen + 1);
      }
    }

    this.docs.set(doc.id, { doc, length: tokens.length, terms });
    this.totalTokens += tokens.length;

    for (const term of terms) {
      const posting = this.postings.get(term);
      if (posting) {
        posting.set(doc.id, frequencies.get(term) ?? 1);
      } else {
        const created = new Map<string, number>();
        created.set(doc.id, frequencies.get(term) ?? 1);
        this.postings.set(term, created);
      }
    }
    this.postingCount += terms.length;

    while (this.docs.size > this.maxDocs) {
      const oldest = this.docs.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
  }

  /** Removes a document and its postings. Returns true when the document existed. */
  remove(id: string): boolean {
    const record = this.docs.get(id);
    if (!record) return false;

    for (const term of record.terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      posting.delete(id);
      if (posting.size === 0) this.postings.delete(term);
    }
    this.postingCount -= record.terms.length;
    this.totalTokens -= record.length;
    this.docs.delete(id);
    return true;
  }

  /** Drops every document and posting. */
  clear(): void {
    this.docs.clear();
    this.postings.clear();
    this.totalTokens = 0;
    this.postingCount = 0;
  }

  /** Number of indexed documents. */
  size(): number {
    return this.docs.size;
  }

  /**
   * BM25 search over the posting lists of the query terms.
   *
   * Score of a document `d` for query term `t`:
   *
   *   idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
   *   score  = idf(t) * (tf(t,d) * (k1 + 1)) / (tf(t,d) + k1 * (1 - b + b * dl(d) / avgdl))
   *
   * with k1 = 1.2, b = 0.75, `dl(d)` the document length and `avgdl` the mean document length.
   * Repeated query terms count once, which is the standard BM25 assumption.
   */
  search(query: string, limit: number = DEFAULT_SEARCH_LIMIT): SearchHit[] {
    const n = this.docs.size;
    if (n === 0 || limit <= 0) return [];

    const queryTerms = new Set<string>();
    for (const token of this.tokenize(query)) queryTerms.add(token);
    if (queryTerms.size === 0) return [];

    const avgdl = this.totalTokens / n || 1;
    const scores = new Map<string, number>();

    for (const term of queryTerms) {
      const posting = this.postings.get(term);
      if (!posting || posting.size === 0) continue;
      const df = posting.size;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const [docId, tf] of posting) {
        const record = this.docs.get(docId);
        if (!record) continue;
        const norm = BM25_K1 * (1 - BM25_B + (BM25_B * record.length) / avgdl);
        const contribution = idf * ((tf * (BM25_K1 + 1)) / (tf + norm));
        scores.set(docId, (scores.get(docId) ?? 0) + contribution);
      }
    }

    const ranked = [...scores.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

    const hits: SearchHit[] = [];
    for (const [docId, score] of ranked) {
      if (hits.length >= limit) break;
      const record = this.docs.get(docId);
      if (!record) continue;
      hits.push({ doc: record.doc, score });
    }
    return hits;
  }

  /** Counters describing the current index state. */
  stats(): IndexStats {
    return { docs: this.docs.size, tokens: this.totalTokens, postings: this.postingCount };
  }
}
