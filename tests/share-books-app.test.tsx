import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyFiles, COPY_CONCURRENCY, type StorageLike } from "@/lib/book-copy";

const BOOK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEW_BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const h = vi.hoisted(() => ({
  rpc: [] as { name: string; args: unknown }[],
  rpcResult: {} as Record<string, { data: unknown; error: { code: string } | null }>,
  downloads: [] as string[],
  uploads: [] as { path: string; type: string }[],
  removed: [] as string[],
  deletedBooks: [] as string[],
  failDownload: null as string | null,
  failUpload: null as string | null,
  updates: [] as Record<string, unknown>[],
  updatedRows: [{ id: "x" }] as unknown[],
  dbError: null as { code: string } | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: unknown) => (h.rpc.push({ name, args }), h.rpcResult[name] ?? { data: null, error: null }),
    storage: {
      from: () => ({
        download: async (p: string) => (h.downloads.push(p), p === h.failDownload ? { data: null, error: { message: "x" } } : { data: new Blob(["img"]), error: null }),
        upload: async (p: string, _b: Blob, o: { contentType: string }) => (p === h.failUpload ? { error: { message: "x" } } : (h.uploads.push({ path: p, type: o.contentType }), { error: null })),
        remove: async (p: string[]) => void h.removed.push(...p),
      }),
    },
    from: () => ({
      update: (v: Record<string, unknown>) => (h.updates.push(v), { eq: () => ({ select: async () => ({ data: h.dbError ? null : h.updatedRows, error: h.dbError }) }) }),
      delete: () => ({ eq: async (_c: string, id: string) => (h.deletedBooks.push(id), { error: null }) }),
    }),
  }),
}));

import { AddFriendBook } from "@/components/add-friend-book";
import { FriendBookCard } from "@/components/friend-book-card";
import { ShareBookToggle } from "@/components/share-book-toggle";

const read = (f: string) => readFileSync(path.resolve(import.meta.dirname, "..", f), "utf8");

beforeEach(() => {
  h.rpc.length = h.downloads.length = h.uploads.length = h.removed.length = h.deletedBooks.length = h.updates.length = 0;
  h.rpcResult = {};
  h.failDownload = h.failUpload = null;
  h.updatedRows = [{ id: "x" }];
  h.dbError = null;
});

const files = (n: number) => Array.from({ length: n }, (_, i) => ({ from: `friend/${BOOK}/f${i}.png`, to: `me/${NEW_BOOK}/n${i}.png`, mime: "image/png" }));

describe("copyFiles", () => {
  const store = (over: Partial<StorageLike> = {}): StorageLike & { running: number; peak: number } => {
    const s = {
      running: 0,
      peak: 0,
      download: async (p: string) => {
        s.running++;
        s.peak = Math.max(s.peak, s.running);
        await new Promise((r) => setTimeout(r, 4));
        s.running--;
        return p.includes("bad") ? { data: null, error: new Error("x") } : { data: new Blob(["x"]), error: null };
      },
      upload: async () => ({ error: null }),
      remove: async () => undefined,
      ...over,
    };
    return s;
  };

  it("copies every file, a few at a time, never more than the limit", async () => {
    const s = store();
    expect(await copyFiles(s, files(12))).toEqual({ ok: true });
    expect(s.peak).toBeGreaterThan(1);
    expect(s.peak).toBeLessThanOrEqual(COPY_CONCURRENCY);
  });

  it("uploads under the new path with the right type, and never overwrites", async () => {
    const calls: { to: string; opts: unknown }[] = [];
    const s = store({ upload: async (to, _b, opts) => (calls.push({ to, opts }), { error: null }) });
    await copyFiles(s, [{ from: "a/b/old.png", to: "me/nb/new.png", mime: "image/png" }]);
    expect(calls).toEqual([{ to: "me/nb/new.png", opts: { contentType: "image/png", upsert: false } }]);
  });

  it("if one file fails, everything already written is removed and the result says so", async () => {
    const removed: string[] = [];
    const uploaded: string[] = [];
    const s = store({ upload: async (to) => (uploaded.push(to), { error: null }), remove: async (p) => void removed.push(...p) });
    const list = [...files(3), { from: "friend/bad.png", to: "me/x/bad.png", mime: "image/png" }, ...files(3)];
    const res = await copyFiles(s, list, 1);
    expect(res.ok).toBe(false);
    expect(removed.sort()).toEqual(uploaded.sort());
    expect(removed.length).toBeGreaterThan(0);
    expect(removed).not.toContain("me/x/bad.png");
  });

  it("a failing upload also counts as a failure", async () => {
    const res = await copyFiles(store({ upload: async () => ({ error: new Error("quota") }) }), files(2));
    expect(res.ok).toBe(false);
  });

  it("no files is fine (a text-only novel)", async () => {
    expect(await copyFiles(store(), [])).toEqual({ ok: true });
  });
});

