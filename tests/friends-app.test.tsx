import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseCover } from "@/lib/cover";

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "a@b.co" } as { id: string } | null,
  rpc: [] as { name: string; args: unknown }[],
  rpcResult: {} as Record<string, { data: unknown; error: { code: string } | null }>,
  downloaded: [] as string[],
  blob: new Blob(["img"]) as Blob | null,
  updates: [] as Record<string, unknown>[],
  updatedRows: [{ id: "x" }] as unknown[],
  dbError: null as { code: string } | null,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => "/friends", redirect: () => undefined, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => h.user, getUser: async () => h.user }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: unknown) => {
      h.rpc.push({ name, args });
      return h.rpcResult[name] ?? { data: null, error: null };
    },
    storage: { from: () => ({ download: async (p: string) => (h.downloaded.push(p), h.blob ? { data: h.blob, error: null } : { data: null, error: { message: "x" } }) }) },
    from: () => ({
      update: (v: Record<string, unknown>) => { h.updates.push(v); return { eq: () => ({ select: async () => ({ data: h.dbError ? null : h.updatedRows, error: h.dbError }) }) }; },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  }),
}));

import { Avatar } from "@/components/avatar";
import { FriendBookCard } from "@/components/friend-book-card";
import { FriendsManager } from "@/components/friends-manager";
import { ProfileEditor } from "@/components/profile-editor";
import { SiteHeader } from "@/components/site-header";
import type { FriendsOverview } from "@/lib/friends";

const read = (f: string) => readFileSync(path.resolve(import.meta.dirname, "..", f), "utf8");
const ID = "99999999-9999-4999-8999-999999999999";
const IMG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  h.user = { id: "u1" };
  h.rpc.length = h.downloaded.length = h.updates.length = 0;
  h.rpcResult = {};
  h.blob = new Blob(["img"]);
  h.updatedRows = [{ id: "x" }];
  h.dbError = null;
});

