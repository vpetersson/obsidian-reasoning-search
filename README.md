# Reasoning Search for Obsidian

Ask your vault a question in plain language, like *"that time the server lost a disk"*, and get back the handful of notes that actually answer it, each with a one-line reason.

Everything runs locally. The plugin talks to any OpenAI-compatible chat endpoint on your machine. The default target is Apple's on-device Foundation Models via [apfel](https://apfel.franzai.com/), and Ollama and LM Studio work unchanged. There are no embeddings, no vector database, no native add-ons and no sidecar processes.

## How it works

1. **Retrieval (local).** Each markdown note is split by heading. Notes without headings, and very long sections, are split into ~800-character windows. The chunks go into an in-memory BM25 index that is built when Obsidian starts and kept current on every create, modify, delete and rename.
2. **Query expansion (LLM).** Your question is turned into 3–5 keyword queries that use the words the answer note probably contains, such as *"RAID degraded"* or *"drive failure"* for *"disk failure on the hosting box"*. The index runs your question and every expansion.
3. **Fusion.** The queries take turns contributing their best unseen note until there are N candidates (15 by default). This round-robin means one good expansion can't be drowned out by several noisy ones.
4. **Rerank (LLM).** The model reads the candidates, with every matching section of each note, and returns `{"results": [{"id", "path", "score", "reason"}]}`. Results are sorted by its 0–100 score.

The plugin requests `response_format: {"type": "json_object"}` and still parses defensively. It strips code fences and `<think>` blocks, accepts bare arrays or wrapped objects, and salvages complete entries from a truncated reply.

If the endpoint is unreachable or fails, a Notice names the URL and the modal shows plain BM25 results instead. You can turn this fallback off in settings.

## Usage

Run **Reasoning search** from the command palette (bind a hotkey if you like), type a question and press <kbd>Enter</kbd>.

- A status line shows the current stage (expanding, retrieving, reranking) and the elapsed time.
- <kbd>↑</kbd>/<kbd>↓</kbd> move the selection. <kbd>Enter</kbd> opens the selected note at the matching section, and <kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> opens it in a new tab.
- Searching only happens on <kbd>Enter</kbd>, not on every keystroke, because each search makes two LLM calls.

## Setting up a backend

### Apple Foundation Models via apfel (default)

Requirements: an Apple Silicon Mac running macOS 26 or later, with Apple Intelligence enabled.

1. **Enable Apple Intelligence:** open *System Settings → Apple Intelligence & Siri* and turn on Apple Intelligence. macOS downloads the on-device model in the background, and the server won't work until that download finishes. Your Mac and Siri language need to be set to a supported language.
2. **Install apfel:** run `brew install apfel`.
3. **Start the server:** run `apfel --serve`. It serves an OpenAI-compatible API at `http://127.0.0.1:11434/v1` with the model `apple-foundationmodel`. These are the plugin's defaults, so nothing needs configuring.
4. In the plugin settings, click **Test connection**.

apfel and Ollama both default to port 11434, so only one of them can run on it. If you use both, move one to another port (see `apfel --help`) and update **Base URL**.

### Ollama

```sh
ollama pull qwen3.5:9b     # or gemma2:9b, llama3:8b, ...
ollama serve               # if it isn't already running
```

Settings:

- **Base URL:** `http://127.0.0.1:11434/v1`
- **Model:** the model tag, e.g. `qwen3.5:9b`
- **API key:** blank

You don't need to set `OLLAMA_ORIGINS`. The plugin uses Obsidian's `requestUrl`, which isn't subject to browser CORS.

For thinking models such as Qwen 3.x, leave **Disable model thinking** on. It sends `reasoning_effort: "none"`. Without it the model can spend its whole token budget reasoning and return an empty answer. When that happens, the plugin says so instead of failing silently.

### LM Studio and others

Start the LM Studio server, then set **Base URL** to `http://127.0.0.1:1234/v1` and **Model** to the loaded model's identifier. Any server that implements `POST /v1/chat/completions` should work. If a server rejects `response_format` or `reasoning_effort`, the plugin retries once without that field and stops sending it.

## The ~4k-token constraint

Apple's on-device model has a context window of roughly 4,096 tokens, and the prompt and reply share it. The plugin is built around that limit:

- The rerank prompt is capped at **~3,000 tokens** (estimated conservatively at 3.5 characters per token). That leaves room for the reply, which is capped at about 45 tokens per candidate.
- Each candidate's excerpt is sized to fit the budget. With the default 15 candidates, each note gets about 600 characters.
- If you raise **Candidates to rerank** above what fits in one prompt, the candidates are split into a few batches. They are not compared pairwise.
- Query expansion is a single short prompt with a 200-token reply.

