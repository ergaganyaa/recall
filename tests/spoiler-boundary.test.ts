import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Runs the REAL migration in an in-process Postgres (PGlite) with a minimal
 * emulation of Supabase's auth schema/roles, then tries to get text from
 * unread chapters through search_passages and through table access.
 */

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

let db: PGlite;
let book: string;
const chapterIds: Record<number, string> = {};

/** Switch the session to a signed-in user (RLS applies) or back to superuser. */
async function as(user: string | "anon" | "admin") {
  if (user === "admin") {
    await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
  } else if (user === "anon") {
    await db.exec("reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);");
  } else {
    await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`);
  }
}

async function search(terms: string[], limit = 10, bookId = book) {
  const r = await db.query<{ chapter_number: number; content: string }>(
    "select chapter_number, content from search_passages($1, $2::text[], $3)",
    [bookId, terms, limit],
  );
  return r.rows;
}

async function setBoundary(n: number) {
  await db.query("update reading_progress set last_read_chapter = $1 where book_id = $2", [n, book]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users values ('${ALICE}'), ('${BOB}');
  `);

  const migration = readFileSync(process.env.MIGRATION_PATH ?? path.resolve(__dirname, "../supabase/migrations/0001_init.sql"), "utf8")
    .replace(/create extension if not exists pgcrypto;/i, ""); // gen_random_uuid() is built in
  await db.exec(migration);

  await db.exec(`
    grant usage on schema public to anon, authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
  `);

  // Alice's book: the word "dragon" appears in chapters 2, 4 and 5; "secret" only in chapter 5.
  await as(ALICE);
  const b = await db.query<{ id: string }>(
    "insert into books (title) values ('Test Novel') returning id",
  );
  book = b.rows[0].id;
  await db.query("insert into reading_progress (book_id, last_read_chapter) values ($1, 3)", [book]);

  const texts: Record<number, string> = {
    1: "Mira swept the shop floor.",
    2: "A dragon appeared over Brasswick.",
    3: "Nothing about reptiles here.",
    4: "The dragon returned at night.",
    5: "The dragon revealed the secret: Odell is the traitor.",
  };
  for (const [n, text] of Object.entries(texts)) {
    const ch = await db.query<{ id: string }>(
      "insert into chapters (book_id, number, title, content, word_count) values ($1, $2, $3, $4, 5) returning id",
      [book, Number(n), `Chapter ${n}`, text],
    );
    chapterIds[Number(n)] = ch.rows[0].id;
    await db.query(
      "insert into chunks (book_id, chapter_id, chapter_number, idx, content) values ($1, $2, $3, 0, $4)",
      [book, ch.rows[0].id, Number(n), text],
    );
  }
});

afterAll(async () => {
  await db.close();
});

describe("search_passages respects the reading boundary", () => {
  it("returns only chapters at or before the boundary", async () => {
    await as(ALICE);
    await setBoundary(3);
    const rows = await search(["dragon"]);
    expect(rows.map((r) => r.chapter_number)).toEqual([2]);
    expect(rows.some((r) => /traitor|secret/.test(r.content))).toBe(false);
  });

  it("never returns the unread chapter's text, even when it is the best match", async () => {
    await as(ALICE);
    await setBoundary(3);
    expect(await search(["secret", "traitor", "revealed"])).toEqual([]);
  });

  it("widens exactly as progress advances", async () => {
    await as(ALICE);
    await setBoundary(4);
    expect((await search(["dragon"])).map((r) => r.chapter_number).sort()).toEqual([2, 4]);
    await setBoundary(5);
    expect((await search(["dragon"])).map((r) => r.chapter_number).sort()).toEqual([2, 4, 5]);
  });

  it("returns nothing when the boundary is 0 or no progress row exists", async () => {
    await as(ALICE);
    await setBoundary(0);
    expect(await search(["dragon"])).toEqual([]);

    await db.query("delete from reading_progress where book_id = $1", [book]);
    expect(await search(["dragon"])).toEqual([]);
    await db.query("insert into reading_progress (book_id, last_read_chapter) values ($1, 3)", [book]);
  });

  it("ignores any attempt to pass a larger boundary (the function takes none)", async () => {
    await as(ALICE);
    await setBoundary(3);
    await expect(
      db.query("select * from search_passages($1, $2::text[], 10, 99)", [book, ["dragon"]]),
    ).rejects.toThrow();
  });

  it("clamps the result limit", async () => {
    await as(ALICE);
    await setBoundary(5);
    expect((await search(["dragon"], 1)).length).toBe(1);
    expect((await search(["dragon"], 1000)).length).toBeLessThanOrEqual(12);
    expect((await search(["dragon"], -5)).length).toBe(1);
  });

  it("handles empty or missing terms", async () => {
    await as(ALICE);
    await setBoundary(5);
    expect(await search([])).toEqual([]);
  });

  it("matches non-Latin text", async () => {
    await as(ALICE);
    await db.query(
      "insert into chunks (book_id, chapter_id, chapter_number, idx, content) values ($1, $2, 1, 7, 'Мира подметала пол в мастерской')",
      [book, chapterIds[1]],
    );
    await setBoundary(3);
    expect((await search(["мира"])).map((r) => r.chapter_number)).toEqual([1]);
  });
});

describe("row level security", () => {
  it("another user cannot search Alice's book at all", async () => {
    await as(ALICE);
    await setBoundary(5);
    await as(BOB);
    expect(await search(["dragon"])).toEqual([]);
  });

  it("another user cannot read Alice's chunks, chapters or progress directly", async () => {
    await as(BOB);
    for (const table of ["chunks", "chapters", "reading_progress", "books", "chat_messages", "bookmarks"]) {
      const r = await db.query(`select * from ${table}`);
      expect(r.rows, table).toEqual([]);
    }
  });

  it("another user cannot attach rows to Alice's book or move her boundary", async () => {
    await as(BOB);
    await expect(
      db.query("insert into chapters (book_id, number, title) values ($1, 99, 'x')", [book]),
    ).rejects.toThrow();
    await expect(
      db.query(
        "insert into chunks (book_id, chapter_id, chapter_number, idx, content) values ($1, $2, 1, 99, 'x')",
        [book, chapterIds[1]],
      ),
    ).rejects.toThrow();
    await db.query("update reading_progress set last_read_chapter = 99 where book_id = $1", [book]);
    await as("admin");
    const r = await db.query<{ last_read_chapter: number }>(
      "select last_read_chapter from reading_progress where book_id = $1",
      [book],
    );
    expect(r.rows[0].last_read_chapter).not.toBe(99);
  });

  it("a user cannot create a row owned by someone else", async () => {
    await as(BOB);
    await expect(
      db.query("insert into books (user_id, title) values ($1, 'forged')", [ALICE]),
    ).rejects.toThrow();
  });

  it("anonymous callers cannot run the search function or read tables", async () => {
    await as("anon");
    await expect(search(["dragon"])).rejects.toThrow(/permission denied/i);
    await expect(db.query("select * from chunks")).rejects.toThrow(/permission denied/i);
  });

  it("deleting a book removes its chunks and progress (cascade)", async () => {
    await as(ALICE);
    const b2 = await db.query<{ id: string }>("insert into books (title) values ('Temp') returning id");
    const id = b2.rows[0].id;
    await db.query("insert into reading_progress (book_id) values ($1)", [id]);
    await db.query("delete from books where id = $1", [id]);
    await as("admin");
    const left = await db.query("select 1 from reading_progress where book_id = $1", [id]);
    expect(left.rows).toEqual([]);
  });
});
