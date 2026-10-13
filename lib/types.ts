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
  created_at: string;
};

export type Volume = {
  id: string;
  number: number;
  title: string | null;
};

export type ChapterSummary = {
  id: string;
  number: number;
  title: string;
  volume_id: string | null;
  source_url: string | null;
  word_count: number;
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
  | { ok: false; error: string };
