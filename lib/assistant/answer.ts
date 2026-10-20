/**
 * The assistant pipeline, with every outside dependency injected (database retrieval, the AI provider), so
 * the security behaviour is unit-testable without Supabase or Google.
 *
 *   question ─► spoiler-safe retrieval (boundary enforced in SQL) ─► budget + de-duplicate
 *            ─► prompt (sources as DATA) ─► provider ─► validate citations ─► answer
 *
 * The reading position is only ever the numbers the DATABASE returned: the chapters it says are complete,
 * plus how much of the next chapter it says has been read. Nothing in this file accepts a position from a
 * caller or the client.
 */
import { extractTerms } from "../chunking";
import { extractCitations } from "./citations";
import type { AssistantConfig } from "./config";
import { friendlyMessage } from "./errors";
import { selectHistory, userQuestions } from "./history";
import { buildPrompt } from "./prompt";
import { ProviderError, type ChatProvider } from "./provider";
import { buildSearchTerms, selectPassages, subjectTermCount } from "./retrieval";
import type { AnswerOutcome, ContextResult, HistoryMessage, SelectionText } from "./types";

export type AnswerDeps = {
  /** Spoiler-safe retrieval: the position and the passages come from one database call. */
  getContext(terms: string[]): Promise<ContextResult>;
  /** Does the book have any text inside the boundary? Only asked when nothing matched. */
  hasReadableText(boundary: number): Promise<boolean>;
  provider: ChatProvider;
  config: AssistantConfig;
  /** Recent stored messages, oldest first (all positions; filtered here). */
  history: HistoryMessage[];
  signal?: AbortSignal;
};

const NOT_STARTED =
  "You haven't read anything yet, so I have nothing I can safely draw on. Read a little (or use “I've read up to here”) and ask again.";
const NO_TEXT = "This book has no chapter text in Recall yet. Import or paste the text so I can look at what you've read.";
const noEvidence = (boundary: number, partial: number) =>
  partial >= 0
    ? `I couldn't find anything about that in the chapters you've finished (through chapter ${boundary}) or the part of chapter ${boundary + 1} you've reached. It may not have come up yet, or try different words.`
    : `I couldn't find anything about that in the chapters you've read (through chapter ${boundary}). It may not have come up yet, or try different words.`;

export async function answerQuestion(args: {
  question: string;
  bookId: string;
  deps: AnswerDeps;
  /**
   * The passage the question is about, as the SERVER read it (selection_context). It is extra context for this
   * one question; it never widens retrieval, history or the stored position of anything but this message.
   */
  selection?: SelectionText;
}): Promise<AnswerOutcome> {
  const { question, bookId, deps, selection } = args;
  const { config } = deps;
  const notFound = { kind: "error", code: "not_found", message: friendlyMessage("not_found") } as const;
  // Words from the selection help find related text, but only INSIDE the boundary (the database applies it).
  const termsFor = (previous: string[] = []) => {
    const own = buildSearchTerms(question, previous);
    return selection ? [...new Set([...own, ...extractTerms(selection.text).slice(0, 8)])] : own;
  };

  // 1. Retrieval. The position is whatever the database says it is for THIS user and book.
  let ctx = await deps.getContext(termsFor());
  if (ctx.boundary === null) return notFound;
  // Nothing read yet is a dead end, unless the reader is asking about the passage in front of them.
  if (ctx.boundary === 0 && ctx.partial_block < 0 && !selection) return { kind: "not_started", text: NOT_STARTED, citations: [], boundary: 0, partialBlock: -1 };

  // 2. History, cut down to what is safe at THIS position (moving backward drops later messages).
  let history = selectHistory(deps.history, { chapter: ctx.boundary, block: ctx.partial_block }, config);

  // 3. A follow-up with too few words of its own ("what happened next?") borrows the previous question's
  //    words, and retrieval runs again: old passages are never reused.
  if (subjectTermCount(question) < 2 && history.length > 0) {
    const refreshed = await deps.getContext(termsFor(userQuestions(history)));
    if (refreshed.boundary === null) return notFound;
    if (refreshed.boundary === 0 && refreshed.partial_block < 0 && !selection) return { kind: "not_started", text: NOT_STARTED, citations: [], boundary: 0, partialBlock: -1 };
    if (refreshed.boundary !== ctx.boundary || refreshed.partial_block !== ctx.partial_block) {
      history = selectHistory(deps.history, { chapter: refreshed.boundary, block: refreshed.partial_block }, config);
    }
    ctx = refreshed;
  }
  const boundary = ctx.boundary as number;
  const partialBlock = ctx.partial_block;
  // The position this message is stored under. If the question used text beyond the recorded boundary (the selected
  // passage), the message belongs at THAT position, so it is dropped from history, and from the chat shown, as soon
  // as the reader is anywhere before it.
  const storedBlock = selection?.isCurrentChapter ? Math.max(partialBlock, selection.block_last) : partialBlock;

  const passages = selectPassages(ctx.passages, config);
  if (passages.length === 0 && !selection) {
    // Nothing relevant inside the boundary: say so without spending a model call.
    const hasText = partialBlock >= 0 || (await deps.hasReadableText(boundary));
    return hasText
      ? { kind: "no_evidence", text: noEvidence(boundary, partialBlock), citations: [], boundary, partialBlock }
      : { kind: "no_text", text: NO_TEXT, citations: [], boundary, partialBlock };
  }

  // 4. Ask the model, with only these passages.
  const prompt = buildPrompt({ question, passages, history, boundary, partialBlock, selection });
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
  return { kind: "answer", text, citations, boundary, partialBlock: storedBlock };
}
