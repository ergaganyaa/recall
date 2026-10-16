import "server-only";
import { cache } from "react";
import { inReadingOrder, resolveCover, type CoverChapter, type CoverVolume } from "./cover";
import { getUser } from "./auth";
import { parseBookParam } from "./book-slug";
import { EXTENSION_FOR } from "./image-sniff";
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

export const BOOK_COLS =
  "id,slug,title,author,description,cover_url,source_url,status,is_sample,is_featured,language,cover_image_id,created_at";
const VOLUME_COLS = "id,number,title,arc,arc_order,language,imported_at,cover_image_id";
const CHAPTER_COLS = "id,number,title,volume_id,source_url,word_count,image_count";

type ChapterRow = Omit<ChapterSummary, "has_content">;
const withContentFlag = (c: ChapterRow): ChapterSummary => ({
  ...c,
  has_content: c.word_count > 0 || c.image_count > 0,
});

/** Reading order: arcs first (e.g. school years), then volume number (4.5 sorts between 4 and 5). */
export const sortVolumes = inReadingOrder;

export type LibraryItem = Book & {
  chapter_count: number;
  /** Chapters that have text or illustrations (the rest are catalog entries only). */
  content_count: number;
  last_read_chapter: number;
  current_chapter: number;
  /** word/image counts per chapter, used for honest progress */
  chapters: { word_count: number; image_count: number }[];
  /** the book's cover as shown: manual choice, else the cover of the volume THIS user is reading, else a linked cover, else null */
  cover_src: string | null;
};

type LibraryRow = Book & {
  volumes: CoverVolume[];
  chapters: (CoverChapter & { word_count: number; image_count: number })[];
  reading_progress: Progress | Progress[] | null;
};

export async function listLibrary(): Promise<LibraryItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select(
      `${BOOK_COLS}, chapters(number,volume_id,word_count,image_count), volumes(id,number,arc_order,imported_at,cover_image_id), reading_progress(last_read_chapter,current_chapter,scroll_pct,partial_read_block,partial_rev,resume_block)`,
    )
    .order("is_featured", { ascending: false })
    .order("created_at", { ascending: false })
    .overrideTypes<LibraryRow[], { merge: false }>();
  if (error) throw new Error("Couldn't load your library.");

  return data.map(({ chapters, volumes, reading_progress, ...book }) => {
    const p = Array.isArray(reading_progress) ? reading_progress[0] : reading_progress;
    const list = chapters ?? [];
    return {
      ...book,
      // The progress row belongs to the signed-in user (row level security), so the cover follows THEIR position.
      cover_src: resolveCover(book, volumes ?? [], { chapters: list, currentChapter: p ? p.current_chapter : null }).src,
      chapters: list,
      chapter_count: list.length,
      content_count: list.filter((c) => c.word_count > 0 || c.image_count > 0).length,
      last_read_chapter: p?.last_read_chapter ?? 0,
      current_chapter: p?.current_chapter ?? 1,
    };
  });
}

// Address (slug) -> id. A book's id never changes, so a found id is remembered per signed-in user for the life of the
// process (the first visit costs one lookup, later ones none). If the book is later deleted and its slug reused, the
// stale entry finds nothing; pages call forgetBook() when that happens, so the next request resolves it afresh.
const resolved = new Map<string, string>();
const cacheKey = (userId: string | undefined, slug: string) => `${userId ?? ""}:${slug}`;

/**
 * The id of the book a /library/[bookId] address refers to (a slug, or a full id from an older link), or null.
 * Only the signed-in user's own books can be found (row level security).
 */
export async function resolveBookId(param: string): Promise<string | null> {
  const ref = parseBookParam(param);
  if (!ref) return null;
  if (ref.kind === "id") return ref.id;
  const user = await getUser();
  const key = cacheKey(user?.id, ref.slug);
  const known = resolved.get(key);
  if (known) return known;
  const supabase = await createClient();
  const { data, error } = await supabase.from("books").select("id").eq("slug", ref.slug).maybeSingle();
  if (error) throw new Error("Couldn't load this book.");
  if (!data) return null;
  if (resolved.size > 500) resolved.clear();
  resolved.set(key, data.id as string);
  return data.id as string;
}

export async function forgetBook(param: string) {
  const ref = parseBookParam(param);
  if (ref?.kind !== "slug") return;
  resolved.delete(cacheKey((await getUser())?.id, ref.slug));
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

export async function getFeaturedBook(): Promise<Book | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select(BOOK_COLS)
    .eq("is_featured", true)
    .maybeSingle<Book>();
  if (error) throw new Error("Couldn't load your featured book.");
  return data;
}

export async function getBookStructure(bookId: string, opts: { bookmarks?: boolean } = {}) {
  const supabase = await createClient();
  const [volumes, chapters, progress, bookmarks] = await Promise.all([
    supabase.from("volumes").select(VOLUME_COLS).eq("book_id", bookId),
    supabase.from("chapters").select(CHAPTER_COLS).eq("book_id", bookId).order("number"),
    supabase
      .from("reading_progress")
      .select("last_read_chapter,current_chapter,scroll_pct,partial_read_block,partial_rev,resume_block")
      .eq("book_id", bookId)
      .maybeSingle<Progress>(),
    // The reader does not show bookmarks, so it skips this query.
    opts.bookmarks === false
      ? Promise.resolve({ data: [], error: null })
      : supabase
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
    volumes: sortVolumes((volumes.data ?? []) as Volume[]),
    chapters: ((chapters.data ?? []) as ChapterRow[]).map(withContentFlag),
    progress: progress.data ?? { last_read_chapter: 0, current_chapter: 1, scroll_pct: 0, partial_read_block: -1, partial_rev: 0, resume_block: null },
    bookmarks: (bookmarks.data ?? []) as Bookmark[],
  };
}

export type ChapterImage = { id: string; width: number | null; height: number | null; alt: string | null; ext?: string };

export async function getChapter(
  bookId: string,
  number: number,
): Promise<(Chapter & { images: Record<string, ChapterImage> }) | null> {
  const supabase = await createClient();
  // The chapter and its illustrations' metadata come back in one request (the embed follows book_images.chapter_id).
  const { data, error } = await supabase
    .from("chapters")
    .select(`${CHAPTER_COLS},content,content_rev,book_images(id,width,height,alt,position,mime_type)`)
    .eq("book_id", bookId)
    .eq("number", number)
    .order("position", { referencedTable: "book_images" })
    .maybeSingle();
  if (error) throw new Error("Couldn't load this chapter.");
  if (!data) return null;

  const imgs = ((data as { book_images?: (ChapterImage & { position: number; mime_type?: string })[] }).book_images ?? []).map(
    ({ id, width, height, alt, mime_type }) => ({ id, width, height, alt, ext: (EXTENSION_FOR as Record<string, string>)[mime_type ?? ""] }),
  );
  return {
    ...withContentFlag(data as ChapterRow),
    content: (data as { content: string | null }).content,
    content_rev: (data as { content_rev: number }).content_rev ?? 0,
    images: Object.fromEntries(imgs.map((i) => [i.id, i])),
  };
}

export async function getChat(bookId: string): Promise<ChatMessage[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id,role,content,boundary_chapter,boundary_block,created_at,sources")
    .eq("book_id", bookId)
    .order("created_at")
    .limit(100);
  if (error) throw new Error("Couldn't load the conversation.");
  return (data ?? []) as ChatMessage[];
}
