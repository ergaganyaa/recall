"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { computeBoundary } from "@/lib/progress";
import { isUuid } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, Bookmark } from "@/lib/types";

const idSchema = z.string().refine(isUuid, "Invalid id.");
const chapterSchema = z.number().int().min(1).max(100_000);

/** Remembers where the reader is, so they can resume exactly there. */
export async function saveProgress(
  bookId: string,
  chapter: number,
  scrollPct: number,
): Promise<ActionResult> {
  await requireUser();
  const parsed = z
    .object({ b: idSchema, c: chapterSchema, s: z.number().min(0).max(1) })
    .safeParse({ b: bookId, c: chapter, s: scrollPct });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const supabase = await createClient();
  // Only current_chapter/scroll_pct are written, so last_read_chapter is untouched.
  const { error } = await supabase.from("reading_progress").upsert(
    {
      book_id: parsed.data.b,
      current_chapter: parsed.data.c,
      scroll_pct: parsed.data.s,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "book_id" },
  );
  if (error) return { ok: false, error: "Couldn't save your place." };
  return { ok: true, data: undefined };
}

/**
 * Moves the spoiler boundary (rules live in lib/progress.ts).
 * - "advance": automatic; only ever moves forward by one chapter at a time.
 * - "set": explicit user choice ("I've read through chapter N"); may lower it.
 */
export async function markChapterRead(
  bookId: string,
  chapter: number,
  mode: "advance" | "set",
): Promise<ActionResult<{ lastRead: number; skippedAhead: boolean }>> {
  await requireUser();
  const parsed = z
    .object({ b: idSchema, c: z.number().int().min(0).max(100_000), m: z.enum(["advance", "set"]) })
    .safeParse({ b: bookId, c: chapter, m: mode });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const supabase = await createClient();
  const [{ data: top }, { data: existing }] = await Promise.all([
    supabase
      .from("chapters")
      .select("number")
      .eq("book_id", parsed.data.b)
      .order("number", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("reading_progress")
      .select("last_read_chapter")
      .eq("book_id", parsed.data.b)
      .maybeSingle(),
  ]);

  const result = computeBoundary({
    existing: existing?.last_read_chapter ?? 0,
    chapter: parsed.data.c,
    max: top?.number ?? 0,
    mode: parsed.data.m,
  });

  if (result.changed || !existing) {
    const { error } = await supabase.from("reading_progress").upsert(
      { book_id: parsed.data.b, last_read_chapter: result.lastRead, updated_at: new Date().toISOString() },
      { onConflict: "book_id" },
    );
    if (error) return { ok: false, error: "Couldn't update your progress." };
  }
  return { ok: true, data: { lastRead: result.lastRead, skippedAhead: result.skippedAhead } };
}

export async function addBookmark(
  bookId: string,
  chapter: number,
  scrollPct: number,
  note: string,
): Promise<ActionResult<Bookmark>> {
  await requireUser();
  const parsed = z
    .object({ b: idSchema, c: chapterSchema, s: z.number().min(0).max(1), n: z.string().trim().max(500) })
    .safeParse({ b: bookId, c: chapter, s: scrollPct, n: note });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bookmarks")
    .insert({
      book_id: parsed.data.b,
      chapter_number: parsed.data.c,
      scroll_pct: parsed.data.s,
      note: parsed.data.n || null,
    })
    .select("id,chapter_number,scroll_pct,note,created_at")
    .single<Bookmark>();
  if (error || !data) return { ok: false, error: "Couldn't add the bookmark." };
  return { ok: true, data };
}

export async function deleteBookmark(id: string): Promise<ActionResult> {
  await requireUser();
  if (!isUuid(id)) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.from("bookmarks").delete().eq("id", id);
  if (error) return { ok: false, error: "Couldn't remove the bookmark." };
  return { ok: true, data: undefined };
}
