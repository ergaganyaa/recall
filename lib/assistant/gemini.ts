import { ApiError, GoogleGenAI } from "@google/genai";
import { ProviderError, type ChatProvider, type GenerateRequest, type GenerateResult } from "./provider";

/** The slice of the SDK we use, so tests can supply a fake client instead of calling Google. */
export type GeminiClientLike = {
  models: {
    generateContent(params: {
      model: string;
      contents: { role: string; parts: { text: string }[] }[];
      config?: Record<string, unknown>;
    }): Promise<{ text?: string; promptFeedback?: { blockReason?: string }; candidates?: { finishReason?: string }[] }>;
  };
};

/** "retry in 12.3s" / "retryDelay":"12s" in a Google 429 payload → seconds. */
function retryAfter(message: string): number | undefined {
  const m = message.match(/retry(?:\s+in|Delay"?\s*:\s*"?)\s*([\d.]+)\s*s/i);
  return m ? Math.min(3600, Math.ceil(Number(m[1]))) : undefined;
}

/**
 * Reduces any SDK or network failure to a safe code. The raw error (which may echo request details) is
 * never returned, logged or shown; only the code and, for rate limits, a retry hint.
 */
export function mapGeminiError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;

  const message = e instanceof Error ? e.message : "";
  const name = e instanceof Error ? e.name : "";
  const status = e instanceof ApiError ? e.status : typeof (e as { status?: unknown })?.status === "number" ? ((e as { status: number }).status) : 0;

  if (name === "AbortError" || /abort|timed? ?out|timeout/i.test(message) && !status) return new ProviderError("timeout");
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(message)) return new ProviderError("rate_limited", retryAfter(message));
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(message)) {
    return new ProviderError("invalid_key");
  }
  if (status === 404 || /models?\/.*not found|NOT_FOUND/i.test(message)) return new ProviderError("model_unavailable");
  if (status === 400) return new ProviderError(/API key/i.test(message) ? "invalid_key" : "bad_request");
  if (status >= 500 || /fetch failed|ECONN|ENOTFOUND|network/i.test(message)) return new ProviderError("unavailable");
  return new ProviderError("unavailable");
}

export function createGeminiProvider(opts: { apiKey: string; model: string; client?: GeminiClientLike }): ChatProvider {
  const client: GeminiClientLike = opts.client ?? (new GoogleGenAI({ apiKey: opts.apiKey }) as unknown as GeminiClientLike);

  return {
    name: "gemini",
    model: opts.model,

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      let res: Awaited<ReturnType<GeminiClientLike["models"]["generateContent"]>>;
      try {
        res = await client.models.generateContent({
          model: opts.model,
          contents: req.turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
          config: {
            systemInstruction: req.system,
            maxOutputTokens: req.maxOutputTokens,
            temperature: req.temperature,
            abortSignal: req.signal,
            httpOptions: { timeout: req.timeoutMs },
          },
        });
      } catch (e) {
        throw mapGeminiError(e);
      }

      if (res.promptFeedback?.blockReason) throw new ProviderError("blocked");
      const text = (res.text ?? "").trim();
      const finishReason = res.candidates?.[0]?.finishReason;
      if (!text) throw new ProviderError(finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT" ? "blocked" : "empty");
      return { text, finishReason };
    },
  };
}
