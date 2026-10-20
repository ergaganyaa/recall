import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, bootDb } from "./helpers/db";

/** Friends, against the real migrations and row level security. "zx" marks private content that must never be visible to a friend. */
let t: Awaited<ReturnType<typeof bootDb>>;
const CAROL = "33333333-3333-3333-3333-333333333333";
const DAVE = "44444444-4444-4444-4444-444444444444";

type Row = Record<string, unknown>;
const q = async <T = Row>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows;
const send = async (who: string, username: string) => (await q<{ r: string }>("select public.send_friend_request($1) as r", [username]))[0].r;
const overview = async () => (await q<{ r: { friends: Row[]; incoming: Row[]; outgoing: Row[] } }>("select public.friends_overview() as r"))[0].r;
const lib = async (u: string) => (await q<{ r: { shared: boolean; books: Row[] } | null }>("select public.friend_library($1) as r", [u]))[0].r;
const prof = async (u: string) => (await q<{ r: Row | null }>("select public.friend_profile($1) as r", [u]))[0].r;
const befriend = async (a: string, aName: string, b: string, bName: string) => {
  await t.as(a);
  await send(a, bName);
  await t.as(b);
  expect(await send(b, aName)).toBe("accepted");
};

let aliceBook: string;
let aliceCover: string;
let aliceChapterImage: string;

beforeAll(async () => {
  t = await bootDb();
  await t.as("admin");
  for (const id of [CAROL, DAVE]) await t.db.query("insert into auth.users (id) values ($1)", [id]);
  for (const [id, name] of [[ALICE, "alice"], [BOB, "bobby"], [CAROL, "carol"], [DAVE, "dave"]]) {
    await t.db.query("insert into profiles (id, username, display_name, bio) values ($1, $2, $3, $4)", [id, name, `${name} Display`, `${name} bio`]);
  }
  // Alice's library: one book with a private chapter, a bookmark, a chat message, a cover and a chapter illustration.
  await t.as(ALICE);
  aliceBook = await t.newBook("Alice Novel");
  await t.db.query("update books set author = 'An Author', source_url = 'https://private.example/zx' where id = $1", [aliceBook]);
  await t.addVolume(aliceBook, { number: 1, chapters: ["zxSecretChapterTitle one zxsecrettext"] });
  await t.db.query("insert into bookmarks (book_id, chapter_number, note) values ($1, 1, 'zxprivate note')", [aliceBook]);
  await t.db.query("insert into chat_messages (book_id, role, content, boundary_chapter) values ($1, 'user', 'zxprivate question', 1)", [aliceBook]);
  await t.db.query("update reading_progress set last_read_chapter = 1, current_chapter = 1 where book_id = $1", [aliceBook]);
  aliceCover = (await q<{ id: string }>("insert into book_images (book_id, storage_path, mime_type) values ($1, $2, 'image/jpeg') returning id", [aliceBook, `${ALICE}/${aliceBook}/cover.jpg`]))[0].id;
  await t.db.query("update volumes set cover_image_id = $2, imported_at = now() where book_id = $1", [aliceBook, aliceCover]);
  const chapterId = (await q<{ id: string }>("select id from chapters where book_id = $1", [aliceBook]))[0].id;
  aliceChapterImage = (await q<{ id: string }>("insert into book_images (book_id, chapter_id, storage_path, mime_type) values ($1, $2, $3, 'image/png') returning id", [aliceBook, chapterId, `${ALICE}/${aliceBook}/zx-illustration.png`]))[0].id;
  await t.db.query("update profiles set avatar_path = $1 where id = $2", [`${ALICE}/avatar/11111111-1111-4111-8111-111111111111.webp`, ALICE]);
  // the stored objects
  await t.as("admin");
  await t.db.query("insert into storage.objects (bucket_id, name) values ('book-images', $1), ('book-images', $2), ('book-images', $3)", [
    `${ALICE}/avatar/11111111-1111-4111-8111-111111111111.webp`,
    `${ALICE}/${aliceBook}/cover.jpg`,
    `${ALICE}/${aliceBook}/zx-illustration.png`,
  ]);
});
afterAll(async () => {
  await t.db.close();
});

