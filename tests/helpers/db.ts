import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

export const ALICE = "11111111-1111-1111-1111-111111111111";
export const BOB = "22222222-2222-2222-2222-222222222222";

const migration = (name: string) =>
  readFileSync(process.env[`RECALL_MIG_${name.slice(0, 4)}`] ?? path.resolve(import.meta.dirname, "../../supabase/migrations", name), "utf8").replace(
    /create extension if not exists pgcrypto;/i,
    "", // gen_random_uuid() is built in
  );

/**
 * In-process Postgres with ALL Recall migrations applied, plus a minimal emulation of
 * Supabase's `auth` schema/roles and `storage` schema, so RLS and policies really run.
 */
export async function bootDb() {
  const db = new PGlite();
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

    create schema storage;
    create table storage.buckets (
      id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (
      id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text);
    create function storage.foldername(name text) returns text[] language sql immutable
      as $$ select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)] $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
  `);

  await db.exec(migration("0001_init.sql"));
  await db.exec(migration("0002_volumes_images_featured.sql"));
  await db.exec(migration("0003_storage_book_images.sql"));
  await db.exec(migration("0004_volume_covers.sql"));
  await db.exec(migration("0005_assistant_context.sql"));
  await db.exec(migration("0006_reading_position.sql"));
  await db.exec(migration("0007_scroll_boundary.sql"));

  await db.exec(`
    grant usage on schema public to anon, authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
  `);

  /** Act as a signed-in user (RLS applies), as anonymous, or as the superuser. */
  async function as(user: string | "anon" | "admin") {
    if (user === "admin") {
      await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
    } else if (user === "anon") {
      await db.exec("reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);");
    } else {
      await db.exec(
        `reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`,
      );
    }
  }

  async function newBook(title = "Test Novel"): Promise<string> {
    const r = await db.query<{ id: string }>("insert into books (title) values ($1) returning id", [title]);
    await db.query("insert into reading_progress (book_id) values ($1)", [r.rows[0].id]);
    return r.rows[0].id;
  }

  /** Calls insert_volume and gives each new chapter one text passage, like a real import would. */
  async function addVolume(
    book: string,
    opts: { number: number; arc?: string | null; arcOrder?: number; title?: string; chapters: string[] },
  ) {
    const res = await db.query<{ volume_id: string; chapter_id: string; chapter_number: number }>(
      "select * from insert_volume($1, $2, $3, $4, $5, $6, $7::jsonb)",
      [
        book,
        opts.arc ?? null,
        opts.arcOrder ?? 1,
        opts.number,
        opts.title ?? `Volume ${opts.number}`,
        "en",
        JSON.stringify(opts.chapters.map((title) => ({ title }))),
      ],
    );
    for (const [i, row] of res.rows.entries()) {
      await db.query(
        "insert into chunks (book_id, chapter_id, chapter_number, idx, content) values ($1, $2, $3, 0, $4)",
        [book, row.chapter_id, row.chapter_number, opts.chapters[i]],
      );
      await db.query("update chapters set word_count = 3, content = $2 where id = $1", [row.chapter_id, opts.chapters[i]]);
    }
    return res.rows;
  }

  const search = async (book: string, terms: string[]) =>
    (
      await db.query<{ chapter_number: number; content: string }>(
        "select chapter_number, content from search_passages($1, $2::text[], 12)",
        [book, terms],
      )
    ).rows;

  const progress = async (book: string) =>
    (
      await db.query<{ last_read_chapter: number; current_chapter: number }>(
        "select last_read_chapter, current_chapter from reading_progress where book_id = $1",
        [book],
      )
    ).rows[0];

  const numbers = async (book: string) =>
    (
      await db.query<{ number: number; title: string }>(
        "select number, title from chapters where book_id = $1 order by number",
        [book],
      )
    ).rows;

  return { db, as, newBook, addVolume, search, progress, numbers };
}
