"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { answerQuestion } from "@/lib/assistant/answer";
import { readAssistantConfig } from "@/lib/assistant/config";
import { checkRateLimit, friendlyMessage } from "@/lib/assistant/errors";
import { createGeminiProvider } from "@/lib/assistant/gemini";
import type { ContextResult, HistoryMessage, SourcePassage } from "@/lib/assistant/types";
import { isUuid } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, ChatMessage } from "@/lib/types";

const MSG_COLS = "id,role,content,boundary_chapter,created_at,sources";

const contextShape = z.object({
  boundary: z.number().int().nullable(),
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
    }),
  ),
});

/**
 * Spoiler-safe Q&A with an AI model.
 *
 * The client sends ONLY a question. Everything that decides what the model may see is derived here from
 * the signed-in user's own rows: the reading boundary is read by the `assistant_context` database function
 * (never passed in), ownership is checked there too, and only passages inside the boundary ever leave the
 * database. The API key lives only in server environment variables.
 */
export async function askAssistant(bookId: string, question: string): Promise<ActionResult<ChatMessage[]>> {
  await requireUser();
  const parsed = z
    .object({ b: z.string().refine(isUuid), q: z.string().trim().min(2).max(500) })
    .safeParse({ b: bookId, q: question });
  if (!parsed.success) return { ok: false, error: "Ask a question of 2–500 characters." };
  const { b: book, q } = parsed.data;

  const config = readAssistantConfig();
  if (!config.apiKey) return { ok: false, error: friendlyMessage("missing_key"), code: "missing_key" };

  const supabase = await createClient();

  // Free-tier protection: limit how fast one account can spend the shared quota.
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const [minute, day] = await Promise.all([
    supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("role", "user").gte("created_at", since(60_000)),
    supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("role", "user").gte("created_at", since(86_400_000)),
  ]);
  const limited = checkRateLimit({ lastMinute: minute.count ?? 0, lastDay: day.count ?? 0 }, config);
  if (limited) {
    return { ok: false, error: friendlyMessage("local_rate_limited", limited.retryAfterSec), code: "local_rate_limited" };
  }

  // Recent conversation (RLS: only this user's messages). Filtered against the boundary inside answerQuestion.
  const { data: recent } = await supabase
    .from("chat_messages")
    .select("role,content,boundary_chapter")
    .eq("book_id", book)
    .order("created_at", { ascending: false })
    .limit(20);
  const history = ((recent ?? []) as HistoryMessage[]).reverse();

  let failure: string | null = null;
  const outcome = await answerQuestion({
    question: q,
    bookId: book,
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
        return { boundary: shaped.data.boundary, passages: shaped.data.passages as SourcePassage[] };
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

  // Save the question and its answer together (and only on success, so failed attempts don't pile up).
  const t0 = Date.now();
  const { data: saved, error: saveErr } = await supabase
    .from("chat_messages")
    .insert([
      { book_id: book, role: "user", content: q, boundary_chapter: outcome.boundary, created_at: new Date(t0).toISOString() },
      {
        book_id: book,
        role: "assistant",
        content: outcome.text,
        boundary_chapter: outcome.boundary,
        sources: outcome.citations.length ? outcome.citations : null,
        created_at: new Date(t0 + 1).toISOString(),
      },
    ])
    .select(MSG_COLS);
  if (saveErr || !saved || saved.length !== 2) return { ok: false, error: "Couldn't save the conversation." };

  const ordered = [...saved].sort((a, c) => (a.role === "user" ? -1 : 1) - (c.role === "user" ? -1 : 1));
  return { ok: true, data: ordered as ChatMessage[] };
}

export async function clearChat(bookId: string): Promise<ActionResult> {
  await requireUser();
  if (!isUuid(bookId)) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.from("chat_messages").delete().eq("book_id", bookId);
  if (error) return { ok: false, error: "Couldn't clear the conversation." };
  return { ok: true, data: undefined };
}
