export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
}

/** Transport seam: Obsidian's `requestUrl` in the plugin, `fetch` in scripts, a fake in tests. */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  /** Send `reasoning_effort: "none"` so thinking models (Qwen 3, gpt-oss…) answer directly. */
  disableThinking?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The endpoint could not be reached at all (connection refused, DNS, timeout). */
export class EndpointUnreachableError extends Error {
  constructor(
    readonly url: string,
    override readonly cause?: unknown,
  ) {
    super(`Can't reach LLM endpoint at ${url}`);
    this.name = "EndpointUnreachableError";
  }
}

/** The endpoint answered, but with an error or an unusable body. */
export class LlmResponseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmResponseError";
  }
}

/** The server is up but doesn't have the configured model (e.g. not pulled in Ollama). */
export class ModelNotFoundError extends LlmResponseError {
  constructor(
    readonly model: string,
    readonly baseUrl: string,
    readonly available: string[],
  ) {
    const hint = available.length
      ? `Available: ${available.join(", ")}.`
      : `Pull it first (for Ollama: ollama pull ${model}).`;
    super(`Model "${model}" isn't available at ${baseUrl}. ${hint}`, 404);
    this.name = "ModelNotFoundError";
  }
}

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function completionsUrl(baseUrl: string): string {
  return `${trimBase(baseUrl)}/chat/completions`;
}

export class LlmClient {
  /** Optional request fields, each flipped off if the server rejects it so we stop sending it. */
  private jsonModeSupported = true;
  private reasoningEffortSupported = true;

  constructor(
    private readonly http: Http,
    private readonly config: LlmConfig,
  ) {}

  get url(): string {
    return completionsUrl(this.config.baseUrl);
  }

  async chat(messages: ChatMessage[], opts: { maxTokens: number; json?: boolean }): Promise<string> {
    const json = Boolean(opts.json) && this.jsonModeSupported;
    const noThinking = Boolean(this.config.disableThinking) && this.reasoningEffortSupported;
    const res = await this.send(messages, opts.maxTokens, json, noThinking);
    if (res.status === 400) {
      // Retry without optional fields the server doesn't understand (e.g. older LM Studio
      // rejects json_object; strict servers reject reasoning_effort). The prompts ask for JSON anyway.
      if (noThinking && /reasoning/i.test(res.text)) {
        this.reasoningEffortSupported = false;
        return this.chat(messages, opts);
      }
      if (json && /response_format|json/i.test(res.text)) {
        this.jsonModeSupported = false;
        return this.chat(messages, opts);
      }
    }
    if (res.status === 404 && /model/i.test(res.text)) {
      const available = await this.listModels().catch(() => []);
      throw new ModelNotFoundError(this.config.model, trimBase(this.config.baseUrl), available);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new LlmResponseError(`LLM endpoint returned HTTP ${res.status}: ${res.text.slice(0, 200)}`, res.status);
    }
    let message: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown } | undefined;
    let finishReason: unknown;
    try {
      const choice = JSON.parse(res.text)?.choices?.[0];
      message = choice?.message;
      finishReason = choice?.finish_reason;
    } catch {
      throw new LlmResponseError(`LLM endpoint returned a non-JSON body: ${res.text.slice(0, 200)}`, res.status);
    }
    const content = message?.content;
    if (typeof content !== "string") {
      throw new LlmResponseError("LLM reply had no choices[0].message.content", res.status);
    }
    if (!content.trim() && finishReason === "length" && (message?.reasoning || message?.reasoning_content)) {
      throw new LlmResponseError(
        "the model spent its whole token budget thinking; use a non-thinking model or enable 'Disable model thinking'",
        res.status,
      );
    }
    return content;
  }

  /** Model ids from the OpenAI-compatible `GET /models` (Ollama, apfel and LM Studio all serve it). */
  async listModels(): Promise<string[]> {
    const url = `${trimBase(this.config.baseUrl)}/models`;
    const headers: Record<string, string> = {};
    if (this.config.apiKey.trim()) headers.Authorization = `Bearer ${this.config.apiKey.trim()}`;
    let res: HttpResponse;
    try {
      res = await this.http({ url, method: "GET", headers });
      if (res.status === 0) throw new Error("no response");
    } catch (err) {
      throw new EndpointUnreachableError(url, err);
    }
    if (res.status < 200 || res.status >= 300) throw new LlmResponseError(`GET ${url} returned HTTP ${res.status}`, res.status);
    try {
      const data = JSON.parse(res.text)?.data;
      if (!Array.isArray(data)) return [];
      return data
        .map((m: { id?: unknown }) => m?.id)
        .filter((id: unknown): id is string => typeof id === "string")
        .sort();
    } catch {
      throw new LlmResponseError(`GET ${url} returned a non-JSON body`, res.status);
    }
  }

  private async send(messages: ChatMessage[], maxTokens: number, json: boolean, noThinking: boolean): Promise<HttpResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey.trim()) headers.Authorization = `Bearer ${this.config.apiKey.trim()}`;
    const body = JSON.stringify({
      model: this.config.model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      ...(noThinking ? { reasoning_effort: "none" } : {}),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${this.config.timeoutMs} ms`)), this.config.timeoutMs);
    });
    try {
      const res = await Promise.race([this.http({ url: this.url, method: "POST", headers, body }), timeout]);
      // requestUrl reports some transport failures as status 0 rather than throwing.
      if (res.status === 0) throw new Error("no response");
      return res;
    } catch (err) {
      throw new EndpointUnreachableError(this.url, err);
    } finally {
      clearTimeout(timer);
    }
  }
}
