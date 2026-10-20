/**
 * "Remind me what happened": a short reminder of the story just before the reader's place.
 *
 * The same security model as answerQuestion, with every outside dependency injected:
 *   recap_context (boundary enforced in SQL) ─► newest-first budget ─► recap prompt (sources as DATA) ─► provider
 *   ─► validate citations ─► reminder
 *
 * Nothing in this file accepts a position, a chapter number or any text from a caller or the browser. The passages
 * and the boundary are exactly what the database returned for THIS user and book; if the database cannot validate
 * the book or the boundary, the result is an error or "nothing to recap yet", never an unrestricted summary.
 * No stored summary is read or written here, so there is nothing to go stale when progress moves backward.
 */
import { extractCitations } from "./citations";
import type { AssistantConfig } from "./config";
import { friendlyMessage } from "./errors";
import { buildRecapPrompt } from "./prompt";
import { ProviderError, type ChatProvider } from "./provider";
import { selectPassages } from "./retrieval";
import type { AnswerOutcome, ContextResult } from "./types";

export type RecapDeps = {
  /** The most recent text inside the boundary, in reading order (recap_context). */
  getRecapContext(): Promise<ContextResult>;
  provider: ChatProvider;
  config: AssistantConfig;
  signal?: AbortSignal;
};

export const RECAP_QUESTION = "Remind me what happened";

const NOT_STARTED = "You haven't read anything yet, so there's nothing to recap. Start reading and come back to this.";
const NO_TEXT = "This book has no chapter text in Recall yet. Import or paste the text, then ask again.";
const TOO_THIN = "There isn't enough text before your place to write a useful recap yet. Read a little further and try again.";
const MIN_CHARS = 200;

export async function generateRecap(args: { bookId: string; deps: RecapDeps }): Promise<AnswerOutcome> {
  const { bookId, deps } = args;
  const { config } = deps;

  const ctx = await deps.getRecapContext();
  // The database could not validate the book (not the caller's, or missing): fail closed.
  if (ctx.boundary === null) return { kind: "error", code: "not_found", message: friendlyMessage("not_found") };
  if (ctx.boundary === 0 && ctx.partial_block < 0) return { kind: "not_started", text: NOT_STARTED, citations: [], boundary: 0, partialBlock: -1 };

  // Newest first, so the character budget is spent on the most recent events; the result is back in reading order.
  const passages = selectPassages([...ctx.passages].reverse(), { maxPassages: 8, contextChars: config.contextChars });
  if (passages.length === 0) return { kind: "no_text", text: NO_TEXT, citations: [], boundary: ctx.boundary, partialBlock: ctx.partial_block };
  if (passages.reduce((n, p) => n + p.content.length, 0) < MIN_CHARS) {
    return { kind: "no_evidence", text: TOO_THIN, citations: [], boundary: ctx.boundary, partialBlock: ctx.partial_block };
  }

  const prompt = buildRecapPrompt({ passages, boundary: ctx.boundary, partialBlock: ctx.partial_block });
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

  // Citations are built from the passages we supplied (with their chapter and paragraph), never from the model's words.
  const { text, citations } = extractCitations(reply.text, passages, bookId);
  if (!text) return { kind: "error", code: "empty", message: friendlyMessage("empty") };
  return { kind: "answer", text, citations, boundary: ctx.boundary, partialBlock: ctx.partial_block };
}
