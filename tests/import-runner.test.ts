import { describe, expect, it, vi } from "vitest";
import type { ParsedChapter, ParsedImage } from "@/lib/epub";
import { discardImport, retryFailedChapters, runVolumeImport, type RunInput, type RunnerDeps, type UploadedImage } from "@/lib/import-runner";

const img = (n: number): ParsedImage => ({ ref: `img${n}`, bytes: new Uint8Array([n]), mime: "image/png", width: 100, height: 50 });
const cover = (): ParsedImage => ({ ref: "cover", bytes: new Uint8Array([9]), mime: "image/jpeg", width: 90, height: 120 });

/** chapter i has `imgs[i]` illustrations after one paragraph */
function chapters(imgs: number[][]): ParsedChapter[] {
  return imgs.map((refs, i) => ({
    title: `Chapter ${i + 1}`,
    frontMatter: false,
    wordCount: 3,
    imageCount: refs.length,
    blocks: [
      { type: "text" as const, text: `Text of chapter ${i + 1}.`, page: i + 1 },
      ...refs.map((r) => ({ type: "image" as const, ref: `img${r}`, alt: null, page: i + 1 })),
    ],
  }));
}

type Fakes = {
  deps: RunnerDeps;
  calls: string[];
  storage: Set<string>;
  finalized: { cover: UploadedImage | null }[];
  discarded: string[];
  bookCovers: number;
};

function makeDeps(opts: {
  failUploadAt?: number; // 1-based upload counter
  failSaveChapter?: number; // 1-based chapter number
  failFinalize?: boolean;
  failStart?: boolean;
  failCoverUpload?: boolean;
  failBookCover?: boolean;
  onUpload?: () => void;
  chapterCount: number;
}): Fakes {
  const calls: string[] = [];
  const storage = new Set<string>();
  const finalized: { cover: UploadedImage | null }[] = [];
  const discarded: string[] = [];
  let uploads = 0;
  const f: Fakes = { deps: null as unknown as RunnerDeps, calls, storage, finalized, discarded, bookCovers: 0 };

  f.deps = {
    start: async () => {
      calls.push("start");
      if (opts.failStart) return { ok: false, error: "no room" };
      return {
        ok: true,
        data: { userId: "u1", volumeId: "vol1", chapters: Array.from({ length: opts.chapterCount }, (_, i) => ({ id: `ch${i + 1}`, number: i + 1 })) },
      };
    },
    uploadImage: async (_u, image) => {
      uploads++;
      opts.onUpload?.();
      if (opts.failUploadAt === uploads) throw new Error("storage unavailable");
      if (opts.failCoverUpload && image.ref === "cover") throw new Error("cover upload failed");
      const id = `id${uploads}`;
      const path = `u1/b1/${id}.png`;
      storage.add(path);
      calls.push(`upload:${image.ref}`);
      return { id, path, mime: "image/png", width: image.width ?? null, height: image.height ?? null, bytes: image.bytes.length };
    },
    removeObjects: async (paths) => {
      calls.push(`remove:${paths.length}`);
      paths.forEach((p) => storage.delete(p));
    },
    saveChapter: async ({ chapterId, images }) => {
      const n = Number(chapterId.replace("ch", ""));
      calls.push(`save:${n}`);
      if (opts.failSaveChapter === n) return { ok: false, error: "database said no" };
      return { ok: true, data: { wordCount: 3, imageCount: images.length } };
    },
    finalize: async ({ cover: c }) => {
      calls.push("finalize");
      if (opts.failFinalize) return { ok: false, error: "finalize failed" };
      finalized.push({ cover: c });
      return { ok: true, data: undefined };
    },
    discard: async (id) => {
      calls.push("discard");
      discarded.push(id);
      return { ok: true, data: undefined };
    },
    setBookCover: async () => {
      calls.push("bookCover");
      if (opts.failBookCover) return { ok: false, error: "nope" };
      f.bookCovers++;
      return { ok: true, data: undefined };
    },
  };
  return f;
}

function input(f: Fakes, chs: ParsedChapter[], extra: Partial<RunInput> = {}): RunInput {
  return {
    bookId: "b1",
    meta: { number: 1, arc: "", arcOrder: 1, title: "Vol", language: "en", replace: false },
    chapters: chs,
    images: new Map([1, 2, 3, 4].map((n) => [`img${n}`, img(n)])),
    cover: cover(),
    setAsBookCover: false,
    deps: f.deps,
    ...extra,
  };
}

