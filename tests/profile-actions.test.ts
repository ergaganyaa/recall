import { beforeEach, describe, expect, it, vi } from "vitest";
import { BAD_LOGIN, safeNext } from "@/lib/auth-redirect";

/**
 * Sign-in with a username, sign-up, and the profile actions, with a stub Supabase client. These tests are about what
 * the server does with what the browser sends, and about messages that must not reveal who has an account.
 */
const USER = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  signIn: [] as { email: string; password: string }[],
  signUp: [] as Record<string, unknown>[],
  rpc: [] as { name: string; args: unknown }[],
  rpcResult: { username_available: { data: true, error: null } } as Record<string, { data: unknown; error: { code: string } | null }>,
  signInError: null as { message: string } | null,
  lookup: { status: "found", email: "alice@example.com" } as { status: string; email?: string },
  lookups: [] as string[],
  updates: [] as { table: string; values: Record<string, unknown> }[],
  inserts: [] as { table: string; values: Record<string, unknown> }[],
  removed: [] as string[],
  dbError: null as { code: string } | null,
  updatedRows: [{ id: "x", username: "x" }] as unknown[],
  currentAvatar: null as string | null,
  passwordError: null as unknown,
  sessionOnSignUp: false,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: USER, email: "alice@example.com" }) }));
vi.mock("@/lib/supabase/lookup", () => ({
  lookupEmail: async (u: string) => {
    h.lookups.push(u);
    return h.lookup;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signInWithPassword: async (c: { email: string; password: string }) => {
        h.signIn.push(c);
        return { error: h.signInError };
      },
      signUp: async (c: Record<string, unknown>) => {
        h.signUp.push(c);
        return { data: { session: h.sessionOnSignUp ? {} : null }, error: null };
      },
      updateUser: async () => ({ error: h.passwordError }),
    },
    rpc: async (name: string, args: unknown) => {
      h.rpc.push({ name, args });
      return h.rpcResult[name] ?? { data: null, error: null };
    },
    storage: { from: () => ({ remove: async (p: string[]) => void h.removed.push(...p) }) },
    from: (table: string) => {
      const q = {
        mode: "select" as "select" | "update" | "insert",
        values: {} as Record<string, unknown>,
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: { avatar_path: h.currentAvatar }, error: null }),
        update(values: Record<string, unknown>) { this.mode = "update"; this.values = values; return this; },
        insert(values: Record<string, unknown>) { this.mode = "insert"; this.values = values; return this; },
        then(res: (v: unknown) => unknown) {
          if (this.mode === "update") h.updates.push({ table, values: this.values });
          if (this.mode === "insert") h.inserts.push({ table, values: this.values });
          return Promise.resolve({ data: h.dbError ? null : h.updatedRows, error: h.dbError }).then(res);
        },
      };
      return q;
    },
  }),
}));