On Ollama, larger-context models don't need these limits, but they don't hurt either. Small prompts keep each search to a few seconds.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Base URL | `http://127.0.0.1:11434/v1` | OpenAI-compatible base, including `/v1` |
| Model | `apple-foundationmodel` | |
| API key | blank | Sent as `Authorization: Bearer …` when set |
| Request timeout | 60 s | Per LLM call; a timeout counts as unreachable |
| Disable model thinking | on | Sends `reasoning_effort: "none"` |
| Candidates to rerank | 15 | One candidate per note |
| Show keyword results if the LLM fails | on | |
| Excluded folders | none | One glob per line: `Templates`, `Archive/**`, `**/drafts/*` |

## Design decisions

**The BM25 index is rebuilt at startup, not persisted.** A 2,000-note synthetic vault (8,000 chunks) indexes in about 0.4 s in the test suite, well under the 3 s budget. A single note updates in under 1 ms. A persisted `index.json` would add invalidation problems (edits made outside Obsidian, sync, settings changes) and would save less than a second, so it isn't worth it. Notes are read with `cachedRead`, and the index is built after the workspace layout is ready, so startup isn't blocked.

**Rerank is one call when the candidates fit and a few batches when they don't. It is never pairwise.** Pairwise comparison needs O(N²) calls, which is far too slow for an on-device model. Listwise batches are worse at comparing notes that land in different batches, but at the default N=15 everything fits in one call.

**One candidate per note.** Results are notes, not fragments. The reranker sees every section of a note that matched any query, and opening a result jumps to the best-matching section.

## Evaluation against a real model

`scripts/eval.ts` runs the full pipeline outside Obsidian against any endpoint, using a fixture vault (`fixtures/vault`) and question set (`fixtures/queries.json`). A question passes when its expected note lands in the top 3. The questions deliberately avoid the target note's words. For example, *"that disk failure on the hosting box"* should find *Ops/Hetzner SX outage 2025-03*, which shares no keywords with it.

```sh
bun run eval -- --model qwen3.5:9b                 # 25-note fixture vault
bun run eval -- --model qwen3.5:9b --pad 2000      # plus 2,000 keyword-dense distractor notes
bun run eval -- --vault ~/Notes --queries mine.json
bun run eval -- --base-url http://127.0.0.1:9/v1   # dead endpoint: every query falls back to BM25
```

Results on Ollama 0.33 (top-3 hits out of 6 questions):

| Model | Fixture vault | + 2,000 distractors |
| --- | --- | --- |
| qwen3.5:9b | 6/6 | 6/6 |
| gemma2:9b | 6/6 | 6/6 |
| llama3:8b | 5/6 | 5/6 |
| mistral:7b-instruct | 4–5/6 | 5/6 |

- Plain BM25 finds none of the "no shared keywords" targets.
- A typical search takes 3–6 s: about 1 s for expansion and 1.5–5 s for the rerank.
- The most common miss is *"custard tarts"* → *pastéis de nata in Lisbon*, which needs the model to know what pastéis de nata are.
- These results have not been measured against apfel or Apple Foundation Models yet.

The plugin has also been run inside Obsidian 1.14.5 (Linux desktop) against Ollama with `qwen3.5:9b`. It loads with no console errors and indexes the fixture vault in under 10 ms. The modal finds the Hetzner note at score 95, and <kbd>Enter</kbd> opens it at the matching heading. Create, modify, rename and delete re-index within 5 ms. With the endpoint pointed at a dead port, the modal shows a Notice naming the URL and returns keyword results instead of crashing. The type definitions are pinned to the Obsidian 1.5 API, so the build can't silently depend on newer APIs.

## Development

```sh
bun install
bun run dev         # rebuild main.js on change
bun test            # chunker, index, glob, JSON parsing, search pipeline with a fake endpoint
bun run typecheck
bun run build
```

To try it in a vault, symlink or copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/reasoning-search/` and enable the plugin.

### Releasing

```sh
bun run release           # patch bump; or: minor | major | 1.2.3
```

This bumps `manifest.json`, `package.json` and `versions.json`, runs the tests, builds, and writes `release/reasoning-search-<version>.zip`. To publish, commit, tag with the bare version (e.g. `0.1.1`) and attach `main.js`, `manifest.json` and `styles.css` to a GitHub release.

## Non-goals

- Embeddings or any semantic index
- Chat, Q&A or answer generation over notes
- Mobile (the plugin is desktop-only)
- Writing to notes

## License

Apache-2.0
