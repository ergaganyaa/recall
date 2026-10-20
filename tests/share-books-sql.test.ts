import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, bootDb } from "./helpers/db";

/** Sharing a novel with friends and adding a friend's novel, against the real migrations and row level security. */
let t: Awaited<ReturnType<typeof bootDb>>;
const CAROL = "33333333-3333-3333-3333-333333333333";
const DAVE = "44444444-4444-4444-4444-444444444444";
const IMG1 = "0000000a-0000-4000-8000-00000000000a";
const IMG2 = "0000000b-0000-4000-8000-00000000000b";

type Row = Record<string, unknown>;
const q = async <T = Row>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows;
type Copy = { error?: string; book_id?: string; slug?: string; images?: { from: string; to: string; mime: string }[] };
const copy = async (owner: string, book: string) => (await q<{ r: Copy }>("select public.copy_friend_book($1, $2) as r", [owner, book]))[0].r;

let book: string; // Alice's shared novel
let secret: string; // Alice's private novel
let coverId: string;
let chapter1: string;

beforeAll(async () => {
  t = await bootDb();
  await t.as("admin");
  for (const id of [CAROL, DAVE]) await t.db.query("insert into auth.users (id) values ($1)", [id]);
  for (const [id, name] of [[ALICE, "alice"], [BOB, "bobby"], [CAROL, "carol"], [DAVE, "dave"]]) await t.db.query("insert into profiles (id, username) values ($1, $2)", [id, name]);
  // Alice and Bob are friends; Carol is not.
  await t.db.query("insert into friendships (requester_id, addressee_id, status) values ($1, $2, 'accepted')", [ALICE, BOB]);

  await t.as(ALICE);
  book = await t.newBook("The Lantern Keeper");
  await t.db.query("update books set author = 'A. Writer', description = 'A description', cover_url = null, source_url = 'https://private.example/zxlink', language = 'en' where id = $1", [book]);
  await t.addVolume(book, { number: 1, chapters: ["Chapter one has the first zxbookline of text.", "Chapter two continues the story."] });
  await t.addVolume(book, { number: 2, chapters: ["Chapter three starts volume two."] });
  chapter1 = (await q<{ id: string }>("select id from chapters where book_id = $1 and number = 1", [book]))[0].id;
  // chapter 1 has two pictures; the text points at them by id
  await t.db.query("update chapters set content = $2, image_count = 2 where id = $1", [chapter1, `First line of text.\n[[image:${IMG1}]]\nSecond line.\n[[image:${IMG2}]]\nLast line.`]);
  await t.db.query("insert into book_images (id, book_id, chapter_id, position, storage_path, mime_type, width, height, bytes, alt) values ($1, $3, $4, 0, $5, 'image/png', 800, 1200, 1000, 'first'), ($2, $3, $4, 1, $6, 'image/jpeg', 600, 900, 2000, null)", [
    IMG1, IMG2, book, chapter1, `${ALICE}/${book}/${IMG1}.png`, `${ALICE}/${book}/${IMG2}.jpg`,
  ]);
  coverId = (await q<{ id: string }>("insert into book_images (book_id, storage_path, mime_type) values ($1, $2, 'image/jpeg') returning id", [book, `${ALICE}/${book}/cover.jpg`]))[0].id;
  await t.db.query("update books set cover_image_id = $2 where id = $1", [book, coverId]);
  await t.db.query("update volumes set cover_image_id = $2, imported_at = now() where book_id = $1 and number = 1", [book, coverId]);
  // search index rows with paragraph ranges (so the copy works with the assistant)
  await t.db.query("update chunks set block_first = 0, block_last = 2 where chapter_id = $1", [chapter1]);
  // things that must NEVER be copied
  await t.db.query("insert into bookmarks (book_id, chapter_number, note) values ($1, 1, 'zxprivate bookmark note')", [book]);
  await t.db.query("insert into chat_messages (book_id, role, content, boundary_chapter) values ($1, 'user', 'zxprivate question', 1)", [book]);
  await t.db.query("update reading_progress set last_read_chapter = 2, current_chapter = 3, scroll_pct = 0.5 where book_id = $1", [book]);
  secret = await t.newBook("My Private Novel");
  await t.addVolume(secret, { number: 1, chapters: ["Private text zxsecretbook."] });
});
afterAll(async () => {
  await t.db.close();
});

const share = async (id: string, on: boolean) => {
  await t.as(ALICE);
  await t.db.query("update books set shared_with_friends = $2 where id = $1", [id, on]);
};

