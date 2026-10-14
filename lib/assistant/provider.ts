/**
 * The only seam between Recall and an AI vendor. To use another provider or a local model,
 * implement `ChatProvider`; the prompt, retrieval, spoiler boundary and chat UI do not change.
 */
import type { AssistantErrorCode } from "./types";

export type ChatTurn = { role: "user" | "model"; text: string };

export type GenerateRequest = {
  system: string;
  /** Alternating turns; the last one is the reader's question with its sources. */
  turns: ChatTurn[];
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type GenerateResult = { text: string; finishReason?: string };

export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export type ProviderErrorCode = Extract<
  AssistantErrorCode,
  "invalid_key" | "rate_limited" | "timeout" | "blocked" | "empty" | "unavailable" | "model_unavailable" | "bad_request"
>;

/** A failure from the provider, reduced to a safe code (never carries a key or raw vendor payload). */
export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    public retryAfterSec?: number,
  ) {
    super(code);
    this.name = "ProviderError";
  }
}