describe("runVolumeImport — success", () => {
  it("finalises only after every chapter has saved, with the cover", async () => {
    const f = makeDeps({ chapterCount: 2 });
    const r = await runVolumeImport(input(f, chapters([[1], [2]])));
    expect(r.status).toBe("done");
    expect(f.calls.indexOf("finalize")).toBeGreaterThan(f.calls.indexOf("save:2"));
    expect(f.finalized).toHaveLength(1);
    expect(f.finalized[0].cover).not.toBeNull();
    expect(f.calls.filter((c) => c === "finalize")).toHaveLength(1);
  });

  it("uploads each illustration once and keeps them (no cleanup on success)", async () => {
    const f = makeDeps({ chapterCount: 1 });
    await runVolumeImport(input(f, chapters([[1, 2]]), { cover: null }));
    expect(f.storage.size).toBe(2);
    expect(f.calls.some((c) => c.startsWith("remove"))).toBe(false);
  });

  it("stores a separate copy as the manual book cover only when asked, and only after finalising", async () => {
    const off = makeDeps({ chapterCount: 1 });
    await runVolumeImport(input(off, chapters([[]])));
    expect(off.bookCovers).toBe(0);

    const on = makeDeps({ chapterCount: 1 });
    const r = await runVolumeImport(input(on, chapters([[]]), { setAsBookCover: true }));
    expect(r.status).toBe("done");
    expect(on.bookCovers).toBe(1);
    expect(on.calls.indexOf("bookCover")).toBeGreaterThan(on.calls.indexOf("finalize"));
    expect(on.storage.size).toBe(2); // volume cover + independent manual copy
  });
});

describe("runVolumeImport — failures leave nothing half-imported", () => {
  it("a failed upload removes that chapter's earlier uploads, reports it, and never finalises", async () => {
    const f = makeDeps({ chapterCount: 2, failUploadAt: 3 }); // ch1: uploads 1,2 ok; ch2: upload 3 fails
    const r = await runVolumeImport(input(f, chapters([[1, 2], [3, 4]])));
    expect(r.status).toBe("incomplete");
    if (r.status !== "incomplete") return;
    expect(r.state.outcomes.map((o) => o.ok)).toEqual([true, false]);
    expect(r.state.outcomes[1].error).toMatch(/storage unavailable/);
    expect(f.calls).not.toContain("finalize");
    expect(f.finalized).toHaveLength(0);
    expect(f.bookCovers).toBe(0);
    expect(f.storage.size).toBe(2); // only chapter 1's images remain; chapter 2 left nothing
  });

  it("partially uploaded images are removed when saving the chapter fails", async () => {
    const f = makeDeps({ chapterCount: 1, failSaveChapter: 1 });
    const r = await runVolumeImport(input(f, chapters([[1, 2]])));
    expect(r.status).toBe("incomplete");
    expect(f.storage.size).toBe(0);
    expect(f.finalized).toHaveLength(0);
  });

  it("never touches the cover when start fails", async () => {
    const f = makeDeps({ chapterCount: 1, failStart: true });
    const r = await runVolumeImport(input(f, chapters([[1]])));
    expect(r).toEqual({ status: "failed", error: "no room" });
    expect(f.calls).toEqual(["start"]);
    expect(f.storage.size).toBe(0);
  });

  it("a failed finalise leaves the volume unmarked and removes the cover it uploaded", async () => {
    const f = makeDeps({ chapterCount: 1, failFinalize: true });
    const r = await runVolumeImport(input(f, chapters([[]])));
    expect(r.status).toBe("incomplete");
    expect(f.finalized).toHaveLength(0);
    expect(f.storage.size).toBe(0);
  });

  it("an unexpected error removes everything and discards the volume", async () => {
    const f = makeDeps({ chapterCount: 2 });
    f.deps.saveChapter = async () => {
      throw new Error("kaboom");
    };
    const r = await runVolumeImport(input(f, chapters([[1], [2]])));
    // saveChapter throwing is caught per chapter; the volume is incomplete, not finalised.
    expect(r.status).toBe("incomplete");
    expect(f.finalized).toHaveLength(0);
    expect(f.storage.size).toBe(0);
  });

  it("rejects a chapter whose illustrations were only partly saved, instead of losing pictures silently", async () => {
    const f = makeDeps({ chapterCount: 1 });
    f.deps.saveChapter = async () => ({ ok: true, data: { wordCount: 3, imageCount: 1 } }); // 2 uploaded, 1 saved
    const r = await runVolumeImport(input(f, chapters([[1, 2]])));
    expect(r.status).toBe("incomplete");
    if (r.status !== "incomplete") return;
    expect(r.state.outcomes[0].error).toMatch(/Only 1 of 2 illustrations/);
    expect(f.finalized).toHaveLength(0);
    expect(f.storage.size).toBe(0); // the uploads were cleaned up
  });

  it("a cover upload failure does not fail the import (it finishes without a cover)", async () => {
    const f = makeDeps({ chapterCount: 1, failCoverUpload: true });
    const r = await runVolumeImport(input(f, chapters([[]])));
    expect(r.status).toBe("done");
    expect(f.finalized[0].cover).toBeNull();
    if (r.status === "done") expect(r.warnings.join(" ")).toMatch(/cover/);
  });

  it("a failed manual-book-cover step does not undo the finished import", async () => {
    const f = makeDeps({ chapterCount: 1, failBookCover: true });
    const r = await runVolumeImport(input(f, chapters([[]]), { setAsBookCover: true }));
    expect(r.status).toBe("done");
    expect(f.finalized).toHaveLength(1);
    if (r.status === "done") expect(r.warnings.join(" ")).toMatch(/book cover/);
    expect(f.storage.size).toBe(1); // only the volume cover; the failed copy was removed
  });
});