describe("books are private until the owner shares them", () => {
  it("nothing is shared by default, so a friend cannot add anything yet", async () => {
    await t.as(BOB);
    expect(await copy("alice", book)).toEqual({ error: "not_found" });
    expect(await copy("alice", secret)).toEqual({ error: "not_found" });
  });

  it("friend_library tells a friend which books are shareable (and shows the same thin fields as before)", async () => {
    await share(book, true);
    await t.as(BOB);
    const lib = (await q<{ r: { books: Row[] } }>("select public.friend_library('alice') as r"))[0].r;
    const byTitle = Object.fromEntries(lib.books.map((b) => [b.title as string, b]));
    expect(byTitle["The Lantern Keeper"]).toMatchObject({ shareable: true, my_slug: null });
    expect(byTitle["My Private Novel"]).toMatchObject({ shareable: false });
    expect(JSON.stringify(lib)).not.toMatch(/zx|source_url|content|bookmark/i);
  });

  it("only the owner can change the switch", async () => {
    await t.as(BOB);
    expect(await q("update books set shared_with_friends = true where id = $1 returning id", [secret])).toEqual([]);
    expect((await q<{ shared_with_friends: boolean }>("select shared_with_friends from books where id = $1", [secret])).length).toBe(0); // not even visible
  });
});

