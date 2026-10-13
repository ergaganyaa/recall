"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { markChapterRead } from "@/app/actions/reading";
import type { ChapterSummary, Volume } from "@/lib/types";

type Group = { key: string; label: string; sub: string | null; chapters: ChapterSummary[] };

export function ChapterList({
  bookId,
  volumes,
  chapters,
  lastRead,
  current,
}: {
  bookId: string;
  volumes: Volume[];
  chapters: ChapterSummary[];
  lastRead: number;
  current: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const groups: Group[] = volumes.map((v) => ({
    key: v.id,
    label: `Volume ${v.number}`,
    sub: v.title,
    chapters: chapters.filter((c) => c.volume_id === v.id),
  }));
  const loose = chapters.filter((c) => !c.volume_id || !volumes.some((v) => v.id === c.volume_id));
  if (loose.length) {
    groups.push({ key: "loose", label: volumes.length ? "Other chapters" : "Chapters", sub: null, chapters: loose });
  }

  // Open the group the reader is currently in.
  const startGroup =
    groups.find((g) => g.chapters.some((c) => c.number === current))?.key ?? groups[0]?.key;
  const [open, setOpen] = useState<Set<string>>(new Set(startGroup ? [startGroup] : []));

  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setThrough(n: number) {
    setError(null);
    startTransition(async () => {
      const res = await markChapterRead(bookId, n, "set");
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  if (chapters.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-surface p-8 text-center text-sm text-muted">
        No chapters yet. Add chapter text on the right to create the first one.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {groups.map((g) => {
        const readCount = g.chapters.filter((c) => c.number <= lastRead).length;
        const isOpen = open.has(g.key);
        return (
          <section key={g.key} className="overflow-hidden rounded-2xl border border-border bg-surface">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggle(g.key)}
              className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left hover:bg-accent-soft/50 sm:px-5"
            >
              <span className="min-w-0">
                <span className="block text-xs font-medium uppercase tracking-wider text-muted">{g.label}</span>
                {g.sub && <span className="block truncate font-semibold">{g.sub}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-3 text-sm text-muted">
                {readCount}/{g.chapters.length}
                <svg viewBox="0 0 24 24" className={`size-4 transition-transform ${isOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>

            {isOpen && (
              <ol className={`divide-y divide-border border-t border-border ${pending ? "opacity-60" : ""}`}>
                {g.chapters.map((c) => {
                  const isRead = c.number <= lastRead;
                  const isLast = c.number === lastRead;
                  return (
                    <li key={c.id} className={`flex items-center gap-2 px-4 py-2 text-sm sm:px-5 ${isLast ? "bg-accent-soft" : ""}`}>
                      <Link
                        href={`/library/${bookId}/read/${c.number}`}
                        className="flex min-w-0 flex-1 items-center gap-3 py-1.5"
                      >
                        <span
                          className={`grid size-6 shrink-0 place-items-center rounded-full text-xs ${
                            isRead ? "bg-accent text-accent-foreground" : "border border-border text-muted"
                          }`}
                          aria-hidden
                        >
                          {isRead ? "✓" : ""}
                        </span>
                        <span className="w-12 shrink-0 text-muted">Ch. {c.number}</span>
                        <span className={`min-w-0 flex-1 truncate ${isRead ? "" : "text-muted"}`}>{c.title}</span>
                        <span className="sr-only">{isRead ? "Read" : "Unread"}</span>
                      </Link>
                      {!c.has_content && (
                        <span className="hidden shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted sm:inline">
                          no text
                        </span>
                      )}
                      {isLast ? (
                        <span className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-foreground">
                          Last read
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setThrough(c.number)}
                          className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-accent"
                          title="Mark everything up to and including this chapter as read"
                        >
                          Read through here
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}
