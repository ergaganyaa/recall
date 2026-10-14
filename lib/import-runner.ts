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
    const lines: string[] = [];
    for (const block of chapter.blocks) {
      if (input.signal?.aborted) throw new Error("cancelled");
      if (block.type === "text") {
        lines.push(block.text);
        continue;
      }
      const img = input.images.get(block.ref);
      if (!img) continue;
      const up = await deps.uploadImage(state.volume.userId, img);
      state.stored.add(up.path);
      uploaded.push({ ...up, alt: block.alt });
      lines.push(imageMarker(up.id));
    }
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
  let cover: UploadedImage | null = null;
  if (input.cover) {
    try {
      cover = await deps.uploadImage(state.volume.userId, input.cover);
      state.stored.add(cover.path);
    } catch (e) {
      warnings.push(`The chapters were imported, but the cover couldn't be saved: ${message(e)}`);
    }
  }

  const fin = await deps.finalize({ bookId: input.bookId, volumeId: state.volume.volumeId, cover });
  if (!fin.ok) {
    if (cover) await deps.removeObjects([cover.path]).catch(() => undefined);
    return { status: "incomplete", state, error: fin.error, warnings };
  }

  if (input.setAsBookCover && input.cover) {
    try {
      const copy = await deps.uploadImage(state.volume.userId, input.cover);
      const res = await deps.setBookCover({ bookId: input.bookId, image: { ...copy, alt: null } });
      if (!res.ok) {
        await deps.removeObjects([copy.path]).catch(() => undefined);
        warnings.push(`The volume was imported, but it couldn't be set as the book cover: ${res.error}`);
      }
    } catch (e) {
      warnings.push(`The volume was imported, but it couldn't be set as the book cover: ${message(e)}`);
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
    for (let i = 0; i < chapters.length; i++) {
      if (input.signal?.aborted) return cancel(input, state);
      input.onProgress?.(i, chapters.length, `Chapter ${i + 1} of ${chapters.length}: ${chapters[i].title}`);
      state.outcomes.push(await importChapter(input, state, i));
    }
    if (input.signal?.aborted) return cancel(input, state);

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
    for (let i = 0; i < state.outcomes.length; i++) {
      if (state.outcomes[i].ok) continue;
      if (input.signal?.aborted) return cancel(input, state);
      input.onProgress?.(i, state.outcomes.length, `Retrying chapter ${i + 1}: ${input.chapters[i].title}`);
      state.outcomes[i] = await importChapter(input, state, i);
    }
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
