"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prepareChapter } from "@/lib/chapter-content";
import { FEATURED_SERIES } from "@/lib/featured";
import { ALLOWED_IMAGE_TYPES, EXTENSION_FOR, type ImageType } from "@/lib/image-sniff";
import { IDX_GENERATION, storeChapterBody } from "@/lib/indexing";
import { timed } from "@/lib/timing";
import { isUuid } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

const BUCKET = "book-images";
const uuid = z.string().refine(isUuid, "Invalid id.");

const imageSchema = z.object({
  id: uuid,
  path: z.string().max(400),
  mime: z.enum(ALLOWED_IMAGE_TYPES),
  width: z.number().int().min(1).max(30_000).nullable(),
  height: z.number().int().min(1).max(30_000).nullable(),
  bytes: z.number().int().min(1).max(15 * 1024 * 1024),
  alt: z.string().max(500).nullable(),
});
type ImageInput = z.infer<typeof imageSchema>;

/** Images must live under the caller's own folder, named by their own id. Prevents pointing at other users' objects. */
const expectedPath = (userId: string, bookId: string, img: { id: string; mime: ImageType }) =>
  `${userId}/${bookId}/${img.id}.${EXTENSION_FOR[img.mime]}`;

async function removeObjects(supabase: SupabaseClient, paths: string[]) {
  for (let i = 0; i < paths.length; i += 100) {
    await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 100)); // best effort
  }
}

// ---------------------------------------------------------------- start a volume
const startSchema = z.object({
  bookId: uuid,
  number: z
    .number()
    .min(0.01, "The volume number must be greater than 0.")
    .max(9999)
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, "Use at most two decimals (e.g. 4.5)."),
  arc: z.string().trim().max(120, "The arc name is too long."),
  arcOrder: z.number().int().min(1).max(99),
  title: z.string().trim().max(300, "The volume title is too long."),
  language: z.string().trim().max(20),
  replace: z.boolean(),
  chapterTitles: z.array(z.string().max(300)).min(1, "Select at least one chapter.").max(3000),
});

export type StartedVolume = {
  userId: string;
  volumeId: string;
  chapters: { id: string; number: number }[];
};

/**
 * Creates the volume and its chapter rows (all "metadata only" until their text
 * arrives) in the right reading-order slot. The database function renumbers later
 * chapters and moves progress/bookmarks atomically.
 */
export async function startVolumeImport(
  input: z.input<typeof startSchema>,
): Promise<ActionResult<StartedVolume>> {
  const user = await requireUser();
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  const v = parsed.data;
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("volumes")
    .select("id")
    .eq("book_id", v.bookId)
    .eq("arc_order", v.arcOrder)
    .eq("number", v.number)
    .maybeSingle();

  if (existing) {
    if (!v.replace) {
      return { ok: false, error: `Volume ${v.number} already exists. Tick “Replace” to re-import it.` };
    }
    const removed = await removeVolume(supabase, existing.id);
    if (!removed.ok) return removed;
  }

  const { data, error } = await supabase.rpc("insert_volume", {
    p_book_id: v.bookId,
    p_arc: v.arc || null,
    p_arc_order: v.arcOrder,
    p_number: v.number,
    p_title: v.title || null,
    p_language: v.language || null,
    p_chapters: v.chapterTitles.map((title) => ({ title })),
  });
  if (error || !data) {
    return { ok: false, error: error?.code === "23505" ? "That volume already exists." : "Couldn't create the volume. Nothing was changed." };
  }

  const rows = data as { volume_id: string; chapter_id: string; chapter_number: number }[];
  revalidatePath("/library/[bookId]", "page"); // every address of the book (readable or id)
  return {
    ok: true,
    data: {
      userId: user.id,
      volumeId: rows[0].volume_id,
      chapters: rows.map((r) => ({ id: r.chapter_id, number: r.chapter_number })),
    },
  };
}

// ------------------------------------------------------------- save one chapter
const chapterSchema = z.object({
  bookId: uuid,
  chapterId: uuid,
  content: z.string().max(2_000_000),
  images: z.array(imageSchema).max(300),
});

/**
 * Saves one imported chapter: text and image markers in order, the passage index
 * (text only), and the image records. Safe to call again for the same chapter.
 */
