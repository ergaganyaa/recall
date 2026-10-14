/**
 * Assistant settings, read from environment variables on the SERVER only.
 * None of these names start with NEXT_PUBLIC_, so Next.js never ships them to the browser.
 */

export type AssistantConfig = {
  /** null when missing or still a placeholder from .env.example */
  apiKey: string | null;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  /** Retrieval budget: how many passages, how many per chapter, how many characters in total */
  maxPassages: number;
  perChapter: number;
  contextChars: number;
  /** Conversation budget */
  historyChars: number;
  historyMessages: number;
  /** Free-tier protection: questions allowed per user */
  maxPerMinute: number;
  maxPerDay: number;
};

/**
 * Default model: gemini-3.5-flash-lite, which Google's docs list as stable and free of charge, and as the
 * recommended light model for new projects. Override with GEMINI_MODEL (e.g. gemini-3.8-flash for quality).
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

const isPlaceholder = (key: string) => key === "" || /^(your|paste|changeme|xxx|<)/i.test(key);

export function readAssistantConfig(env: Record<string, string | undefined> = process.env): AssistantConfig {
  const key = (env.GEMINI_API_KEY ?? "").trim();
  const temp = Number(env.ASSISTANT_TEMPERATURE);
  return {
    apiKey: isPlaceholder(key) ? null : key,
    model: (env.GEMINI_MODEL ?? "").trim() || DEFAULT_GEMINI_MODEL,
    maxOutputTokens: int(env.ASSISTANT_MAX_OUTPUT_TOKENS, 700, 64, 4096),
    temperature: Number.isFinite(temp) && env.ASSISTANT_TEMPERATURE?.trim() ? Math.min(1, Math.max(0, temp)) : 0.3,
    timeoutMs: int(env.ASSISTANT_TIMEOUT_MS, 20_000, 3_000, 60_000),
    maxPassages: int(env.ASSISTANT_MAX_PASSAGES, 8, 1, 12),
    perChapter: int(env.ASSISTANT_PASSAGES_PER_CHAPTER, 2, 1, 4),
    contextChars: int(env.ASSISTANT_CONTEXT_CHARS, 6_000, 1_000, 20_000),
    historyChars: int(env.ASSISTANT_HISTORY_CHARS, 3_000, 0, 12_000),
    historyMessages: int(env.ASSISTANT_HISTORY_MESSAGES, 8, 0, 20),
    maxPerMinute: int(env.ASSISTANT_MAX_PER_MINUTE, 6, 1, 60),
    maxPerDay: int(env.ASSISTANT_MAX_PER_DAY, 150, 1, 5_000),
  };
}
