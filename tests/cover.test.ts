import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestVolumeCoverId, resolveCover } from "@/lib/cover";
import { ALICE, BOB, bootDb } from "./helpers/db";

describe("resolveCover (pure rules)", () => {
  const book = { id: "b1", cover_image_id: null, cover_url: null };
  const vol = (cover: string | null, at: string | null) => ({ cover_image_id: cover, imported_at: at });

  it("uses the cover of the most recently IMPORTED volume, not the highest number or the last read", () => {
    const volumes = [vol("c-vol1", "2026-01-01T00:00:00Z"), vol("c-vol9", "2026-02-01T00:00:00Z"), vol("c-vol4-5", "2026-03-01T00:00:00Z")];
    expect(resolveCover(book, volumes)).toEqual({ src: "/library/b1/image/c-vol4-5", source: "volume" });
  });

  it("updates when a newer volume is imported", () => {
    const before = [vol("c1", "2026-01-01T00:00:00Z")];
    const after = [...before, vol("c2", "2026-05-01T00:00:00Z")];
    expect(latestVolumeCoverId(before)).toBe("c1");
    expect(latestVolumeCoverId(after)).toBe("c2");
  });

  it("ignores volumes whose import never finished (a failed import cannot change the cover)", () => {
    const volumes = [vol("c1", "2026-01-01T00:00:00Z"), vol("c-failed", null)];
    expect(latestVolumeCoverId(volumes)).toBe("c1");
  });

  it("skips a newer volume that has no cover (e.g. a text-only volume) instead of blanking the cover", () => {
    expect(latestVolumeCoverId([vol("c1", "2026-01-01T00:00:00Z"), vol(null, "2026-06-01T00:00:00Z")])).toBe("c1");
  });

  it("a manually chosen book cover always wins and is never overridden", () => {
    const manual = { ...book, cover_image_id: "manual-1" };
    expect(resolveCover(manual, [vol("c1", "2026-09-01T00:00:00Z")])).toEqual({ src: "/library/b1/image/manual-1", source: "manual" });
  });

  it("prefers a linked cover URL over an automatic volume cover, and shows a placeholder when there is nothing", () => {
    expect(resolveCover({ ...book, cover_url: "https://x/y.png" }, [vol("c1", "2026-01-01T00:00:00Z")]).source).toBe("linked");
    expect(resolveCover(book, [])).toEqual({ src: null, source: "none" });
  });

  it("compares real timestamps, not strings", () => {
    const a = vol("old", "2026-01-01T10:00:00+05:00"); // = 05:00Z
    const b = vol("new", "2026-01-01T06:00:00Z"); // later in absolute time
    expect(latestVolumeCoverId([b, a])).toBe("new");
  });
});