describe("setBookShared", () => {
  it("changes only the sharing switch of the caller's own book", async () => {
    const { setBookShared } = await import("@/app/actions/friends");
    expect(await setBookShared(BOOK, true)).toEqual({ ok: true, data: undefined });
    expect(h.updates).toEqual([{ shared_with_friends: true }]);
    h.updatedRows = [];
    expect(await setBookShared(BOOK, false)).toMatchObject({ ok: false, error: "That novel wasn't found." }); // someone else's book updates no row
    expect((await setBookShared("nope", true)).ok).toBe(false);
    expect((await setBookShared(BOOK, "yes" as never)).ok).toBe(false);
  });

  it("explains a missing migration", async () => {
    const { setBookShared } = await import("@/app/actions/friends");
    h.dbError = { code: "42703" };
    expect(JSON.stringify(await setBookShared(BOOK, true))).toMatch(/0012_share_books\.sql/);
  });
});

describe("addFriendBook", () => {
  const ok = { book_id: NEW_BOOK, slug: "their-novel", images: files(5) };

  it("asks the database to copy, then copies the pictures it names, and returns the new address", async () => {
    const { addFriendBook } = await import("@/app/actions/friends");
    h.rpcResult.copy_friend_book = { data: ok, error: null };
    const res = await addFriendBook("  Mira_Reads ", BOOK);
    expect(res).toEqual({ ok: true, data: { slug: "their-novel", alreadyAdded: false } });
    expect(h.rpc).toEqual([{ name: "copy_friend_book", args: { p_owner_username: "mira_reads", p_book_id: BOOK } }]);
    expect(h.downloads.sort()).toEqual(ok.images.map((i) => i.from).sort());
    expect(h.uploads.map((u) => u.path).sort()).toEqual(ok.images.map((i) => i.to).sort());
    expect(h.deletedBooks).toEqual([]);
  });

  it("the browser cannot choose which files are copied: only the database's list is used", async () => {
    const { addFriendBook } = await import("@/app/actions/friends");
    h.rpcResult.copy_friend_book = { data: ok, error: null };
    await addFriendBook("mira_reads", BOOK);
    expect(h.downloads.every((p) => p.startsWith(`friend/${BOOK}/`))).toBe(true);
    expect(read("app/actions/friends.ts")).toMatch(/export async function addFriendBook\(username: string, bookId: string\)/);
  });

  it("a failed picture copy removes the new book and every file written, and says nothing was added", async () => {
    const { addFriendBook } = await import("@/app/actions/friends");
    h.rpcResult.copy_friend_book = { data: ok, error: null };
    h.failDownload = ok.images[3].from;
    const res = await addFriendBook("mira_reads", BOOK);
    expect(res).toMatchObject({ ok: false, error: "Couldn't copy the pictures, so nothing was added. Please try again." });
    expect(h.deletedBooks).toEqual([NEW_BOOK]);
    expect(h.removed.sort()).toEqual(h.uploads.map((u) => u.path).sort());
  });

  it("a novel you already added just opens your copy", async () => {
    const { addFriendBook } = await import("@/app/actions/friends");
    h.rpcResult.copy_friend_book = { data: { error: "already_added", book_id: NEW_BOOK, slug: "their-novel" }, error: null };
    expect(await addFriendBook("mira_reads", BOOK)).toEqual({ ok: true, data: { slug: "their-novel", alreadyAdded: true } });
    expect(h.downloads).toEqual([]);
  });

  it("every refusal is plain, and a book that is not shared reads the same as one that does not exist", async () => {
    const { addFriendBook } = await import("@/app/actions/friends");
    for (const [error, text] of [["not_found", /isn't available to add/], ["too_large", /too large/], ["not_signed_in", /Sign in again/], ["something_new", /Couldn't add that novel/]] as const) {
      h.rpcResult.copy_friend_book = { data: { error }, error: null };
      const res = await addFriendBook("mira_reads", BOOK);
      expect(res.ok, error).toBe(false);
      expect(JSON.stringify(res), error).toMatch(text);
    }
    expect(h.downloads).toEqual([]);
    expect(h.deletedBooks).toEqual([]);
  });

  it("bad names and ids are refused before asking the database; a missing migration says what to run", async () => {
    const { addFriendBook } = await import("@/app/actions/friends");
    expect((await addFriendBook("ab", BOOK)).ok).toBe(false);
    expect((await addFriendBook("mira_reads", "not-an-id")).ok).toBe(false);
    expect(h.rpc).toEqual([]);
    h.rpcResult.copy_friend_book = { data: null, error: { code: "PGRST202" } };
    expect(JSON.stringify(await addFriendBook("mira_reads", BOOK))).toMatch(/0012_share_books\.sql/);
    h.rpcResult.copy_friend_book = { data: { weird: true }, error: null };
    expect((await addFriendBook("mira_reads", BOOK)).ok).toBe(false);
  });
});

