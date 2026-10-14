import type { HistoryMessage, ReadingPosition } from "./types";

/** Lexicographic: a later chapter is always later; within a chapter, a later paragraph is later. */
export const comparePositions = (a: ReadingPosition, b: ReadingPosition) => a.chapter - b.chapter || a.block - b.block;

/**
 * Conversation context for a follow-up question, under a size budget.
 *
 * Spoiler rule: earlier messages can NEVER carry the reader past their current position. Each stored
 * message remembers the position it was produced under, as (complete chapters, paragraph within the next
 * chapter). A message produced under a position AFTER today's (the reader moved backward, even by a few
 * paragraphs) may contain events they have not reached, so it is dropped, and so is any message with an
 * unknown position. History is context only; it is never evidence.
 *
 * `position` may be a plain number (complete chapters, no in-chapter position) for chapter-level callers.
 */
export function selectHistory(
  messages: HistoryMessage[],
  position: number | ReadingPosition,
  opts: { historyChars: number; historyMessages: number },
): { role: "user" | "assistant"; content: string }[] {
  if (opts.historyChars <= 0 || opts.historyMessages <= 0) return [];
  const now: ReadingPosition = typeof position === "number" ? { chapter: position, block: -1 } : position;

  const safe = (m: HistoryMessage) =>
    m.boundary_chapter !== null && comparePositions({ chapter: m.boundary_chapter, block: m.boundary_block ?? -1 }, now) <= 0;

  // Only complete user→assistant pairs where BOTH sides are within the boundary.
  const pairs: [HistoryMessage, HistoryMessage][] = [];
  for (let i = 0; i + 1 < messages.length; i++) {
    const a = messages[i];
    const b = messages[i + 1];
    if (a.role === "user" && b.role === "assistant" && safe(a) && safe(b)) {
      pairs.push([a, b]);
      i++;
    }
  }

  // Newest pairs first until the budget is used, then back into chronological order.
  const out: { role: "user" | "assistant"; content: string }[] = [];
  let chars = 0;
  for (let i = pairs.length - 1; i >= 0; i--) {
    const [u, a] = pairs[i];
    const cost = u.content.length + a.content.length;
    if (out.length + 2 > opts.historyMessages || chars + cost > opts.historyChars) break;
    out.unshift({ role: "user", content: u.content }, { role: "assistant", content: a.content });
    chars += cost;
  }
  return out;
}

/** The user questions that survive the boundary filter, newest last (used to resolve follow-ups). */
export const userQuestions = (history: { role: "user" | "assistant"; content: string }[]) =>
  history.filter((m) => m.role === "user").map((m) => m.content);
