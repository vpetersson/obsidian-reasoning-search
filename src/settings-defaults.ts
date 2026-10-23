export interface ReasoningSearchSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
  candidateCount: number;
  excludeGlobs: string[];
  fallbackToBm25: boolean;
  timeoutSeconds: number;
  disableThinking: boolean;
}

/** apfel (`apfel --serve`) defaults: OpenAI-compatible API on port 11434, model `apple-foundationmodel`. */
export const DEFAULT_SETTINGS: ReasoningSearchSettings = {
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "apple-foundationmodel",
  apiKey: "",
  candidateCount: 15,
  excludeGlobs: [],
  fallbackToBm25: true,
  timeoutSeconds: 60,
  disableThinking: true,
};