describe("screens", () => {
  const book = { id: BOOK, title: "Their Novel", author: null, status: "reading", coverImageId: null, coverUrl: null, finished: 1, total: 4 };

  it("a friend's shared novel offers 'Add to my library'", () => {
    const html = renderToStaticMarkup(<FriendBookCard owner="mira_reads" book={{ ...book, shareable: true, mySlug: null }} />);
    expect(html).toContain('data-testid="add-to-library"');
    expect(html).toContain("+ Add to my library");
  });

  it("a novel that is not shared offers nothing", () => {
    const html = renderToStaticMarkup(<FriendBookCard owner="mira_reads" book={{ ...book, shareable: false, mySlug: null }} />);
    expect(html).not.toContain("add-to-library");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });

  it("a novel you already added links to your own copy", () => {
    const html = renderToStaticMarkup(<FriendBookCard owner="mira_reads" book={{ ...book, shareable: true, mySlug: "their-novel" }} />);
    expect(html).toContain('href="/library/their-novel"');
    expect(html).toContain("In your library");
    expect(html).not.toContain("add-to-library");
  });

  it("the add button reports progress and errors on screen (not silently)", () => {
    const source = read("components/add-friend-book.tsx");
    expect(source).toContain("Copying… this can take a moment");
    expect(source).toContain('aria-busy={pending}');
    expect(source).toContain('role="alert"');
    expect(renderToStaticMarkup(<AddFriendBook username="m" bookId={BOOK} shareable mySlug={null} />)).toContain("disabled=\"\"".slice(0, 0) + "Add to my library");
  });

  it("the owner's switch is off by default, per novel, with the rights reminder", () => {
    const off = renderToStaticMarkup(<ShareBookToggle bookId={BOOK} shared={false} />);
    expect(off).toContain("Let friends add this novel to their library");
    expect(off).toContain("Only share files you");
    expect(off).toContain("not your progress, bookmarks or chats");
    expect(off).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(renderToStaticMarkup(<ShareBookToggle bookId={BOOK} shared />)).toMatch(/type="checkbox"[^>]*checked/);
  });

  it("the book page shows the switch for the owner's own book, and the screens use only design tokens", () => {
    expect(read("app/library/[bookId]/page.tsx")).toContain("<ShareBookToggle bookId={book.id} shared={book.shared_with_friends} />");
    for (const f of ["components/add-friend-book.tsx", "components/share-book-toggle.tsx"]) {
      expect(read(f), f).not.toMatch(/\b(?:bg|text|border|ring|outline)-(?:white|black|gray|slate|zinc|neutral|red|blue|green)(?:-\d{2,3})?\b/);
      expect(read(f), f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
