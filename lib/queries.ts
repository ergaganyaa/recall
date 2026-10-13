import "server-only";
import { cache } from "react";
import { createClient } from "./supabase/server";
import type {
  Book,
  Bookmark,
  Chapter,
  ChapterSummary,
  ChatMessage,
  Progress,
  Volume,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

const BOOK_COLS =
  "id,title,author,description,cover_url,source_url,status,is_sample,created_at";

export type LibraryItem = Book & {
  chapter_count: number;
  last_read_chapter: number;
  current_chapter: number;
};

type LibraryRow = Book & {
  chapters: { count: number }[];
  reading_progress: Progress | Progress[] | null;
};

export async function listLibrary(): Promise<LibraryItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select(`${BOOK_COLS}, chapters(count), reading_progress(last_read_chapter,current_chapter,scroll_pct)`)
    .order("created_at", { ascending: false })
    .overrideTypes<LibraryRow[], { merge: false }>();
  if (error) throw new Error("Couldn't load your library.");

  return data.map(({ chapters, reading_progress, ...book }) => {
    const p = Array.isArray(reading_progress) ? reading_progress[0] : reading_progress;
    return {
      ...book,
      chapter_count: chapters?.[0]?.count ?? 0,
      last_read_chapter: p?.last_read_chapter ?? 0,
      current_chapter: p?.current_chapter ?? 1,
    };
  });
}

export const getBook = cache(async (id: string): Promise<Book | null> => {
  if (!isUuid(id)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select(BOOK_COLS)
    .eq("id", id)
    .maybeSingle<Book>();
  if (error) throw new Error("Couldn't load this book.");
  return data;
});

export async function getBookStructure(bookId: string) {
  const supabase = await createClient();
  const [volumes, chapters, progress, bookmarks] = await Promise.all([
    supabase.from("volumes").select("id,number,title").eq("book_id", bookId).order("number"),
    supabase
      .from("chapters")
      .select("id,number,title,volume_id,source_url,word_count")
      .eq("book_id", bookId)
      .order("number"),
    supabase
      .from("reading_progress")
      .select("last_read_chapter,current_chapter,scroll_pct")
      .eq("book_id", bookId)
      .maybeSingle<Progress>(),
    supabase
      .from("bookmarks")
      .select("id,chapter_number,scroll_pct,note,created_at")
      .eq("book_id", bookId)
      .order("chapter_number")
      .order("created_at"),
  ]);
  if (volumes.error || chapters.error || progress.error || bookmarks.error) {
    throw new Error("Couldn't load the chapters.");
  }

  return {
    volumes: (volumes.data ?? []) as Volume[],
    chapters: (chapters.data ?? []).map((c) => ({
      ...c,
      has_content: c.word_count > 0,
    })) as ChapterSummary[],
    progress: progress.data ?? { last_read_chapter: 0, current_chapter: 1, scroll_pct: 0 },
    bookmarks: (bookmarks.data ?? []) as Bookmark[],
  };
}

export async function getChapter(bookId: string, number: number): Promise<Chapter | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("chapters")
    .select("id,number,title,volume_id,source_url,word_count,content")
    .eq("book_id", bookId)
    .eq("number", number)
    .maybeSingle();
  if (error) throw new Error("Couldn't load this chapter.");
  if (!data) return null;
  return { ...data, has_content: data.word_count > 0 } as Chapter;
}

export async function getChat(bookId: string): Promise<ChatMessage[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id,role,content,boundary_chapter,created_at")
    .eq("book_id", bookId)
    .order("created_at")
    .limit(100);
  if (error) throw new Error("Couldn't load the conversation.");
  return (data ?? []) as ChatMessage[];
}
