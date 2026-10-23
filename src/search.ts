import type { Bm25Index, Hit } from "./bm25";
import type { Chunk } from "./chunker";
import { EndpointUnreachableError, type LlmClient, ModelNotFoundError } from "./llm";
import { parseQueries, parseRerank, type RerankItem } from "./parse";
import { expansionMessages, planRerank, rerankMessages } from "./prompts";

export type Stage = "expanding" | "retrieving" | "reranking";

export interface SearchResult {
  chunk: Chunk;
  /** 0-100. LLM relevance, or BM25 normalised against the best hit in fallback mode. */
  score: number;
  reason: string;
  source: "llm" | "bm25";
}

export interface SearchOutcome {
  results: SearchResult[];
  /** Keyword queries actually run against the index (the question first). */
  queries: string[];
  /** Set when the LLM failed and we fell back to BM25. */
  fallback?: { message: string; error: unknown };
}

export interface SearchOptions {
  index: Bm25Index;
  llm: LlmClient;
  candidateCount: number;
  fallbackToBm25: boolean;
  onStage?: (stage: Stage) => void;
}

export interface Candidate extends Hit {
  /** Every chunk of this note that matched any query, best first; the rerank excerpt draws on all of them. */
  matched: Chunk[];
}

/**
 * Round-robin fusion: take each query's best unseen note in turn (the user's own question first)
 * until `limit` notes are chosen. Unlike score-summing fusion this guarantees every query's top
 * hits reach the reranker, so one good expansion can't be drowned out by noisy ones, and a strong
 * literal match on the question can't be either. Each candidate opens at its best-scoring chunk.
 */
export function fuse(hitLists: Hit[][], limit: number): Candidate[] {
  const order: string[] = [];
  const chosen = new Set<string>();
  const cursors = hitLists.map(() => 0);
  let progressed = true;
  while (order.length < limit && progressed) {
    progressed = false;
    for (const [i, hits] of hitLists.entries()) {
      if (order.length >= limit) break;
      for (let at = cursors[i] ?? 0; at < hits.length; at = cursors[i] ?? hits.length) {
        cursors[i] = at + 1;
        const path = hits[at]!.chunk.path;
        progressed = true;
        if (chosen.has(path)) continue;
        chosen.add(path);
        order.push(path);
        break;
      }
    }
  }
  // Collect every matched chunk of the chosen notes, across all queries.
  const chunks = new Map<string, Map<Chunk, number>>();
  for (const hits of hitLists) {
    for (const hit of hits) {
      if (!chosen.has(hit.chunk.path)) continue;
      let m = chunks.get(hit.chunk.path);
      if (!m) chunks.set(hit.chunk.path, (m = new Map()));
      m.set(hit.chunk, Math.max(m.get(hit.chunk) ?? 0, hit.score));
    }
  }
  return order.map((path, rank) => {
    const matched = [...(chunks.get(path) ?? new Map<Chunk, number>()).entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    return { chunk: matched[0]!, score: limit - rank, matched };
  });
}

/** A copy of the best chunk whose text spans all matched sections, so the model sees the whole match. */
function rerankView(c: Candidate): Chunk {
  return { ...c.chunk, text: c.matched.map((m) => m.text).join("\n\n") };
}

function bm25Results(hits: Hit[]): SearchResult[] {
  const top = hits[0]?.score ?? 1;
  return hits.map((h) => ({
    chunk: h.chunk,
    score: Math.round((h.score / top) * 100),
    reason: "Keyword match",
    source: "bm25" as const,
  }));
}

function failureMessage(err: unknown): string {
  if (err instanceof EndpointUnreachableError) return `Reasoning search: can't reach LLM endpoint at ${err.url}`;
  if (err instanceof ModelNotFoundError) return `Reasoning search: ${err.message.replace(/\.$/, "")}`;
  return `Reasoning search: LLM call failed (${err instanceof Error ? err.message : String(err)})`;
}

/** Match a rerank item back to its candidate: by echoed number, then exact path, then loosely. */
export function resolveCandidate(item: RerankItem, candidates: Chunk[]): Chunk | undefined {
  const lower = item.path.toLowerCase().replace(/\.md$/, "");
  return (
    candidates.find((c) => c.path === item.path) ??
    (item.id !== undefined ? candidates[item.id - 1] : undefined) ??
    (lower
      ? candidates.find((c) => {
          const p = c.path.toLowerCase().replace(/\.md$/, "");
          return p === lower || p.endsWith(`/${lower}`) || c.title.toLowerCase() === lower;
        })
      : undefined)
  );
}

export async function reasoningSearch(question: string, opts: SearchOptions): Promise<SearchOutcome> {
  const { index, llm, candidateCount, fallbackToBm25, onStage } = opts;
  const perQuery = Math.max(candidateCount * 3, 30);

  const fallback = (err: unknown, queries: string[], hits: Hit[]): SearchOutcome => {
    if (!fallbackToBm25) throw err;
    return { results: bm25Results(hits), queries, fallback: { message: failureMessage(err), error: err } };
  };

  onStage?.("expanding");
  let expanded: string[];
  try {
    expanded = parseQueries(await llm.chat(expansionMessages(question), { maxTokens: 200, json: true }));
  } catch (err) {
    // Endpoint down or unusable: don't bother with the rerank call too.
    onStage?.("retrieving");
    return fallback(err, [question], fuse([index.search(question, perQuery)], candidateCount));
  }

  onStage?.("retrieving");
  const queries = [question, ...expanded.filter((q) => q.toLowerCase() !== question.toLowerCase())];
  const candidates = fuse(
    queries.map((q) => index.search(q, perQuery)),
    candidateCount,
  );
  if (candidates.length === 0) return { results: [], queries };

  onStage?.("reranking");
  const views = candidates.map(rerankView);
  const results: SearchResult[] = [];
  try {
    for (const batch of planRerank(question, views)) {
      const items = parseRerank(
        await llm.chat(rerankMessages(question, batch), {
          maxTokens: Math.min(1000, 60 + batch.candidates.length * 45),
          json: true,
        }),
      );
      for (const item of items) {
        const view = resolveCandidate(item, batch.candidates);
        const candidate = view && candidates[views.indexOf(view)];
        if (!candidate || results.some((r) => r.chunk.path === candidate.chunk.path)) continue;
        results.push({ chunk: candidate.chunk, score: item.score, reason: item.reason, source: "llm" });
      }
    }
  } catch (err) {
    return fallback(err, queries, candidates);
  }
  results.sort((a, b) => b.score - a.score);
  return { results, queries };
}
