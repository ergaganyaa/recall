import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { avatarPathPattern, avatarVersion, initialsOf, looksLikeEmail, type Profile } from "@/lib/profile";

const h = vi.hoisted(() => ({
  pathname: "/profile",
  user: { id: "u1", email: "a@b.co" } as { id: string; email: string } | null,
  avatarPath: null as string | null,
  blob: new Blob(["img"]) as Blob | null,
  rpc: [] as { name: string; args: unknown; headers: unknown }[],
  rpcResult: { data: "alice@example.com", error: null } as { data: unknown; error: { code: string } | null },
  clientOptions: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => h.pathname,
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/app/actions/auth", () => ({ signIn: async () => ({}), signUp: async () => ({}), signOut: async () => undefined }));
vi.mock("@/app/actions/profile", () => ({
  changePassword: async () => ({ ok: true }), changeUsername: async () => ({ ok: true }), claimUsername: async () => ({ ok: true }),
  removeAvatar: async () => ({ ok: true }), setAvatar: async () => ({ ok: true }), updateProfile: async () => ({ ok: true }),
}));
vi.mock("@/lib/auth", () => ({ getUser: async () => h.user, requireUser: async () => h.user }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.avatarPath ? { avatar_path: h.avatarPath } : null }) }) }) }),
    storage: { from: () => ({ download: async () => (h.blob ? { data: h.blob, error: null } : { data: null, error: { message: "x" } }) }) },
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: { global?: { headers?: unknown } }) => {
    h.clientOptions.push(options);
    return { rpc: async (name: string, args: unknown) => (h.rpc.push({ name, args, headers: options.global?.headers }), h.rpcResult) };
  },
}));
vi.mock("@/lib/supabase/config", () => ({ supabaseUrl: "https://x.supabase.co", supabaseKey: "publishable", isSupabaseConfigured: true }));

import { AuthForm } from "@/components/auth-form";
import { Avatar } from "@/components/avatar";
import { ClaimUsername, ProfileEditor } from "@/components/profile-editor";
import { SiteHeader } from "@/components/site-header";

const read = (f: string) => readFileSync(path.resolve(import.meta.dirname, "..", f), "utf8");
const U = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
const profile: Profile = { id: U, username: "mira_o", display_name: "Mira Odell", bio: "I read a lot", avatar_path: null, share_library: true, created_at: "2026-01-01T00:00:00Z" };

beforeEach(() => {
  h.pathname = "/profile";
  h.user = { id: "u1", email: "a@b.co" };
  h.avatarPath = null;
  h.blob = new Blob(["img"]);
  h.rpc.length = 0;
  h.clientOptions.length = 0;
  h.rpcResult = { data: "alice@example.com", error: null };
});

describe("profile helpers", () => {
  it("tells an email from a username", () => {
    expect(looksLikeEmail("a@b.co")).toBe(true);
    expect(looksLikeEmail(" a@b.co ")).toBe(true);
    for (const s of ["mira_o", "a@", "@b.co", "a b@c.d", ""]) expect(looksLikeEmail(s), s).toBe(false);
  });

  it("accepts avatar paths only inside the owner's avatar folder", () => {
    const ok = avatarPathPattern(U);
    expect(ok.test(`${U}/avatar/${FILE}.webp`)).toBe(true);
    expect(ok.test(`${U}/avatar/${FILE}.jpg`)).toBe(true);
    for (const bad of [`${U}/avatar/${FILE}.png`, `${U}/avatar/${FILE}xwebp`, `${FILE}/avatar/${FILE}.webp`, `${U}/avatar/../${FILE}.webp`, `${U}/${FILE}.webp`, `${U}/avatar/${FILE}.webp/extra`]) {
      expect(ok.test(bad), bad).toBe(false);
    }
  });

  it("reads the version from an avatar path and makes initials", () => {
    expect(avatarVersion(`${U}/avatar/${FILE}.webp`)).toBe(FILE);
    expect(avatarVersion(null)).toBeNull();
    expect(avatarVersion("garbage")).toBeNull();
    expect(initialsOf({ display_name: "Mira Odell" })).toBe("MO");
    expect(initialsOf({ display_name: "  mira  ", username: "x" })).toBe("M");
    expect(initialsOf({ username: "mira_o_reads" })).toBe("MR");
    expect(initialsOf(null)).toBe("?");
  });
});

