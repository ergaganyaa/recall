import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mapLimit } from "@/lib/concurrency";
import { IMAGE_CONCURRENCY, CHAPTER_CONCURRENCY, runVolumeImport, type RunnerDeps, type UploadedImage } from "@/lib/import-runner";
import { imageMarker } from "@/lib/chapter-content";

const USER = "11111111-1111-4111-8111-111111111111";
const BOOK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IMG = "0000000a-0000-4000-8000-00000000000a";

// ---- a controllable stand-in for the Supabase client used by auth, schema and the image route
const calls: string[] = [];
let claims: { sub?: string; email?: string } | null = { sub: USER, email: "a@b.c" };
const downloads: Record<string, Blob | null> = {};
const stub = {
  auth: {
    getClaims: async () => (claims ? { data: { claims }, error: null } : { data: null, error: new Error("no session") }),
    getUser: async () => {
      calls.push("auth.getUser");
      return { data: { user: null }, error: null };
    },
  },
  from: (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      limit: () => q,
      maybeSingle: async () => {
        calls.push(`rest.${table}`);
        return { data: { storage_path: `${USER}/${BOOK}/${IMG}.png`, mime_type: "image/png" }, error: null };
      },
      then: (res: (v: unknown) => unknown) => {
        calls.push(`rest.${table}`);
        return Promise.resolve({ data: [], error: null }).then(res);
      },
    };
    return q;
  },
  storage: {
    from: () => ({
      download: async (path: string) => {
        calls.push(`download ${path}`);
        const blob = downloads[path];
        return blob ? { data: blob, error: null } : { data: null, error: new Error("not found") };
      },
    }),
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => stub }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

describe("mapLimit", () => {
  it("never runs more than `limit` at once and keeps results in input order", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return i;
    });
    expect(peak).toBe(3);
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : "x"))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("stops starting new work after a failure, and reports every outcome", async () => {
    const started: number[] = [];
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      await new Promise((r) => setTimeout(r, 5));
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(out.some((r) => r.status === "rejected")).toBe(true);
    expect(started.length).toBeLessThan(6);
  });
});

