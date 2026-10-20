import { beforeEach, describe, expect, it, vi } from "vitest";
import { friendlyMessage } from "@/lib/assistant/errors";
import { ProviderError } from "@/lib/assistant/provider";
import { fakeProvider, everythingSent, type FakeProvider } from "./helpers/assistant-fixture";

/**
 * The server actions askAssistant and recapStory, with a stub Supabase client and a fake AI provider. These tests are
 * about what the BROWSER can and cannot do: it cannot supply text, a boundary or a position, and every failure has a
 * clear, generic message.
 */
const BOOK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const h = vi.hoisted(() => ({
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcData: {} as Record<string, unknown>,
  rpcError: {} as Record<string, { code: string } | undefined>,
  inserted: [] as Record<string, unknown>[],
  counts: { minute: 0, day: 0 },
  provider: null as unknown as FakeProvider,
}));

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "u1", email: null }) }));
vi.mock("@/lib/assistant/gemini", () => ({ createGeminiProvider: () => h.provider }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args });
      return { data: h.rpcData[name] ?? null, error: h.rpcError[name] ?? null };
    },
    from: (table: string) => {
      const q = {
        opts: undefined as { head?: boolean } | undefined,
        rows: undefined as Record<string, unknown>[] | undefined,
        select(_c?: string, opts?: { head?: boolean }) {
          this.opts = opts;
          return this;
        },
        insert(rows: Record<string, unknown>[]) {
          this.rows = rows;
          return this;
        },
        eq() { return this; },
        gte() { return this; },
        lte() { return this; },
        gt() { return this; },
        order() { return this; },
        limit() { return this; },
        then(res: (v: unknown) => unknown) {
          if (this.rows) {
            h.inserted.push(...this.rows);
            return Promise.resolve({ data: this.rows.map((r, i) => ({ id: `m${i}`, sources: null, created_at: "2026-01-01T00:00:00Z", ...r })), error: null }).then(res);
          }
          if (this.opts?.head) return Promise.resolve({ count: table === "chat_messages" ? h.counts.minute : 0, error: null }).then(res);
          return Promise.resolve({ data: [], error: null }).then(res);
        },
      };
      return q;
    },
  }),
}));

const passage = (n: number, content: string) => ({
  chunk_id: `c${n}`, chapter_id: `x${n}`, chapter_number: n, chapter_title: `Chapter ${n}`, volume_number: 1, volume_title: null, arc: null,
  content, rank: 1, block_first: 0, block_last: 1,
});
const LONG = "Mira found the brass key in the cellar of the clock shop and hid it from Master Odell for many long weeks, while the city above her slowly forgot what the great clock had once been built to do.";

beforeEach(() => {
  h.rpcCalls.length = 0;
  h.inserted.length = 0;
  h.counts = { minute: 0, day: 0 };
  h.rpcError = {};
  h.provider = fakeProvider("It is the key to the vault [1].");
  h.rpcData = {
    assistant_context: { boundary: 2, partial_block: 1, passages: [passage(1, LONG)] },
    recap_context: { boundary: 2, partial_block: 1, passages: [passage(1, LONG), passage(2, "Odell warned Mira about the Guild and gave her a map to the old tower of the city, telling her to burn it as soon as she had memorised every turn.")] },
    selection_context: {
      ok: true, chapter_number: 3, chapter_title: "The Tower", volume_number: 1, block_first: 2, block_last: 2,
      texts: [{ idx: 2, line: "Tamsin said that the brass key opened the vault under the great clock." }], is_current_chapter: true,
    },
  };
  vi.stubEnv("GEMINI_API_KEY", "test-key-not-real");
});

const sel = { chapter: 3, from: 2, to: 2, rev: 1 };

