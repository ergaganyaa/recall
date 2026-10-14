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
};

/** What `assistant_context` returns. `boundary` is null when the book is not the caller's. */
export type ContextResult = { boundary: number | null; passages: SourcePassage[] };

/** A stored chat message, with the reading boundary it was produced under. */
export type HistoryMessage = { role: "user" | "assistant"; content: string; boundary_chapter: number | null };

/** A source shown under an answer: one chapter, with the passage numbers that came from it. */
export type Citation = {
  chapter: number;
  /** e.g. "Vol. 2 · Ch. 14 — The Gate" */
  label: string;
  href: string;
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
  | { kind: "answer"; text: string; citations: Citation[]; boundary: number }
  /** Answered without calling the model: nothing safe to draw on. */
  | { kind: "not_started" | "no_text" | "no_evidence"; text: string; citations: []; boundary: number }
  | { kind: "error"; code: AssistantErrorCode; message: string; retryAfterSec?: number };