describe("friend requests", () => {
  it("sending a request by username makes it pending for both people, and shows only what the other needs", async () => {
    await t.as(BOB);
    expect(await send(BOB, "  ALICE ")).toBe("sent");
    expect((await overview()).outgoing.map((r) => r.username)).toEqual(["alice"]);
    await t.as(ALICE);
    const o = await overview();
    expect(o.incoming).toHaveLength(1);
    expect(o.incoming[0]).toMatchObject({ username: "bobby", display_name: "bobby Display" });
    expect(Object.keys(o.incoming[0]).sort()).toEqual(["created_at", "display_name", "friendship_id", "username"]); // no avatar, bio or ids of people
    expect(o.friends).toEqual([]);
  });

  it("a request is not friendship: nothing of the library or profile is visible yet", async () => {
    await t.as(BOB);
    expect(await prof("alice")).toBeNull();
    expect(await lib("alice")).toBeNull();
  });

  it("only the person asked can accept; the asker and strangers cannot", async () => {
    const id = (await (async () => { await t.as(ALICE); return (await overview()).incoming[0].friendship_id as string; })());
    for (const who of [BOB, CAROL]) {
      await t.as(who);
      expect((await q<{ r: string }>("select public.respond_friend_request($1, true) as r", [id]))[0].r).toBe("not_found");
    }
    await t.as(ALICE);
    expect((await q<{ r: string }>("select public.respond_friend_request($1, true) as r", [id]))[0].r).toBe("accepted");
    expect((await overview()).friends.map((f) => f.username)).toEqual(["bobby"]);
    await t.as(BOB);
    expect((await overview()).friends.map((f) => f.username)).toEqual(["alice"]);
  });

  it("asking someone who already asked you simply makes you friends", async () => {
    await t.as(CAROL);
    expect(await send(CAROL, "dave")).toBe("sent");
    await t.as(DAVE);
    expect(await send(DAVE, "carol")).toBe("accepted");
    expect((await overview()).friends.map((f) => f.username)).toEqual(["carol"]);
    await t.as(CAROL);
    expect(await send(CAROL, "dave")).toBe("already_friends");
  });

  it("answers for strange requests: yourself, nobody, duplicates, and people with no profile of your own", async () => {
    await t.as(CAROL);
    expect(await send(CAROL, "carol")).toBe("self");
    expect(await send(CAROL, "no_such_person")).toBe("not_found");
    expect(await send(CAROL, "alice")).toBe("sent");
    expect(await send(CAROL, "alice")).toBe("already_requested");
    await t.as("admin");
    const lonely = "55555555-5555-4555-8555-555555555555";
    await t.db.query("insert into auth.users (id) values ($1)", [lonely]);
    await t.as(lonely);
    expect(await send(lonely, "alice")).toBe("need_username");
    await t.as("anon");
    await expect(q("select public.send_friend_request('alice')")).rejects.toThrow(/permission denied/i);
  });

  it("a declined request cannot be sent again, and the asker is not told it was declined", async () => {
    await t.as(ALICE);
    const id = (await overview()).incoming.find((r) => r.username === "carol")!.friendship_id as string;
    expect((await q<{ r: string }>("select public.respond_friend_request($1, false) as r", [id]))[0].r).toBe("declined");
    await t.as(CAROL);
    expect(await send(CAROL, "alice")).toBe("already_requested"); // same answer as a pending one
    expect((await overview()).friends.map((f) => f.username)).toEqual(["dave"]);
    expect(await prof("alice")).toBeNull();
    // but Alice, who declined, may ask Carol herself later
    await t.as(ALICE);
    expect(await send(ALICE, "carol")).toBe("sent");
    await t.as(CAROL);
    expect((await overview()).incoming.map((r) => r.username)).toEqual(["alice"]);
    const again = (await overview()).incoming[0].friendship_id as string;
    expect((await q<{ r: string }>("select public.respond_friend_request($1, true) as r", [again]))[0].r).toBe("accepted");
  });

  it("the table cannot be written directly by anyone", async () => {
    await t.as(DAVE);
    await expect(q("insert into friendships (requester_id, addressee_id, status) values ($1, $2, 'accepted')", [DAVE, ALICE])).rejects.toThrow(/row-level security/i);
    expect(await q("update friendships set status = 'accepted' returning id")).toEqual([]);
    expect(await q("delete from friendships returning id")).toEqual([]);
    // and people see only their own rows
    await t.as(CAROL);
    expect((await q("select * from friendships")).every((r) => r.requester_id === CAROL || r.addressee_id === CAROL)).toBe(true);
  });

  it("limits how many requests one person can have open", async () => {
    await t.as("admin");
    const spammer = "66666666-6666-4666-8666-666666666666";
    await t.db.query("insert into auth.users (id) values ($1)", [spammer]);
    await t.db.query("insert into profiles (id, username) values ($1, 'spammer')", [spammer]);
    await t.db.query("insert into auth.users (id) select gen_random_uuid() from generate_series(0, 30)");
    await t.db.query(
      "insert into profiles (id, username) select id, 'target_' || (row_number() over (order by id) - 1) from auth.users where id not in (select id from profiles) and id <> $1",
      [spammer],
    );
    await t.as(spammer);
    const results: string[] = [];
    for (let i = 0; i < 31; i++) results.push(await send(spammer, `target_${i}`));
    expect(results.filter((r) => r === "sent")).toHaveLength(30);
    expect(results[30]).toBe("too_many");
  });
});

