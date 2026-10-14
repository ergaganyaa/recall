"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { askAssistant, clearChat } from "@/app/actions/assistant";
import type { Citation } from "@/lib/assistant/types";
import type { ChatMessage } from "@/lib/types";

/** Where the reader is, shown at the top of the in-reader chat so follow-up questions need no repeated context. */
export type ChatContext = {
  book: string;
  volume: string | null;
  chapter: number;
  chapterTitle: string;
  /** e.g. "chapters 1–4 and up to ¶ 12 of chapter 5" */
  readTo: string;
};

const chip =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground transition hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent";

/** Sources under an answer: the chapters it cites first, then any others that were only consulted. */
function Sources({
  sources,
  currentChapter,
  onJump,
}: {
  sources: Citation[];
  currentChapter?: number;
  onJump?: (c: Citation) => boolean;
}) {
  if (sources.length === 0) return null;
  const cited = sources.filter((s) => s.cited);
  const others = sources.filter((s) => !s.cited);

  const link = (s: Citation, children: ReactNode, title?: string) => {
    const sameChapter = currentChapter !== undefined && s.chapter === currentChapter && s.block !== null;
    return (
      <Link
        key={s.chapter}
        href={s.href}
        title={title}
        className={chip}
        data-testid="citation"
        data-block={s.block ?? undefined}
        onClick={(e) => {
          // A passage in the chapter you are reading: scroll there in place, without leaving or losing your place.
          if (sameChapter && onJump?.(s)) e.preventDefault();
        }}
      >
        {children}
      </Link>
    );
  };

  return (
    <div className="mt-2 space-y-1.5" data-testid="sources">
      {cited.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[0.7rem] font-medium uppercase tracking-wide text-muted">Sources</span>
          {cited.map((s) =>
            link(
              s,
              <>
                <span className="font-semibold text-accent">[{s.indices.join(", ")}]</span>
                <span className="truncate">{s.label}</span>
                {s.block !== null && <span aria-hidden className="text-muted">↗</span>}
              </>,
              s.block !== null ? "Jump to this passage" : "Open this chapter",
            ),
          )}
        </div>
      )}
      {others.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none hover:text-foreground">
            {cited.length > 0 ? "Also looked at" : "Passages consulted"} ({others.length})
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-1.5">{others.map((s) => link(s, <span className="truncate">{s.label}</span>))}</div>
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
  variant = "card",
  context,
  currentChapter,
  onJump,
  beforeAsk,
  headerAction,
  onClose,
}: {
  suggestions?: string[];
  bookId: string;
  initialMessages: ChatMessage[];
  /** Last finished chapter; displayed only. The server enforces the real limit. */
  boundary: number;
  /** Whether the server has an API key. A boolean only: the key itself never reaches the browser. */
  configured: boolean;
  modelLabel: string;
  /** "card" on the book page; "panel" fills its container inside the reader */
  variant?: "card" | "panel";
  context?: ChatContext;
  /** The chapter open in the reader: citations into it jump in place */
  currentChapter?: number;
  /** Handle a citation click in place; return true if handled */
  onJump?: (c: Citation) => boolean;
  /** Awaited before each question: lets the reader save its latest position first */
  beforeAsk?: () => Promise<void>;
  headerAction?: ReactNode;
  onClose?: () => void;
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
        try {
          await beforeAsk?.();
        } catch (e) {
          // The reader could not save your position, so the question is not sent (an older, further position must never be used).
          setError({ text: e instanceof Error ? e.message : "Couldn't save your reading position.", code: "position" });
          setInput(q);
          return;
        }
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

  const blocked = !configured || (boundary === 0 && !context);
  const panel = variant === "panel";

  return (
    <section
      id={panel ? undefined : "assistant"}
      aria-label="Spoiler-aware assistant"
      data-testid="assistant-chat"
      className={
        panel
          ? "flex h-full min-h-0 flex-col bg-surface text-foreground"
          : "flex h-[36rem] scroll-mt-24 flex-col overflow-hidden rounded-2xl border border-border bg-surface"
      }
    >
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Ask about the story</h2>
          <div className="flex items-center gap-3">
            {messages.length > 0 && (
              <button type="button" onClick={clear} className="text-xs text-muted hover:text-danger">
                Clear
              </button>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close chat"
                data-testid="close-chat"
                className="grid size-8 place-items-center rounded-full border border-border text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {context ? (
          <div className="mt-2 rounded-xl bg-accent-soft px-3 py-2 text-xs" data-testid="chat-context">
            <p className="truncate font-medium text-foreground">{context.book}</p>
            <p className="truncate text-muted">
              {context.volume ? `${context.volume} · ` : ""}Ch. {context.chapter} — {context.chapterTitle}
            </p>
            <p className="mt-1 text-muted">
              The assistant only uses <strong className="text-foreground">{context.readTo}</strong>. Nothing later is ever sent.
            </p>
          </div>
        ) : (
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
        )}
        {headerAction}
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

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4" aria-live="polite">
        {messages.length === 0 && !pending && configured && (
          <p className="pt-8 text-center text-sm text-muted">
            Ask about characters, relationships or events. Answers are based on passages you&apos;ve already read, with links
            to the paragraphs they came from.
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
              {m.role === "assistant" && m.sources && <Sources sources={m.sources} currentChapter={currentChapter} onJump={onJump} />}
            </div>
          </div>
        ))}
        {pending && (
          <div className="flex justify-start">
            <p className="rounded-2xl rounded-bl-md bg-accent-soft px-4 py-2.5 text-sm text-muted" data-testid="chat-loading">
              {context ? "Looking through what you've read…" : `Looking through chapters 1–${boundary}…`}
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
          <label htmlFor={panel ? "reader-chat-input" : "chat-input"} className="sr-only">
            Ask about the story
          </label>
          <input
            id={panel ? "reader-chat-input" : "chat-input"}
            value={input}
            maxLength={500}
            disabled={!configured}
            onChange={(e) => setInput(e.target.value)}
            placeholder={configured ? "Ask about characters, plot, lore…" : "Set up the API key to ask questions"}
            className="min-w-0 flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-sm text-foreground outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
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
