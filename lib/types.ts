export const BOOK_STATUSES = [
  "reading",
  "plan_to_read",
  "on_hold",
  "completed",
  "dropped",
] as const;
export type BookStatus = (typeof BOOK_STATUSES)[number];

export const STATUS_LABELS: Record<BookStatus, string> = {
  reading: "Reading",
  plan_to_read: "Plan to read",
  on_hold: "On hold",
  completed: "Completed",
  dropped: "Dropped",
};

export type Book = {
  id: string;
  title: string;
  author: string | null;
  description: string | null;
  cover_url: string | null;
  source_url: string | null;
  status: BookStatus;
  is_sample: boolean;
  is_featured: boolean;
  language: string | null;
  cover_image_id: string | null;
  created_at: string;
};

export type Volume = {
  id: string;
  /** Decimal-safe: 4.5 is a valid volume number. */
  number: number;
  title: string | null;
  /** Arc / school year; (arc_order, number) is the reading order. */
  arc: string | null;
  arc_order: number;
  language: string | null;
  /** Set only when an import finished successfully; volumes without it never affect the book cover. */
  imported_at: string | null;
  /** This volume's own cover (separate from the illustrations inside the reader). */
  cover_image_id: string | null;
};

export type ChapterSummary = {
  id: string;
  number: number;
  title: string;
  volume_id: string | null;
  source_url: string | null;
  word_count: number;
  image_count: number;
  /** True when the chapter has text or illustrations (false = catalog entry only). */
  has_content: boolean;
};

export type Chapter = ChapterSummary & {
  content: string | null;
};

export type Progress = {
  last_read_chapter: number;
  current_chapter: number;
  scroll_pct: number;
};

export type Bookmark = {
  id: string;
  chapter_number: number;
  scroll_pct: number;
  note: string | null;
  created_at: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  boundary_chapter: number | null;
  created_at: string;
  /** Chapters an assistant answer drew on (null for questions and older messages) */
  sources: import("./assistant/types").Citation[] | null;
};

export type Passage = {
  chunk_id: string;
  chapter_number: number;
  chapter_title: string;
  content: string;
  rank: number;
};

/** Result shape for server actions called from client components. */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; /** machine-readable reason for the UI, e.g. "missing_key" */ code?: string };