describe("what a friend can see", () => {
  it("friends see each other's profile; strangers and the signed-out see nothing", async () => {
    await t.as(BOB);
    expect(await prof("alice")).toMatchObject({ username: "alice", display_name: "alice Display", bio: "alice bio" });
    await t.as(DAVE); // not Alice's friend
    expect(await prof("alice")).toBeNull();
    expect(await lib("alice")).toBeNull();
    expect(await prof("no_such_person")).toBeNull(); // the same answer as for a real stranger
    await t.as("anon");
    await expect(q("select public.friend_profile('alice')")).rejects.toThrow(/permission denied/i);
    await expect(q("select public.friend_library('alice')")).rejects.toThrow(/permission denied/i);
  });

  it("a friend's library is thin: title, author, status, progress counts and cover ids, and NOTHING private", async () => {
    await t.as(BOB);
    const l = (await lib("alice"))!;
    expect(l.shared).toBe(true);
    expect(l.books).toHaveLength(1);
    const book = l.books[0];
    expect(book).toMatchObject({ title: "Alice Novel", author: "An Author", status: "reading", finished: 1, total: 1 });
    expect((book.volumes as Row[])[0]).toMatchObject({ cover_image_id: aliceCover });
    const everything = JSON.stringify(l);
    expect(everything).not.toMatch(/zx|private|bookmark|source_url|content|note/i); // no chapter text/titles, notes, chat, links
    expect(Object.keys(book).sort()).toEqual(["author", "cover_image_id", "cover_url", "current_chapter", "finished", "id", "reading_volume_id", "status", "title", "total", "volumes"]);
  });

  it("friends cannot read the rows behind it directly (books, chapters, bookmarks, chat, progress)", async () => {
    await t.as(BOB);
    for (const table of ["books", "chapters", "bookmarks", "chat_messages", "reading_progress", "volumes", "chunks", "book_images"]) {
      expect(await q(`select * from ${table} where user_id = $1`, [ALICE]), table).toEqual([]);
    }
  });

  it("switching library sharing off hides the books at once, but not the profile", async () => {
    await t.as(ALICE);
    await t.db.query("update profiles set share_library = false where id = $1", [ALICE]);
    await t.as(BOB);
    expect(await lib("alice")).toEqual({ shared: false, books: [] });
    expect(await prof("alice")).toMatchObject({ username: "alice", share_library: false });
    expect(await q("select public.friend_cover('alice', $1) as r", [aliceCover])).toEqual([{ r: null }]);
    await t.as(ALICE);
    await t.db.query("update profiles set share_library = true where id = $1", [ALICE]);
  });

  it("friends can read the avatar and cover files, but never chapter illustrations, and strangers read nothing", async () => {
    const names = async () => (await q<{ name: string }>("select name from storage.objects where bucket_id = 'book-images' order by name")).map((r) => r.name.split("/").slice(1).join("/"));
    await t.as(BOB);
    expect(await names()).toEqual([`${aliceBook}/cover.jpg`, "avatar/11111111-1111-4111-8111-111111111111.webp"].sort());
    await t.as(DAVE);
    expect(await names()).toEqual([]);
    await t.as(ALICE);
    expect(await names()).toHaveLength(3); // the owner still sees everything, including the illustration
  });

  it("with sharing off, friends lose the covers but keep the avatar", async () => {
    await t.as(ALICE);
    await t.db.query("update profiles set share_library = false where id = $1", [ALICE]);
    await t.as(BOB);
    const names = (await q<{ name: string }>("select name from storage.objects where bucket_id = 'book-images'")).map((r) => r.name);
    expect(names).toEqual([`${ALICE}/avatar/11111111-1111-4111-8111-111111111111.webp`]);
    await t.as(ALICE);
    await t.db.query("update profiles set share_library = true where id = $1", [ALICE]);
  });

  it("friend_cover and friend_avatar_path answer only for friends, only for covers", async () => {
    await t.as(BOB);
    expect((await q<{ r: { path: string } | null }>("select public.friend_cover('alice', $1) as r", [aliceCover]))[0].r).toMatchObject({ path: `${ALICE}/${aliceBook}/cover.jpg` });
    expect((await q<{ r: unknown }>("select public.friend_cover('alice', $1) as r", [aliceChapterImage]))[0].r).toBeNull(); // a chapter illustration
    expect((await q<{ r: string }>("select public.friend_avatar_path('alice') as r"))[0].r).toContain("/avatar/");
    await t.as(DAVE);
    expect((await q<{ r: unknown }>("select public.friend_cover('alice', $1) as r", [aliceCover]))[0].r).toBeNull();
    expect((await q<{ r: unknown }>("select public.friend_avatar_path('alice') as r"))[0].r).toBeNull();
  });

  it("is_friend_of only ever answers about the caller, so it cannot be used to probe other people's friendships", async () => {
    await t.as(DAVE);
    expect((await q<{ r: boolean }>("select public.is_friend_of($1) as r", [ALICE]))[0].r).toBe(false);
    expect((await q<{ r: boolean }>("select public.is_friend_of($1) as r", [CAROL]))[0].r).toBe(true); // Dave IS Carol's friend
    await expect(q("select public.is_friend_of($1, $2)", [ALICE, BOB])).rejects.toThrow();
  });
});