describe("volume import runs in parallel, but boundedly and safely", () => {
  type Block = { type: "text"; text: string } | { type: "image"; ref: string; alt: string | null };
  const make = (chapterCount: number, imagesPer: number) => {
    const chapters = Array.from({ length: chapterCount }, (_, c) => ({
      title: `Ch ${c + 1}`,
      blocks: [
        { type: "text", text: `Opening of chapter ${c + 1}.` },
        ...Array.from({ length: imagesPer }, (_, i): Block[] => [
          { type: "image", ref: `i-${c}-${i}`, alt: `pic ${i}` },
          { type: "text", text: `After picture ${i} in chapter ${c + 1}.` },
        ]).flat(),
      ] as Block[],
    }));
    const images = new Map(
      chapters.flatMap((_, c) =>
        Array.from({ length: imagesPer }, (_, i) => [`i-${c}-${i}`, { bytes: new Uint8Array([c, i]), mime: "image/png" as const, width: 10, height: 10 }] as const),
      ),
    );
    return { chapters, images };
  };

  function deps(over: Partial<RunnerDeps> = {}) {
    const stats = { uploading: 0, peakUploads: 0, saving: 0, peakSaves: 0, saved: new Map<string, { content: string; ids: string[] }>(), removed: [] as string[], n: 0 };
    const d: RunnerDeps = {
      start: async (input) => ({
        ok: true,
        data: { userId: USER, volumeId: "v1", chapters: input.chapterTitles.map((_, i) => ({ id: `c${i}`, number: i + 1 })) },
      }),
      uploadImage: async (_u, img) => {
        stats.uploading++;
        stats.peakUploads = Math.max(stats.peakUploads, stats.uploading);
        const id = `10000000-0000-4000-8000-${String(++stats.n).padStart(12, "0")}`;
        // earlier pictures take LONGER, so completion order differs from reading order
        await new Promise((r) => setTimeout(r, img.bytes[1] === 0 ? 12 : 2));
        stats.uploading--;
        return { id, path: `${USER}/b/${id}.png`, mime: img.mime, width: 10, height: 10, bytes: img.bytes.length } as UploadedImage;
      },
      removeObjects: async (p) => void stats.removed.push(...p),
      saveChapter: async (i) => {
        stats.saving++;
        stats.peakSaves = Math.max(stats.peakSaves, stats.saving);
        await new Promise((r) => setTimeout(r, 6));
        stats.saving--;
        stats.saved.set(i.chapterId, { content: i.content, ids: i.images.map((x) => x.id) });
        return { ok: true, data: { wordCount: 5, imageCount: i.images.length } };
      },
      finalize: async () => ({ ok: true, data: undefined }),
      discard: async () => ({ ok: true, data: undefined }),
      setBookCover: async () => ({ ok: true, data: undefined }),
      ...over,
    };
    return { d, stats };
  }
  const meta = { number: 1, arc: "", arcOrder: 1, title: "", language: "", replace: false };

  it("uses bounded concurrency for chapters and for pictures", async () => {
    const { chapters, images } = make(10, 6);
    const { d, stats } = deps();
    const r = await runVolumeImport({ bookId: BOOK, meta, chapters: chapters as never, images: images as never, cover: null, setAsBookCover: false, deps: d });
    expect(r.status).toBe("done");
    expect(stats.peakSaves).toBeGreaterThan(1);
    expect(stats.peakSaves).toBeLessThanOrEqual(CHAPTER_CONCURRENCY);
    expect(stats.peakUploads).toBeGreaterThan(1);
    expect(stats.peakUploads).toBeLessThanOrEqual(CHAPTER_CONCURRENCY * IMAGE_CONCURRENCY);
  });

  it("keeps text and pictures in the original reading order even when uploads finish out of order", async () => {
    const { chapters, images } = make(3, 4);
    const { d, stats } = deps();
    await runVolumeImport({ bookId: BOOK, meta, chapters: chapters as never, images: images as never, cover: null, setAsBookCover: false, deps: d });
    for (const [chapterId, saved] of stats.saved) {
      const lines = saved.content.split("\n");
      const markers = lines.filter((l) => l.startsWith("[[image:"));
      expect(markers).toHaveLength(4);
      // text, marker, text, marker ... exactly as in the source blocks
      expect(lines.map((l) => (l.startsWith("[[image:") ? "I" : "T")).join("")).toBe("TITITITIT");
      // the records are in reading order too (their ids are the ones in the content, in the same order)
      expect(saved.ids.map((id) => imageMarker(id))).toEqual(markers);
      expect(chapterId).toMatch(/^c\d$/);
    }
  });

  it("a failed picture upload fails only that chapter, removes what it uploaded, and the volume is not finalised", async () => {
    const { chapters, images } = make(4, 3);
    let calls2 = 0;
    const finalize = vi.fn(async () => ({ ok: true as const, data: undefined }));
    const { d, stats } = deps({
      uploadImage: async (_u, img) => {
        calls2++;
        if (img.bytes[0] === 1 && img.bytes[1] === 1) throw new Error("storage down");
        const id = `20000000-0000-4000-8000-${String(calls2).padStart(12, "0")}`;
        await new Promise((r) => setTimeout(r, 3));
        return { id, path: `${USER}/b/${id}.png`, mime: img.mime, width: 10, height: 10, bytes: 2 };
      },
      finalize,
    });
    const r = await runVolumeImport({ bookId: BOOK, meta, chapters: chapters as never, images: images as never, cover: null, setAsBookCover: false, deps: d });
    expect(r.status).toBe("incomplete");
    if (r.status !== "incomplete") return;
    expect(r.state.outcomes.map((o) => o.ok)).toEqual([true, false, true, true]);
    expect(r.state.outcomes[1].error).toMatch(/storage down/);
    expect(stats.saved.has("c1")).toBe(false); // the failed chapter was not saved
    expect(stats.removed.length).toBeGreaterThan(0); // what it had uploaded was cleaned up
    expect(finalize).not.toHaveBeenCalled();
  });

  it("uploads the volume cover and the book-cover copy together, and never sets the book cover if the volume cannot be finalised", async () => {
    const { chapters, images } = make(2, 0);
    const setBookCover = vi.fn(async () => ({ ok: true as const, data: undefined }));
    const { d, stats } = deps({
      finalize: async () => ({ ok: false, error: "nope" }),
      setBookCover,
    });
    const cover = { bytes: new Uint8Array([9, 9]), mime: "image/png" as const, width: 10, height: 10 };
    const r = await runVolumeImport({ bookId: BOOK, meta, chapters: chapters as never, images: images as never, cover: cover as never, setAsBookCover: true, deps: d });
    expect(r.status).toBe("incomplete");
    expect(setBookCover).not.toHaveBeenCalled();
    expect(stats.removed).toHaveLength(2); // both cover uploads removed again
  });

  it("cancelling stops new work and removes everything that was uploaded", async () => {
    const { chapters, images } = make(6, 3);
    const abort = new AbortController();
    const { d, stats } = deps({
      saveChapter: async (i) => {
        abort.abort();
        return { ok: true, data: { wordCount: 1, imageCount: i.images.length } };
      },
    });
    const r = await runVolumeImport({ bookId: BOOK, meta, chapters: chapters as never, images: images as never, cover: null, setAsBookCover: false, deps: d, signal: abort.signal });
    expect(r.status).toBe("cancelled");
    expect(stats.removed.length).toBeGreaterThan(0);
  });
});

