import { describe, expect, it, vi } from "vitest";
import { bookPath, canonicalSuffix, isCanonicalParam, parseBookParam } from "@/lib/book-slug";

const lookups = vi.hoisted(() => ({ n: 0, rows: new Map<string, string>() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      let slug = "";
      const q = {
        select: () => q,
        eq: (_c: string, v: string) => ((slug = v), q),
        maybeSingle: async () => {
          lookups.n++;
          const id = lookups.rows.get(slug);
          return { data: id ? { id } : null, error: null };
        },
      };
      return q;
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: "u1" } }, error: null }) },
  }),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => undefined }));

const ID = "3f9a2c1d-8b4e-4c6a-9d2f-1a2b3c4d5e6f";

describe("readable book addresses", () => {
  it("builds the address from the stored slug", () => {
    expect(bookPath({ slug: "classroom-of-the-elite" })).toBe("/library/classroom-of-the-elite");
    expect(bookPath({ slug: "мастер-и-маргарита" })).toBe("/library/%D0%BC%D0%B0%D1%81%D1%82%D0%B5%D1%80-%D0%B8-%D0%BC%D0%B0%D1%80%D0%B3%D0%B0%D1%80%D0%B8%D1%82%D0%B0");
  });

  it("tells a full id (older links) from a slug, and rejects anything unsafe", () => {
    expect(parseBookParam(ID)).toEqual({ kind: "id", id: ID });
    expect(parseBookParam(ID.toUpperCase())).toEqual({ kind: "id", id: ID });
    expect(parseBookParam("classroom-of-the-elite")).toEqual({ kind: "slug", slug: "classroom-of-the-elite" });
    expect(parseBookParam("%D0%BC%D0%B0")).toEqual({ kind: "slug", slug: "ма" }); // percent-encoded
    for (const bad of ["", "a b", "a/b", "a%2Fb", "a?x=1", "a#b", "%E0%A4%A", "x".repeat(81)]) expect(parseBookParam(bad), bad).toBeNull();
  });

  it("knows when an address already is the canonical slug (encoded or not)", () => {
    expect(isCanonicalParam("my-book", "my-book")).toBe(true);
    expect(isCanonicalParam("%D0%BC%D0%B0", "ма")).toBe(true);
    expect(isCanonicalParam(ID, "my-book")).toBe(false);
    expect(isCanonicalParam("%E0%A4%A", "x")).toBe(false);
  });

  it("keeps the query string when redirecting an old address", () => {
    expect(canonicalSuffix({})).toBe("");
    expect(canonicalSuffix({ p: "0.250", cite: "1", block: ["4", "5"], x: undefined })).toBe("?p=0.250&cite=1&block=4&block=5");
  });
});

describe("resolving an address to a book id", () => {
  it("a full id costs no lookup; a slug costs one, then none; a deleted-and-reused slug resolves afresh after forgetBook", async () => {
    const { resolveBookId, forgetBook } = await import("@/lib/queries");
    lookups.n = 0;
    lookups.rows.set("my-book", ID);
    expect(await resolveBookId(ID)).toBe(ID);
    expect(lookups.n).toBe(0);
    expect(await resolveBookId("my-book")).toBe(ID);
    expect(await resolveBookId("my-book")).toBe(ID);
    expect(lookups.n).toBe(1);
    expect(await resolveBookId("nothing-here")).toBeNull();

    const NEW = "99999999-8b4e-4c6a-9d2f-1a2b3c4d5e6f";
    lookups.rows.set("my-book", NEW); // the book was deleted and a new one took the slug
    expect(await resolveBookId("my-book")).toBe(ID); // stale until a page reports a miss
    await forgetBook("my-book");
    expect(await resolveBookId("my-book")).toBe(NEW);
  });
});
