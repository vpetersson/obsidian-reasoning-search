/** Defensive parsing of LLM output: tolerate fences, <think> blocks, prose and wrapper objects. */

export interface RerankItem {
  path: string;
  score: number;
  reason: string;
  /** Candidate number from the prompt, when the model echoes it back. */
  id?: number;
}

export function stripNoise(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```[a-z]*\s*$/gim, "")
    .trim();
}

/** Find the first balanced JSON object or array in text, respecting strings. */
function firstBalanced(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse the JSON payload from a model reply. Throws if there is none. */
export function extractJson(raw: string): unknown {
  const text = stripNoise(raw);
  try {
    return JSON.parse(text);
  } catch {
    const balanced = firstBalanced(text);
    if (balanced) return JSON.parse(balanced);
    throw new Error(`No JSON found in model reply: ${text.slice(0, 120)}`);
  }
}

/** Pull the list out of `[...]`, `{"results": [...]}`, or any object with a single array property. */
function unwrapList(value: unknown, preferredKeys: string[]): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const key of preferredKeys) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) return v;
  }
  return null;
}

export function parseQueries(raw: string, max = 5): string[] {
  let list: unknown[] | null = null;
  try {
    list = unwrapList(extractJson(raw), ["queries", "keywords", "searches"]);
  } catch {
    // Not JSON: accept one query per line, minus bullets and numbering.
    list = stripNoise(raw)
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["']|["'],?$/g, ""));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list ?? []) {
    const q = (typeof item === "string" ? item : typeof item === "object" && item ? String((item as Record<string, unknown>).query ?? "") : "").trim();
    if (!q || q.length > 200 || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

function toScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(n)) return 0;
  const scaled = n > 0 && n <= 1 && !Number.isInteger(n) ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

function toItem(value: unknown): RerankItem | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const path = obj.path ?? obj.note ?? obj.file;
  const idRaw = obj.id ?? obj.n ?? obj.index;
  const id = typeof idRaw === "number" ? idRaw : Number.parseInt(String(idRaw ?? ""), 10);
  if (typeof path !== "string" && !Number.isFinite(id)) return null;
  return {
    path: typeof path === "string" ? path.trim() : "",
    score: toScore(obj.score ?? obj.relevance),
    reason: typeof obj.reason === "string" ? obj.reason.trim() : "",
    ...(Number.isFinite(id) ? { id } : {}),
  };
}

export function parseRerank(raw: string): RerankItem[] {
  let list: unknown[] | null = null;
  try {
    const value = extractJson(raw);
    list = unwrapList(value, ["results", "ranking", "items", "notes", "candidates"]);
    if (!list && value && typeof value === "object") list = [value];
  } catch {
    // Truncated reply (hit max_tokens): salvage every complete flat object.
    list = [];
    for (const m of stripNoise(raw).matchAll(/\{[^{}]*\}/g)) {
      try {
        list.push(JSON.parse(m[0]));
      } catch {
        // skip
      }
    }
    if (list.length === 0) throw new Error(`Could not parse rerank reply: ${raw.slice(0, 120)}`);
  }
  return (list ?? []).map(toItem).filter((x): x is RerankItem => x !== null);
}