describe("friend actions", () => {
  it("each answer from the database becomes a clear message; the browser only ever sends a username", async () => {
    const { sendFriendRequest } = await import("@/app/actions/friends");
    for (const [answer, ok, text] of [
      ["sent", true, /request sent/i],
      ["accepted", true, /now friends/i],
      ["already_friends", true, /already friends/i],
      ["already_requested", true, /already open/i],
      ["self", false, /that's you/i],
      ["not_found", false, /No one has that username/],
      ["need_username", false, /Choose a username/],
      ["too_many", false, /too many open requests/],
    ] as const) {
      h.rpcResult.send_friend_request = { data: answer, error: null };
      const res = await sendFriendRequest("  Mira_Reads ");
      expect(res.ok, answer).toBe(ok);
      expect(JSON.stringify(res), answer).toMatch(text);
    }
    expect(h.rpc.every((c) => c.name === "send_friend_request" && JSON.stringify(c.args) === '{"p_username":"mira_reads"}')).toBe(true);
  });

  it("a malformed username is answered like an unknown one, without asking the database", async () => {
    const { sendFriendRequest } = await import("@/app/actions/friends");
    for (const bad of ["", "ab", "has space", "admin", "x".repeat(40), "a@b.co"]) {
      expect(await sendFriendRequest(bad), bad).toMatchObject({ ok: false, error: "No one has that username." });
    }
    expect(h.rpc).toEqual([]);
  });

  it("says what to run when the migration is missing, and hides vendor errors", async () => {
    const { sendFriendRequest, respondToRequest, removeFriend, setLibrarySharing } = await import("@/app/actions/friends");
    h.rpcResult.send_friend_request = { data: null, error: { code: "PGRST202" } };
    expect(JSON.stringify(await sendFriendRequest("mira_reads"))).toMatch(/0011_friends\.sql/);
    h.rpcResult.respond_friend_request = { data: null, error: { code: "XX000" } };
    expect(await respondToRequest(ID, true)).toMatchObject({ ok: false, error: "Couldn't answer the request. Please try again." });
    h.rpcResult.remove_friendship = { data: null, error: { code: "42883" } };
    expect(JSON.stringify(await removeFriend(ID))).toMatch(/0011_friends\.sql/);
    h.dbError = { code: "42703" };
    expect(JSON.stringify(await setLibrarySharing(false))).toMatch(/0011_friends\.sql/);
  });

  it("answering and removing check the id and report a request that is no longer open", async () => {
    const { respondToRequest, removeFriend } = await import("@/app/actions/friends");
    expect(await respondToRequest("not-an-id", true)).toMatchObject({ ok: false });
    expect(await removeFriend("not-an-id")).toMatchObject({ ok: false });
    expect(h.rpc).toEqual([]);
    h.rpcResult.respond_friend_request = { data: "not_found", error: null };
    expect(await respondToRequest(ID, true)).toMatchObject({ ok: false, error: "That request is no longer open." });
    h.rpcResult.respond_friend_request = { data: "accepted", error: null };
    expect(await respondToRequest(ID, true)).toEqual({ ok: true, data: undefined });
    expect(h.rpc.at(-1)).toEqual({ name: "respond_friend_request", args: { p_id: ID, p_accept: true } });
    h.rpcResult.remove_friendship = { data: false, error: null };
    expect(await removeFriend(ID)).toMatchObject({ ok: false, error: "That friendship no longer exists." });
    h.rpcResult.remove_friendship = { data: true, error: null };
    expect(await removeFriend(ID)).toEqual({ ok: true, data: undefined });
  });

  it("library sharing is saved for the signed-in user only", async () => {
    const { setLibrarySharing } = await import("@/app/actions/friends");
    expect(await setLibrarySharing(false)).toEqual({ ok: true, data: undefined });
    expect(h.updates[0]).toMatchObject({ share_library: false });
    h.updatedRows = [];
    expect(await setLibrarySharing(true)).toMatchObject({ ok: false, error: "Choose a username first." });
    expect(await setLibrarySharing("yes" as never)).toMatchObject({ ok: false });
  });
});

describe("a friend's library on the server", () => {
  const book = (over: Record<string, unknown> = {}) => ({
    id: "b1", title: "Their Novel", author: null, status: "reading", cover_image_id: null, cover_url: null,
    volumes: [
      { id: "v1", number: 1, arc_order: 1, imported_at: "2026-01-01T00:00:00Z", cover_image_id: "c1" },
      { id: "v2", number: 2, arc_order: 1, imported_at: "2026-01-02T00:00:00Z", cover_image_id: "c2" },
    ],
    current_chapter: 5, finished: 4, total: 10, reading_volume_id: "v2", shareable: false, my_slug: null, ...over,
  });

  it("covers follow the FRIEND's reading position, and a pinned cover wins", async () => {
    const { getFriendLibrary } = await import("@/lib/friends");
    h.rpcResult.friend_library = { data: { shared: true, books: [book(), book({ id: "b2", current_chapter: 1, reading_volume_id: "v1" }), book({ id: "b3", cover_image_id: "pinned" })] }, error: null };
    const lib = (await getFriendLibrary("mira_reads"))!;
    expect(lib.shared).toBe(true);
    expect(lib.books.map((b) => b.coverImageId)).toEqual(["c2", "c1", "pinned"]);
    expect(lib.books[0]).toMatchObject({ title: "Their Novel", finished: 4, total: 10 });
    expect(h.rpc[0]).toEqual({ name: "friend_library", args: { p_username: "mira_reads" } });
  });

  it("a non-friend, an error or a malformed answer is simply null (the same as an unknown name)", async () => {
    const { getFriendLibrary, getFriendProfile } = await import("@/lib/friends");
    for (const result of [{ data: null, error: null }, { data: null, error: { code: "42883" } }, { data: { shared: "yes" }, error: null }]) {
      h.rpcResult.friend_library = result;
      h.rpcResult.friend_profile = result;
      expect(await getFriendLibrary("x")).toBeNull();
      expect(await getFriendProfile("x")).toBeNull();
    }
  });

  it("sharing turned off gives no books", async () => {
    const { getFriendLibrary } = await import("@/lib/friends");
    h.rpcResult.friend_library = { data: { shared: false, books: [] }, error: null };
    expect(await getFriendLibrary("mira_reads")).toEqual({ shared: false, books: [] });
  });

  it("chooseCover gives the same answer the library page gets (one set of rules)", () => {
    expect(chooseCover({ id: "b", cover_image_id: null, cover_url: "https://x/y.png" }, [], undefined)).toEqual({ imageId: null, url: "https://x/y.png", source: "linked" });
    expect(chooseCover({ id: "b", cover_image_id: null, cover_url: null }, [], undefined).source).toBe("none");
  });
});

describe("routes that serve a friend's pictures", () => {
  const cover = async (username: string, imageId: string) => (await import("@/app/friends/[username]/cover/[imageId]/route")).GET(new Request("http://x"), { params: Promise.resolve({ username, imageId }) } as never);
  const avatar = async (q: string) => (await import("@/app/profile/avatar/route")).GET(new Request(`http://x/profile/avatar${q}`));

  it("covers: signed-out 401; bad names or ids 404 without asking the database; non-friends 404", async () => {
    h.user = null;
    expect((await cover("mira_reads", IMG)).status).toBe(401);
    h.user = { id: "u1" };
    for (const [u, i] of [["admin", IMG], ["has space", IMG], ["mira_reads", "not-a-uuid"]] as const) expect((await cover(u, i)).status).toBe(404);
    expect(h.rpc).toEqual([]);
    h.rpcResult.friend_cover = { data: null, error: null };
    expect((await cover("mira_reads", IMG)).status).toBe(404);
    expect(h.downloaded).toEqual([]);
  });

  it("covers: a friend's cover is fetched only from the path the database approved, with a short cache", async () => {
    h.rpcResult.friend_cover = { data: { path: "friend-id/book/cover.jpg", mime: "image/jpeg" }, error: null };
    const res = await cover("Mira_Reads", IMG);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).not.toContain("immutable"); // access can end with the friendship
    expect(h.downloaded).toEqual(["friend-id/book/cover.jpg"]);
    expect(h.rpc[0]).toEqual({ name: "friend_cover", args: { p_username: "mira_reads", p_image_id: IMG } });
  });

  it("covers: a file the database approved but storage refuses is 404", async () => {
    h.rpcResult.friend_cover = { data: { path: "friend-id/book/cover.jpg", mime: "image/jpeg" }, error: null };
    h.blob = null;
    expect((await cover("mira_reads", IMG)).status).toBe(404);
  });

  it("avatars: ?u= goes through friend_avatar_path, and a non-friend or bad name gets 404", async () => {
    h.rpcResult.friend_avatar_path = { data: "friend-id/avatar/x.webp", error: null };
    expect((await avatar("?u=mira_reads&v=1")).status).toBe(200);
    expect(h.downloaded).toEqual(["friend-id/avatar/x.webp"]);
    h.rpcResult.friend_avatar_path = { data: null, error: null };
    expect((await avatar("?u=stranger")).status).toBe(404);
    expect((await avatar("?u=admin")).status).toBe(404);
    expect((await avatar("?u=has%20space")).status).toBe(404);
  });
});