describe("ending a friendship", () => {
  it("either friend can unfriend, and access ends at once", async () => {
    await t.as(BOB);
    const id = (await overview()).friends.find((f) => f.username === "alice")!.friendship_id as string;
    await t.as(DAVE);
    expect((await q<{ r: boolean }>("select public.remove_friendship($1) as r", [id]))[0].r).toBe(false); // a stranger cannot
    await t.as(BOB);
    expect((await q<{ r: boolean }>("select public.remove_friendship($1) as r", [id]))[0].r).toBe(true);
    expect(await lib("alice")).toBeNull();
    expect(await prof("alice")).toBeNull();
    expect(await q("select name from storage.objects where bucket_id = 'book-images'")).toEqual([]);
    await t.as(ALICE);
    expect((await overview()).friends.map((f) => f.username)).not.toContain("bobby");
  });

  it("after unfriending, the two can become friends again", async () => {
    await befriend(ALICE, "alice", BOB, "bobby");
    await t.as(BOB);
    expect((await lib("alice"))!.books).toHaveLength(1);
  });

  it("a sender can cancel a pending request; the receiver cannot 'remove' it (they decline it)", async () => {
    await t.as(DAVE);
    expect(await send(DAVE, "bobby")).toBe("sent");
    const id = (await overview()).outgoing[0].friendship_id as string;
    await t.as(BOB);
    expect((await q<{ r: boolean }>("select public.remove_friendship($1) as r", [id]))[0].r).toBe(false);
    await t.as(DAVE);
    expect((await q<{ r: boolean }>("select public.remove_friendship($1) as r", [id]))[0].r).toBe(true);
    expect((await overview()).outgoing).toEqual([]);
  });

  it("a declined request cannot be cleared by the person who sent it (that would let them ask again)", async () => {
    await t.as("admin");
    const [x, y] = ["99999999-0000-4000-8000-000000000001", "99999999-0000-4000-8000-000000000002"];
    for (const [id, name] of [[x, "decliner_x"], [y, "asker_y"]]) {
      await t.db.query("insert into auth.users (id) values ($1)", [id]);
      await t.db.query("insert into profiles (id, username) values ($1, $2)", [id, name]);
    }
    await t.as(y);
    expect(await send(y, "decliner_x")).toBe("sent");
    await t.as(x);
    const id = (await overview()).incoming[0].friendship_id as string;
    expect((await q<{ r: string }>("select public.respond_friend_request($1, false) as r", [id]))[0].r).toBe("declined");
    await t.as(y);
    expect((await q<{ r: boolean }>("select public.remove_friendship($1) as r", [id]))[0].r).toBe(false);
    expect(await send(y, "decliner_x")).toBe("already_requested");
    await t.as(x);
    expect((await q<{ r: boolean }>("select public.remove_friendship($1) as r", [id]))[0].r).toBe(false); // nobody can clear it
  });

  it("deleting an account removes its friendships", async () => {
    await t.as("admin");
    const gone = "88888888-8888-4888-8888-888888888888";
    await t.db.query("insert into auth.users (id) values ($1)", [gone]);
    await t.db.query("insert into profiles (id, username) values ($1, 'goner')", [gone]);
    await t.db.query("insert into friendships (requester_id, addressee_id, status) values ($1, $2, 'accepted')", [gone, ALICE]);
    await t.db.query("delete from auth.users where id = $1", [gone]);
    expect(await q("select * from friendships where requester_id = $1 or addressee_id = $1", [gone])).toEqual([]);
  });
});
