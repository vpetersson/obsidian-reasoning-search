import { describe, expect, test } from "bun:test";
import { Bm25Index } from "../src/bm25";
import { type Chunk, chunkNote } from "../src/chunker";
import { EndpointUnreachableError, type Http, LlmClient, ModelNotFoundError } from "../src/llm";
import { planRerank, promptTokens, rerankMessages } from "../src/prompts";
import { fuse, reasoningSearch, resolveCandidate } from "../src/search";

const notes: Record<string, string> = {
  "ops/Hetzner SX outage 2025-03.md":
    "# Summary\nOne of the SSDs in the SX dedicated server died and the RAID 1 array went degraded.\n" +
    "# Recovery\nOpened a ticket with Hetzner, they swapped the drive within an hour and mdadm resynced.",
  "ops/Backups.md": "# Restic\nNightly restic backups to the storage box.",
  "home/Garden.md": "Planted tomatoes and basil.",
  "work/Hosting costs.md": "# Budget\nCompare hosting providers for next year.",
};

function buildIndex(): Bm25Index {
  const idx = new Bm25Index();
  for (const [p, t] of Object.entries(notes)) idx.setNote(p, chunkNote(p, t));
  return idx;
}

/** Fake OpenAI-compatible server: answers expansion and rerank prompts by inspecting the system prompt. */
function fakeServer(handler: (system: string, user: string) => string | Error): { http: Http; calls: { body: Record<string, unknown> }[] } {
  const calls: { body: Record<string, unknown> }[] = [];
  const http: Http = async (req) => {
    const body = JSON.parse(req.body ?? "{}");
    calls.push({ body });
    const out = handler(body.messages[0].content, body.messages.at(-1)?.content ?? "");
    if (out instanceof Error) throw out;
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: out } }] }) };
  };
  return { http, calls };
}

const config = { baseUrl: "http://127.0.0.1:11434/v1/", model: "m", apiKey: "", timeoutMs: 1000 };