describe("cover behaviour against the real schema", () => {
  let t: Awaited<ReturnType<typeof bootDb>>;
  beforeAll(async () => {
    t = await bootDb();
  });
  afterAll(async () => {
    await t.db.close();
  });

  /** Mimics a successful import: a volume, a cover image row, then the finalising update. */
  async function importVolume(book: string, number: number, opts: { cover?: boolean; at?: string; finish?: boolean } = {}) {
    const rows = await t.addVolume(book, { number, chapters: [`Ch of vol ${number}`] });
    const volumeId = rows[0].volume_id;
    let coverId: string | null = null;
    if (opts.cover !== false) {
      const img = await t.db.query<{ id: string }>(
        "insert into book_images (book_id, storage_path, mime_type) values ($1, $2, 'image/jpeg') returning id",
        [book, `${ALICE}/${book}/cover-${number}.jpg`],
      );
      coverId = img.rows[0].id;
    }
    if (opts.finish !== false) {
      await t.db.query("update volumes set cover_image_id = $2, imported_at = $3 where id = $1", [
        volumeId,
        coverId,
        opts.at ?? new Date().toISOString(),
      ]);
    }
    return { volumeId, coverId };
  }

  const state = async (book: string) => {
    const b = await t.db.query<{ id: string; cover_image_id: string | null; cover_url: string | null }>(
      "select id, cover_image_id, cover_url from books where id = $1",
      [book],
    );
    const v = await t.db.query<{ imported_at: string | null; cover_image_id: string | null }>(
      "select imported_at, cover_image_id from volumes where book_id = $1",
      [book],
    );
    return resolveCover(
      b.rows[0],
      v.rows.map((r) => ({ imported_at: r.imported_at ? new Date(r.imported_at).toISOString() : null, cover_image_id: r.cover_image_id })),
    );
  };

  it("7. importing a new volume switches the default cover to it (and it survives a refresh)", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    const v1 = await importVolume(book, 1, { at: "2026-01-01T00:00:00Z" });
    expect((await state(book)).src).toContain(v1.coverId!);
    const v2 = await importVolume(book, 2, { at: "2026-02-01T00:00:00Z" });
    expect((await state(book)).src).toContain(v2.coverId!);

    await t.as("admin");
    await t.as(ALICE); // a new session
    expect((await state(book)).src).toContain(v2.coverId!);
  });

  it("7b. an older-numbered volume imported later becomes the cover (latest import wins, not highest number)", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    await importVolume(book, 5, { at: "2026-01-01T00:00:00Z" });
    const v45 = await importVolume(book, 4.5, { at: "2026-03-01T00:00:00Z" });
    expect((await state(book)).src).toContain(v45.coverId!);
  });

  it("8. deleting the latest volume falls back to the most recent remaining one", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    const v1 = await importVolume(book, 1, { at: "2026-01-01T00:00:00Z" });
    const v2 = await importVolume(book, 2, { at: "2026-02-01T00:00:00Z" });
    const v3 = await importVolume(book, 3, { at: "2026-03-01T00:00:00Z" });
    expect((await state(book)).src).toContain(v3.coverId!);

    await t.db.query("select delete_volume($1)", [v3.volumeId]);
    expect((await state(book)).src).toContain(v2.coverId!);
    expect((await t.db.query("select 1 from book_images where id = $1", [v3.coverId])).rows).toEqual([]); // cover row removed

    await t.db.query("select delete_volume($1)", [v2.volumeId]);
    expect((await state(book)).src).toContain(v1.coverId!);

    await t.db.query("select delete_volume($1)", [v1.volumeId]);
    expect(await state(book)).toEqual({ src: null, source: "none" }); // placeholder when no volumes remain
  });

  it("9. a manually chosen cover is preserved through imports and deletions", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    const manual = await t.db.query<{ id: string }>(
      "insert into book_images (book_id, storage_path, mime_type) values ($1, 'x/manual.jpg', 'image/jpeg') returning id",
      [book],
    );
    await t.db.query("update books set cover_image_id = $2 where id = $1", [book, manual.rows[0].id]);

    const v1 = await importVolume(book, 1, { at: "2026-01-01T00:00:00Z" });
    expect((await state(book)).source).toBe("manual");
    await t.db.query("select delete_volume($1)", [v1.volumeId]);
    const s = await state(book);
    expect(s.source).toBe("manual");
    expect(s.src).toContain(manual.rows[0].id);

    // Clearing the manual choice returns to the automatic behaviour.
    const v2 = await importVolume(book, 2, { at: "2026-02-01T00:00:00Z" });
    await t.db.query("update books set cover_image_id = null where id = $1", [book]);
    expect((await state(book)).src).toContain(v2.coverId!);
  });

  it("10a. a volume whose import did not finish never becomes the cover", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    const good = await importVolume(book, 1, { at: "2026-01-01T00:00:00Z" });
    await importVolume(book, 2, { finish: false }); // started, never finalised
    expect((await state(book)).src).toContain(good.coverId!);
  });

  it("deleting a volume never touches another volume's or the manual cover", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    const a = await importVolume(book, 1, { at: "2026-01-01T00:00:00Z" });
    const b = await importVolume(book, 2, { at: "2026-02-01T00:00:00Z" });
    await t.db.query("select delete_volume($1)", [a.volumeId]);
    expect((await t.db.query("select 1 from book_images where id = $1", [b.coverId])).rows).toHaveLength(1);
  });

  it("another user cannot read or alter these covers", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    const v = await importVolume(book, 1);
    await t.as(BOB);
    expect((await t.db.query("select * from volumes where book_id = $1", [book])).rows).toEqual([]);
    expect((await t.db.query("select * from book_images where id = $1", [v.coverId])).rows).toEqual([]);
    await t.db.query("update volumes set imported_at = now() where id = $1", [v.volumeId]); // 0 rows under RLS
    await t.as("admin");
    const row = await t.db.query<{ imported_at: string }>("select imported_at from volumes where id = $1", [v.volumeId]);
    expect(row.rows).toHaveLength(1);
  });
});
