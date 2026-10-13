"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { composeAnswer } from "@/lib/assistant";
import { extractTerms } from "@/lib/chunking";
import { isUuid } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, ChatMessage, Passage } from "@/lib/types";

const MSG_COLS = "id,role,content,boundary_chapter,created_at";

/**
 * Spoiler-safe Q&A. The client sends only a question. The reading boundary is
 * NEVER taken from the client: the search_passages database function reads it
 * from the user's own reading_progress row and filters chunks by it.
 */
export async function askAssistant(
  bookId: string,
  question: string,
): Promise<ActionResult<ChatMessage[]>> {
  await requireUser();
  const parsed = z
    .object({ b: z.string().refine(isUuid), q: z.string().trim().min(2).max(500) })
    .safeParse({ b: bookId, q: question });
  if (!parsed.success) return { ok: false, error: "Ask a question of 2–500 characters." };

  const supabase = await createClient();

  const { data: progress } = await supabase
    .from("reading_progress")
    .select("last_read_chapter")
    .eq("book_id", parsed.data.b)
    .maybeSingle();
  const boundary = progress?.last_read_chapter ?? 0;

  const { data: userMsg, error: userErr } = await supabase
    .from("chat_messages")
    .insert({ book_id: parsed.data.b, role: "user", content: parsed.data.q, boundary_chapter: boundary })
    .select(MSG_COLS)
    .single<ChatMessage>();
  if (userErr || !userMsg) return { ok: false, error: "Couldn't send your question." };

  const terms = extractTerms(parsed.data.q);
  const [search, withText] = await Promise.all([
    terms.length
      ? supabase.rpc("search_passages", { p_book_id: parsed.data.b, p_terms: terms, p_limit: 5 })
      : Promise.resolve({ data: [] as Passage[], error: null }),
    supabase
      .from("chapters")
      .select("id", { count: "exact", head: true })
      .eq("book_id", parsed.data.b)
      .lte("number", boundary)
      .gt("word_count", 0),
  ]);
  if (search.error) return { ok: false, error: "Search failed. Please try again." };

  const answer = composeAnswer({
    passages: (search.data ?? []) as Passage[],
    boundary,
    hasAnyText: (withText.count ?? 0) > 0,
  });

  const { data: botMsg, error: botErr } = await supabase
    .from("chat_messages")
    .insert({ book_id: parsed.data.b, role: "assistant", content: answer, boundary_chapter: boundary })
    .select(MSG_COLS)
    .single<ChatMessage>();
  if (botErr || !botMsg) return { ok: false, error: "Couldn't save the answer." };

  return { ok: true, data: [userMsg, botMsg] };
}

export async function clearChat(bookId: string): Promise<ActionResult> {
  await requireUser();
  if (!isUuid(bookId)) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.from("chat_messages").delete().eq("book_id", bookId);
  if (error) return { ok: false, error: "Couldn't clear the conversation." };
  return { ok: true, data: undefined };
}
