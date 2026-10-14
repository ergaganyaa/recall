/** Shared types for the assistant. Nothing here depends on a specific AI provider. */

/** One retrieved passage. Already filtered to the reading boundary by the database. */
export type SourcePassage = {
  chunk_id: string;
  chapter_id: string;
  chapter_number: number;
  chapter_title: string;
  volume_number: number | null;
  volume_title: string | null;
  arc: string | null;
  content: string;
  rank: number;
  /** Paragraph (block) range of the passage in the reader's numbering; null for passages indexed before 0006 */
  block_first: number | null;
  block_last: number | null;
};

/**
 * What `assistant_context` returns.
 *  - boundary: chapters 1..boundary are complete; null when the book is not the caller's.
 *  - partial_block: blocks 0..partial_block of chapter boundary+1 have also been read (-1 = none).
 */
export type ContextResult = { boundary: number | null; partial_block: number; passages: SourcePassage[] };

/** The reader's position: complete chapters plus blocks read of the next one. Ordered lexicographically. */
export type ReadingPosition = { chapter: number; block: number };

/** A stored chat message, with the reading boundary it was produced under. */
export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
  boundary_chapter: number | null;
  /** In-chapter position the message was produced under; null/absent = none (chapter-level only) */
  boundary_block?: number | null;
};

/** A source shown under an answer: one chapter, with the passage numbers that came from it. */
export type Citation = {
  chapter: number;
  /** e.g. "Vol. 2 · Ch. 14 — The Gate" */
  label: string;
  href: string;
  /** Paragraph to jump to in that chapter (the first cited passage's last paragraph), or null if unknown */
  block: number | null;
  /** Passage numbers ([1], [2]…) this chapter supplied */
  indices: number[];
  /** true when the answer actually cites it; false when it was only consulted */
  cited: boolean;
};

export type AssistantErrorCode =
  | "missing_key"
  | "invalid_key"
  | "rate_limited"
  | "local_rate_limited"
  | "timeout"
  | "blocked"
  | "empty"
  | "unavailable"
  | "model_unavailable"
  | "bad_request"
  | "not_found";

export type AnswerOutcome =
  | { kind: "answer"; text: string; citations: Citation[]; boundary: number; partialBlock: number }
  /** Answered without calling the model: nothing safe to draw on. */
  | { kind: "not_started" | "no_text" | "no_evidence"; text: string; citations: []; boundary: number; partialBlock: number }
  | { kind: "error"; code: AssistantErrorCode; message: string; retryAfterSec?: number };
