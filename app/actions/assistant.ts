"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { answerQuestion } from "@/lib/assistant/answer";
import { readAssistantConfig, type AssistantConfig } from "@/lib/assistant/config";
import { checkRateLimit, friendlyMessage } from "@/lib/assistant/errors";
import { createGeminiProvider } from "@/lib/assistant/gemini";
import { generateRecap, RECAP_QUESTION } from "@/lib/assistant/recap";
import type { AnswerOutcome, AssistantErrorCode, ContextResult, HistoryMessage, SelectionText, SourcePassage } from "@/lib/assistant/types";
import { isUuid } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, ChatMessage } from "@/lib/types";

const MSG_COLS = "id,role,content,boundary_chapter,boundary_block,created_at,sources";

const contextShape = z.object({
  boundary: z.number().int().nullable(),
  partial_block: z.number().int(),
  passages: z.array(
    z.object({
      chunk_id: z.string(),
      chapter_id: z.string(),
      chapter_number: z.number().int(),
      chapter_title: z.string(),
      volume_number: z.number().nullable(),
      volume_title: z.string().nullable(),
      arc: z.string().nullable(),
      content: z.string(),
      rank: z.number(),
      block_first: z.number().int().nullable(),
      block_last: z.number().int().nullable(),
    }),
  ),
});

const selectionInput = z.object({
  chapter: z.number().int().min(1).max(100_000),
  from: z.number().int().min(0).max(1_000_000),
  to: z.number().int().min(0).max(1_000_000),
  rev: z.number().int().min(0).max(1_000_000_000),
  /** what the reader highlighted; only used if it really occurs in the passage the server read */
  quote: z.string().max(600).optional(),
});
export type SelectionInput = z.input<typeof selectionInput>;

const selectionShape = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    chapter_number: z.number().int(),
    chapter_title: z.string(),
    volume_number: z.number().nullable(),
    block_first: z.number().int(),
    block_last: z.number().int(),
    texts: z.array(z.object({ idx: z.number().int(), line: z.string() })).min(1),
    is_current_chapter: z.boolean(),
  }),
]);

