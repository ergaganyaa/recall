"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { importFromRanobelib, parseNovelUrl, type ImportOutcome } from "@/lib/import/ranobelib";
import { insertStructure, setChapterContent } from "@/lib/indexing";
import { analyzeOutline, MAX_OUTLINE_CHAPTERS, MAX_OUTLINE_CHARS } from "@/lib/outline";
import { isUuid } from "@/lib/queries";
import { validateChapterText } from "@/lib/text-file";
import { SAMPLE_BOOK } from "@/lib/sample-book";
import { createClient } from "@/lib/supabase/server";
import { BOOK_STATUSES, type ActionResult } from "@/lib/types";
import { bookPath } from "@/lib/book-slug";

export type CreateBookState = { error?: string };

/** Step 1 of URL import: fetch whatever public metadata is available. */
export async function importNovelFromUrl(url: string): Promise<ImportOutcome> {
  await requireUser();
  if (typeof url !== "string" || url.length > 2000) {
    return { ok: false, error: "That link is too long.", fallbackTitle: null, source_url: null };
  }
  return importFromRanobelib(url);
}

const optionalHttps = z
  .string()
  .trim()
  .max(2000, "The cover link is too long.")
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || /^https:\/\//i.test(v), "The cover link must start with https://");

const bookSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(300, "The title is too long (300 characters max)."),
  author: z.string().trim().max(200, "The author name is too long (200 characters max).").transform((v) => v || null),
  description: z
    .string()
    .trim()
    .max(4000, "The description is too long (4000 characters max).")
    .transform((v) => v || null),
  cover_url: optionalHttps,
  source_url: z
    .string()
    .trim()
    .max(2000, "The source link is too long.")
    .transform((v) => v || null)
    .refine((v) => v === null || parseNovelUrl(v) !== null, "The source link must be an https://ranobelib.me/ URL."),
  status: z.enum(BOOK_STATUSES),
  outline: z.string().max(MAX_OUTLINE_CHARS, "The chapter outline is too long."),
});

