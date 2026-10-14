/**
 * The assistant pipeline, with every outside dependency injected (database retrieval, the AI provider), so
 * the security behaviour is unit-testable without Supabase or Google.
 *
 *   question ─► spoiler-safe retrieval (boundary enforced in SQL) ─► budget + de-duplicate
 *            ─► prompt (sources as DATA) ─► provider ─► validate citations ─► answer
 *
 * The reading boundary is only ever the number the DATABASE returned. Nothing in this file accepts a
 * boundary from a caller or the client.
 */
import { extractCitations } from "./citations";
import type { AssistantConfig } from "./config";
import { friendlyMessage } from "./errors";
import { selectHistory, userQuestions } from "./history";
import { buildPrompt } from "./prompt";
import { ProviderError, type ChatProvider } from "./provider";
import { buildSearchTerms, selectPassages, subjectTermCount } from "./retrieval";
import type { AnswerOutcome, ContextResult, HistoryMessage } from "./types";

export type AnswerDeps = {
  /** Spoiler-safe retrieval: the boundary and the passages come from one database call. */
  getContext(terms: string[]): Promise<ContextResult>;
  /** Does the book have any text inside the boundary? Only asked when nothing matched. */
  hasReadableText(boundary: number): Promise<boolean>;
  provider: ChatProvider;
  config: AssistantConfig;
  /** Recent stored messages, oldest first (all boundaries; filtered here). */
  history: HistoryMessage[];
  signal?: AbortSignal;
};

const NOT_STARTED =
  "You haven't finished any chapters yet, so I have nothing I can safely draw on. Finish a chapter (or use “Read through here”) and ask again.";
const NO_TEXT = "This book has no chapter text in Recall yet. Import or paste the text so I can look at what you've read.";
const noEvidence = (boundary: number) =>
  `I couldn't find anything about that in the chapters you've read (through chapter ${boundary}). It may not have come up yet, or try different words.`;

export async function answerQuestion(args: { question: string; bookId: string; deps: AnswerDeps }): Promise<AnswerOutcome> {
  const { question, bookId, deps } = args;
  const { config } = deps;

  // 1. Retrieval. The boundary is whatever the database says it is for THIS user and book.
  let ctx = await deps.getContext(buildSearchTerms(question));
  if (ctx.boundary === null) return { kind: "error", code: "not_found", message: friendlyMessage("not_found") };
  if (ctx.boundary === 0) return { kind: "not_started", text: NOT_STARTED, citations: [], boundary: 0 };

  // 2. History, cut down to what is safe at THIS boundary (moving backward drops later messages).
  let history = selectHistory(deps.history, ctx.boundary, config);

  // 3. A follow-up with too few words of its own ("what happened next?") borrows the previous question's
  //    words, and retrieval runs again: old passages are never reused.
  if (subjectTermCount(question) < 2 && history.length > 0) {
    const refreshed = await deps.getContext(buildSearchTerms(question, userQuestions(history)));
    if (refreshed.boundary === null) return { kind: "error", code: "not_found", message: friendlyMessage("not_found") };
    if (refreshed.boundary === 0) return { kind: "not_started", text: NOT_STARTED, citations: [], boundary: 0 };
    if (refreshed.boundary !== ctx.boundary) history = selectHistory(deps.history, refreshed.boundary, config);
    ctx = refreshed;
  }
  const boundary = ctx.boundary as number;

  const passages = selectPassages(ctx.passages, config);
  if (passages.length === 0) {
    // Nothing relevant inside the boundary: say so without spending a model call.
    const hasText = await deps.hasReadableText(boundary);
    return hasText
      ? { kind: "no_evidence", text: noEvidence(boundary), citations: [], boundary }
      : { kind: "no_text", text: NO_TEXT, citations: [], boundary };
  }

  // 4. Ask the model, with only these passages.
  const prompt = buildPrompt({ question, passages, history, boundary });
  let reply;
  try {
    reply = await deps.provider.generate({
      system: prompt.system,
      turns: prompt.turns,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      timeoutMs: config.timeoutMs,
      signal: deps.signal,
    });
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError("unavailable");
    return { kind: "error", code: err.code, message: friendlyMessage(err.code, err.retryAfterSec), retryAfterSec: err.retryAfterSec };
  }

  // 5. Citations come from the passages we supplied, never from what the model claims to have read.
  const { text, citations } = extractCitations(reply.text, passages, bookId);
  if (!text) return { kind: "error", code: "empty", message: friendlyMessage("empty") };
  return { kind: "answer", text, citations, boundary };
}
