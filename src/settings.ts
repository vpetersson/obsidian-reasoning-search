import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ReasoningSearchPlugin from "./main";
import { DEFAULT_SETTINGS } from "./settings-defaults";

export class ReasoningSearchSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ReasoningSearchPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("Endpoint").setHeading();

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("OpenAI-compatible API base, including /v1. apfel and Ollama both default to http://127.0.0.1:11434/v1; LM Studio uses http://127.0.0.1:1234/v1.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.baseUrl)
          .setValue(s.baseUrl)
          .onChange(async (v) => {
            s.baseUrl = v.trim() || DEFAULT_SETTINGS.baseUrl;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("apple-foundationmodel for apfel, or e.g. llama3.1:8b for Ollama.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.model)
          .setValue(s.model)
          .onChange(async (v) => {
            s.model = v.trim() || DEFAULT_SETTINGS.model;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Optional. Sent as a Bearer token when set.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.apiKey).onChange(async (v) => {
          s.apiKey = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Request timeout")
      .setDesc("Seconds to wait for each LLM call.")
      .addText((t) =>
        t.setValue(String(s.timeoutSeconds)).onChange(async (v) => {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            s.timeoutSeconds = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Disable model thinking")
      .setDesc("Sends reasoning_effort: none, so thinking models (Qwen 3, gpt-oss…) answer directly instead of using up the token budget. Dropped automatically if the server rejects it.")
      .addToggle((t) =>
        t.setValue(s.disableThinking).onChange(async (v) => {
          s.disableThinking = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Sends a one-word prompt to the endpoint.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          b.setDisabled(true);
          const started = performance.now();
          try {
            await this.plugin.llmClient().chat([{ role: "user", content: "Reply with the single word OK." }], { maxTokens: 5 });
            new Notice(`Reasoning search: endpoint OK (${Math.round(performance.now() - started)} ms)`);
          } catch (err) {
            new Notice(`Reasoning search: ${err instanceof Error ? err.message : String(err)}`, 8000);
          } finally {
            b.setDisabled(false);
          }
        }),
      );

    new Setting(containerEl).setName("Search").setHeading();

    new Setting(containerEl)
      .setName("Candidates to rerank")
      .setDesc("How many BM25 candidates (one per note) are sent to the model. Prompts are capped at ~3,000 tokens; larger values are split into several calls.")
      .addSlider((sl) =>
        sl
          .setLimits(5, 40, 1)
          .setValue(s.candidateCount)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.candidateCount = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Show keyword results if the LLM fails")
      .setDesc("When the endpoint is unreachable or errors, show raw BM25 results instead of nothing.")
      .addToggle((t) =>
        t.setValue(s.fallbackToBm25).onChange(async (v) => {
          s.fallbackToBm25 = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("One glob per line, e.g. Templates, Archive/**, **/drafts/*. A plain folder name excludes everything inside it.")
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.setValue(s.excludeGlobs.join("\n")).onChange(async (v) => {
          s.excludeGlobs = v.split("\n").map((l) => l.trim()).filter(Boolean);
          await this.plugin.saveSettings();
          this.plugin.scheduleRebuild();
        });
      });

    new Setting(containerEl)
      .setName("Index")
      .setDesc(`${this.plugin.index.noteCount} notes, ${this.plugin.index.chunkCount} chunks indexed.`)
      .addButton((b) =>
        b.setButtonText("Rebuild").onClick(async () => {
          await this.plugin.rebuildIndex();
          this.display();
        }),
      );
  }
}
