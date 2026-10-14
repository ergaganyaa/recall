import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, bootDb } from "./helpers/db";

type Ctx = Awaited<ReturnType<typeof bootDb>>;
let t: Ctx;

beforeAll(async () => {
  t = await bootDb();
});
afterAll(async () => {
  await t.db.close();
});

// Original placeholder sentences; "lantern" etc. are just searchable markers.
const V1 = ["Alpha lantern opens", "Beta lantern burns", "Gamma lantern fades"];
const V2 = ["Delta compass turns", "Epsilon compass breaks"];

async function freshBook() {
  await t.as(ALICE);
  const book = await t.newBook();
  await t.addVolume(book, { number: 1, chapters: V1 });
  await t.addVolume(book, { number: 2, chapters: V2 });
  return book;
}

describe("ordered volume import (decimal volumes)", () => {
  it("numbers chapters across volumes in reading order", async () => {
    const book = await freshBook();
    expect((await t.numbers(book)).map((c) => c.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it("slots volume 1.5 between 1 and 2 and renumbers everything keyed by chapter number", async () => {
    const book = await freshBook();
    await t.db.query("update reading_progress set last_read_chapter = 4, current_chapter = 5 where book_id = $1", [book]);
    await t.db.query("insert into bookmarks (book_id, chapter_number, scroll_pct) values ($1, 4, 0.5)", [book]);

    await t.addVolume(book, { number: 1.5, chapters: ["Side one", "Side two"] });

    expect((await t.numbers(book)).map((c) => c.title)).toEqual([...V1, "Side one", "Side two", ...V2]);
    // Boundary (finished "Delta", was #4) still points at Delta, now #6; current was #5 → #7.
    expect(await t.progress(book)).toEqual({ last_read_chapter: 6, current_chapter: 7 });
    const bm = await t.db.query<{ chapter_number: number }>("select chapter_number from bookmarks where book_id = $1", [book]);
    expect(bm.rows[0].chapter_number).toBe(6);
    // Passages moved with their chapters.
    expect((await t.search(book, ["delta"])).map((r) => r.chapter_number)).toEqual([6]);
  });

  it("does not shift progress that is before the insertion point", async () => {
    const book = await freshBook();
    await t.db.query("update reading_progress set last_read_chapter = 3, current_chapter = 3 where book_id = $1", [book]);
    await t.addVolume(book, { number: 1.5, chapters: ["Side one"] });
    expect(await t.progress(book)).toEqual({ last_read_chapter: 3, current_chapter: 3 });
  });

  it("appends a later volume without touching existing numbers", async () => {
    const book = await freshBook();
    await t.addVolume(book, { number: 3, chapters: ["Zeta"] });
    expect((await t.numbers(book)).map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("orders arcs before volume numbers (school years restart at volume 1)", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    await t.addVolume(book, { number: 2, arc: "Year 2", arcOrder: 2, chapters: ["Y2V2"] });
    await t.addVolume(book, { number: 14, arc: "Year 1", arcOrder: 1, chapters: ["Y1V14"] });
    await t.addVolume(book, { number: 1, arc: "Year 2", arcOrder: 2, chapters: ["Y2V1"] });
    await t.addVolume(book, { number: 4.5, arc: "Year 1", arcOrder: 1, chapters: ["Y1V4.5"] });
    expect((await t.numbers(book)).map((c) => c.title)).toEqual(["Y1V4.5", "Y1V14", "Y2V1", "Y2V2"]);
  });

  it("stores decimal volume numbers exactly", async () => {
    const book = await freshBook();
    await t.addVolume(book, { number: 7.5, chapters: ["Interlude"] });
    const r = await t.db.query<{ number: number }>("select number from volumes where book_id = $1 and number = 7.5", [book]);
    expect(Number(r.rows[0].number)).toBe(7.5);
  });

  it("rejects a duplicate volume and an empty volume", async () => {
    const book = await freshBook();
    await expect(t.addVolume(book, { number: 2, chapters: ["again"] })).rejects.toThrow(/already exists/);
    await expect(t.addVolume(book, { number: 9, chapters: [] })).rejects.toThrow(/at least one chapter/);
  });

  it("leaves nothing half-built when an import fails", async () => {
    const book = await freshBook();
    await expect(t.addVolume(book, { number: 2, chapters: ["dup"] })).rejects.toThrow();
    expect((await t.numbers(book)).length).toBe(5);
  });
});

describe("delete_volume", () => {
  async function bookWith3() {
    await t.as(ALICE);
    const book = await t.newBook();
    const [v1] = await t.addVolume(book, { number: 1, chapters: ["A1", "A2"] });
    const [v2] = await t.addVolume(book, { number: 2, chapters: ["B1", "B2", "B3"] });
    await t.addVolume(book, { number: 3, chapters: ["C1", "C2"] });
    return { book, v1: v1.volume_id, v2: v2.volume_id };
  }

  it("closes the numbering gap and moves progress to the same chapter", async () => {
    const { book, v2 } = await bookWith3();
    await t.db.query("update reading_progress set last_read_chapter = 6, current_chapter = 7 where book_id = $1", [book]);
    await t.db.query("insert into bookmarks (book_id, chapter_number) values ($1, 3), ($1, 7)", [book]);

    await t.db.query("select delete_volume($1)", [v2]);

    expect((await t.numbers(book)).map((c) => `${c.number}:${c.title}`)).toEqual(["1:A1", "2:A2", "3:C1", "4:C2"]);
    expect(await t.progress(book)).toEqual({ last_read_chapter: 3, current_chapter: 4 }); // C1 stays "finished"
    const bm = await t.db.query<{ chapter_number: number }>("select chapter_number from bookmarks where book_id = $1", [book]);
    expect(bm.rows.map((r) => r.chapter_number)).toEqual([4]); // bookmark inside the deleted volume is gone
    const chunks = await t.db.query<{ chapter_number: number; content: string }>(
      "select chapter_number, content from chunks where book_id = $1 order by chapter_number",
      [book],
    );
    expect(chunks.rows.map((r) => `${r.chapter_number}:${r.content}`)).toEqual(["1:A1", "2:A2", "3:C1", "4:C2"]);
  });

  it("pulls the boundary back when it was inside the deleted volume", async () => {
    const { book, v2 } = await bookWith3();
    await t.db.query("update reading_progress set last_read_chapter = 4, current_chapter = 4 where book_id = $1", [book]);
    await t.db.query("select delete_volume($1)", [v2]);
    expect((await t.progress(book)).last_read_chapter).toBe(2); // end of volume 1, never "ahead"
  });

  it("does not touch progress that is before the deleted volume", async () => {
    const { book, v2 } = await bookWith3();
    await t.db.query("update reading_progress set last_read_chapter = 1, current_chapter = 2 where book_id = $1", [book]);
    await t.db.query("select delete_volume($1)", [v2]);
    expect(await t.progress(book)).toEqual({ last_read_chapter: 1, current_chapter: 2 });
  });

  it("cascades image rows and keeps current_chapter valid when the book becomes empty", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    const [row] = await t.addVolume(book, { number: 1, chapters: ["Only"] });
    await t.db.query(
      "insert into book_images (book_id, chapter_id, storage_path, mime_type) values ($1, $2, 'x/y/z.png', 'image/png')",
      [book, row.chapter_id],
    );
    await t.db.query("update reading_progress set last_read_chapter = 1, current_chapter = 1 where book_id = $1", [book]);
    await t.db.query("select delete_volume($1)", [row.volume_id]);
    expect((await t.db.query("select 1 from book_images where book_id = $1", [book])).rows).toEqual([]);
    expect(await t.progress(book)).toEqual({ last_read_chapter: 0, current_chapter: 1 });
  });
});

describe("spoiler boundary across chapter and volume boundaries", () => {
  it("includes the last chapter of a volume and excludes the first chapter of the next", async () => {
    const book = await freshBook();
    await t.db.query("update reading_progress set last_read_chapter = 3 where book_id = $1", [book]); // end of vol 1
    expect((await t.search(book, ["lantern"])).map((r) => r.chapter_number).sort()).toEqual([1, 2, 3]);
    expect(await t.search(book, ["compass"])).toEqual([]); // vol 2 entirely hidden
    await t.db.query("update reading_progress set last_read_chapter = 4 where book_id = $1", [book]);
    expect((await t.search(book, ["compass"])).map((r) => r.chapter_number)).toEqual([4]); // first of vol 2 only
  });

  it("moving backward re-hides later chapters immediately", async () => {
    const book = await freshBook();
    await t.db.query("update reading_progress set last_read_chapter = 5 where book_id = $1", [book]);
    expect((await t.search(book, ["compass"])).length).toBe(2);
    await t.db.query("update reading_progress set last_read_chapter = 4 where book_id = $1", [book]);
    expect((await t.search(book, ["compass"])).map((r) => r.chapter_number)).toEqual([4]);
    await t.db.query("update reading_progress set last_read_chapter = 0 where book_id = $1", [book]);
    expect(await t.search(book, ["lantern", "compass"])).toEqual([]);
  });

  it("inserting an EARLIER volume later never exposes the unread tail", async () => {
    const book = await freshBook();
    await t.db.query("update reading_progress set last_read_chapter = 3 where book_id = $1", [book]);
    await t.addVolume(book, { number: 1.5, chapters: ["Hidden midpoint secret"] }); // lands at #4, after the boundary
    expect(await t.search(book, ["secret"])).toEqual([]);
    expect(await t.search(book, ["compass"])).toEqual([]);
    expect((await t.progress(book)).last_read_chapter).toBe(3);
  });

  it("importing an earlier volume after the reader is further on keeps the same chapters visible", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    await t.addVolume(book, { number: 3, chapters: ["Late gate opens", "Late gate closes"] });
    await t.db.query("update reading_progress set last_read_chapter = 1 where book_id = $1", [book]);
    await t.addVolume(book, { number: 1, chapters: ["Early one", "Early two"] }); // shifts boundary 1 → 3
    expect((await t.progress(book)).last_read_chapter).toBe(3);
    expect((await t.search(book, ["gate"])).map((r) => r.chapter_number)).toEqual([3]); // only "Late gate opens"
    expect(await t.search(book, ["closes"])).toEqual([]);
  });

  it("progress survives a refresh (a brand-new session reads the stored value)", async () => {
    const book = await freshBook();
    await t.db.query("update reading_progress set last_read_chapter = 2, current_chapter = 3 where book_id = $1", [book]);
    await t.as("admin");
    await t.as(ALICE); // simulates a new request/session
    expect(await t.progress(book)).toEqual({ last_read_chapter: 2, current_chapter: 3 });
  });

  it("image rows and alt text are never reachable through search", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    const [row] = await t.addVolume(book, { number: 1, chapters: ["Plain text chapter"] });
    await t.db.query(
      "insert into book_images (book_id, chapter_id, storage_path, mime_type, alt) values ($1, $2, 'a/b/c.png', 'image/png', 'A dragonfly secret reveal')",
      [book, row.chapter_id],
    );
    await t.db.query("update reading_progress set last_read_chapter = 1 where book_id = $1", [book]);
    expect(await t.search(book, ["dragonfly", "reveal"])).toEqual([]);
  });
});

describe("ownership and RLS for the new objects", () => {
  it("another user cannot insert a volume into, delete from, or feature Alice's book", async () => {
    const book = await freshBook();
    const vol = await t.db.query<{ id: string }>("select id from volumes where book_id = $1 limit 1", [book]);
    await t.as(BOB);
    await expect(t.addVolume(book, { number: 9, chapters: ["x"] })).rejects.toThrow(/Book not found/);
    await expect(t.db.query("select delete_volume($1)", [vol.rows[0].id])).rejects.toThrow(/Volume not found/);
    await expect(t.db.query("select set_featured_book($1)", [book])).rejects.toThrow(/Book not found/);
    await expect(t.db.query("select * from book_images")).resolves.toMatchObject({ rows: [] });
  });

  it("anonymous callers cannot run the volume functions", async () => {
    await t.as("anon");
    await expect(t.db.query("select delete_volume(gen_random_uuid())")).rejects.toThrow(/permission denied/i);
  });

  it("only allows image mime types and positive sizes", async () => {
    await t.as(ALICE);
    const book = await t.newBook();
    await expect(
      t.db.query("insert into book_images (book_id, storage_path, mime_type) values ($1, 'p', 'text/html')", [book]),
    ).rejects.toThrow();
    await expect(
      t.db.query("insert into book_images (book_id, storage_path, mime_type, width) values ($1, 'p', 'image/png', 0)", [book]),
    ).rejects.toThrow();
  });

  it("a user cannot attach an image to someone else's book", async () => {
    const book = await freshBook();
    await t.as(BOB);
    await expect(
      t.db.query("insert into book_images (book_id, storage_path, mime_type) values ($1, 'p', 'image/png')", [book]),
    ).rejects.toThrow();
  });
});

describe("featured book", () => {
  it("features exactly one book per user, switching cleanly", async () => {
    await t.as(ALICE);
    const a = await t.newBook("A");
    const b = await t.newBook("B");
    await t.db.query("select set_featured_book($1)", [a]);
    await t.db.query("select set_featured_book($1)", [b]);
    const r = await t.db.query<{ title: string }>("select title from books where is_featured");
    expect(r.rows.map((x) => x.title)).toEqual(["B"]);
  });

  it("the partial unique index forbids two featured books directly", async () => {
    await t.as(ALICE);
    const a = await t.newBook("F1");
    const b = await t.newBook("F2");
    await t.db.query("update books set is_featured = false where user_id = $1", [ALICE]);
    await t.db.query("update books set is_featured = true where id = $1", [a]);
    await expect(t.db.query("update books set is_featured = true where id = $1", [b])).rejects.toThrow();
  });
});

describe("storage policies", () => {
  it("lets a user write and read only under their own folder", async () => {
    await t.as(ALICE);
    await t.db.query("insert into storage.objects (bucket_id, name) values ('book-images', $1)", [`${ALICE}/book/img.png`]);
    await expect(
      t.db.query("insert into storage.objects (bucket_id, name) values ('book-images', $1)", [`${BOB}/book/img.png`]),
    ).rejects.toThrow();
    await expect(
      t.db.query("insert into storage.objects (bucket_id, name) values ('other-bucket', $1)", [`${ALICE}/x.png`]),
    ).rejects.toThrow();

    expect((await t.db.query("select name from storage.objects")).rows.length).toBe(1);
    await t.as(BOB);
    expect((await t.db.query("select name from storage.objects")).rows).toEqual([]);
  });

  it("creates the bucket as private with a size cap and image-only types", async () => {
    await t.as("admin");
    const r = await t.db.query<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>(
      "select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'book-images'",
    );
    expect(r.rows[0].public).toBe(false);
    expect(Number(r.rows[0].file_size_limit)).toBe(15728640);
    expect(r.rows[0].allowed_mime_types).toContain("image/jpeg");
    expect(r.rows[0].allowed_mime_types).not.toContain("text/html");
  });
});