/** Step 2 (and the manual path): create the book from the confirmed details. */
export async function createBook(_prev: CreateBookState, formData: FormData): Promise<CreateBookState> {
  await requireUser();
  const parsed = bookSchema.safeParse({
    title: formData.get("title") ?? "",
    author: formData.get("author") ?? "",
    description: formData.get("description") ?? "",
    cover_url: formData.get("cover_url") ?? "",
    source_url: formData.get("source_url") ?? "",
    status: formData.get("status") ?? "reading",
    outline: formData.get("outline") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { outline: outlineText, ...fields } = parsed.data;
  const outline = analyzeOutline(outlineText);
  if (outline.chapterCount > MAX_OUTLINE_CHAPTERS) {
    return { error: `That's ${outline.chapterCount} chapters — please add at most ${MAX_OUTLINE_CHAPTERS} at a time.` };
  }

  const supabase = await createClient();
  const { data: book, error } = await supabase.from("books").insert(fields).select("id,slug").single();
  if (error || !book) return { error: "Couldn't save the novel. Please try again." };

  try {
    await supabase.from("reading_progress").insert({ book_id: book.id });
    if (outline.chapterCount) await insertStructure(supabase, book.id, outline.groups);
  } catch {
    await supabase.from("books").delete().eq("id", book.id); // don't leave a half-built book
    return { error: "Couldn't save the chapter outline. Please try again." };
  }

  revalidatePath("/library");
  revalidatePath("/profile");
  redirect(bookPath(book));
}

/** Adds the bundled original sample novel (mock content) to the library. */
export async function addSampleBook(): Promise<void> {
  await requireUser();
  const supabase = await createClient();

  const { data: book, error } = await supabase
    .from("books")
    .insert({
      title: SAMPLE_BOOK.title,
      author: SAMPLE_BOOK.author,
      description: SAMPLE_BOOK.description,
      status: "reading",
      is_sample: true,
    })
    .select("id,slug")
    .single();
  if (error || !book) throw new Error("Couldn't add the sample novel.");

  try {
    await supabase.from("reading_progress").insert({ book_id: book.id });
    const { chapterIds } = await insertStructure(supabase, book.id, [
      { heading: true, title: SAMPLE_BOOK.volumes[0].title, chapters: SAMPLE_BOOK.chapters.map((c) => c.title) },
    ]);
    for (const [i, id] of chapterIds.entries()) {
      await setChapterContent(supabase, { id, book_id: book.id, number: i + 1 }, SAMPLE_BOOK.chapters[i].content);
    }
  } catch {
    await supabase.from("books").delete().eq("id", book.id);
    throw new Error("Couldn't add the sample novel.");
  }

  revalidatePath("/library");
  revalidatePath("/profile");
  redirect(bookPath(book));
}

export async function deleteBook(bookId: string): Promise<ActionResult> {
  await requireUser();
  if (!isUuid(bookId)) return { ok: false, error: "Invalid book." };
  const supabase = await createClient();
  const { error } = await supabase.from("books").delete().eq("id", bookId);
  if (error) return { ok: false, error: "Couldn't remove this book." };
  revalidatePath("/library");
  revalidatePath("/profile");
  return { ok: true, data: undefined };
}

export async function updateBookStatus(bookId: string, status: string): Promise<ActionResult> {
  await requireUser();
  const parsed = z.enum(BOOK_STATUSES).safeParse(status);
  if (!isUuid(bookId) || !parsed.success) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.from("books").update({ status: parsed.data }).eq("id", bookId);
  if (error) return { ok: false, error: "Couldn't update the status." };
  revalidatePath("/library");
  revalidatePath("/profile");
  return { ok: true, data: undefined };
}

const chapterTextSchema = z.object({
  bookId: z.string().refine(isUuid, "Invalid book."),
  chapterNumber: z.number().int().min(0).max(100_000), // 0 = add as a new chapter
  title: z.string().trim().max(300, "The chapter title is too long (300 characters max)."),
  content: z.string(),
});

/** Adds text to an existing chapter, or creates a new chapter at the end. */
export async function saveChapterText(input: {
  bookId: string;
  chapterNumber: number;
  title: string;
  content: string;
}): Promise<ActionResult<{ chapterNumber: number }>> {
  await requireUser();
  const parsed = chapterTextSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  const { bookId, chapterNumber, title, content } = parsed.data;

  const problem = validateChapterText(content);
  if (problem) return { ok: false, error: problem };

  const supabase = await createClient();
  try {
    let chapter: { id: string; number: number } | null = null;
    let created = false;

    if (chapterNumber > 0) {
      const { data } = await supabase
        .from("chapters")
        .select("id,number")
        .eq("book_id", bookId)
        .eq("number", chapterNumber)
        .maybeSingle();
      chapter = data;
      if (!chapter) return { ok: false, error: "That chapter doesn't exist." };
    } else {
      if (!title) return { ok: false, error: "Give the new chapter a title." };
      const { data: last } = await supabase
        .from("chapters")
        .select("number,volume_id")
        .eq("book_id", bookId)
        .order("number", { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data, error } = await supabase
        .from("chapters")
        // New chapters continue in the same volume as the previous last chapter.
        .insert({ book_id: bookId, number: (last?.number ?? 0) + 1, title, volume_id: last?.volume_id ?? null })
        .select("id,number")
        .single();
      if (error || !data) return { ok: false, error: "Couldn't create the chapter. Please try again." };
      chapter = data;
      created = true;
    }

    try {
      await setChapterContent(supabase, { id: chapter.id, book_id: bookId, number: chapter.number }, content);
    } catch (e) {
      // Don't leave an empty chapter behind when the text itself failed to save.
      if (created) await supabase.from("chapters").delete().eq("id", chapter.id);
      throw e;
    }
    revalidatePath("/library/[bookId]", "page"); // every address of the book (readable or id)
    return { ok: true, data: { chapterNumber: chapter.number } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

/**
 * Appends chapters (titles only) from a plain-text outline to an existing book.
 * Heading lines start new volumes; chapters before the first heading continue
 * the book's last volume.
 */
export async function addChaptersFromOutline(
  bookId: string,
  outlineText: string,
): Promise<ActionResult<{ added: number; volumes: number; warnings: string[] }>> {
  await requireUser();
  if (!isUuid(bookId)) return { ok: false, error: "Invalid book." };
  if (typeof outlineText !== "string" || outlineText.length > MAX_OUTLINE_CHARS) {
    return { ok: false, error: "The chapter list is too long." };
  }

  const outline = analyzeOutline(outlineText);
  if (outline.chapterCount === 0) {
    return { ok: false, error: "No chapter titles found. Put one chapter title on each line." };
  }
  if (outline.chapterCount > MAX_OUTLINE_CHAPTERS) {
    return { ok: false, error: `That's ${outline.chapterCount} chapters — please add at most ${MAX_OUTLINE_CHAPTERS} at a time.` };
  }

  const supabase = await createClient();
  const [{ data: last }, { data: lastVolume }] = await Promise.all([
    supabase
      .from("chapters")
      .select("number,volume_id")
      .eq("book_id", bookId)
      .order("number", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("volumes")
      .select("id,number")
      .eq("book_id", bookId)
      .order("number", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  try {
    await insertStructure(supabase, bookId, outline.groups, {
      startNumber: (last?.number ?? 0) + 1,
      startVolumeNumber: (lastVolume?.number ?? 0) + 1,
      fallbackVolumeId: last?.volume_id ?? lastVolume?.id ?? null,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't add the chapters." };
  }

  revalidatePath("/library/[bookId]", "page"); // every address of the book (readable or id)
  return {
    ok: true,
    data: { added: outline.chapterCount, volumes: outline.volumeCount, warnings: outline.warnings },
  };
}
