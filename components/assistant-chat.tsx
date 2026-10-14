"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { askAssistant, clearChat } from "@/app/actions/assistant";
import type { Citation } from "@/lib/assistant/types";
import type { ChatMessage } from "@/lib/types";

/** Sources under an answer: the chapters it cites first, then any others that were only consulted. */
function Sources({ sources }: { sources: Citation[] }) {
  const cited = sources.filter((s) => s.cited);
  const others = sources.filter((s) => !s.cited);
  if (sources.length === 0) return null;
  const chip = "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground transition hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent";
  return (
    <div className="mt-2 space-y-1.5" data-testid="sources">
      {cited.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[0.7rem] font-medium uppercase tracking-wide text-muted">Sources</span>
          {cited.map((s) => (
            <Link key={s.chapter} href={s.href} className={chip} title="Open this chapter">
              <span className="font-semibold text-accent">[{s.indices.join(", ")}]</span>
              <span className="truncate">{s.label}</span>
            </Link>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none hover:text-foreground">
            {cited.length > 0 ? "Also looked at" : "Passages consulted"} ({others.length})
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {others.map((s) => (
              <Link key={s.chapter} href={s.href} className={chip}>
                <span className="truncate">{s.label}</span>
              </Link>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function AssistantChat({
  bookId,
  initialMessages,
  boundary,
  suggestions = [],
  configured,
  modelLabel,
}: {
  suggestions?: string[];
  bookId: string;
  initialMessages: ChatMessage[];
  /** Last finished chapter; displayed only. The server enforces the real limit. */
  boundary: number;
  /** Whether the server has an API key. A boolean only: the key itself never reaches the browser. */
  configured: boolean;
  modelLabel: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);
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
      try {
        const res = await askAssistant(bookId, q);
        if (res.ok) setMessages((m) => [...m, ...res.data]);
        else {
          setError({ text: res.error, code: res.code });
          setInput(q);
        }
      } catch {
        setError({ text: "Couldn't reach the server. Please try again." });
        setInput(q);
      }
    });
  }

  function clear() {
    if (!window.confirm("Clear this conversation?")) return;
    startTransition(async () => {
      const res = await clearChat(bookId);
      if (res.ok) setMessages([]);
      else setError({ text: res.error });
    });
  }

  const blocked = !configured || boundary === 0;

  return (
    <section
      id="assistant"
      aria-label="Spoiler-aware assistant"
      className="flex h-[36rem] scroll-mt-24 flex-col overflow-hidden rounded-2xl border border-border bg-surface"
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
              Answers use chapters <strong className="text-foreground">1–{boundary}</strong> only. Nothing later is ever
              sent to the AI.
            </>
          ) : (
            "Finish a chapter to unlock questions."
          )}
        </p>
        <p className="mt-2 text-[0.7rem] leading-snug text-muted">
          <span className="mr-1.5 inline-block rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">AI · {modelLabel}</span>
          Your question and a few short passages you&apos;ve read are sent to Google Gemini. On the free tier, Google may use
          them to improve its products.
        </p>
      </header>

      {!configured && (
        <div role="status" className="m-4 rounded-xl border border-dashed border-border bg-background p-4 text-sm" data-testid="setup-notice">
          <p className="font-medium">The assistant needs a free Gemini API key</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted">
            <li>Create a key in Google AI Studio (aistudio.google.com).</li>
            <li>
              Add <code className="font-mono text-foreground">GEMINI_API_KEY=your-key</code> to <code className="font-mono text-foreground">.env.local</code>.
            </li>
            <li>Restart <code className="font-mono text-foreground">npm run dev</code>.</li>
          </ol>
        </div>
      )}

      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {messages.length === 0 && !pending && configured && (
          <p className="pt-8 text-center text-sm text-muted">
            Ask about characters, relationships or events. Answers are based on passages you&apos;ve already read, with links
            to the chapters they came from.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className="max-w-[92%]">
              <p
                className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  m.role === "user" ? "rounded-br-md bg-accent text-accent-foreground" : "rounded-bl-md bg-accent-soft"
                }`}
              >
                {m.content}
              </p>
              {m.role === "assistant" && m.sources && <Sources sources={m.sources} />}
            </div>
          </div>
        ))}
        {pending && (
          <div className="flex justify-start">
            <p className="rounded-2xl rounded-bl-md bg-accent-soft px-4 py-2.5 text-sm text-muted">
              Looking through chapters 1–{boundary}…
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        {error && (
          <p role="alert" className="mb-2 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger" data-code={error.code}>
            {error.text}
          </p>
        )}
        {messages.length === 0 && suggestions.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                disabled={pending || blocked}
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
            disabled={!configured}
            onChange={(e) => setInput(e.target.value)}
            placeholder={configured ? "Ask about characters, plot, lore…" : "Set up the API key to ask questions"}
            className="min-w-0 flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-sm outline-none focus:border-accent disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={input.trim().length < 2 || pending || !configured}
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-40"
          >
            Ask
          </button>
        </form>
      </div>
    </section>
  );
}
