import { type App, Modal, Notice, Platform, TFile } from "obsidian";
import type ReasoningSearchPlugin from "./main";
import { reasoningSearch, type SearchResult, type Stage } from "./search";

const STAGE_LABEL: Record<Stage, string> = {
  expanding: "Expanding query",
  retrieving: "Retrieving",
  reranking: "Reranking",
};

/**
 * Suggest-modal look-alike. Unlike SuggestModal it searches on Enter rather than on every
 * keystroke, since each search costs two LLM calls.
 */
export class ReasoningSearchModal extends Modal {
  private inputEl!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private results: SearchResult[] = [];
  private selected = 0;
  private lastQuery = "";
  private run = 0;
  private timer: number | undefined;

  constructor(
    app: App,
    private readonly plugin: ReasoningSearchPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("prompt", "reasoning-search-modal");
    const { contentEl } = this;
    contentEl.empty();
    const inputWrap = contentEl.createDiv({ cls: "prompt-input-container" });
    this.inputEl = inputWrap.createEl("input", {
      cls: "prompt-input",
      attr: { type: "text", placeholder: "Ask your notes… (Enter to search)", spellcheck: "false" },
    });
    this.statusEl = contentEl.createDiv({ cls: "reasoning-search-status" });
    this.resultsEl = contentEl.createDiv({ cls: "prompt-results reasoning-search-results" });
    this.inputEl.addEventListener("keydown", (e) => this.onKey(e));
    this.setStatus(`${this.plugin.index.noteCount} notes indexed`);
    this.inputEl.focus();
  }

  override onClose(): void {
    this.run++;
    this.stopTimer();
    this.contentEl.empty();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this.results.length) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      this.select((this.selected + delta + this.results.length) % this.results.length);
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      const query = this.inputEl.value.trim();
      if (query && query !== this.lastQuery) void this.search(query);
      else if (this.results[this.selected]) void this.openResult(this.results[this.selected]!, Platform.isMacOS ? e.metaKey : e.ctrlKey);
    }
  }

  private async search(query: string): Promise<void> {
    const run = ++this.run;
    this.lastQuery = query;
    this.renderResults([]);
    const started = performance.now();
    let stage = "Starting";
    const tick = () => this.setStatus(`${stage}… ${((performance.now() - started) / 1000).toFixed(1)}s`, true);
    this.stopTimer();
    this.timer = window.setInterval(tick, 100);
    tick();
    try {
      await this.plugin.indexReady;
      const outcome = await reasoningSearch(query, {
        index: this.plugin.index,
        llm: this.plugin.llmClient(),
        candidateCount: this.plugin.settings.candidateCount,
        fallbackToBm25: this.plugin.settings.fallbackToBm25,
        onStage: (s) => {
          stage = STAGE_LABEL[s];
          tick();
        },
      });
      if (run !== this.run) return;
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      if (outcome.fallback) {
        new Notice(`${outcome.fallback.message}. Showing keyword results.`, 8000);
        console.warn("[reasoning-search]", outcome.fallback.error);
      }
      const label = outcome.fallback ? "keyword results (LLM unavailable)" : `queries: ${outcome.queries.slice(1).join(" · ") || "none"}`;
      this.stopTimer();
      const count = outcome.results.length;
      this.setStatus(`${count} ${count === 1 ? "result" : "results"} in ${secs}s — ${label}`);
      this.renderResults(outcome.results, true);
    } catch (err) {
      if (run !== this.run) return;
      this.stopTimer();
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Reasoning search: ${message}`, 8000);
      console.error("[reasoning-search]", err);
      this.setStatus(`Failed: ${message}`);
      this.lastQuery = "";
    } finally {
      if (run === this.run) this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  private setStatus(text: string, busy = false): void {
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-busy", busy);
  }

  private renderResults(results: SearchResult[], showEmpty = false): void {
    this.results = results;
    this.resultsEl.empty();
    if (!results.length && showEmpty) {
      this.resultsEl.createDiv({ cls: "suggestion-empty", text: "No relevant notes found." });
    }
    results.forEach((r, i) => {
      const item = this.resultsEl.createDiv({ cls: "suggestion-item mod-complex reasoning-search-item" });
      const content = item.createDiv({ cls: "suggestion-content" });
      const title = content.createDiv({ cls: "suggestion-title" });
      title.createSpan({ text: r.chunk.title });
      if (r.chunk.heading) title.createSpan({ cls: "reasoning-search-heading", text: ` › ${r.chunk.heading}` });
      if (r.reason) content.createDiv({ cls: "suggestion-note", text: r.reason });
      const aux = item.createDiv({ cls: "suggestion-aux" });
      aux.createSpan({ cls: `reasoning-search-score is-${r.source}`, text: r.source === "llm" ? String(r.score) : "BM25" });
      item.addEventListener("mousemove", () => this.select(i));
      item.addEventListener("click", (e) => void this.openResult(r, Platform.isMacOS ? e.metaKey : e.ctrlKey));
    });
    this.select(0);
  }

  private select(i: number): void {
    const items = Array.from(this.resultsEl.children);
    items[this.selected]?.removeClass("is-selected");
    this.selected = i;
    items[i]?.addClass("is-selected");
    items[i]?.scrollIntoView({ block: "nearest" });
  }

  private async openResult(result: SearchResult, newTab: boolean): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(result.chunk.path);
    if (!(file instanceof TFile)) {
      new Notice(`Reasoning search: ${result.chunk.path} no longer exists`);
      return;
    }
    this.close();
    const leaf = this.app.workspace.getLeaf(newTab ? "tab" : false);
    await leaf.openFile(file, { eState: { line: result.chunk.line } });
  }
}
