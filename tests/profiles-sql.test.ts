import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESERVED_USERNAMES, validateUsername } from "@/lib/profile";
import { ALICE, BOB, bootDb } from "./helpers/db";

/** Profiles, usernames and the username -> email lookup, against the real migration and row level security. */
let t: Awaited<ReturnType<typeof bootDb>>;
const SECRET = "a-long-random-secret-for-tests-0123456789";
const CAROL = "33333333-3333-3333-3333-333333333333";

const asServer = async (secret: string | null) => {
  // PostgREST puts the request headers in this setting; the server's lookup client sends the secret as a header.
  await t.db.query("select set_config('request.headers', $1, false)", [secret === null ? "" : JSON.stringify({ "x-recall-login-secret": secret })]);
};

beforeAll(async () => {
  t = await bootDb();
  await t.as("admin");
  await t.db.query("update auth.users set email = 'alice@example.com' where id = $1", [ALICE]);
  await t.db.query("update auth.users set email = 'bob@example.com' where id = $1", [BOB]);
  await t.db.query("insert into auth.users (id, email) values ($1, 'carol@example.com')", [CAROL]);
  await t.db.query("select public.set_login_lookup_secret($1)", [SECRET]);
});
afterAll(async () => {
  await t.db.close();
});

describe("username rules (database and app agree)", () => {
  const cases = ["alice", "Alice_1", "ab", "a".repeat(21), "has space", "dash-name", "ünïcode", "admin", "ADMIN", "library", "me", "add", "ok_name_9", "___", "x1y", "", "  padded  "];
  it("the app's validateUsername accepts exactly what username_valid accepts", async () => {
    for (const raw of cases) {
      const app = validateUsername(raw).ok;
      const db = (await t.db.query<{ v: boolean }>("select public.username_valid(lower(trim($1))) as v", [raw])).rows[0].v;
      expect(app, `"${raw}"`).toBe(db);
    }
  });

  it("every reserved name is refused by both", async () => {
    for (const name of RESERVED_USERNAMES) {
      expect(validateUsername(name).ok).toBe(false);
      expect((await t.db.query<{ v: boolean }>("select public.username_valid($1) as v", [name])).rows[0].v).toBe(false);
    }
  });
});

describe("profiles table", () => {
  it("an owner creates, reads and updates their own profile; the table refuses bad usernames", async () => {
    await t.as(ALICE);
    await t.db.query("insert into profiles (username, display_name, bio) values ('alice', 'Alice A', 'I read a lot')");
    const mine = await t.db.query<{ id: string; username: string }>("select id, username from profiles");
    expect(mine.rows).toEqual([{ id: ALICE, username: "alice" }]); // the id defaulted to the signed-in user
    await t.db.query("update profiles set bio = 'Updated bio' where id = $1", [ALICE]);
    for (const bad of ["ab", "Has Space", "admin", "x".repeat(21), "UPPER"]) {
      await t.as(BOB);
      await expect(t.db.query("insert into profiles (username) values ($1)", [bad]), bad).rejects.toThrow();
    }
  });

  it("usernames are unique", async () => {
    await t.as(BOB);
    await expect(t.db.query("insert into profiles (username) values ('alice')")).rejects.toThrow(/duplicate|unique/i);
    await t.db.query("insert into profiles (username) values ('bobby')");
  });

  it("nobody can read, change or create another person's profile", async () => {
    await t.as(BOB);
    expect((await t.db.query("select * from profiles where id = $1", [ALICE])).rows).toEqual([]);
    expect((await t.db.query("update profiles set bio = 'hacked' where id = $1 returning id", [ALICE])).rows).toEqual([]);
    expect((await t.db.query("delete from profiles where id = $1 returning id", [ALICE])).rows).toEqual([]);
    await expect(t.db.query("insert into profiles (id, username) values ($1, 'impostor')", [CAROL])).rejects.toThrow(/row-level security/i);
    await t.as("anon");
    await expect(t.db.query("select * from profiles")).rejects.toThrow(/permission denied/i);
    await t.as("admin");
    expect((await t.db.query<{ bio: string }>("select bio from profiles where id = $1", [ALICE])).rows[0].bio).toBe("Updated bio");
  });

  it("limits the lengths of the name and bio", async () => {
    await t.as(ALICE);
    await expect(t.db.query("update profiles set bio = $1 where id = $2", ["x".repeat(301), ALICE])).rejects.toThrow();
    await expect(t.db.query("update profiles set display_name = $1 where id = $2", ["x".repeat(61), ALICE])).rejects.toThrow();
  });

  it("an avatar must be in the owner's own folder", async () => {
    await t.as(ALICE);
    await t.db.query("update profiles set avatar_path = $1 where id = $2", [`${ALICE}/avatar/11111111-1111-4111-8111-111111111111.webp`, ALICE]);
    await expect(t.db.query("update profiles set avatar_path = $1 where id = $2", [`${BOB}/avatar/11111111-1111-4111-8111-111111111111.webp`, ALICE])).rejects.toThrow();
    await expect(t.db.query("update profiles set avatar_path = $1 where id = $2", ["elsewhere/file.png", ALICE])).rejects.toThrow();
    await t.db.query("update profiles set avatar_path = null where id = $1", [ALICE]);
  });

  it("renaming frees the old username", async () => {
    await t.as(BOB);
    await t.db.query("update profiles set username = 'bobby2' where id = $1", [BOB]);
    expect((await t.db.query<{ a: boolean }>("select public.username_available('bobby') as a")).rows[0].a).toBe(true);
    await t.db.query("update profiles set username = 'bobby' where id = $1", [BOB]);
  });
});