describe("askAssistant with a selected passage", () => {
  it("the browser cannot supply text: only the passage the server read goes to the model", async () => {
    const { askAssistant } = await import("@/app/actions/assistant");
    const res = await askAssistant(BOOK, "What does this mean?", { ...sel, quote: "FAKE TEXT THE BROWSER INVENTED about the ending" });
    expect(res.ok).toBe(true);
    const sent = everythingSent(h.provider);
    expect(sent).toContain("brass key opened the vault"); // the server's copy
    expect(sent).not.toContain("FAKE TEXT"); // a quote that does not occur in the server's text is dropped
  });

  it("a quote that does occur in the server's passage is kept as the highlighted part", async () => {
    const { askAssistant } = await import("@/app/actions/assistant");
    await askAssistant(BOOK, "What does this mean?", { ...sel, quote: "the brass   key opened the vault" });
    expect(everythingSent(h.provider)).toContain('The reader highlighted: "the brass   key opened the vault"');
  });

  it("the browser cannot supply a boundary: retrieval is called with the book and the words only", async () => {
    const { askAssistant } = await import("@/app/actions/assistant");
    await askAssistant(BOOK, "Who is Tamsin?", sel);
    const retrieval = h.rpcCalls.find((c) => c.name === "assistant_context")!;
    expect(Object.keys(retrieval.args).sort()).toEqual(["p_book_id", "p_limit", "p_per_chapter", "p_terms"]);
    const selection = h.rpcCalls.find((c) => c.name === "selection_context")!;
    expect(selection.args).toEqual({ p_book_id: BOOK, p_chapter: 3, p_from: 2, p_to: 2, p_rev: 1 }); // numbers only, validated by the database
  });

  it("6. a selection the database refuses never reaches the model, and the message says why without any book text", async () => {
    const { askAssistant } = await import("@/app/actions/assistant");
    for (const [reason, code] of [["ahead", "selection_ahead"], ["far", "selection_far"], ["stale", "selection_stale"], ["invalid", "selection_invalid"]] as const) {
      h.rpcData.selection_context = { ok: false, reason };
      const res = await askAssistant(BOOK, "What does this mean?", sel);
      expect(res).toMatchObject({ ok: false, code });
      expect(!res.ok && res.error).toBe(friendlyMessage(code));
    }
    expect(h.provider.calls).toHaveLength(0);
    expect(h.inserted).toHaveLength(0); // nothing stored
  });

  it("7. the answer is stored at the position of the passage it used, and the stored question names the passage", async () => {
    const { askAssistant } = await import("@/app/actions/assistant");
    const res = await askAssistant(BOOK, "Why the key?", { ...sel, quote: "the brass key opened the vault" });
    expect(res.ok).toBe(true);
    expect(h.inserted).toHaveLength(2);
    expect(h.inserted.map((m) => m.boundary_block)).toEqual([2, 2]); // the selection's last paragraph (the recorded boundary was 1)
    expect(h.inserted.map((m) => m.boundary_chapter)).toEqual([2, 2]);
    expect(h.inserted[0].content).toBe("About “the brass key opened the vault”: Why the key?");
  });

  it("11. a missing API key, quota limits and provider errors give useful messages and store nothing", async () => {
    const { askAssistant } = await import("@/app/actions/assistant");
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(await askAssistant(BOOK, "Who?", sel)).toMatchObject({ ok: false, code: "missing_key", error: friendlyMessage("missing_key") });
    vi.stubEnv("GEMINI_API_KEY", "test-key-not-real");

    h.counts = { minute: 99, day: 0 };
    expect(await askAssistant(BOOK, "Who?", sel)).toMatchObject({ ok: false, code: "local_rate_limited" });
    h.counts = { minute: 0, day: 0 };

    h.provider = fakeProvider(new ProviderError("rate_limited", 40));
    expect(await askAssistant(BOOK, "Who?", sel)).toMatchObject({ ok: false, code: "rate_limited", error: friendlyMessage("rate_limited", 40) });
    h.provider = fakeProvider(new ProviderError("invalid_key"));
    expect(await askAssistant(BOOK, "Who?", sel)).toMatchObject({ ok: false, code: "invalid_key" });
    expect(h.inserted).toHaveLength(0);
  });

  it("a database without migration 0009 says what to run, instead of failing mysteriously", async () => {
    const { askAssistant } = await import("@/app/actions/assistant");
    h.rpcError.selection_context = { code: "42883" };
    const res = await askAssistant(BOOK, "Who?", sel);
    expect(!res.ok && res.error).toMatch(/0009_recap_and_selection\.sql/);
  });

  it("rejects malformed input before anything is read", async () => {
    const { askAssistant } = await import("@/app/actions/assistant");
    expect((await askAssistant(BOOK, "Who?", { ...sel, from: -1 })).ok).toBe(false);
    expect((await askAssistant("not-an-id", "Who?", sel)).ok).toBe(false);
    expect((await askAssistant(BOOK, "x", sel)).ok).toBe(false);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("ordinary questions without a selection still work and store the plain question", async () => {
    const { askAssistant } = await import("@/app/actions/assistant");
    const res = await askAssistant(BOOK, "Who is Mira?");
    expect(res.ok).toBe(true);
    expect(h.rpcCalls.map((c) => c.name)).toEqual(["assistant_context"]);
    expect(h.inserted[0].content).toBe("Who is Mira?");
    expect(h.inserted.map((m) => m.boundary_block)).toEqual([1, 1]);
  });
});

describe("recapStory", () => {
  it("sends only the book id's own recap request and stores the exchange at the recap's position", async () => {
    const { recapStory } = await import("@/app/actions/assistant");
    h.provider = fakeProvider("Mira has the key [1] and Odell warned her [2].");
    const res = await recapStory(BOOK);
    expect(res.ok).toBe(true);
    expect(h.rpcCalls).toEqual([{ name: "recap_context", args: { p_book_id: BOOK, p_chapters: 3, p_chunks: 2, p_blocks: 6 } }]); // no boundary, no chapter, no text
    expect(h.provider.calls).toHaveLength(1);
    expect(h.inserted.map((m) => m.content)[0]).toBe("Remind me what happened");
    expect(h.inserted.map((m) => m.boundary_block)).toEqual([1, 1]);
    const out = res.ok ? res.data.find((m) => m.role === "assistant")! : null;
    expect(out?.sources?.length).toBeGreaterThan(0);
  });

  it("5. when the database cannot validate the boundary, nothing is summarised and nothing is stored", async () => {
    const { recapStory } = await import("@/app/actions/assistant");
    h.rpcData.recap_context = { boundary: null, partial_block: -1, passages: [] };
    expect(await recapStory(BOOK)).toMatchObject({ ok: false, code: "not_found" });
    h.rpcData.recap_context = { nonsense: true };
    const bad = await recapStory(BOOK);
    expect(bad.ok).toBe(false);
    expect(h.provider.calls).toHaveLength(0);
    expect(h.inserted).toHaveLength(0);
  });

  it("nothing read yet gets an honest message, no model call and no stored chat", async () => {
    const { recapStory } = await import("@/app/actions/assistant");
    h.rpcData.recap_context = { boundary: 0, partial_block: -1, passages: [] };
    const res = await recapStory(BOOK);
    expect(res.ok && res.data[0].content).toMatch(/haven't read anything yet/);
    expect(h.provider.calls).toHaveLength(0);
    expect(h.inserted).toHaveLength(0);
  });

  it("11. missing key, rate limit and provider errors", async () => {
    const { recapStory } = await import("@/app/actions/assistant");
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(await recapStory(BOOK)).toMatchObject({ ok: false, code: "missing_key" });
    vi.stubEnv("GEMINI_API_KEY", "test-key-not-real");
    h.counts = { minute: 99, day: 0 };
    expect(await recapStory(BOOK)).toMatchObject({ ok: false, code: "local_rate_limited" });
    h.counts = { minute: 0, day: 0 };
    h.provider = fakeProvider(new ProviderError("timeout"));
    expect(await recapStory(BOOK)).toMatchObject({ ok: false, code: "timeout", error: friendlyMessage("timeout") });
    h.rpcError.recap_context = { code: "42883" };
    expect(await recapStory(BOOK)).toMatchObject({ ok: false });
    const res = await recapStory(BOOK);
    expect(!res.ok && res.error).toMatch(/0009_recap_and_selection\.sql/);
    expect(h.inserted).toHaveLength(0);
  });

  it("an invalid book id is refused before anything runs", async () => {
    const { recapStory } = await import("@/app/actions/assistant");
    expect((await recapStory("nope")).ok).toBe(false);
    expect(h.rpcCalls).toHaveLength(0);
  });
});
