/**
 * Orchestrates saving a parsed volume: create the volume, upload each chapter's
 * illustrations, save the chapter, and only when EVERYTHING succeeded mark the
 * volume as imported and set its cover. Dependencies are injected so the failure
 * and cleanup behaviour is unit-testable without a browser or a server.
 *
 * Guarantees:
 *  - a volume is "imported" (and can influence the book cover) only after every chapter saved;
 *  - objects uploaded for a failed chapter are removed straight away;
 *  - cancelling removes the volume and every uploaded object.
 */
import type { ParsedChapter, ParsedImage } from "./epub";
import { imageMarker } from "./chapter-content";
import { mapLimit } from "./concurrency";
import type { ImageType } from "./image-sniff";

type Result<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

export type UploadedImage = {
  id: string;
  path: string;
  mime: ImageType;
  width: number | null;
  height: number | null;
  bytes: number;
};

export type VolumeMeta = { number: number; arc: string; arcOrder: number; title: string; language: string; replace: boolean };
export type StartedVolumeLike = { userId: string; volumeId: string; chapters: { id: string; number: number }[] };

export type RunnerDeps = {
  start(input: { bookId: string; chapterTitles: string[] } & VolumeMeta): Promise<Result<StartedVolumeLike>>;
  /** Uploads to private Storage; throws on failure. */
  uploadImage(userId: string, img: ParsedImage): Promise<UploadedImage>;
  removeObjects(paths: string[]): Promise<void>;
  saveChapter(input: {
    bookId: string;
    chapterId: string;
    content: string;
    images: (UploadedImage & { alt: string | null })[];
  }): Promise<Result<{ wordCount: number; imageCount: number }>>;
  finalize(input: { bookId: string; volumeId: string; cover: UploadedImage | null }): Promise<Result>;
  /** Removes the volume, its chapters, rows and Storage objects. */
  discard(volumeId: string): Promise<Result>;
  setBookCover(input: { bookId: string; image: UploadedImage & { alt: null } }): Promise<Result>;
};

/** Uploads in flight at once for one chapter, and chapters saved at once. Bounded so memory and Supabase stay calm. */
export const IMAGE_CONCURRENCY = 4;
export const CHAPTER_CONCURRENCY = 3;

export type ChapterOutcome = { number: number; title: string; ok: boolean; words: number; images: number; error?: string };

export type RunInput = {
  bookId: string;
  meta: VolumeMeta;
  chapters: ParsedChapter[];
  images: Map<string, ParsedImage>;
  /** The volume cover (a separate, thumbnail-sized copy), or null. */
  cover: ParsedImage | null;
  /** Also store the cover as the book's manual cover. */
  setAsBookCover: boolean;
  deps: RunnerDeps;
  onProgress?: (done: number, total: number, label: string) => void;
  signal?: AbortSignal;
};

export type RunState = {
  volume: StartedVolumeLike;
  outcomes: ChapterOutcome[];
  /** Paths currently stored for this import (so a cancel can remove them all). */
  stored: Set<string>;
};

export type RunResult =
  | { status: "done"; state: RunState; warnings: string[] }
  | { status: "incomplete"; state: RunState; error: string | null; warnings: string[] }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

async function importChapter(
  input: RunInput,
  state: RunState,
  index: number,
): Promise<ChapterOutcome> {
  const { deps } = input;
  const chapter = input.chapters[index];
  const row = state.volume.chapters[index];
  const uploaded: (UploadedImage & { alt: string | null })[] = [];
  try {
    // Illustrations upload in parallel (bounded); the text order is rebuilt afterwards from the block order.
    const wanted = chapter.blocks.flatMap((block, at) => {
      if (block.type === "text") return [];
      const img = input.images.get(block.ref);
      return img ? [{ at, img, alt: block.alt }] : [];
    });
    const settled = await mapLimit(wanted, IMAGE_CONCURRENCY, async (w) => {
      if (input.signal?.aborted) throw new Error("cancelled");
      const up = await deps.uploadImage(state.volume.userId, w.img);
      state.stored.add(up.path);
      uploaded.push({ ...up, alt: w.alt });
      return up;
    });
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;
    const markerAt = new Map(wanted.map((w, i) => [w.at, (settled[i] as PromiseFulfilledResult<UploadedImage>).value]));

    const lines: string[] = [];
    chapter.blocks.forEach((block, at) => {
      if (block.type === "text") lines.push(block.text);
      else {
        const up = markerAt.get(at);
        if (up) lines.push(imageMarker(up.id));
      }
    });
    // Keep the saved illustration records in reading order too.
    const order = new Map(lines.map((l, i) => [l, i]));
    uploaded.sort((x, y) => (order.get(imageMarker(x.id)) ?? 0) - (order.get(imageMarker(y.id)) ?? 0));
    const res = await deps.saveChapter({ bookId: input.bookId, chapterId: row.id, content: lines.join("\n"), images: uploaded });
    if (!res.ok) throw new Error(res.error);
    // Never accept a chapter that saved fewer illustrations than were uploaded: that would lose pictures silently.
    if (res.data.imageCount !== uploaded.length) {
      throw new Error(`Only ${res.data.imageCount} of ${uploaded.length} illustrations were saved for this chapter.`);
    }
    return { number: row.number, title: chapter.title, ok: true, words: res.data.wordCount, images: res.data.imageCount };
  } catch (e) {
    // Remove whatever this attempt uploaded so a retry starts clean and nothing is orphaned.
    if (uploaded.length) {
      const paths = uploaded.map((u) => u.path);
      await deps.removeObjects(paths).catch(() => undefined);
      paths.forEach((p) => state.stored.delete(p));
    }
    return { number: row.number, title: chapter.title, ok: false, words: 0, images: 0, error: message(e) };
  }
}