export async function saveImportedChapter(
  input: z.input<typeof chapterSchema>,
): Promise<ActionResult<{ wordCount: number; imageCount: number }>> {
  const user = await requireUser();
  const parsed = chapterSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid chapter data." };
  const { bookId, chapterId, content, images } = parsed.data;

  for (const img of images) {
    if (img.path !== expectedPath(user.id, bookId, img)) return { ok: false, error: "An illustration has an invalid storage path." };
  }

  const prepared = prepareChapter(content, images.map((i) => i.id));
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const body = prepared.value;

  const supabase = await createClient();
  // Three independent reads in ONE round trip (they used to run one after another). The two that look
  // at other tables are scoped by row level security, so for a chapter that is not theirs they find nothing.
  const [{ data: chapter }, { data: old }, { data: highChunks }] = await timed("save chapter: reads", () =>
    Promise.all([
      supabase.from("chapters").select("id,number,book_id").eq("id", chapterId).eq("book_id", bookId).maybeSingle(),
      supabase.from("book_images").select("id,storage_path").eq("chapter_id", chapterId),
      supabase.from("chunks").select("idx").eq("chapter_id", chapterId).gte("idx", IDX_GENERATION).limit(1),
    ]),
  );
  if (!chapter) return { ok: false, error: "That chapter doesn't exist." };

  try {
    // Replace any illustrations from an earlier attempt/import of this chapter.
    const keep = new Set(images.map((i) => i.id));
    const stale = (old ?? []).filter((o) => !keep.has(o.id as string));
    if (stale.length) {
      await supabase.from("book_images").delete().in("id", stale.map((s) => s.id as string));
      await removeObjects(supabase, stale.map((s) => s.storage_path as string));
    }

    if (images.length) {
      const order = new Map(body.imageIds.map((id, i) => [id, i]));
      const { error } = await supabase.from("book_images").upsert(
        images.map((img) => ({
          id: img.id,
          book_id: bookId,
          chapter_id: chapterId,
          position: order.get(img.id.toLowerCase()) ?? 0,
          storage_path: img.path,
          mime_type: img.mime,
          width: img.width,
          height: img.height,
          bytes: img.bytes,
          alt: img.alt,
        })),
        { onConflict: "id" },
      );
      if (error) throw new Error("Couldn't save the illustrations.");
    }

    await storeChapterBody(supabase, { id: chapter.id, book_id: bookId, number: chapter.number }, {
      content: body.content,
      chunks: body.chunks,
      chunkRanges: body.chunkRanges,
      wordCount: body.wordCount,
      imageCount: body.imageIds.length,
    }, { oldIsHigh: (highChunks?.length ?? 0) > 0 });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save this chapter." };
  }

  return { ok: true, data: { wordCount: body.wordCount, imageCount: body.imageIds.length } };
}