describe("friends screens", () => {
  const overview: FriendsOverview = {
    friends: [{ friendship_id: ID, username: "mira_reads", display_name: "Mira Odell", avatar_path: "x/avatar/22222222-2222-4222-8222-222222222222.webp", since: null }],
    incoming: [{ friendship_id: ID, username: "odell", display_name: null, created_at: "2026-01-01T00:00:00Z" }],
    outgoing: [{ friendship_id: ID, username: "tamsin", display_name: "Tamsin", created_at: "2026-01-01T00:00:00Z" }],
  };

  it("shows the add box, requests with Accept / Decline, friends and sent requests", () => {
    const html = renderToStaticMarkup(<FriendsManager overview={overview} />);
    expect(html).toContain('data-testid="add-friend"');
    expect(html).toContain("Send request");
    expect(html).toContain("Requests for you");
    expect(html).toContain("Accept");
    expect(html).toContain("Decline");
    expect(html).toContain("Your friends");
    expect(html).toContain('href="/friends/mira_reads"'); // a friend links to their page
    expect(html).toContain("Mira Odell");
    expect(html).toContain("@mira_reads");
    expect(html).toContain("Requests you sent");
    expect(html).toContain("waiting for an answer");
    expect(html).toContain("Cancel");
    // the friend's picture is requested for THAT friend
    expect(html).toContain("/profile/avatar?u=mira_reads&amp;v=22222222-2222-4222-8222-222222222222");
    // a person who only asked has no picture file requested
    expect(html.match(/<img/g)).toHaveLength(1);
  });

  it("an empty list says so and hides the empty request sections", () => {
    const html = renderToStaticMarkup(<FriendsManager overview={{ friends: [], incoming: [], outgoing: [] }} />);
    expect(html).toContain("No friends yet");
    expect(html).not.toContain("Requests for you");
    expect(html).not.toContain("Requests you sent");
  });

  it("a friend's book card is read-only: cover from the friend's cover route, progress, and no link into the book", () => {
    const html = renderToStaticMarkup(<FriendBookCard owner="mira_reads" book={{ id: "b", title: "Their Novel", author: "Au Thor", status: "completed", coverImageId: IMG, coverUrl: null, finished: 5, total: 10, shareable: false, mySlug: null }} />);
    expect(html).toContain(`src="/friends/mira_reads/cover/${IMG}"`);
    expect(html).toContain("Their Novel");
    expect(html).toContain("by Au Thor");
    expect(html).toContain("5 / 10 chapters");
    expect(html).toContain('aria-valuenow="50"');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("/library/");
    expect(renderToStaticMarkup(<FriendBookCard owner="m" book={{ id: "b", title: "No Cover", author: null, status: "reading", coverImageId: null, coverUrl: null, finished: 0, total: 0, shareable: false, mySlug: null }} />)).not.toContain("<img");
  });

  it("Avatar asks for a friend's picture with ?u= only when it is given an owner", () => {
    const p = { username: "mira_reads", display_name: null, avatar_path: "x/avatar/22222222-2222-4222-8222-222222222222.webp" };
    expect(renderToStaticMarkup(<Avatar profile={p} owner="mira_reads" />)).toContain("?u=mira_reads&amp;v=");
    expect(renderToStaticMarkup(<Avatar profile={p} />)).toContain('src="/profile/avatar?v=');
  });

  it("the header links to Friends, and the profile offers a privacy switch for the library", () => {
    expect(renderToStaticMarkup(<SiteHeader account={<span />} />)).toContain('href="/friends"');
    const profile = { id: "u", username: "mira_reads", display_name: null, bio: null, avatar_path: null, share_library: true, created_at: "2026-01-01T00:00:00Z" };
    const html = renderToStaticMarkup(<ProfileEditor profile={profile} userId="u" />);
    expect(html).toContain("Show my library to friends");
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
    expect(renderToStaticMarkup(<ProfileEditor profile={{ ...profile, share_library: false }} userId="u" />)).not.toMatch(/type="checkbox"[^>]*checked/);
  });

  it("friend pages are protected, show the same 404 for strangers and unknown names, and use only design tokens", () => {
    expect(read("proxy.ts")).toContain('"/friends"');
    const page = read("app/friends/[username]/page.tsx");
    expect(page).toContain("if (!profile) notFound();");
    expect(page).toContain("validateUsername(decodeURIComponent(raw))");
    for (const f of ["components/friends-manager.tsx", "components/friend-book-card.tsx", "app/friends/page.tsx", "app/friends/[username]/page.tsx"]) {
      expect(read(f), f).not.toMatch(/\b(?:bg|text|border|ring|outline)-(?:white|black|gray|slate|zinc|neutral|red|blue|green)(?:-\d{2,3})?\b/);
      expect(read(f), f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