describe("copying a shared novel", () => {
  let result: Copy;
  let newBook: string;

  it("copies the novel for the friend, and returns the picture files to copy", async () => {
    await share(book, true);
    await t.as(BOB);
    result = await copy("alice", book);
    expect(result.error).toBeUndefined();
    newBook = result.book_id!;
    expect(newBook).not.toBe(book);
    expect(result.slug).toBe("the-lantern-keeper");
    expect(result.images).toHaveLength(3); // two chapter pictures and a cover
    for (const img of result.images!) {
      expect(img.from.startsWith(`${ALICE}/${book}/`)).toBe(true); // read from Alice's folder
      expect(img.to.startsWith(`${BOB}/${newBook}/`)).toBe(true); // written to Bob's own folder
      expect(img.to).not.toContain(img.from.split("/").pop()!.split(".")[0]); // a new file name, not the old id
      expect(img.to.split(".").pop()).toBe(img.from.split(".").pop()); // same type
    }
  });

  it("the copy belongs to the friend, is unread and not featured, and keeps only public details", async () => {
    await t.as(BOB);
    const b = (await q<Row>("select * from books where id = $1", [newBook]))[0];
    expect(b).toMatchObject({ user_id: BOB, title: "The Lantern Keeper", author: "A. Writer", description: "A description", language: "en", status: "plan_to_read", is_featured: false, is_sample: false, copied_from: book, shared_with_friends: false });
    expect(b.source_url).toBeNull(); // the owner's source link is not copied
    expect(await q("select last_read_chapter, current_chapter, scroll_pct from reading_progress where book_id = $1", [newBook])).toEqual([{ last_read_chapter: 0, current_chapter: 1, scroll_pct: 0 }]);
  });

  it("copies the volumes, chapters and text; picture markers point at the copy's own pictures", async () => {
    await t.as(BOB);
    const vols = await q("select number::float as number, imported_at is not null as imported from volumes where book_id = $1 order by number", [newBook]);
    expect(vols).toEqual([{ number: 1, imported: true }, { number: 2, imported: false }]); // imported_at is copied as it was
    const chapters = await q<{ number: number; title: string; volume_number: number }>("select c.number, c.title, v.number::float as volume_number from chapters c join volumes v on v.id = c.volume_id where c.book_id = $1 order by c.number", [newBook]);
    expect(chapters.map((c) => [c.number, c.volume_number])).toEqual([[1, 1], [2, 1], [3, 2]]);
    const text = (await q<{ content: string }>("select content from chapters where book_id = $1 and number = 1", [newBook]))[0].content;
    expect(text).not.toContain(IMG1); // no pointer to the owner's pictures
    expect(text).not.toContain(IMG2);
    const newImages = await q<{ id: string; storage_path: string }>("select id, storage_path from book_images where book_id = $1 and chapter_id is not null order by position", [newBook]);
    expect(newImages).toHaveLength(2);
    expect(text).toBe(`First line of text.\n[[image:${newImages[0].id}]]\nSecond line.\n[[image:${newImages[1].id}]]\nLast line.`);
    expect(newImages.every((i) => i.storage_path.startsWith(`${BOB}/${newBook}/`))).toBe(true);
  });

  it("copies picture details and the covers (book and volume)", async () => {
    await t.as(BOB);
    const imgs = await q("select position, mime_type, width, height, bytes, alt from book_images where book_id = $1 and chapter_id is not null order by position", [newBook]);
    expect(imgs).toEqual([
      { position: 0, mime_type: "image/png", width: 800, height: 1200, bytes: 1000, alt: "first" },
      { position: 1, mime_type: "image/jpeg", width: 600, height: 900, bytes: 2000, alt: null },
    ]);
    const cover = (await q<{ cover_image_id: string }>("select cover_image_id from books where id = $1", [newBook]))[0].cover_image_id;
    expect(cover).toBeTruthy();
    expect(cover).not.toBe(coverId);
    expect((await q<{ n: number }>("select count(*)::int as n from book_images where id = $1 and book_id = $2 and chapter_id is null", [cover, newBook]))[0].n).toBe(1);
    expect((await q<{ cover_image_id: string }>("select cover_image_id from volumes where book_id = $1 and number = 1", [newBook]))[0].cover_image_id).toBe(cover);
  });

  it("copies the search index so the assistant works at once, with paragraph ranges", async () => {
    await t.as(BOB);
    const chunks = await q<{ n: number }>("select count(*)::int as n from chunks where book_id = $1", [newBook]);
    expect(chunks[0].n).toBeGreaterThan(0);
    expect((await q("select block_first, block_last from chunks c join chapters ch on ch.id = c.chapter_id where ch.book_id = $1 and ch.number = 1", [newBook]))[0]).toEqual({ block_first: 0, block_last: 2 });
    expect((await q<{ ok: boolean }>("select exists (select 1 from chunks where book_id = $1 and fts @@ to_tsquery('simple', 'zxbookline')) as ok", [newBook]))[0].ok).toBe(true);
  });

  it("copies NOTHING private: no bookmarks, notes, chat, progress or source link", async () => {
    await t.as(BOB);
    expect(await q("select * from bookmarks where book_id = $1", [newBook])).toEqual([]);
    expect(await q("select * from chat_messages where book_id = $1", [newBook])).toEqual([]);
    const all = JSON.stringify(await q("select * from books where id = $1", [newBook])) + JSON.stringify(await q("select content, title from chapters where book_id = $1", [newBook]));
    expect(all).not.toMatch(/zxprivate|zxlink/);
  });

  it("the copy is independent: the friend can change it, and the owner's book is untouched", async () => {
    await t.as(BOB);
    await t.db.query("update chapters set title = 'Renamed by Bob' where book_id = $1 and number = 1", [newBook]);
    await t.db.query("update books set status = 'reading', shared_with_friends = true where id = $1", [newBook]);
    await t.as(ALICE);
    expect((await q<{ title: string }>("select title from chapters where id = $1", [chapter1]))[0].title).not.toBe("Renamed by Bob");
    expect((await q<{ status: string }>("select status from books where id = $1", [book]))[0].status).toBe("reading");
    expect((await q<{ last_read_chapter: number }>("select last_read_chapter from reading_progress where book_id = $1", [book]))[0].last_read_chapter).toBe(2);
    // and Alice cannot see Bob's copy at all
    expect(await q("select * from books where id = $1", [newBook])).toEqual([]);
  });

  it("adding the same novel twice gives back the copy you already have", async () => {
    await t.as(BOB);
    expect(await copy("alice", book)).toEqual({ error: "already_added", book_id: newBook, slug: "the-lantern-keeper" });
    expect((await q<{ n: number }>("select count(*)::int as n from books where copied_from = $1", [book]))[0].n).toBe(1);
    const lib = (await q<{ r: { books: Row[] } }>("select public.friend_library('alice') as r"))[0].r;
    expect(lib.books.find((b) => b.title === "The Lantern Keeper")).toMatchObject({ my_slug: "the-lantern-keeper" });
  });

  it("the copy keeps working after the original is deleted or unshared", async () => {
    await t.as(ALICE);
    await t.db.query("update books set shared_with_friends = false where id = $1", [book]);
    await t.as(BOB);
    expect((await q<{ n: number }>("select count(*)::int as n from chapters where book_id = $1", [newBook]))[0].n).toBe(3);
    await t.as(ALICE);
    await t.db.query("update books set shared_with_friends = true where id = $1", [book]);
  });
});

