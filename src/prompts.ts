import type { Chunk } from "./chunker";
import type { ChatMessage } from "./llm";

/** Conservative token estimate (~3.5 chars/token for English prose, a bit pessimistic on purpose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function expansionMessages(question: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You write keyword queries for a plain keyword search over someone's personal notes. " +
        "The note that answers the question probably uses different words than the question, so " +
        "do not just repeat the question. Use the words the note itself would contain: synonyms, " +
        "more specific technical terms, product, brand, place or people types, and concrete details. " +
        'Reply with JSON only: {"queries": [...]} with 3 to 5 queries of 1-4 words each.',
    },
    { role: "user", content: "the time my car wouldn't start in the cold" },
    {
      role: "assistant",
      content: '{"queries": ["dead battery", "jump start", "frozen engine winter", "breakdown recovery", "starter motor"]}',
    },
    { role: "user", content: question },
  ];
}

const RERANK_SYSTEM =
  "You rank candidate notes by how directly they answer the user's question. " +
  "Judge meaning, not shared words: a note about the exact event or thing asked about scores 80-100, " +
  "a merely related note scores below 50. Reply with JSON only: " +
  '{"results": [{"id": <candidate number>, "path": "<path>", "score": <0-100>, "reason": "<at most 15 words>"}]}. ' +
  "Include only candidates scoring 20 or more, best first. Return an empty list if none are relevant.";

export interface RerankBudget {
  /** Upper bound for the whole prompt; the Apple model has a ~4k token window shared with the reply. */
  maxPromptTokens: number;
  minExcerptChars: number;
  maxExcerptChars: number;
}

export const DEFAULT_BUDGET: RerankBudget = { maxPromptTokens: 3000, minExcerptChars: 280, maxExcerptChars: 1200 };

export interface RerankBatch {
  candidates: Chunk[];
  excerptChars: number;
}

function header(chunk: Chunk): string {
  return chunk.heading ? `${chunk.path} > ${chunk.heading}` : chunk.path;
}

function excerpt(chunk: Chunk, chars: number): string {
  const flat = chunk.text.replace(/\s+/g, " ").trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars).replace(/\s\S*$/, "")}…`;
}

/**
 * Split candidates into as few rerank calls as fit the token budget. With the default N=15
 * this is a single call; a larger N becomes a few batches rather than O(N²) pairwise calls.
 */
export function planRerank(question: string, candidates: Chunk[], budget: RerankBudget = DEFAULT_BUDGET): RerankBatch[] {
  if (candidates.length === 0) return [];
  const fixed = estimateTokens(RERANK_SYSTEM) + estimateTokens(question) + 40;
  const available = Math.max(200, budget.maxPromptTokens - fixed);
  const perMeta = (c: Chunk) => estimateTokens(header(c)) + 8;
  const minPer = (c: Chunk) => perMeta(c) + estimateTokens("x".repeat(budget.minExcerptChars));

  const batches: Chunk[][] = [];
  let current: Chunk[] = [];
  let used = 0;
  for (const c of candidates) {
    if (current.length > 0 && used + minPer(c) > available) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(c);
    used += minPer(c);
  }
  if (current.length) batches.push(current);

  return batches.map((batch) => {
    const meta = batch.reduce((sum, c) => sum + perMeta(c), 0);
    const perExcerptTokens = (available - meta) / batch.length;
    const chars = Math.floor(perExcerptTokens * 3.5);
    return {
      candidates: batch,
      excerptChars: Math.max(budget.minExcerptChars, Math.min(budget.maxExcerptChars, chars)),
    };
  });
}

export function rerankMessages(question: string, batch: RerankBatch): ChatMessage[] {
  const list = batch.candidates
    .map((c, i) => `[${i + 1}] ${header(c)}\n${excerpt(c, batch.excerptChars)}`)
    .join("\n\n");
  return [
    { role: "system", content: RERANK_SYSTEM },
    { role: "user", content: `Question: ${question}\n\nCandidates:\n\n${list}` },
  ];
}

export function promptTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}
