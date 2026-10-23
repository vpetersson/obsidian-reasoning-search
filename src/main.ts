import { debounce, Plugin, requestUrl, TAbstractFile, TFile } from "obsidian";
import { Bm25Index } from "./bm25";
import { chunkNote } from "./chunker";
import { compileExcludes } from "./glob";
import { type Http, LlmClient } from "./llm";
import { ReasoningSearchModal } from "./modal";
import { ReasoningSearchSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type ReasoningSearchSettings } from "./settings-defaults";

const obsidianHttp: Http = async (req) => {
  const res = await requestUrl({ ...req, throw: false });
  return { status: res.status, text: res.text };
};

export default class ReasoningSearchPlugin extends Plugin {
  settings: ReasoningSearchSettings = { ...DEFAULT_SETTINGS };
  readonly index = new Bm25Index();
  indexReady: Promise<void> = Promise.resolve();
  private isExcluded: (path: string) => boolean = () => false;
  readonly scheduleRebuild = debounce(() => {
    this.indexReady = this.rebuildIndex().then(() => undefined);
  }, 1000, true);

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ReasoningSearchSettingTab(this.app, this));
    this.addCommand({
      id: "open",
      name: "Reasoning search",
      callback: () => new ReasoningSearchModal(this.app, this).open(),
    });

    this.app.workspace.onLayoutReady(() => {
      this.indexReady = this.rebuildIndex().then(() => undefined);
      // Registered after layout-ready so the initial vault load doesn't fire a create per file.
      this.registerEvent(this.app.vault.on("create", (f) => void this.indexFile(f)));
      this.registerEvent(this.app.vault.on("modify", (f) => void this.indexFile(f)));
      this.registerEvent(this.app.vault.on("delete", (f) => this.index.removeNote(f.path)));
      this.registerEvent(
        this.app.vault.on("rename", (f, oldPath) => {
          this.index.removeNote(oldPath);
          void this.indexFile(f);
        }),
      );
    });
  }

  llmClient(): LlmClient {
    const s = this.settings;
    return new LlmClient(obsidianHttp, {
      baseUrl: s.baseUrl,
      model: s.model,
      apiKey: s.apiKey,
      timeoutMs: s.timeoutSeconds * 1000,
      disableThinking: s.disableThinking,
    });
  }

  async rebuildIndex(): Promise<{ notes: number; chunks: number; ms: number }> {
    const started = performance.now();
    this.isExcluded = compileExcludes(this.settings.excludeGlobs);
    this.index.clear();
    const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path));
    const contents = await Promise.all(files.map((f) => this.app.vault.cachedRead(f).catch(() => "")));
    files.forEach((f, i) => this.index.setNote(f.path, chunkNote(f.path, contents[i] ?? "")));
    const stats = { notes: this.index.noteCount, chunks: this.index.chunkCount, ms: Math.round(performance.now() - started) };
    console.debug(`[reasoning-search] indexed ${stats.notes} notes / ${stats.chunks} chunks in ${stats.ms} ms`);
    return stats;
  }

  private async indexFile(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (this.isExcluded(file.path)) {
      this.index.removeNote(file.path);
      return;
    }
    try {
      this.index.setNote(file.path, chunkNote(file.path, await this.app.vault.cachedRead(file)));
    } catch (err) {
      console.error(`[reasoning-search] failed to index ${file.path}`, err);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<ReasoningSearchSettings> | null) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  override onunload(): void {
    this.index.clear();
  }
}

