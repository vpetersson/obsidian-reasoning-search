import type { Chunk } from "./chunker";
import { tokenize } from "./tokenize";

export interface Hit {
  chunk: Chunk;
  score: number;
}

interface Doc {
  chunk: Chunk;
  length: number;
  terms: Map<string, number>;
}

/**
 * In-memory BM25 inverted index over note chunks. Title and heading tokens are
 * counted twice so a query that names a note ranks it above passing mentions.
 */
export class Bm25Index {
  private docs = new Map<number, Doc>();
  private postings = new Map<string, Map<number, number>>();
  private byPath = new Map<string, number[]>();
  private nextId = 0;
  private totalLength = 0;

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  get chunkCount(): number {
    return this.docs.size;
  }

  get noteCount(): number {
    return this.byPath.size;
  }

  clear(): void {
    this.docs.clear();
    this.postings.clear();
    this.byPath.clear();
    this.totalLength = 0;
  }

  /** Replace all chunks for a note. */
  setNote(path: string, chunks: Chunk[]): void {
    this.removeNote(path);
    const ids: number[] = [];
    for (const chunk of chunks) {
      const tokens = [
        ...tokenize(chunk.title),
        ...tokenize(chunk.title),
        ...tokenize(chunk.heading ?? ""),
        ...tokenize(chunk.heading ?? ""),
        ...tokenize(chunk.text),
      ];
      if (tokens.length === 0) continue;
      const terms = new Map<string, number>();
      for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
      const id = this.nextId++;
      this.docs.set(id, { chunk, length: tokens.length, terms });
      this.totalLength += tokens.length;
      for (const [term, tf] of terms) {
        let list = this.postings.get(term);
        if (!list) this.postings.set(term, (list = new Map()));
        list.set(id, tf);
      }
      ids.push(id);
    }
    if (ids.length) this.byPath.set(path, ids);
  }

  removeNote(path: string): void {
    const ids = this.byPath.get(path);
    if (!ids) return;
    for (const id of ids) {
      const doc = this.docs.get(id);
      if (!doc) continue;
      for (const term of doc.terms.keys()) {
        const list = this.postings.get(term);
        list?.delete(id);
        if (list?.size === 0) this.postings.delete(term);
      }
      this.totalLength -= doc.length;
      this.docs.delete(id);
    }
    this.byPath.delete(path);
  }

  search(query: string, limit = 20): Hit[] {
    const n = this.docs.size;
    if (n === 0) return [];
    const avgLength = this.totalLength / n;
    const scores = new Map<number, number>();
    for (const term of new Set(tokenize(query))) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.size + 0.5) / (list.size + 0.5));
      for (const [id, tf] of list) {
        const doc = this.docs.get(id);
        if (!doc) continue;
        const norm = tf + this.k1 * (1 - this.b + (this.b * doc.length) / avgLength);
        scores.set(id, (scores.get(id) ?? 0) + (idf * (tf * (this.k1 + 1))) / norm);
      }
    }
    const hits: Hit[] = [];
    for (const [id, score] of scores) {
      const doc = this.docs.get(id);
      if (doc) hits.push({ chunk: doc.chunk, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}
