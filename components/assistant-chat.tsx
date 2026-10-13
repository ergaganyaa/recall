"use client";

import { useEffect, useRef, useState } from "react";

type Message = { id: number; role: "user" | "assistant"; text: string };

const SUGGESTIONS = [
  "Who is the main character?",
  "Recap what I've read so far",
  "Explain the world's magic system",
];

export function AssistantChat({
  bookTitle,
  lastReadLabel,
}: {
  bookTitle: string;
  lastReadLabel: string;
}) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      role: "assistant",
      text: `Hi! I'm your reading assistant for “${bookTitle}”. I'll only discuss events up to ${lastReadLabel}, so you won't get spoilers.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const nextId = useRef(1);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
    setMessages((m) => [...m, { id: nextId.current++, role: "user", text: trimmed }]);
    setInput("");
    setThinking(true);
    timer.current = setTimeout(() => {
      setMessages((m) => [
        ...m,
        {
          id: nextId.current++,
          role: "assistant",
          text: "This is a placeholder reply. Once the AI is connected, I'll answer using only the chapters you've read so far.",
        },
      ]);
      setThinking(false);
    }, 900);
  }

  return (
    <section
      id="assistant"
      aria-label="Reading assistant"
      className="flex h-[32rem] scroll-mt-24 flex-col overflow-hidden rounded-2xl border border-border bg-surface"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="font-semibold">Reading assistant</h2>
        <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
          Preview · AI not connected
        </span>
      </header>

      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <p
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === "user"
                  ? "rounded-br-md bg-accent text-accent-foreground"
                  : "rounded-bl-md bg-accent-soft"
              }`}
            >
              {m.text}
            </p>
          </div>
        ))}
        {thinking && (
          <div className="flex justify-start">
            <p className="rounded-2xl rounded-bl-md bg-accent-soft px-4 py-2.5 text-sm text-muted">
              Thinking…
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="mb-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              disabled={thinking}
              onClick={() => send(s)}
              className="rounded-full border border-border px-3 py-1.5 text-xs transition hover:bg-accent-soft disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
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
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about characters, plot, lore…"
            className="min-w-0 flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={!input.trim() || thinking}
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition hover:opacity-90 disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>
    </section>
  );
}