describe("username_available", () => {
  it("answers yes/no for anyone, including signed-out visitors, and never says who has a name", async () => {
    await t.as("anon");
    const q = async (n: string) => (await t.db.query<{ a: boolean }>("select public.username_available($1) as a", [n])).rows[0].a;
    expect(await q("alice")).toBe(false); // taken
    expect(await q("  ALICE ")).toBe(false); // case and spaces do not matter
    expect(await q("brand_new_name")).toBe(true);
    expect(await q("admin")).toBe(false); // reserved
    expect(await q("a")).toBe(false); // invalid
  });
});

describe("the sign-up trigger", () => {
  it("creates the profile from the username in the sign-up data", async () => {
    await t.as("admin");
    const id = "44444444-4444-4444-4444-444444444444";
    await t.db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'dave@example.com', '{"username": "  Dave_9 "}')`, [id]);
    expect((await t.db.query<{ username: string }>("select username from profiles where id = $1", [id])).rows).toEqual([{ username: "dave_9" }]);
  });

  it("never blocks sign-up: a missing, invalid or taken username just means no profile yet", async () => {
    await t.as("admin");
    for (const [id, meta] of [
      ["55555555-5555-4555-8555-555555555555", "{}"],
      ["66666666-6666-4666-8666-666666666666", '{"username": "admin"}'],
      ["77777777-7777-4777-8777-777777777777", '{"username": "alice"}'],
    ]) {
      await t.db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)", [id, `${id}@example.com`, meta]);
      expect((await t.db.query("select 1 from profiles where id = $1", [id])).rows).toEqual([]);
    }
  });
});

describe("login_email: username -> email, only for the server", () => {
  const lookup = async (u: string) => (await t.db.query<{ e: string | null }>("select public.login_email($1) as e", [u])).rows[0].e;

  it("returns the email only to a request that carries the server's secret", async () => {
    await t.as("anon");
    await asServer(SECRET);
    expect(await lookup("alice")).toBe("alice@example.com");
    expect(await lookup("  ALICE ")).toBe("alice@example.com");
    expect(await lookup("nobody_here")).toBeNull();
  });

  it("returns nothing without the header, with a wrong secret, or with an empty one", async () => {
    await t.as("anon");
    for (const bad of [null, "", "wrong-secret-wrong-secret-wrong", SECRET + "x", SECRET.slice(1)]) {
      await asServer(bad);
      expect(await lookup("alice"), String(bad)).toBeNull();
    }
    await asServer(null);
  });

  it("returns nothing at all until a secret has been set (a fresh database)", async () => {
    const fresh = await bootDb();
    await fresh.as("admin");
    await fresh.db.query("update auth.users set email = 'alice@example.com' where id = $1", [ALICE]);
    await fresh.db.query("insert into profiles (id, username) values ($1, 'alice')", [ALICE]);
    await fresh.db.query("select set_config('request.headers', $1, false)", [JSON.stringify({ "x-recall-login-secret": SECRET })]);
    expect((await fresh.db.query<{ e: string | null }>("select public.login_email('alice') as e")).rows[0].e).toBeNull();
    await fresh.db.close();
  });

  it("only the SQL editor can set the secret; the secret table is closed to everyone else", async () => {
    for (const who of [ALICE, "anon"] as const) {
      await t.as(who);
      await expect(t.db.query("select public.set_login_lookup_secret('hijacked-hijacked-hijacked')")).rejects.toThrow(/permission denied/i);
      await expect(t.db.query("select * from private.app_secret")).rejects.toThrow(/permission denied/i);
    }
    await asServer(SECRET);
    await t.as("anon");
    expect(await lookup("alice")).toBe("alice@example.com"); // still the original secret
    await asServer(null);
  });

  it("a signed-in user without the secret cannot look up anyone's email either", async () => {
    await t.as(BOB);
    await asServer(null);
    expect(await lookup("alice")).toBeNull();
  });
});