describe("who may add a novel", () => {
  it("a stranger cannot, even for a shared book, and gets the same answer as for a book that does not exist", async () => {
    await share(book, true);
    await t.as(CAROL);
    expect(await copy("alice", book)).toEqual({ error: "not_found" });
    expect(await copy("alice", "99999999-9999-4999-8999-999999999999")).toEqual({ error: "not_found" });
    expect(await copy("nobody_here", book)).toEqual({ error: "not_found" });
  });

  it("a friend cannot add someone else's book through a different owner name", async () => {
    await t.as(BOB);
    expect(await copy("carol", book)).toEqual({ error: "not_found" }); // Bob is not Carol's friend, and the book is not hers
    expect(await copy("bobby", book)).toEqual({ error: "not_found" }); // not even his own name
  });

  it("switching library sharing off blocks adding too, and anonymous callers have no access", async () => {
    await t.as(ALICE);
    await t.db.query("update profiles set share_library = false where id = $1", [ALICE]);
    await t.as(CAROL);
    await t.db.query("insert into friendships (requester_id, addressee_id, status) values ($1, $2, 'accepted') on conflict do nothing", [CAROL, ALICE]).catch(() => undefined);
    await t.as("admin");
    await t.db.query("insert into friendships (requester_id, addressee_id, status) values ($1, $2, 'accepted')", [CAROL, ALICE]);
    await t.as(CAROL);
    expect(await copy("alice", book)).toEqual({ error: "not_found" });
    await t.as(ALICE);
    await t.db.query("update profiles set share_library = true where id = $1", [ALICE]);
    await t.as(CAROL);
    expect((await copy("alice", book)).error).toBeUndefined(); // now that sharing is back on, a friend may
    await t.as("anon");
    await expect(q("select public.copy_friend_book('alice', $1)", [book])).rejects.toThrow(/permission denied/i);
  });

  it("an unfriended person can no longer add the book", async () => {
    await t.as("admin");
    await t.db.query("delete from friendships where requester_id = $1 and addressee_id = $2", [CAROL, ALICE]);
    await t.db.query("delete from books where user_id = $1 and copied_from = $2", [CAROL, book]);
    await t.as(CAROL);
    expect(await copy("alice", book)).toEqual({ error: "not_found" });
  });

  it("refuses a book that is too large", async () => {
    await t.as(ALICE);
    const big = await t.newBook("Huge");
    await t.db.query("update books set shared_with_friends = true where id = $1", [big]);
    const ch = (await t.addVolume(big, { number: 1, chapters: ["x"] }))[0].chapter_id;
    await t.db.query("insert into book_images (book_id, chapter_id, storage_path, mime_type) select $1, $2, $3 || g::text || '.png', 'image/png' from generate_series(1, 401) g", [big, ch, `${ALICE}/${big}/`]);
    await t.as(BOB);
    expect(await copy("alice", big)).toEqual({ error: "too_large" });
    expect(await q("select * from books where title = 'Huge' and user_id = $1", [BOB])).toEqual([]);
  });
});

describe("storage: friends may read a shared book's pictures, never a private book's", () => {
  const names = async () => (await q<{ name: string }>("select name from storage.objects where bucket_id = 'book-images' order by name")).map((r) => r.name);
  beforeAll(async () => {
    await t.as("admin");
    await t.db.query("insert into storage.objects (bucket_id, name) values ('book-images', $1), ('book-images', $2), ('book-images', $3), ('book-images', $4)", [
      `${ALICE}/${book}/${IMG1}.png`,
      `${ALICE}/${book}/${IMG2}.jpg`,
      `${ALICE}/${book}/cover.jpg`,
      `${ALICE}/${secret}/hidden-illustration.png`,
    ]);
    await t.db.query("insert into book_images (user_id, book_id, chapter_id, storage_path, mime_type) select $3, $1, id, $2, 'image/png' from chapters where book_id = $1 limit 1", [secret, `${ALICE}/${secret}/hidden-illustration.png`, ALICE]);
  });

  it("with the book shared, the friend can read its chapter pictures and cover; the private book's picture stays hidden", async () => {
    await share(book, true);
    await t.as(BOB);
    const seen = await names();
    expect(seen).toContain(`${ALICE}/${book}/${IMG1}.png`);
    expect(seen).toContain(`${ALICE}/${book}/${IMG2}.jpg`);
    expect(seen).toContain(`${ALICE}/${book}/cover.jpg`);
    expect(seen).not.toContain(`${ALICE}/${secret}/hidden-illustration.png`);
  });

  it("when the book is not shared, its chapter pictures are hidden again (covers still follow library sharing)", async () => {
    await share(book, false);
    await t.as(BOB);
    const seen = await names();
    expect(seen).not.toContain(`${ALICE}/${book}/${IMG1}.png`);
    expect(seen).toContain(`${ALICE}/${book}/cover.jpg`);
    await share(book, true);
  });

  it("a stranger reads none of it", async () => {
    await t.as(DAVE);
    expect(await names()).toEqual([]);
  });
});
