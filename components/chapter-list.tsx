"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteVolume } from "@/app/actions/import";
import { markChapterRead } from "@/app/actions/reading";
import { contentKind } from "@/lib/chapter-content";
import type { ChapterSummary, Volume } from "@/lib/types";

type Group = { key: string; volume: Volume | null; label: string; chapters: ChapterSummary[] };

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

  // `volumes` arrives already sorted by (arc order, number), so 4.5 sits between 4 and 5.
  const groups: Group[] = volumes.map((v) => ({
    key: v.id,
    volume: v,
    label: `Volume ${v.number}`,
    chapters: chapters.filter((c) => c.volume_id === v.id),
  }));
  const loose = chapters.filter((c) => !c.volume_id || !volumes.some((v) => v.id === c.volume_id));
  if (loose.length) {
    groups.push({ key: "loose", volume: null, label: volumes.length ? "Other chapters" : "Chapters", chapters: loose });
  }

  const startGroup = groups.find((g) => g.chapters.some((c) => c.number === current))?.key ?? groups[0]?.key;
  const [open, setOpen] = useState<Set<string>>(new Set(startGroup ? [startGroup] : []));

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else router.refresh();
    });
  }

  if (chapters.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-surface p-8 text-center text-sm text-muted">
        No chapters yet. Import a volume, or add chapter titles from the panel on the right.
      </div>
    );
  }

  // An arc (school year) heading appears whenever the arc changes between consecutive volumes.
  const arcName = (v: Volume) => v.arc ?? `Arc ${v.arc_order}`;
  const multipleArcs = volumes.some((v) => v.arc) || volumes.some((v) => v.arc_order !== volumes[0]?.arc_order);
  const arcHeading = new Map<string, string>();
  volumes.forEach((v, i) => {
    if (multipleArcs && (i === 0 || arcName(volumes[i - 1]) !== arcName(v))) arcHeading.set(v.id, arcName(v));
  });

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
        const kinds = g.chapters.map(contentKind);
        const full = kinds.filter((k) => k === "full_text").length;
        const ill = kinds.filter((k) => k === "illustrations_only").length;
        const none = kinds.filter((k) => k === "metadata_only").length;

        const arc = g.volume ? arcHeading.get(g.volume.id) : undefined;

        return (
          <div key={g.key}>
            {arc && (
              <h3 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-accent first:mt-0">{arc}</h3>
            )}
            <section className="overflow-hidden rounded-2xl border border-border bg-surface">
              <div className="flex items-stretch">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggle(g.key)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 py-4 text-left hover:bg-accent-soft/50 sm:px-5"
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-medium uppercase tracking-wider text-muted">{g.label}</span>
                    {g.volume?.title && <span className="block truncate font-semibold">{g.volume.title}</span>}
                    <span className="mt-1 block text-xs text-muted">
                      {none === 0 && ill === 0
                        ? `${full} chapters · full text`
                        : [full && `${full} full text`, ill && `${ill} illustrations only`, none && `${none} not imported`]
                            .filter(Boolean)
                            .join(" · ")}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-sm text-muted">
                    {readCount}/{g.chapters.length}
                    <svg viewBox="0 0 24 24" className={`size-4 transition-transform ${isOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </span>
                </button>
                {g.volume && (
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`Remove ${g.label}`}
                    onClick={() => {
                      if (window.confirm(`Remove ${g.label} and all of its chapter text and illustrations? Your reading progress stays on the same chapters.`)) {
                        run(() => deleteVolume(g.volume!.id, bookId));
                      }
                    }}
                    className="border-l border-border px-3 text-xs text-muted hover:text-danger"
                  >
                    Remove
                  </button>
                )}
              </div>

              {isOpen && (
                <ol className={`divide-y divide-border border-t border-border ${pending ? "opacity-60" : ""}`}>
                  {g.chapters.map((c) => {
                    const isRead = c.number <= lastRead;
                    const isLast = c.number === lastRead;
                    const kind = contentKind(c);
                    return (
                      <li key={c.id} className={`flex items-center gap-2 px-4 py-2 text-sm sm:px-5 ${isLast ? "bg-accent-soft" : ""}`}>
                        <Link href={`/library/${bookId}/read/${c.number}`} className="flex min-w-0 flex-1 items-center gap-3 py-1.5">
                          <span
                            className={`grid size-6 shrink-0 place-items-center rounded-full text-xs ${
                              isRead ? "bg-accent text-accent-foreground" : "border border-border text-muted"
                            }`}
                            aria-hidden
                          >
                            {isRead ? "✓" : ""}
                          </span>
                          <span className="w-12 shrink-0 text-muted">Ch. {c.number}</span>
                          <span className={`min-w-0 flex-1 truncate ${kind === "metadata_only" ? "text-muted" : ""}`}>{c.title}</span>
                          <span className="sr-only">{isRead ? "Read" : "Unread"}</span>
                        </Link>
                        {kind === "illustrations_only" && (
                          <span className="hidden shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted sm:inline">
                            illustrations
                          </span>
                        )}
                        {kind === "metadata_only" && (
                          <span className="hidden shrink-0 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted sm:inline">
                            not imported
                          </span>
                        )}
                        {isLast ? (
                          <span className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-foreground">Last read</span>
                        ) : (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => run(() => markChapterRead(bookId, c.number, "set"))}
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
          </div>
        );
      })}
    </div>
  );
}