async function cancel(input: RunInput, state: RunState | null): Promise<RunResult> {
  if (state) {
    await input.deps.removeObjects([...state.stored]).catch(() => undefined);
    await input.deps.discard(state.volume.volumeId).catch(() => undefined);
  }
  return { status: "cancelled" };
}

/** Marks the volume imported once every chapter has saved. */
async function complete(input: RunInput, state: RunState): Promise<RunResult> {
  const { deps } = input;
  const warnings: string[] = [];
  const upload = async (img: ParsedImage) => {
    const up = await deps.uploadImage(state.volume.userId, img);
    state.stored.add(up.path);
    return up;
  };

  // The volume cover and the book-cover copy are independent uploads: do them together. The book cover is only
  // SET after the volume has been finalised, so a failed import still never touches it.
  const [coverTry, copyTry] = await Promise.allSettled([
    input.cover ? upload(input.cover) : Promise.resolve(null),
    input.setAsBookCover && input.cover ? upload(input.cover) : Promise.resolve(null),
  ]);
  let cover: UploadedImage | null = null;
  if (coverTry.status === "fulfilled") cover = coverTry.value;
  else warnings.push(`The chapters were imported, but the cover couldn't be saved: ${message(coverTry.reason)}`);
  const copy = copyTry.status === "fulfilled" ? copyTry.value : null;
  const discardUploads = async () => {
    const paths = [cover?.path, copy?.path].filter((p): p is string => !!p);
    if (paths.length) await deps.removeObjects(paths).catch(() => undefined);
  };

  const fin = await deps.finalize({ bookId: input.bookId, volumeId: state.volume.volumeId, cover });
  if (!fin.ok) {
    await discardUploads();
    return { status: "incomplete", state, error: fin.error, warnings };
  }

  if (input.setAsBookCover && input.cover) {
    if (!copy) {
      warnings.push(`The volume was imported, but it couldn't be set as the book cover: ${copyTry.status === "rejected" ? message(copyTry.reason) : "upload failed"}`);
    } else {
      try {
        const res = await deps.setBookCover({ bookId: input.bookId, image: { ...copy, alt: null } });
        if (!res.ok) {
          await deps.removeObjects([copy.path]).catch(() => undefined);
          warnings.push(`The volume was imported, but it couldn't be set as the book cover: ${res.error}`);
        }
      } catch (e) {
        await deps.removeObjects([copy.path]).catch(() => undefined);
        warnings.push(`The volume was imported, but it couldn't be set as the book cover: ${message(e)}`);
      }
    }
  }
  return { status: "done", state, warnings };
}

export async function runVolumeImport(input: RunInput): Promise<RunResult> {
  const { deps, chapters } = input;
  input.onProgress?.(0, chapters.length, "Creating the volume…");

  const started = await deps.start({
    bookId: input.bookId,
    chapterTitles: chapters.map((c) => c.title),
    ...input.meta,
  });
  if (!started.ok) return { status: "failed", error: started.error };

  const state: RunState = { volume: started.data, outcomes: [], stored: new Set() };

  try {
    let done = 0;
    const slots: ChapterOutcome[] = new Array(chapters.length);
    await mapLimit(chapters, CHAPTER_CONCURRENCY, async (chapter, i) => {
      if (input.signal?.aborted) return;
      input.onProgress?.(done, chapters.length, `Chapter ${i + 1} of ${chapters.length}: ${chapter.title}`);
      slots[i] = await importChapter(input, state, i);
      input.onProgress?.(++done, chapters.length, `Saved ${done} of ${chapters.length} chapters`);
    });
    if (input.signal?.aborted) return cancel(input, state);
    state.outcomes.push(...slots);

    if (state.outcomes.some((o) => !o.ok)) {
      // Not finalised: the volume stays unmarked, so it can't affect the book cover.
      return { status: "incomplete", state, error: null, warnings: [] };
    }
    input.onProgress?.(chapters.length, chapters.length, "Finishing…");
    return await complete(input, state);
  } catch (e) {
    // Anything unexpected: leave nothing half-imported behind.
    await cancel(input, state);
    return { status: "failed", error: message(e) };
  }
}

/** Re-runs only the chapters that failed; finalises if they all succeed this time. */
export async function retryFailedChapters(input: RunInput, state: RunState): Promise<RunResult> {
  try {
    const failed = state.outcomes.flatMap((o, i) => (o.ok ? [] : [i]));
    let done = 0;
    await mapLimit(failed, CHAPTER_CONCURRENCY, async (i) => {
      if (input.signal?.aborted) return;
      input.onProgress?.(done, failed.length, `Retrying chapter ${i + 1}: ${input.chapters[i].title}`);
      state.outcomes[i] = await importChapter(input, state, i);
      input.onProgress?.(++done, failed.length, `Retried ${done} of ${failed.length}`);
    });
    if (input.signal?.aborted) return cancel(input, state);
    if (state.outcomes.some((o) => !o.ok)) return { status: "incomplete", state, error: null, warnings: [] };
    return await complete(input, state);
  } catch (e) {
    await cancel(input, state);
    return { status: "failed", error: message(e) };
  }
}

/** The user chose to throw away an incomplete import. */
export async function discardImport(deps: RunnerDeps, state: RunState): Promise<void> {
  await deps.removeObjects([...state.stored]).catch(() => undefined);
  await deps.discard(state.volume.volumeId).catch(() => undefined);
}