describe("signing in and signing up forms", () => {
  it("the login box takes a username or an email, and asks for nothing else", () => {
    const html = renderToStaticMarkup(<AuthForm mode="login" />);
    expect(html).toContain("Username or email");
    expect(html).toContain('name="identifier"');
    expect(html).toContain('type="text"'); // an email-only field would reject a username
    expect(html).not.toContain('name="email"');
    expect(html).toContain('autoComplete="username"');
  });

  it("the sign-up form asks for a username, an email and a password, and says what a username may contain", () => {
    const html = renderToStaticMarkup(<AuthForm mode="signup" />);
    expect(html).toContain('name="username"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toMatch(/pattern="\[A-Za-z0-9_\]\{3,20\}"/);
    expect(html).toContain("3–20 letters, numbers or underscores");
  });
});

describe("avatar", () => {
  it("shows initials when there is no picture, and the account's own picture route when there is", () => {
    const none = renderToStaticMarkup(<Avatar profile={profile} size="lg" />);
    expect(none).toContain(">MO<");
    expect(none).not.toContain("<img");
    const withPic = renderToStaticMarkup(<Avatar profile={{ ...profile, avatar_path: `${U}/avatar/${FILE}.webp` }} size="lg" />);
    expect(withPic).toContain(`src="/profile/avatar?v=${FILE}"`);
    expect(withPic).toContain("Mira Odell&#x27;s picture");
    expect(renderToStaticMarkup(<Avatar profile={null} />)).toContain(">?<");
  });
});

describe("profile editor", () => {
  it("offers picture, details, username and password, with the current values", () => {
    const html = renderToStaticMarkup(<ProfileEditor profile={profile} userId={U} />);
    for (const title of ["Profile picture", "About you", "Username", "Password"]) expect(html).toContain(title);
    expect(html).toContain('value="Mira Odell"');
    expect(html).toContain('value="mira_o"');
    expect(html).toContain("I read a lot");
    expect(html).toContain("Upload a picture");
    expect(html).toContain('accept="image/jpeg,image/png,image/webp,image/gif,image/avif"');
    expect(html).not.toContain("Remove"); // no picture yet
    const withPic = renderToStaticMarkup(<ProfileEditor profile={{ ...profile, avatar_path: `${U}/avatar/${FILE}.webp` }} userId={U} />);
    expect(withPic).toContain("Change picture");
    expect(withPic).toContain("Remove");
  });

  it("accounts without a profile are asked to choose a username", () => {
    const html = renderToStaticMarkup(<ClaimUsername />);
    expect(html).toContain("Choose your username");
    expect(html).toContain('aria-label="Username"');
  });

  it("uses only design tokens (themes) and visible focus rings", () => {
    for (const f of ["components/profile-editor.tsx", "components/avatar.tsx", "components/library-section.tsx", "app/profile/page.tsx"]) {
      const source = read(f);
      expect(source, f).not.toMatch(/\b(?:bg|text|border|ring|outline)-(?:white|black|gray|slate|zinc|neutral|red|blue|green)(?:-\d{2,3})?\b/);
      expect(source, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe("navigation: the library lives on the profile", () => {
  const header = (pathname: string) => {
    h.pathname = pathname;
    return renderToStaticMarkup(<SiteHeader account={<span>acct</span>} />);
  };

  it("the header has Home and My library (-> /profile), and no separate Library link", () => {
    const html = header("/");
    expect(html).toContain('href="/profile"');
    expect(html).toContain("My library");
    expect(html).not.toContain('href="/library"');
  });

  it("My library is highlighted on the profile and on book pages", () => {
    expect(header("/profile")).toMatch(/aria-current="page"[^>]*>My library|My library/);
    expect(header("/library/some-book")).toMatch(/href="\/profile"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/profile"/);
    expect(header("/")).not.toMatch(/href="\/profile"[^>]*aria-current="page"/);
  });

  it("the old /library address redirects to the library on the profile", async () => {
    const { default: LibraryPage } = await import("@/app/library/page");
    expect(() => LibraryPage()).toThrow("REDIRECT /profile#library");
  });

  it("the profile is protected like the library, and nothing links to the old address any more", () => {
    expect(read("proxy.ts")).toContain('["/library", "/profile", "/friends"]');
    for (const f of ["components/home-hero.tsx", "app/error.tsx", "app/library/add/page.tsx", "app/library/[bookId]/page.tsx", "app/library/[bookId]/not-found.tsx"]) {
      expect(read(f), f).not.toContain('href="/library"');
    }
  });
});

describe("the avatar route", () => {
  const call = async (query = "") => (await import("@/app/profile/avatar/route")).GET(new Request(`http://x/profile/avatar${query}`));

  it("is private: signed-out visitors get 401", async () => {
    h.user = null;
    expect((await call()).status).toBe(401);
  });

  it("is 404 when there is no avatar or no file", async () => {
    expect((await call()).status).toBe(404);
    h.avatarPath = `${U}/avatar/${FILE}.webp`;
    h.blob = null;
    expect((await call()).status).toBe(404);
  });

  it("serves the caller's own avatar with a long cache (the URL changes with every new picture)", async () => {
    h.avatarPath = `${U}/avatar/${FILE}.webp`;
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("without ?u= it can only ever return the caller's own picture", async () => {
    h.avatarPath = `${U}/avatar/${FILE}.webp`;
    expect((await call("?v=anything")).status).toBe(200);
    expect(read("app/profile/avatar/route.ts")).toContain('.eq("id", user.id)');
  });
});

describe("the username lookup client", () => {
  const SECRET = "a-long-random-secret-0123456789";

  it("sends the server's secret in a header and asks only for one username", async () => {
    const { lookupEmail } = await import("@/lib/supabase/lookup");
    const res = await lookupEmail("alice", SECRET);
    expect(res).toEqual({ status: "found", email: "alice@example.com" });
    expect(h.rpc).toEqual([{ name: "login_email", args: { p_username: "alice" }, headers: { "x-recall-login-secret": SECRET } }]);
    expect(h.clientOptions[0]).toMatchObject({ auth: { persistSession: false, autoRefreshToken: false } }); // no session is created or shared
  });

  it("does nothing, and says so, when no secret is configured (or it is too short to be one)", async () => {
    const { lookupEmail } = await import("@/lib/supabase/lookup");
    for (const secret of [undefined, "", "short"]) expect(await lookupEmail("alice", secret)).toEqual({ status: "unconfigured" });
    expect(h.rpc).toEqual([]);
  });

  it("tells apart: nobody with that name, a missing migration, and other errors", async () => {
    const { lookupEmail } = await import("@/lib/supabase/lookup");
    h.rpcResult = { data: null, error: null };
    expect(await lookupEmail("nobody", SECRET)).toEqual({ status: "none" });
    h.rpcResult = { data: "", error: null };
    expect(await lookupEmail("nobody", SECRET)).toEqual({ status: "none" });
    h.rpcResult = { data: null, error: { code: "PGRST202" } };
    expect(await lookupEmail("alice", SECRET)).toEqual({ status: "missing_migration" });
    h.rpcResult = { data: null, error: { code: "XX000" } };
    expect(await lookupEmail("alice", SECRET)).toEqual({ status: "error" });
  });

  it("the secret never reaches client code", () => {
    expect(read("lib/supabase/lookup.ts")).toContain('import "server-only"');
    expect(read(".env.example")).toMatch(/LOGIN_LOOKUP_SECRET/);
    expect(read(".env.example")).not.toMatch(/NEXT_PUBLIC_LOGIN/);
  });
});
