import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const log = (line: string) => appendFileSync(process.env.RECALL_BENCH_LOG ?? join(tmpdir(), "recall-bench.log"), `${line}
`);

/**
 * Round-trip benchmark (opt-in: RECALL_BENCH=1). It runs the REAL server code (actions, queries, route handler,
 * import runner) against a stub Supabase client that sleeps RECALL_RTT ms (default 380, measured against the live
 * project from this machine) per network round trip and counts the calls. It therefore measures the structure of the
 * code (how many round trips, how many in series), not database speed, rendering or upload bandwidth.
 *
 *   RECALL_BENCH=1 npx vitest run tests/perf.bench.test.ts
 */
const RTT = Number(process.env.RECALL_RTT ?? 380);
const PROXY_ROUND_TRIPS = Number(process.env.RECALL_PROXY_RTT ?? 1); // proxy.ts's own session check per request
const USER = "11111111-1111-4111-8111-111111111111";
const BOOK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stats = { calls: 0, auth: 0, rest: 0, storage: 0 };
let volumeExists = true;
const reset = () => Object.assign(stats, { calls: 0, auth: 0, rest: 0, storage: 0 });

const chapterRow = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  number: n,
  title: `Chapter ${n}`,
  volume_id: null,
  source_url: null,
  word_count: 3000,
  image_count: 3,
  book_id: BOOK,
  content: Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of chapter ${n}.`).join("\n"),
  content_rev: 1,
  book_images: [1, 2, 3].map((i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, width: 800, height: 1200, alt: null, position: i })),
});

class Query {
  op = "select";
  one = false;
  constructor(private table: string) {}
  select() { return this; }
  insert() { this.op = "insert"; return this; }
  upsert() { this.op = "upsert"; return this; }
  update() { this.op = "update"; return this; }
  delete() { this.op = "delete"; return this; }
  eq() { return this; } in() { return this; } gte() { return this; } lt() { return this; } lte() { return this; } gt() { return this; }
  order() { return this; } limit() { return this; } is() { return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
    stats.calls++; stats.rest++;
    return sleep(RTT).then(() => this.result()).then(res, rej);
  }
  result() {
    const ok = (data: unknown) => ({ data, error: null, count: 0 });
    if (this.op !== "select") return ok(null);
    switch (this.table) {
      case "books": return ok({ id: BOOK, title: "Book", user_id: USER, cover_image_id: null, source_url: null });
      case "chapters": return ok(this.one ? chapterRow(3) : Array.from({ length: 40 }, (_, i) => chapterRow(i + 1)));
      case "reading_progress": return ok({ last_read_chapter: 2, current_chapter: 3, scroll_pct: 0.1, partial_read_block: -1, partial_rev: 0, resume_block: null });
      case "book_images": return ok([1, 2, 3].map((i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, width: 800, height: 1200, alt: null, storage_path: `${USER}/${BOOK}/x${i}.png`, mime_type: "image/png" })));
      case "volumes": return ok(this.one ? (volumeExists ? { id: "v", cover_image_id: null } : null) : []);
      default: return ok(this.one ? null : []);
    }
  }
}

const stub = {
  from: (t: string) => new Query(t),
  rpc: () => { stats.calls++; stats.rest++; return sleep(RTT).then(() => ({ data: [{ volume_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", chapter_id: chapterRow(1).id, chapter_number: 1 }], error: null })); },
  auth: {
    getUser: async () => { stats.calls++; stats.auth++; await sleep(RTT); return { data: { user: { id: USER, email: "a@b.c" } }, error: null }; },
    // Local JWT verification (cached signing keys): no network round trip.
    getClaims: async () => ({ data: { claims: { sub: USER, email: "a@b.c" } }, error: null }),
  },
  storage: {
    from: () => ({
      upload: async () => { stats.calls++; stats.storage++; await sleep(RTT); return { error: null }; },
      remove: async () => { stats.calls++; stats.storage++; await sleep(RTT); return { error: null }; },
      download: async () => { stats.calls++; stats.storage++; await sleep(RTT); return { data: new Blob(["x"]), error: null }; },
    }),
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => stub }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } }));

const run = describe.skipIf(!process.env.RECALL_BENCH);

async function measure<T>(label: string, fn: () => Promise<T>) {
  reset();
  const t0 = performance.now();
  await sleep(PROXY_ROUND_TRIPS * RTT); // proxy.ts session check that precedes every request
  const proxyCalls = PROXY_ROUND_TRIPS;
  const out = await fn();
  const ms = performance.now() - t0;
  log(`BENCH ${label.padEnd(46)} ${(ms / 1000).toFixed(2)} s   calls=${stats.calls + proxyCalls} (auth ${stats.auth + proxyCalls}, rest ${stats.rest}, storage ${stats.storage})`);
  return { out, ms, calls: stats.calls + proxyCalls };
}

run("round-trip benchmark (RTT per call = " + RTT + " ms)", () => {
  it("reader page load: layout + page data", async () => {
    const { getUser } = await import("@/lib/auth");
    const { loadReaderData } = await import("@/lib/reader-data");
    const r = await measure("reader page (chapter 3)", async () => {
      const [, data] = await Promise.all([getUser(), loadReaderData(BOOK, 3)]);
      return data;
    });
    expect(r.out.kind).toBe("ok");
  });

  it("Next chapter click: finish action, then the next page", async () => {
    const { markChapterRead } = await import("@/app/actions/reading");
    const { getUser } = await import("@/lib/auth");
    const { loadReaderData } = await import("@/lib/reader-data");
    await measure("click -> action markChapterRead", () => markChapterRead(BOOK, 3, "advance"));
    await measure("   then page for chapter 4", async () => {
      await Promise.all([getUser(), loadReaderData(BOOK, 4)]);
    });
  });

  it("6 illustrations requested at once by the browser", async () => {
    const { GET } = await import("@/app/library/[bookId]/image/[imageId]/route");
    await measure("6 parallel image requests", async () => {
      const calls = Array.from({ length: 6 }, (_, i) => {
        const imageId = `0000000${(i % 3) + 1}-0000-4000-8000-000000000000`;
        return GET(new Request(process.env.RECALL_IMG_HINT === "0" ? "http://x" : "http://x/?e=png"), { params: Promise.resolve({ bookId: BOOK, imageId }) } as never);
      });
      const res = await Promise.all(calls);
      return res.map((r) => r.status);
    });
  });

  it("volume import: 12 chapters x 3 illustrations", async () => {
    const { runVolumeImport } = await import("@/lib/import-runner");
    const { startVolumeImport, saveImportedChapter, finalizeVolumeImport } = await import("@/app/actions/import");
    const bytes = new Uint8Array(1000);
    const chapters = Array.from({ length: 12 }, (_, c) => ({
      title: `Chapter ${c + 1}`,
      blocks: [
        { type: "text" as const, text: "First paragraph of the chapter, long enough to count as real prose." },
        ...[0, 1, 2].flatMap((i) => [
          { type: "image" as const, ref: `img-${c}-${i}`, alt: null },
          { type: "text" as const, text: `Paragraph after picture ${i}, with a few more words in it to chunk.` },
        ]),
      ],
    }));
    const images = new Map(chapters.flatMap((ch, c) => [0, 1, 2].map((i) => [`img-${c}-${i}`, { bytes, mime: "image/png" as const, width: 800, height: 1200 }])));
    let uploads = 0;
    const startedChapters = Array.from({ length: 12 }, (_, i) => ({ id: chapterRow(i + 1).id, number: i + 1 }));
    // The volume comes back from the real startVolumeImport action; its chapter rows come from the stub rpc above,
    // so substitute the 12 ids the rest of the flow uses.
    const r = await measure("import 12 chapters / 36 images", () =>
      runVolumeImport({
        bookId: BOOK,
        meta: { number: 1, arc: "", arcOrder: 1, title: "", language: "", replace: false },
        chapters: chapters as never,
        images: images as never,
        cover: null,
        setAsBookCover: false,
        deps: {
          start: async (input) => {
            volumeExists = false;
            const res = await startVolumeImport({ ...input, chapterTitles: input.chapterTitles });
            volumeExists = true;
            return res.ok ? { ok: true, data: { userId: USER, volumeId: res.data.volumeId, chapters: startedChapters } } : res;
          },
          uploadImage: async (_u, img) => {
            const n = ++uploads; stats.calls++; stats.storage++;
            await sleep(RTT);
            const id = `a${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
            return { id, path: `${USER}/${BOOK}/${id}.png`, mime: img.mime, width: img.width, height: img.height, bytes: img.bytes.byteLength };
          },
          removeObjects: async () => undefined,
          saveChapter: (i) => saveImportedChapter(i),
          finalize: (i) => finalizeVolumeImport(i),
          discard: async () => ({ ok: true, data: undefined }),
          setBookCover: async () => ({ ok: true, data: undefined }),
        },
      }),
    );
    log(`BENCH import result: ${(r.out as { status: string }).status} ${JSON.stringify((r.out as { state?: { outcomes: { ok: boolean; error?: string }[] }; error?: string }).state?.outcomes?.filter((o) => !o.ok).slice(0, 2) ?? (r.out as { error?: string }).error)}`);
    expect((r.out as { status: string }).status).toBe("done");
  }, 300_000);
});