describe("authentication is verified locally, once per request", () => {
  it("getUser uses the local token check, never the Auth server, and returns id + email", async () => {
    calls.length = 0;
    claims = { sub: USER, email: "reader@example.com" };
    const { getUser } = await import("@/lib/auth");
    expect(await getUser()).toEqual({ id: USER, email: "reader@example.com" });
    expect(calls).not.toContain("auth.getUser");
  });

  it("no valid session means signed out, and requireUser redirects to the login page", async () => {
    claims = null;
    const { getUser, requireUser } = await import("@/lib/auth");
    expect(await getUser()).toBeNull();
    await expect(requireUser()).rejects.toThrow("redirect /login");
    claims = { sub: undefined };
    expect(await getUser()).toBeNull();
    claims = { sub: USER, email: "a@b.c" };
  });
});

describe("illustration route", () => {
  const ctx = (imageId = IMG, bookId = BOOK) => ({ params: Promise.resolve({ bookId, imageId }) }) as never;

  it("fast path: one Storage download, with the path built from the VERIFIED user id", async () => {
    calls.length = 0;
    downloads[`${USER}/${BOOK}/${IMG}.png`] = new Blob(["png-bytes"]);
    const { GET } = await import("@/app/library/[bookId]/image/[imageId]/route");
    const res = await GET(new Request(`http://x/library/${BOOK}/image/${IMG}?e=png`), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(calls).toEqual([`download ${USER}/${BOOK}/${IMG}.png`]); // no table lookup, no second auth call
  });

  it("the query string can never point at another user's folder or an unknown type", async () => {
    calls.length = 0;
    const { GET } = await import("@/app/library/[bookId]/image/[imageId]/route");
    // a hostile extension is ignored (falls back to the lookup, which RLS scopes to the caller)
    const res = await GET(new Request(`http://x/?e=../../${"22222222-2222-4222-8222-222222222222"}/x`), ctx());
    expect(calls.some((c) => c.startsWith("download") && c.includes("22222222"))).toBe(false);
    expect(calls).toContain("rest.book_images");
    expect([200, 404]).toContain(res.status);
  });

  it("falls back to the lookup when there is no hint or the hinted object is missing, and is 401 when signed out", async () => {
    calls.length = 0;
    downloads[`${USER}/${BOOK}/${IMG}.png`] = new Blob(["png-bytes"]);
    const { GET } = await import("@/app/library/[bookId]/image/[imageId]/route");
    const noHint = await GET(new Request("http://x/"), ctx());
    expect(noHint.status).toBe(200);
    expect(calls[0]).toBe("rest.book_images");
    const stale = await GET(new Request("http://x/?e=jpg"), ctx()); // wrong type hint: object not there, lookup finds the real one
    expect(stale.status).toBe(200);
    expect(stale.headers.get("content-type")).toBe("image/png");
    claims = null;
    expect((await GET(new Request("http://x/?e=png"), ctx())).status).toBe(401);
    claims = { sub: USER, email: "a@b.c" };
    expect((await GET(new Request("http://x/"), ctx("not-a-uuid"))).status).toBe(404);
  });
});

describe("schema check is not repeated on every page", () => {
  it("probes the database once while it is current, and again only after a failure", async () => {
    vi.resetModules();
    const { schemaIsCurrent } = await import("@/lib/schema");
    calls.length = 0;
    expect(await schemaIsCurrent()).toBe(true);
    const first = calls.length;
    expect(first).toBe(6); // books, chapters, volumes, images, profiles and friendships
    expect(await schemaIsCurrent()).toBe(true);
    expect(calls.length).toBe(first); // cached for the life of the server process
  });
});

describe("pictures start loading early and in the right order", () => {
  it("leadingImageIds returns the first pictures at or after a block, in reading order", async () => {
    const { leadingImageIds } = await import("@/lib/chapter-content");
    const A = "0000000a-0000-4000-8000-00000000000a";
    const B = "0000000b-0000-4000-8000-00000000000b";
    const C = "0000000c-0000-4000-8000-00000000000c";
    const content = ["one", `[[image:${A}]]`, "", "two", `[[image:${B}]]`, "three", `[[image:${C}]]`].join("\n");
    // blocks: 0 one, 1 A, 2 two, 3 B, 4 three, 5 C
    expect(leadingImageIds(content, 0, 2)).toEqual([A, B]);
    expect(leadingImageIds(content, 2, 2)).toEqual([B, C]);
    expect(leadingImageIds(content, 4, 5)).toEqual([C]);
    expect(leadingImageIds(content, 99, 2)).toEqual([]);
    expect(leadingImageIds(content, -5, 1)).toEqual([A]);
    expect(leadingImageIds("", 0, 2)).toEqual([]);
  });
});

describe("import reads a PDF once", () => {
  it("the importer parses first and only inspects (a second full pass) for a scanned PDF", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../components/volume-importer.tsx"), "utf8");
    const parseAt = source.indexOf('await parsePdfFile(bytes, f.name, "text")');
    const inspectAt = source.indexOf("await inspectPdf(bytes");
    expect(parseAt).toBeGreaterThan(0);
    expect(inspectAt).toBeGreaterThan(parseAt); // inspection comes after, inside the needs_ocr branch
    expect(source.slice(parseAt, inspectAt)).toContain('e.code !== "needs_ocr"');
  });
});

