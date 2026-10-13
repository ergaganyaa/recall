"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { askAssistant, clearChat } from "@/app/actions/assistant";
import type { ChatMessage } from "@/lib/types";

export function AssistantChat({
  bookId,
  initialMessages,
  boundary,
  suggestions = [],
}: {
  suggestions?: string[];
  bookId: string;
  initialMessages: ChatMessage[];
  /** Last finished chapter; displayed only. The server enforces the real limit. */
  boundary: number;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  function send(text: string) {
    const q = text.trim();
    if (q.length < 2 || pending) return;
    setError(null);
    setInput("");
    startTransition(async () => {
      const res = await askAssistant(bookId, q);
      if (res.ok) setMessages((m) => [...m, ...res.data]);
      else {
        setError(res.error);
        setInput(q);
      }
    });
  }

  function clear() {
    if (!window.confirm("Clear this conversation?")) return;
    startTransition(async () => {
      const res = await clearChat(bookId);
      if (res.ok) setMessages([]);
      else setError(res.error);
    });
  }

  return (
    <section
      id="assistant"
      aria-label="Spoiler-aware assistant"
      className="flex h-[34rem] scroll-mt-24 flex-col overflow-hidden rounded-2xl border border-border bg-surface"
    >
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Ask about the story</h2>
          {messages.length > 0 && (
            <button type="button" onClick={clear} className="text-xs text-muted hover:text-danger">
              Clear
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">
          {boundary > 0 ? (
            <>
              Searching chapters <strong className="text-foreground">1–{boundary}</strong> only. Nothing later is
              ever read.
            </>
          ) : (
            "Finish a chapter to unlock questions."
          )}
        </p>
        <p className="mt-2 inline-block rounded-full bg-accent-soft px-2.5 py-1 text-[0.7rem] font-medium text-accent">
          Passage search · no AI model connected yet
        </p>
      </header>

      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {messages.length === 0 && !pending && (
          <p className="pt-8 text-center text-sm text-muted">
            Ask about characters, events or lore. Answers quote passages you&apos;ve already read.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <p
              className={`max-w-[90%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === "user" ? "rounded-br-md bg-accent text-accent-foreground" : "rounded-bl-md bg-accent-soft"
              }`}
            >
              {m.content}
            </p>
          </div>
        ))}
        {pending && (
          <div className="flex justify-start">
            <p className="rounded-2xl rounded-bl-md bg-accent-soft px-4 py-2.5 text-sm text-muted">Searching what you&apos;ve read…</p>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        {error && (
          <p role="alert" className="mb-2 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        {messages.length === 0 && suggestions.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                disabled={pending || boundary === 0}
                onClick={() => send(s)}
                className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-accent-soft disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <label htmlFor="chat-input" className="sr-only">
            Ask about the story
          </label>
          <input
            id="chat-input"
            value={input}
            maxLength={500}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about characters, plot, lore…"
            className="min-w-0 flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={input.trim().length < 2 || pending}
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-40"
          >
            Ask
          </button>
        </form>
      </div>
    </section>
  );
}