describe("reasoningSearch", () => {
  const question = "that disk failure on the hosting box";

  test("query expansion surfaces a note that shares no keywords with the question", async () => {
    const index = buildIndex();
    expect(index.search(question).some((h) => h.chunk.path.includes("Hetzner"))).toBe(false);

    const { http, calls } = fakeServer((system, user) => {
      if (system.includes("keyword queries")) return '{"queries": ["drive failure", "RAID degraded", "dedicated server outage"]}';
      const n = user.split("\n").findIndex((l) => l.includes("Hetzner"));
      expect(n).toBeGreaterThan(0);
      return '```json\n{"results": [{"id": 1, "path": "ops/Hetzner SX outage 2025-03.md", "score": 92, "reason": "SSD died, RAID degraded on the Hetzner server"}]}\n```';
    });
    const stages: string[] = [];
    const outcome = await reasoningSearch(question, {
      index,
      llm: new LlmClient(http, config),
      candidateCount: 15,
      fallbackToBm25: true,
      onStage: (s) => stages.push(s),
    });
    expect(stages).toEqual(["expanding", "retrieving", "reranking"]);
    expect(outcome.fallback).toBeUndefined();
    expect(outcome.queries[0]).toBe(question);
    expect(outcome.results[0]).toMatchObject({ score: 92, source: "llm", chunk: { title: "Hetzner SX outage 2025-03" } });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.response_format).toEqual({ type: "json_object" });
  });

  test("unreachable endpoint degrades to BM25 with a message naming the URL", async () => {
    const { http, calls } = fakeServer(() => new Error("ECONNREFUSED"));
    const outcome = await reasoningSearch("restic backups", {
      index: buildIndex(),
      llm: new LlmClient(http, config),
      candidateCount: 15,
      fallbackToBm25: true,
    });
    expect(calls).toHaveLength(1);
    expect(outcome.fallback?.message).toContain("http://127.0.0.1:11434/v1/chat/completions");
    expect(outcome.fallback?.error).toBeInstanceOf(EndpointUnreachableError);
    expect(outcome.results[0]).toMatchObject({ source: "bm25", score: 100, chunk: { path: "ops/Backups.md" } });
  });

  test("endpoint dying between expansion and rerank also falls back", async () => {
    let n = 0;
    const { http } = fakeServer(() => (n++ === 0 ? '{"queries": ["restic"]}' : new Error("socket hang up")));
    const outcome = await reasoningSearch("backups", { index: buildIndex(), llm: new LlmClient(http, config), candidateCount: 15, fallbackToBm25: true });
    expect(outcome.fallback).toBeDefined();
    expect(outcome.queries).toEqual(["backups", "restic"]);
    expect(outcome.results[0]?.chunk.path).toBe("ops/Backups.md");
  });

  test("with fallback disabled, the error propagates", async () => {
    const { http } = fakeServer(() => new Error("ECONNREFUSED"));
    await expect(
      reasoningSearch("x", { index: buildIndex(), llm: new LlmClient(http, config), candidateCount: 15, fallbackToBm25: false }),
    ).rejects.toBeInstanceOf(EndpointUnreachableError);
  });

  test("timeout counts as unreachable", async () => {
    const http: Http = () => new Promise(() => {});
    const llm = new LlmClient(http, { ...config, timeoutMs: 20 });
    await expect(llm.chat([{ role: "user", content: "hi" }], { maxTokens: 5 })).rejects.toBeInstanceOf(EndpointUnreachableError);
  });

  test("sends reasoning_effort when thinking is disabled, and drops it if rejected", async () => {
    const bodies: Record<string, unknown>[] = [];
    const http: Http = async (req) => {
      const body = JSON.parse(req.body ?? "{}");
      bodies.push(body);
      if (body.reasoning_effort) return { status: 400, text: '{"error": "unknown field reasoning_effort"}' };
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
    };
    const llm = new LlmClient(http, { ...config, disableThinking: true });
    expect(await llm.chat([{ role: "user", content: "hi" }], { maxTokens: 5 })).toBe("ok");
    expect(await llm.chat([{ role: "user", content: "hi" }], { maxTokens: 5 })).toBe("ok");
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(["none", undefined, undefined]);
  });

  test("explains an empty reply from a model that ran out of tokens while thinking", async () => {
    const http: Http = async () => ({
      status: 200,
      text: JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "", reasoning: "Let me think..." } }] }),
    });
    await expect(new LlmClient(http, config).chat([{ role: "user", content: "hi" }], { maxTokens: 5 })).rejects.toThrow(/thinking/);
  });

  test("retries without response_format when the server rejects it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const http: Http = async (req) => {
      const body = JSON.parse(req.body ?? "{}");
      bodies.push(body);
      if (body.response_format) return { status: 400, text: '{"error": "response_format.type must be json_schema"}' };
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
    };
    const llm = new LlmClient(http, { ...config, apiKey: "sk-test" });
    expect(await llm.chat([{ role: "user", content: "hi" }], { maxTokens: 5, json: true })).toBe("ok");
    expect(bodies.map((b) => Boolean(b.response_format))).toEqual([true, false]);
  });
});

describe("rerank planning", () => {
  const chunk = (i: number): Chunk => ({
    path: `folder/Note ${i}.md`,
    title: `Note ${i}`,
    heading: "Heading",
    line: 0,
    text: "lorem ipsum ".repeat(400),
  });

  test("default N fits one call under ~3,000 prompt tokens", () => {
    const batches = planRerank("a question", Array.from({ length: 15 }, (_, i) => chunk(i)));
    expect(batches).toHaveLength(1);
    expect(promptTokens(rerankMessages("a question", batches[0]!))).toBeLessThanOrEqual(3000);
  });

  test("large N is split into batches that each fit", () => {
    const batches = planRerank("a question", Array.from({ length: 40 }, (_, i) => chunk(i)));
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((b) => b.candidates)).toHaveLength(40);
    for (const b of batches) expect(promptTokens(rerankMessages("a question", b))).toBeLessThanOrEqual(3000);
  });

  test("resolveCandidate matches by path, id, or loose title", () => {
    const cs = [chunk(1), chunk(2)];
    expect(resolveCandidate({ path: "folder/Note 2.md", score: 1, reason: "" }, cs)).toBe(cs[1]);
    expect(resolveCandidate({ path: "", id: 1, score: 1, reason: "" }, cs)).toBe(cs[0]);
    expect(resolveCandidate({ path: "Note 2", score: 1, reason: "" }, cs)).toBe(cs[1]);
    expect(resolveCandidate({ path: "nope.md", score: 1, reason: "" }, cs)).toBeUndefined();
  });
});

