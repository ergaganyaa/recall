import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkText, cleanText, countWords } from "./chunking";
import type { OutlineGroup } from "./outline";
import { validateChapterText } from "./text-file";

type StructureOptions = {
  /** Series-wide number for the first inserted chapter. */
  startNumber?: number;
  /** Number for the first newly created volume. */
  startVolumeNumber?: number;
  /** Where chapters that precede any volume heading go (existing last volume, or none). */
  fallbackVolumeId?: string | null;
};

/**
 * Inserts volumes and chapters for a book, numbering chapters across the series.
 * Groups that came from an explicit heading become new volumes; heading-less
 * chapters join `fallbackVolumeId` (or stay volume-less).
 */
export async function insertStructure(
  supabase: SupabaseClient,
  bookId: string,
  groups: OutlineGroup[],
  { startNumber = 1, startVolumeNumber = 1, fallbackVolumeId = null }: StructureOptions = {},
): Promise<{ chapterIds: string[] }> {
  const headed = groups.filter((g) => g.heading);
  const volumeIdByGroup = new Map<OutlineGroup, string>();

  if (headed.length) {
    const { data, error } = await supabase
      .from("volumes")
      .insert(headed.map((g, i) => ({ book_id: bookId, number: startVolumeNumber + i, title: g.title })))
      .select("id,number");
    if (error) throw new Error("Couldn't save volumes.");
    const byNumber = new Map((data ?? []).map((v) => [v.number as number, v.id as string]));
    headed.forEach((g, i) => {
      const id = byNumber.get(startVolumeNumber + i);
      if (id) volumeIdByGroup.set(g, id);
    });
  }

  let n = startNumber;
  const rows = groups.flatMap((g) =>
    g.chapters.map((title) => ({
      book_id: bookId,
      volume_id: volumeIdByGroup.get(g) ?? fallbackVolumeId,
      number: n++,
      title,
    })),
  );

  const chapterIds: string[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await supabase
      .from("chapters")
      .insert(rows.slice(i, i + 500))
      .select("id,number")
      .order("number");
    if (error) throw new Error("Couldn't save chapters.");
    chapterIds.push(...(data ?? []).map((r) => r.id as string));
  }
  return { chapterIds };
}

/** Chunk idx values alternate between two ranges so old and new passages can coexist briefly. */
const IDX_GENERATION = 1_000_000;

/**
 * Stores chapter text and rebuilds its passage index.
 *
 * New passages are written first (into the idx range the old ones don't use),
 * then the old passages are removed. A failure part-way therefore never leaves
 * the chapter with no searchable passages.
 */
export async function setChapterContent(
  supabase: SupabaseClient,
  chapter: { id: string; book_id: string; number: number },
  rawContent: string,
) {
  const content = cleanText(rawContent);
  const problem = validateChapterText(content);
  if (problem) throw new Error(problem);

  const { data: existing, error: existingErr } = await supabase
    .from("chunks")
    .select("idx")
    .eq("chapter_id", chapter.id)
    .gte("idx", IDX_GENERATION)
    .limit(1);
  if (existingErr) throw new Error("Couldn't update the search index.");
  const oldIsHigh = (existing?.length ?? 0) > 0;
  const base = oldIsHigh ? 0 : IDX_GENERATION;

  const rows = chunkText(content).map((text, i) => ({
    book_id: chapter.book_id,
    chapter_id: chapter.id,
    chapter_number: chapter.number,
    idx: base + i,
    content: text,
  }));

  const removeNew = () =>
    oldIsHigh
      ? supabase.from("chunks").delete().eq("chapter_id", chapter.id).lt("idx", IDX_GENERATION)
      : supabase.from("chunks").delete().eq("chapter_id", chapter.id).gte("idx", IDX_GENERATION);

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from("chunks").insert(rows.slice(i, i + 200));
    if (error) {
      await removeNew();
      throw new Error("Couldn't update the search index.");
    }
  }

  const { error: upErr } = await supabase
    .from("chapters")
    .update({ content, word_count: countWords(content) })
    .eq("id", chapter.id);
  if (upErr) {
    await removeNew();
    throw new Error("Couldn't save the chapter text.");
  }

  // Remove the previous generation (the range the new rows did not use).
  const { error: delErr } = oldIsHigh
    ? await supabase.from("chunks").delete().eq("chapter_id", chapter.id).gte("idx", IDX_GENERATION)
    : await supabase.from("chunks").delete().eq("chapter_id", chapter.id).lt("idx", IDX_GENERATION);
  if (delErr) throw new Error("Saved, but couldn't clean up the old search index.");
}
