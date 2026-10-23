/**
 * Run the full search pipeline against a real endpoint, outside Obsidian.
 *
 *   bun run eval -- --base-url http://127.0.0.1:11434/v1 --model llama3:8b
 *   bun run eval -- --vault ~/Notes --queries my-queries.json
 *   bun run eval -- --pad 2000   # add synthetic distractor notes to approximate a real vault
 *
 * Each query passes if its expected note lands in the top 3.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { Bm25Index } from "../src/bm25";
import { chunkNote } from "../src/chunker";
import { type Http, LlmClient } from "../src/llm";
import { fuse, reasoningSearch, type Stage } from "../src/search";
import { DEFAULT_SETTINGS } from "../src/settings-defaults";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "base-url": { type: "string", default: DEFAULT_SETTINGS.baseUrl },
    model: { type: "string", default: DEFAULT_SETTINGS.model },
    "api-key": { type: "string", default: "" },
    vault: { type: "string", default: "fixtures/vault" },
    queries: { type: "string", default: "fixtures/queries.json" },
    candidates: { type: "string", default: String(DEFAULT_SETTINGS.candidateCount) },
    thinking: { type: "boolean", default: false },
    pad: { type: "string", default: "0" },
  },
});

const fetchHttp: Http = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  return { status: res.status, text: await res.text() };
};

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !join(e.parentPath, e.name).includes("/.obsidian/"))
    .map((e) => join(e.parentPath, e.name));
}

const vault = values.vault!;
const files = await markdownFiles(vault);
const index = new Bm25Index();
const t0 = performance.now();
const contents = await Promise.all(files.map((f) => readFile(f, "utf8")));
files.forEach((f, i) => {
  const path = relative(vault, f);
  index.setNote(path, chunkNote(path, contents[i] ?? ""));
});
// Distractors drawn from overlapping vocabulary (servers, disks, backups…) so they compete with the fixtures.
const VOCAB = (
  "server deploy backup disk storage network latency alert cluster node upgrade invoice meeting " +
  "migration database postgres cache queue billing customer release incident review roadmap hiring " +
  "budget travel recipe garden kernel docker volume snapshot monitoring dashboard ticket vendor contract"
).split(" ");
for (let i = 0; i < Number(values.pad); i++) {
  const words = (n: number, seed: number) => Array.from({ length: n }, (_, w) => VOCAB[(seed * 31 + w * 17 + w * w) % VOCAB.length]).join(" ");
  const path = `Synthetic/${words(3, i)} ${i}.md`;
  const body = Array.from({ length: 4 }, (_, h) => `## ${words(2, i + h)}\n${words(60, i * 5 + h)}`).join("\n\n");
  index.setNote(path, chunkNote(path, body));
}
console.log(`Indexed ${index.noteCount} notes / ${index.chunkCount} chunks in ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`Endpoint ${values["base-url"]}  model ${values.model}\n`);

const llm = new LlmClient(fetchHttp, {
  baseUrl: values["base-url"]!,
  model: values.model!,
  apiKey: values["api-key"]!,
  timeoutMs: 180_000,
  disableThinking: !values.thinking,
});
const cases = JSON.parse(await readFile(values.queries!, "utf8")) as { question: string; expect: string }[];

let passed = 0;
for (const { question, expect } of cases) {
  const started = performance.now();
  const marks: string[] = [];
  let last = started;
  let lastStage: Stage | null = null;
  const outcome = await reasoningSearch(question, {
    index,
    llm,
    candidateCount: Number(values.candidates),
    fallbackToBm25: true,
    onStage: (s) => {
      const now = performance.now();
      if (lastStage) marks.push(`${lastStage} ${((now - last) / 1000).toFixed(1)}s`);
      lastStage = s;
      last = now;
    },
  });
  if (lastStage) marks.push(`${lastStage} ${((performance.now() - last) / 1000).toFixed(1)}s`);
  const rank = outcome.results.findIndex((r) => r.chunk.path === expect) + 1;
  const bm25Rank = index.search(question, 50).findIndex((h) => h.chunk.path === expect) + 1;
  const perQuery = Math.max(Number(values.candidates) * 3, 30);
  const candidates = fuse(outcome.queries.map((q) => index.search(q, perQuery)), Number(values.candidates));
  const candidateRank = candidates.findIndex((c) => c.chunk.path === expect) + 1;
  const ok = rank > 0 && rank <= 3;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"}  "${question}"`);
  console.log(`      expected ${expect}: rank ${rank || "-"} (candidate ${candidateRank || "-"}, plain BM25 ${bm25Rank || "-"})  [${marks.join(", ")}]`);
  if (outcome.fallback) console.log(`      fallback: ${outcome.fallback.message}`);
  console.log(`      queries: ${outcome.queries.slice(1).join(" | ")}`);
  for (const r of outcome.results.slice(0, 3)) console.log(`      ${String(r.score).padStart(3)}  ${r.chunk.path}  — ${r.reason}`);
}
console.log(`\n${passed}/${cases.length} in top 3`);
process.exit(passed === cases.length ? 0 : 1);