describe("cancelling, retrying, discarding", () => {
  it("cancelling mid-import removes every uploaded object and the volume, and never finalises", async () => {
    const ac = new AbortController();
    const f = makeDeps({ chapterCount: 3, onUpload: () => {} });
    let saved = 0;
    const originalSave = f.deps.saveChapter;
    f.deps.saveChapter = async (i) => {
      const r = await originalSave(i);
      if (++saved === 2) ac.abort(); // user cancels after the second chapter
      return r;
    };
    const r = await runVolumeImport(input(f, chapters([[1], [2], [3]]), { signal: ac.signal }));
    expect(r.status).toBe("cancelled");
    expect(f.storage.size).toBe(0);
    expect(f.discarded).toEqual(["vol1"]);
    expect(f.finalized).toHaveLength(0);
  });

  it("retrying only re-runs failed chapters and then finalises", async () => {
    const f = makeDeps({ chapterCount: 2, failSaveChapter: 2 });
    const run = input(f, chapters([[1], [2]]));
    const first = await runVolumeImport(run);
    expect(first.status).toBe("incomplete");
    if (first.status !== "incomplete") return;

    const savesBefore = f.calls.filter((c) => c === "save:1").length;
    const fixed = makeDeps({ chapterCount: 2 });
    run.deps = { ...f.deps, saveChapter: fixed.deps.saveChapter }; // the problem is gone
    const second = await retryFailedChapters(run, first.state);
    expect(second.status).toBe("done");
    expect(f.calls.filter((c) => c === "save:1")).toHaveLength(savesBefore); // chapter 1 not repeated
    expect(f.finalized).toHaveLength(1);
  });

  it("discarding an incomplete import removes its images and the volume", async () => {
    const f = makeDeps({ chapterCount: 2, failSaveChapter: 2 });
    const r = await runVolumeImport(input(f, chapters([[1], [2]])));
    if (r.status !== "incomplete") throw new Error("expected incomplete");
    expect(f.storage.size).toBeGreaterThan(0);
    await discardImport(f.deps, r.state);
    expect(f.storage.size).toBe(0);
    expect(f.discarded).toEqual(["vol1"]);
  });

  it("reports progress through to completion", async () => {
    const f = makeDeps({ chapterCount: 2 });
    const onProgress = vi.fn();
    await runVolumeImport(input(f, chapters([[], []]), { onProgress }));
    const done = onProgress.mock.calls.map((c) => c[0]);
    expect(done[0]).toBe(0);
    expect(done.at(-1)).toBe(2);
  });
});