describe("import progress reports illustrations", () => {
  it("includes how many illustrations have been uploaded", async () => {
    const labels: string[] = [];
    const bytes = new Uint8Array([1]);
    const chapters = [0, 1].map((c) => ({
      title: `C${c}`,
      blocks: [
        { type: "text" as const, text: "text" },
        { type: "image" as const, ref: `i${c}`, alt: null },
      ],
    }));
    const images = new Map(chapters.map((_, c) => [`i${c}`, { bytes, mime: "image/png" as const, width: 1, height: 1 }]));
    let n = 0;
    await runVolumeImport({
      bookId: BOOK,
      meta: { number: 1, arc: "", arcOrder: 1, title: "", language: "", replace: false },
      chapters: chapters as never,
      images: images as never,
      cover: null,
      setAsBookCover: false,
      onProgress: (_d, _t, label) => labels.push(label),
      deps: {
        start: async () => ({ ok: true, data: { userId: USER, volumeId: "v", chapters: [{ id: "c0", number: 1 }, { id: "c1", number: 2 }] } }),
        uploadImage: async (_u, img) => {
          const id = `3000000${++n}-0000-4000-8000-000000000000`;
          return { id, path: `${USER}/b/${id}.png`, mime: img.mime, width: 1, height: 1, bytes: 1 };
        },
        removeObjects: async () => undefined,
        saveChapter: async (i) => ({ ok: true, data: { wordCount: 1, imageCount: i.images.length } }),
        finalize: async () => ({ ok: true, data: undefined }),
        discard: async () => ({ ok: true, data: undefined }),
        setBookCover: async () => ({ ok: true, data: undefined }),
      },
    });
    expect(labels.some((l) => /Saved 2 of 2 chapters · 2 of 2 illustrations uploaded/.test(l))).toBe(true);
  });
});