describe("fuse", () => {
  const c = (path: string, heading = path): Chunk => ({ path, title: path, heading, line: 0, text: heading });
  const hits = (...cs: Chunk[]) => cs.map((chunk, i) => ({ chunk, score: 10 - i }));

  test("interleaves queries so every query's top hit is a candidate", () => {
    const fused = fuse([hits(c("q1"), c("q2"), c("q3")), hits(c("e1"), c("e2")), hits(c("q1"), c("f1"))], 4);
    expect(fused.map((f) => f.chunk.path)).toEqual(["q1", "e1", "f1", "q2"]);
  });

  test("one candidate per note, opening at its best chunk, with all matched chunks", () => {
    const a1 = c("a.md", "a1");
    const a2 = c("a.md", "a2");
    const fused = fuse(
      [
        [{ chunk: a1, score: 5 }, { chunk: c("b.md"), score: 4 }],
        [{ chunk: a2, score: 8 }],
      ],
      10,
    );
    expect(fused.map((f) => f.chunk.path)).toEqual(["a.md", "b.md"]);
    expect(fused[0]?.chunk).toBe(a2);
    expect(fused[0]?.matched).toEqual([a2, a1]);
  });
});

describe("model not found", () => {
  const server = (notFoundBody: string): Http => async (req) => {
    if (req.method === "GET") {
      expect(req.url).toBe("http://127.0.0.1:11434/v1/models");
      return { status: 200, text: JSON.stringify({ object: "list", data: [{ id: "qwen3.5:9b" }, { id: "gemma2:9b" }] }) };
    }
    return { status: 404, text: notFoundBody };
  };

  test.each([
    ["Ollama", '{"error":{"message":"model \'llama3.1:8b\' not found","type":"not_found_error","param":null,"code":null}}'],
    ["apfel", '{"error":{"code":"model_not_found","message":"The model \'llama3.1:8b\' does not exist.","type":"invalid_request_error"}}'],
  ])("%s 404 becomes ModelNotFoundError listing available models", async (_name, body) => {
    const llm = new LlmClient(server(body), { ...config, model: "llama3.1:8b" });
    const err = await llm.chat([{ role: "user", content: "hi" }], { maxTokens: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelNotFoundError);
    expect(err.message).toBe('Model "llama3.1:8b" isn\'t available at http://127.0.0.1:11434/v1. Available: gemma2:9b, qwen3.5:9b.');
  });

  test("suggests pulling the model when the server lists none", async () => {
    const http: Http = async (req) =>
      req.method === "GET" ? { status: 500, text: "" } : { status: 404, text: '{"error":{"message":"model \'x\' not found"}}' };
    const err = await new LlmClient(http, { ...config, model: "x" }).chat([{ role: "user", content: "hi" }], { maxTokens: 5 }).catch((e) => e);
    expect(err.message).toContain("ollama pull x");
  });

  test("search falls back to BM25 with the model hint in the message", async () => {
    const llm = new LlmClient(server('{"error":{"message":"model \'llama3.1:8b\' not found"}}'), { ...config, model: "llama3.1:8b" });
    const outcome = await reasoningSearch("restic", { index: buildIndex(), llm, candidateCount: 15, fallbackToBm25: true });
    expect(outcome.fallback?.message).toBe(
      'Reasoning search: Model "llama3.1:8b" isn\'t available at http://127.0.0.1:11434/v1. Available: gemma2:9b, qwen3.5:9b',
    );
    expect(outcome.results[0]?.source).toBe("bm25");
  });

  test("listModels sends the API key and tolerates a missing data array", async () => {
    let auth: string | undefined;
    const http: Http = async (req) => {
      auth = req.headers.Authorization;
      return { status: 200, text: "{}" };
    };
    expect(await new LlmClient(http, { ...config, apiKey: "sk-1" }).listModels()).toEqual([]);
    expect(auth).toBe("Bearer sk-1");
  });
});