const REJECTION: Record<string, AssistantErrorCode> = {
  ahead: "selection_ahead",
  far: "selection_far",
  stale: "selection_stale",
  invalid: "selection_invalid",
  not_found: "not_found",
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

type Prepared = { supabase: Awaited<ReturnType<typeof createClient>>; config: AssistantConfig & { apiKey: string }; book: string };

/**
 * What every assistant request starts with: authenticate, validate the book id, require the server-side key and
 * apply the per-user rate limit. Nothing from the browser is trusted beyond the book id and the user's own words.
 */
async function prepare(bookId: string): Promise<{ ok: true; value: Prepared } | { ok: false; error: string; code?: string }> {
  await requireUser();
  if (!isUuid(bookId)) return { ok: false, error: "Invalid request." };

  const config = readAssistantConfig();
  if (!config.apiKey) return { ok: false, error: friendlyMessage("missing_key"), code: "missing_key" };

  const supabase = await createClient();
  // Free-tier protection: limit how fast one account can spend the shared quota (a recap counts as a question).
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const [minute, day] = await Promise.all([
    supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("role", "user").gte("created_at", since(60_000)),
    supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("role", "user").gte("created_at", since(86_400_000)),
  ]);
  const limited = checkRateLimit({ lastMinute: minute.count ?? 0, lastDay: day.count ?? 0 }, config);
  if (limited) return { ok: false, error: friendlyMessage("local_rate_limited", limited.retryAfterSec), code: "local_rate_limited" };

  return { ok: true, value: { supabase, config: config as Prepared["config"], book: bookId } };
}

/** Saves the question and its answer together, only on success, under the position the answer was produced at. */
async function saveExchange(p: Prepared, userText: string, outcome: Extract<AnswerOutcome, { boundary: number }>): Promise<ActionResult<ChatMessage[]>> {
  const t0 = Date.now();
  const { data: saved, error } = await p.supabase
    .from("chat_messages")
    .insert([
      { book_id: p.book, role: "user", content: userText, boundary_chapter: outcome.boundary, boundary_block: outcome.partialBlock, created_at: new Date(t0).toISOString() },
      {
        book_id: p.book,
        role: "assistant",
        content: outcome.text,
        boundary_chapter: outcome.boundary,
        boundary_block: outcome.partialBlock,
        sources: outcome.citations.length ? outcome.citations : null,
        created_at: new Date(t0 + 1).toISOString(),
      },
    ])
    .select(MSG_COLS);
  if (error || !saved || saved.length !== 2) return { ok: false, error: "Couldn't save the conversation." };
  const ordered = [...saved].sort((a, c) => (a.role === "user" ? -1 : 1) - (c.role === "user" ? -1 : 1));
  return { ok: true, data: ordered as ChatMessage[] };
}

/**
 * Spoiler-safe Q&A with an AI model, optionally about a passage the reader selected.
 *
 * The client sends ONLY a question (and, optionally, which paragraphs it selected). Everything that decides what
 * the model may see is derived here from the signed-in user's own rows: the reading boundary is read by the
 * `assistant_context` database function (never passed in), ownership is checked there too, and only passages
 * inside the boundary ever leave the database. A selection is re-read from the chapter by `selection_context`,
 * which refuses a later chapter or paragraphs further ahead than what is on screen; the browser's copy of the text
 * is never used. The API key lives only in server environment variables.
 */
export async function askAssistant(bookId: string, question: string, selection?: SelectionInput): Promise<ActionResult<ChatMessage[]>> {
  const parsed = z
    .object({ b: z.string().refine(isUuid), q: z.string().trim().min(2).max(500), s: selectionInput.optional() })
    .safeParse({ b: bookId, q: question, s: selection });
  await requireUser();
  if (!parsed.success) return { ok: false, error: "Ask a question of 2–500 characters." };
  const { q, s } = parsed.data;

  const prep = await prepare(parsed.data.b);
  if (!prep.ok) return prep;
  const p = prep.value;
  const { supabase, config, book } = p;

  // The passage, re-read by the server. Only an answer of "ok" is used; a rejection says why in generic words.
  let selected: SelectionText | undefined;
  if (s) {
    const { data, error } = await supabase.rpc("selection_context", { p_book_id: book, p_chapter: s.chapter, p_from: s.from, p_to: s.to, p_rev: s.rev });
    const shaped = selectionShape.safeParse(data);
    if (error || !shaped.success) {
      const missing = error?.code === "42883" ? "Run migration 0009_recap_and_selection.sql in the Supabase SQL editor, then try again." : "Couldn't read that passage. Please try again.";
      return { ok: false, error: missing };
    }
    if (!shaped.data.ok) {
      const code = REJECTION[shaped.data.reason] ?? "selection_invalid";
      return { ok: false, error: friendlyMessage(code), code };
    }
    const text = shaped.data.texts.map((t) => t.line).join("\n");
    const quote = s.quote && s.quote.trim().length >= 3 && squash(text).includes(squash(s.quote)) ? s.quote.trim() : null;
    selected = {
      chapter: shaped.data.chapter_number,
      chapter_title: shaped.data.chapter_title,
      volume_number: shaped.data.volume_number,
      block_first: shaped.data.block_first,
      block_last: shaped.data.block_last,
      text,
      quote,
      isCurrentChapter: shaped.data.is_current_chapter,
    };
  }

  // Recent conversation (RLS: only this user's messages). Filtered against the boundary inside answerQuestion.
  const { data: recent } = await supabase
    .from("chat_messages")
    .select("role,content,boundary_chapter,boundary_block")
    .eq("book_id", book)
    .order("created_at", { ascending: false })
    .limit(20);
  const history = ((recent ?? []) as HistoryMessage[]).reverse();

  let failure: string | null = null;
  const outcome = await answerQuestion({
    question: q,
    bookId: book,
    selection: selected,
    deps: {
      config,
      history,
      provider: createGeminiProvider({ apiKey: config.apiKey, model: config.model }),
      getContext: async (terms): Promise<ContextResult> => {
        const { data, error } = await supabase.rpc("assistant_context", {
          p_book_id: book,
          p_terms: terms,
          p_limit: Math.min(12, config.maxPassages + 3), // a few extra so de-duplication still leaves enough
          p_per_chapter: config.perChapter,
        });
        if (error) {
          // 42883 = function does not exist: migration 0005 has not been run on this database.
          failure = error.code === "42883" ? "Run migration 0005_assistant_context.sql in the Supabase SQL editor, then try again." : "Couldn't search the book. Please try again.";
          throw new Error("retrieval failed");
        }
        const shaped = contextShape.safeParse(data);
        if (!shaped.success) {
          failure = "Couldn't search the book. Please try again.";
          throw new Error("unexpected retrieval result");
        }
        return { boundary: shaped.data.boundary, partial_block: shaped.data.partial_block, passages: shaped.data.passages as SourcePassage[] };
      },
      hasReadableText: async (boundary) => {
        const { count } = await supabase
          .from("chapters")
          .select("id", { count: "exact", head: true })
          .eq("book_id", book)
          .lte("number", boundary)
          .gt("word_count", 0);
        return (count ?? 0) > 0;
      },
    },
  }).catch((e: unknown) => {
    // Only a safe tag is logged: never the question, passages, key or vendor payload.
    console.error("[assistant] pipeline failed:", e instanceof Error ? e.message : "unknown");
    return null;
  });

  if (!outcome) return { ok: false, error: failure ?? "Something went wrong. Please try again." };
  if (outcome.kind === "error") {
    console.error(`[assistant] provider/pipeline error code=${outcome.code}`);
    return { ok: false, error: outcome.message, code: outcome.code };
  }

  // The stored question names the passage it was about, so the chat still makes sense later. It sits at the same
  // position as the answer, so it is dropped from history and from the chat shown whenever the reader moves before it.
  const userText = selected ? `About “${short((selected.quote ?? selected.text).replace(/\s+/g, " "), 140)}”: ${q}` : q;
  return saveExchange(p, userText, outcome);
}

/**
 * "Remind me what happened": a short recap of the most recent events BEFORE the reader's place.
 *
 * The client sends only the book id. The boundary, the ownership check and the passages all come from the
 * `recap_context` database function, which reads the caller's own reading_progress row; no chapter number, offset
 * or text is accepted from the browser. Nothing is cached, so moving backward can never reuse a longer recap.
 */
export async function recapStory(bookId: string): Promise<ActionResult<ChatMessage[]>> {
  await requireUser();
  const prep = await prepare(bookId);
  if (!prep.ok) return prep;
  const p = prep.value;
  const { supabase, config, book } = p;

  let failure: string | null = null;
  const outcome = await generateRecap({
    bookId: book,
    deps: {
      config,
      provider: createGeminiProvider({ apiKey: config.apiKey, model: config.model }),
      getRecapContext: async (): Promise<ContextResult> => {
        const { data, error } = await supabase.rpc("recap_context", { p_book_id: book, p_chapters: 3, p_chunks: 2, p_blocks: 6 });
        if (error) {
          failure = error.code === "42883" ? "Run migration 0009_recap_and_selection.sql in the Supabase SQL editor, then try again." : "Couldn't load your recent chapters. Please try again.";
          throw new Error("recap retrieval failed");
        }
        const shaped = contextShape.safeParse(data);
        if (!shaped.success) {
          failure = "Couldn't load your recent chapters. Please try again.";
          throw new Error("unexpected recap result");
        }
        return { boundary: shaped.data.boundary, partial_block: shaped.data.partial_block, passages: shaped.data.passages as SourcePassage[] };
      },
    },
  }).catch((e: unknown) => {
    console.error("[assistant] recap failed:", e instanceof Error ? e.message : "unknown");
    return null;
  });

  if (!outcome) return { ok: false, error: failure ?? "Something went wrong. Please try again." };
  if (outcome.kind === "error") {
    console.error(`[assistant] recap provider/pipeline error code=${outcome.code}`);
    return { ok: false, error: outcome.message, code: outcome.code };
  }
  // "Nothing to recap yet" answers are returned without being stored (no model call was made, nothing to keep).
  if (outcome.kind !== "answer") {
    const now = new Date().toISOString();
    return {
      ok: true,
      data: [
        { id: `local-${Date.now()}-q`, role: "assistant", content: outcome.text, boundary_chapter: outcome.boundary, boundary_block: outcome.partialBlock, created_at: now, sources: null },
      ] as ChatMessage[],
    };
  }
  return saveExchange(p, RECAP_QUESTION, outcome);
}

export async function clearChat(bookId: string): Promise<ActionResult> {
  await requireUser();
  if (!isUuid(bookId)) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.from("chat_messages").delete().eq("book_id", bookId);
  if (error) return { ok: false, error: "Couldn't clear the conversation." };
  return { ok: true, data: undefined };
}
