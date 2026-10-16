import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, bootDb } from "./helpers/db";

let t: Awaited<ReturnType<typeof bootDb>>;
beforeAll(async () => {
  t = await bootDb();
});
afterAll(async () => {
  await t.db.close();
});

const slugOf = async (id: string) => (await t.db.query<{ slug: string }>("select slug from books where id = $1", [id])).rows[0].slug;
const add = async (title: string, who = ALICE) => {
  await t.as(who);
  return (await t.db.query<{ id: string }>("insert into books (title) values ($1) returning id", [title])).rows[0].id;
};

describe("books.slug (migration 0008)", () => {
  it("is set from the title when a book is created", async () => {
    expect(await slugOf(await add("Classroom of the Elite"))).toBe("classroom-of-the-elite");
    expect(await slugOf(await add("  Re:Zero — Starting Life (Vol. 2)!  "))).toBe("re-zero-starting-life-vol-2");
  });

  it("is unique per user: repeats get -2, -3; another user may use the same name", async () => {
    const a = await add("Same Title");
    const b = await add("Same Title");
    const c = await add("Same Title");
    expect([await slugOf(a), await slugOf(b), await slugOf(c)]).toEqual(["same-title", "same-title-2", "same-title-3"]);
    expect(await slugOf(await add("Same Title", BOB))).toBe("same-title");
  });

  it("falls back for titles with no letters, caps the length, and never produces the reserved 'add'", async () => {
    expect(await slugOf(await add("!!!"))).toBe("book");
    const long = await slugOf(await add("A".repeat(200)));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(await slugOf(await add("Add"))).toBe("add-book");
    expect(await slugOf(await add("ADD!"))).toBe("add-book-2");
  });

  it("keeps a slug given explicitly, but the database refuses unsafe or reserved ones and duplicates", async () => {
    await t.as(ALICE);
    const ok = (await t.db.query<{ id: string }>("insert into books (title, slug) values ('x', 'my-own-name') returning id")).rows[0].id;
    expect(await slugOf(ok)).toBe("my-own-name");
    for (const bad of ["add", "has space", "a/b", "a?b", "a#b"]) {
      await expect(t.db.query("insert into books (title, slug) values ('y', $1)", [bad]), bad).rejects.toThrow();
    }
    await expect(t.db.query("insert into books (title, slug) values ('z', 'my-own-name')")).rejects.toThrow(/duplicate|unique/i);
    // an empty slug means "generate one"
    const blank = (await t.db.query<{ id: string }>("insert into books (title, slug) values ('From Blank', '') returning id")).rows[0].id;
    expect(await slugOf(blank)).toBe("from-blank");
  });

  it("a rename does not change the address", async () => {
    const id = await add("Original Name");
    await t.db.query("update books set title = 'Brand New Name' where id = $1", [id]);
    expect(await slugOf(id)).toBe("original-name");
  });

  it("one user cannot see another user's slugs", async () => {
    await add("Private Bobbook", BOB);
    await t.as(ALICE);
    const seen = await t.db.query("select slug from books where slug = 'private-bobbook'");
    expect(seen.rows).toEqual([]);
  });

  it("the backfill gives existing books slugs, oldest first, resolving repeats", async () => {
    await t.as("admin");
    const sql = readFileSync(path.resolve(import.meta.dirname, "../supabase/migrations/0008_book_slugs.sql"), "utf8");
    const block = /do \$\$[\s\S]*?end \$\$;/.exec(sql)![0];
    await t.db.exec("alter table books alter column slug drop not null; drop index books_user_slug_idx;");
    const first = (await t.db.query<{ id: string }>("insert into books (user_id, title, slug, created_at) values ($1, 'Old Book', 'tmp1', now() - interval '2 days') returning id", [ALICE])).rows[0].id;
    const second = (await t.db.query<{ id: string }>("insert into books (user_id, title, slug, created_at) values ($1, 'Old Book', 'tmp2', now() - interval '1 day') returning id", [ALICE])).rows[0].id;
    await t.db.query("update books set slug = null where id in ($1, $2)", [first, second]);
    await t.db.exec(block);
    expect([await slugOf(first), await slugOf(second)]).toEqual(["old-book", "old-book-2"]);
  });
});