beforeEach(() => {
  h.signIn.length = h.signUp.length = h.rpc.length = h.lookups.length = h.updates.length = h.inserts.length = h.removed.length = 0;
  h.rpcResult = { username_available: { data: true, error: null } };
  h.signInError = null;
  h.lookup = { status: "found", email: "alice@example.com" };
  h.dbError = null;
  h.updatedRows = [{ id: "x", username: "x" }];
  h.currentAvatar = null;
  h.passwordError = null;
  h.sessionOnSignUp = false;
});

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("signing in", () => {
  it("with an email address, the username lookup is not used at all", async () => {
    const { signIn } = await import("@/app/actions/auth");
    await expect(signIn({}, form({ identifier: "Alice@Example.com", password: "correct horse" }))).rejects.toThrow("REDIRECT /profile");
    expect(h.lookups).toEqual([]);
    expect(h.signIn).toEqual([{ email: "Alice@Example.com", password: "correct horse" }]);
  });

  it("with a username, the server finds the email, then signs in with it", async () => {
    const { signIn } = await import("@/app/actions/auth");
    await expect(signIn({}, form({ identifier: "  Alice_1 ", password: "correct horse" }))).rejects.toThrow("REDIRECT /profile");
    expect(h.lookups).toEqual(["alice_1"]); // normalised
    expect(h.signIn).toEqual([{ email: "alice@example.com", password: "correct horse" }]);
  });

  it("an unknown username, a wrong password and a malformed name all give the SAME message (nothing reveals who has an account)", async () => {
    const { signIn } = await import("@/app/actions/auth");
    h.lookup = { status: "none" };
    const unknown = await signIn({}, form({ identifier: "nobody_here", password: "x-password" }));
    h.lookup = { status: "found", email: "alice@example.com" };
    h.signInError = { message: "Invalid login credentials" };
    const wrongPassword = await signIn({}, form({ identifier: "alice", password: "wrong-password" }));
    const wrongEmail = await signIn({}, form({ identifier: "ghost@example.com", password: "wrong-password" }));
    const malformed = await signIn({}, form({ identifier: "has space!", password: "x-password" }));
    for (const r of [unknown, wrongPassword, wrongEmail, malformed]) expect(r).toEqual({ error: BAD_LOGIN });
    expect(h.lookups).not.toContain("has space!"); // never even looked up
  });

  it("says plainly when username sign-in is not set up or the migration is missing (that reveals nothing about accounts)", async () => {
    const { signIn } = await import("@/app/actions/auth");
    h.lookup = { status: "unconfigured" };
    expect((await signIn({}, form({ identifier: "alice", password: "x-password" }))).error).toMatch(/isn't set up on this server yet/);
    h.lookup = { status: "missing_migration" };
    expect((await signIn({}, form({ identifier: "alice", password: "x-password" }))).error).toMatch(/0010_profiles\.sql/);
    h.lookup = { status: "error" };
    expect((await signIn({}, form({ identifier: "alice", password: "x-password" }))).error).toMatch(/Couldn't check that username/);
    expect(h.signIn).toEqual([]);
  });

  it("still accepts the old form field name 'email', and rejects an empty box", async () => {
    const { signIn } = await import("@/app/actions/auth");
    await expect(signIn({}, form({ email: "a@b.co", password: "correct horse" }))).rejects.toThrow("REDIRECT");
    expect((await signIn({}, form({ identifier: "  ", password: "x" }))).error).toMatch(/username or email/);
    expect((await signIn({}, form({ identifier: "alice", password: "" }))).error).toMatch(/password/);
  });

  it("only goes to a same-site address afterwards", async () => {
    expect(safeNext("/library/some-book")).toBe("/library/some-book");
    expect(safeNext("https://evil.example")).toBe("/profile");
    expect(safeNext("//evil.example")).toBe("/profile");
    expect(safeNext(null)).toBe("/profile");
    const { signIn } = await import("@/app/actions/auth");
    await expect(signIn({}, form({ identifier: "a@b.co", password: "correct horse", next: "//evil.example" }))).rejects.toThrow("REDIRECT /profile");
  });
});

describe("signing up", () => {
  const ok = { username: "New_Reader", email: "new@example.com", password: "a-good-password" };

  it("checks the username with the database, then sends it as sign-up data (the database creates the profile)", async () => {
    const { signUp } = await import("@/app/actions/auth");
    const res = await signUp({}, form(ok));
    expect(h.rpc).toEqual([{ name: "username_available", args: { p_username: "new_reader" } }]);
    expect(h.signUp).toEqual([{ email: "new@example.com", password: "a-good-password", options: { data: { username: "new_reader" } } }]);
    expect(res.message).toMatch(/Check your inbox/);
  });

  it("with email confirmation off it goes straight to the profile", async () => {
    const { signUp } = await import("@/app/actions/auth");
    h.sessionOnSignUp = true;
    await expect(signUp({}, form(ok))).rejects.toThrow("REDIRECT /profile");
  });

  it("refuses bad, reserved and taken usernames before creating anything", async () => {
    const { signUp } = await import("@/app/actions/auth");
    for (const username of ["ab", "has space", "admin", "x".repeat(21)]) {
      expect((await signUp({}, form({ ...ok, username }))).error, username).toBeTruthy();
    }
    h.rpcResult.username_available = { data: false, error: null };
    expect((await signUp({}, form(ok))).error).toMatch(/taken or not available/);
    expect(h.signUp).toEqual([]);
  });

  it("explains a missing migration, and validates the email and password", async () => {
    const { signUp } = await import("@/app/actions/auth");
    h.rpcResult.username_available = { data: null, error: { code: "PGRST202" } };
    expect((await signUp({}, form(ok))).error).toMatch(/0010_profiles\.sql/);
    expect((await signUp({}, form({ ...ok, email: "nope" }))).error).toMatch(/valid email/);
    expect((await signUp({}, form({ ...ok, password: "short" }))).error).toMatch(/at least 8/);
  });
});

describe("profile actions", () => {
  it("claiming a username inserts only the username (the database sets the owner) and maps a clash to a friendly message", async () => {
    const { claimUsername } = await import("@/app/actions/profile");
    expect(await claimUsername("  Mira_Reads ")).toEqual({ ok: true, data: { username: "mira_reads" } });
    expect(h.inserts).toEqual([{ table: "profiles", values: { username: "mira_reads" } }]);
    h.dbError = { code: "23505" };
    expect(await claimUsername("taken_name")).toMatchObject({ ok: false, error: expect.stringMatching(/taken or not available/) });
    h.dbError = { code: "42P01" };
    expect(await claimUsername("another")).toMatchObject({ ok: false, error: expect.stringMatching(/0010_profiles\.sql/) });
    expect(await claimUsername("admin")).toMatchObject({ ok: false });
  });

  it("changing the username validates it, writes it for the caller only, and reports a clash or a missing profile", async () => {
    const { changeUsername } = await import("@/app/actions/profile");
    expect(await changeUsername("new_name")).toEqual({ ok: true, data: { username: "new_name" } });
    expect(h.updates[0].values).toMatchObject({ username: "new_name" });
    expect((await changeUsername("no")).ok).toBe(false);
    h.updatedRows = [];
    expect(await changeUsername("new_name")).toMatchObject({ ok: false, error: "Choose a username first." });
    h.updatedRows = [{ id: "x" }];
    h.dbError = { code: "23505" };
    expect(await changeUsername("taken")).toMatchObject({ ok: false, error: expect.stringMatching(/taken/) });
  });

  it("saves a display name and bio (trimmed, bounded; empty means none)", async () => {
    const { updateProfile } = await import("@/app/actions/profile");
    expect(await updateProfile({ displayName: "  Mira O.  ", bio: "" })).toEqual({ ok: true, data: undefined });
    expect(h.updates[0].values).toMatchObject({ display_name: "Mira O.", bio: null });
    expect((await updateProfile({ displayName: "x".repeat(61), bio: "" })).ok).toBe(false);
    expect((await updateProfile({ displayName: "", bio: "x".repeat(301) })).ok).toBe(false);
    h.updatedRows = [];
    expect(await updateProfile({ displayName: "A", bio: "" })).toMatchObject({ ok: false, error: "Choose a username first." });
  });

  it("an avatar can only be a file in the caller's own avatar folder, and the old one is removed", async () => {
    const { setAvatar } = await import("@/app/actions/profile");
    const good = `${USER}/avatar/22222222-2222-4222-8222-222222222222.webp`;
    h.currentAvatar = `${USER}/avatar/33333333-3333-4333-8333-333333333333.webp`;
    expect(await setAvatar(good)).toEqual({ ok: true, data: undefined });
    expect(h.updates[0].values).toMatchObject({ avatar_path: good });
    expect(h.removed).toEqual([h.currentAvatar]);
    h.updates.length = 0;
    for (const bad of [
      `22222222-2222-4222-8222-222222222222/avatar/22222222-2222-4222-8222-222222222222.webp`, // another user's folder
      `${USER}/avatar/22222222-2222-4222-8222-222222222222.exe`,
      `${USER}/book/22222222-2222-4222-8222-222222222222.webp`,
      `${USER}/avatar/../../x.webp`,
      `${USER}/avatar/22222222-2222-4222-8222-222222222222xwebp`,
      "",
    ]) {
      expect(await setAvatar(bad), bad).toMatchObject({ ok: false });
    }
    expect(h.updates).toEqual([]);
  });

  it("an avatar upload is cleaned up if it cannot be saved", async () => {
    const { setAvatar } = await import("@/app/actions/profile");
    const good = `${USER}/avatar/22222222-2222-4222-8222-222222222222.jpg`;
    h.dbError = { code: "XX000" };
    expect(await setAvatar(good)).toMatchObject({ ok: false });
    expect(h.removed).toEqual([good]);
  });

  it("removing the avatar clears it and deletes the file", async () => {
    const { removeAvatar } = await import("@/app/actions/profile");
    h.currentAvatar = `${USER}/avatar/33333333-3333-4333-8333-333333333333.webp`;
    expect(await removeAvatar()).toEqual({ ok: true, data: undefined });
    expect(h.updates[0].values).toMatchObject({ avatar_path: null });
    expect(h.removed).toEqual([h.currentAvatar]);
  });

  it("changes the password only when it is long enough", async () => {
    const { changePassword } = await import("@/app/actions/profile");
    expect((await changePassword("short")).ok).toBe(false);
    expect(await changePassword("a-long-enough-password")).toEqual({ ok: true, data: undefined });
    h.passwordError = { message: "needs reauthentication: secret details" };
    const res = await changePassword("a-long-enough-password");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).not.toContain("secret details"); // vendor text is never shown
  });
});