// ------------------------------------------------------------------- the cover
export async function setBookCover(input: {
  bookId: string;
  image: ImageInput;
}): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = z.object({ bookId: uuid, image: imageSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid cover image." };
  const { bookId, image } = parsed.data;
  if (image.path !== expectedPath(user.id, bookId, image)) return { ok: false, error: "The cover has an invalid storage path." };

  const supabase = await createClient();
  const { data: book } = await supabase.from("books").select("id,cover_image_id").eq("id", bookId).maybeSingle();
  if (!book) return { ok: false, error: "Book not found." };

  const { error } = await supabase.from("book_images").insert({
    id: image.id,
    book_id: bookId,
    chapter_id: null,
    storage_path: image.path,
    mime_type: image.mime,
    width: image.width,
    height: image.height,
    bytes: image.bytes,
  });
  if (error) return { ok: false, error: "Couldn't save the cover." };

  const { error: upErr } = await supabase.from("books").update({ cover_image_id: image.id }).eq("id", bookId);
  if (upErr) return { ok: false, error: "Couldn't set the cover." };

  if (book.cover_image_id) {
    const { data: prev } = await supabase.from("book_images").select("storage_path").eq("id", book.cover_image_id).maybeSingle();
    await supabase.from("book_images").delete().eq("id", book.cover_image_id);
    if (prev) await removeObjects(supabase, [prev.storage_path as string]);
  }
  revalidatePath("/");
  revalidatePath("/library");
  revalidatePath("/library/[bookId]", "page"); // every address of the book (readable or id)
  return { ok: true, data: undefined };
}

// ------------------------------------------------------------- remove a volume
async function removeVolume(supabase: SupabaseClient, volumeId: string): Promise<ActionResult> {
  const { data: chapters } = await supabase.from("chapters").select("id").eq("volume_id", volumeId);
  const ids = (chapters ?? []).map((c) => c.id as string);
  const paths: string[] = [];
  if (ids.length) {
    const { data: imgs } = await supabase.from("book_images").select("storage_path").in("chapter_id", ids);
    paths.push(...(imgs ?? []).map((i) => i.storage_path as string));
  }
  // The volume's own cover is stored separately from its reader images.
  const { data: vol } = await supabase.from("volumes").select("cover_image_id").eq("id", volumeId).maybeSingle();
  if (vol?.cover_image_id) {
    const { data: cover } = await supabase.from("book_images").select("storage_path").eq("id", vol.cover_image_id).maybeSingle();
    if (cover) paths.push(cover.storage_path as string);
  }
  await removeObjects(supabase, paths);
  const { error } = await supabase.rpc("delete_volume", { p_volume_id: volumeId });
  if (error) return { ok: false, error: "Couldn't remove the existing volume. Nothing was changed." };
  return { ok: true, data: undefined };
}

export async function deleteVolume(volumeId: string, bookId: string): Promise<ActionResult> {
  await requireUser();
  if (!isUuid(volumeId) || !isUuid(bookId)) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const res = await removeVolume(supabase, volumeId);
  if (res.ok) revalidatePath("/library/[bookId]", "page"); // every address of the book (readable or id)
  return res;
}

// ----------------------------------------------------------------- featured book
/** Creates (or reuses) the featured series record and makes it the Home page book. Metadata only. */
export async function setupFeaturedSeries(): Promise<ActionResult<{ bookId: string }>> {
  await requireUser();
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("books")
    .select("id")
    .eq("title", FEATURED_SERIES.title)
    .maybeSingle();

  let bookId = existing?.id as string | undefined;
  if (!bookId) {
    const { data, error } = await supabase
      .from("books")
      .insert({
        title: FEATURED_SERIES.title,
        author: FEATURED_SERIES.author,
        description: FEATURED_SERIES.description,
        source_url: FEATURED_SERIES.sourceUrl,
        status: "reading",
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: "Couldn't create the series." };
    bookId = data.id as string;
    await supabase.from("reading_progress").insert({ book_id: bookId });
  }

  const { error: featErr } = await supabase.rpc("set_featured_book", { p_book_id: bookId });
  if (featErr) return { ok: false, error: "Couldn't feature the series." };
  revalidatePath("/");
  revalidatePath("/library");
  return { ok: true, data: { bookId } };
}

export async function setFeaturedBook(bookId: string): Promise<ActionResult> {
  await requireUser();
  if (!isUuid(bookId)) return { ok: false, error: "Invalid book." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_featured_book", { p_book_id: bookId });
  if (error) return { ok: false, error: "Couldn't feature this book." };
  revalidatePath("/");
  revalidatePath("/library");
  return { ok: true, data: undefined };
}

// ------------------------------------------------------- finishing an import
const finalizeSchema = z.object({ bookId: uuid, volumeId: uuid, cover: imageSchema.omit({ alt: true }).nullable() });

/**
 * The last step of a volume import. Marks the volume as imported, which is what lets its cover be
 * used (as the library cover while the user reads it, and in the cover browser). Refuses unless EVERY chapter of the volume has text or
 * illustrations, so a partial import can never be marked complete.
 */
export async function finalizeVolumeImport(input: z.input<typeof finalizeSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = finalizeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const { bookId, volumeId, cover } = parsed.data;
  const supabase = await createClient();

  const { data: volume } = await supabase.from("volumes").select("id").eq("id", volumeId).eq("book_id", bookId).maybeSingle();
  if (!volume) return { ok: false, error: "That volume doesn't exist." };

  const { data: chapters, error } = await supabase
    .from("chapters")
    .select("word_count,image_count")
    .eq("volume_id", volumeId);
  if (error || !chapters || chapters.length === 0) return { ok: false, error: "Couldn't check the volume's chapters." };
  const empty = chapters.filter((c) => c.word_count === 0 && c.image_count === 0).length;
  if (empty > 0) {
    return { ok: false, error: `${empty} chapter${empty === 1 ? " is" : "s are"} still missing content, so the import isn't complete.` };
  }

  let coverId: string | null = null;
  if (cover) {
    if (cover.path !== expectedPath(user.id, bookId, cover)) return { ok: false, error: "The cover has an invalid storage path." };
    const { error: coverErr } = await supabase.from("book_images").insert({
      id: cover.id,
      book_id: bookId,
      chapter_id: null,
      storage_path: cover.path,
      mime_type: cover.mime,
      width: cover.width,
      height: cover.height,
      bytes: cover.bytes,
    });
    if (coverErr) return { ok: false, error: "Couldn't save the volume cover." };
    coverId = cover.id;
  }

  const { error: upErr } = await supabase
    .from("volumes")
    .update({ imported_at: new Date().toISOString(), cover_image_id: coverId })
    .eq("id", volumeId);
  if (upErr) {
    if (coverId) await supabase.from("book_images").delete().eq("id", coverId);
    return { ok: false, error: "Couldn't mark the volume as imported." };
  }

  revalidatePath("/");
  revalidatePath("/library");
  revalidatePath("/library/[bookId]", "page"); // every address of the book (readable or id)
  return { ok: true, data: undefined };
}

/** Goes back to the automatic cover (the volume the user is reading) by dropping a manually chosen one. */
export async function clearBookCover(bookId: string): Promise<ActionResult> {
  await requireUser();
  if (!isUuid(bookId)) return { ok: false, error: "Invalid book." };
  const supabase = await createClient();
  const { data: book } = await supabase.from("books").select("cover_image_id").eq("id", bookId).maybeSingle();
  if (!book) return { ok: false, error: "Book not found." };
  if (book.cover_image_id) {
    const { data: prev } = await supabase.from("book_images").select("storage_path").eq("id", book.cover_image_id).maybeSingle();
    const { error } = await supabase.from("books").update({ cover_image_id: null }).eq("id", bookId);
    if (error) return { ok: false, error: "Couldn't reset the cover." };
    await supabase.from("book_images").delete().eq("id", book.cover_image_id);
    if (prev) await removeObjects(supabase, [prev.storage_path as string]);
  }
  revalidatePath("/");
  revalidatePath("/library");
  revalidatePath("/library/[bookId]", "page"); // every address of the book (readable or id)
  return { ok: true, data: undefined };
}
