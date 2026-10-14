"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { addBookmark, markChapterRead, saveProgress } from "@/app/actions/reading";
import { imageUrl, toBlocks } from "@/lib/chapter-content";
import { createProgressSaver, type ProgressSaver } from "@/lib/progress-saver";
import { ChapterImage } from "./chapter-image";
import { ChapterPicker } from "./chapter-picker";

type Prefs = { size: number; font: "serif" | "sans"; wide: boolean };
const DEFAULT_PREFS: Prefs = { size: 19, font: "serif", wide: false };
const PREFS_KEY = "recall-reader-prefs";

// --- tiny external store so preferences persist without effect-driven setState ---
const listeners = new Set<() => void>();
function readRaw(): string {
  try {
    return localStorage.getItem(PREFS_KEY) ?? "";
  } catch {
    return "";
  }
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function writePrefs(next: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // not persisted; the in-memory fallback below still applies for this session
  }
  listeners.forEach((l) => l());
}
function parsePrefs(raw: string): Prefs {
  try {
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      size: typeof p.size === "number" ? Math.min(28, Math.max(14, p.size)) : DEFAULT_PREFS.size,
      font: p.font === "sans" ? "sans" : "serif",
      wide: p.wide === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

type ChapterRef = { number: number; title: string };

export function Reader(props: {
  bookId: string;
  bookTitle: string;
  chapter: { number: number; title: string; content: string | null };
  /** Illustrations of this chapter by id. Markers that aren't listed here are ignored. */
  images: Record<string, { id: string; width: number | null; height: number | null; alt: string | null }>;
  chapters: ChapterRef[];
  initialPct: number;
  bookSourceUrl: string | null;
  /** Last chapter finished so far: the spoiler boundary the assistant respects. */
  lastRead: number;
}) {
  const { bookId, bookTitle, chapter, chapters, initialPct, bookSourceUrl, images } = props;
  const [boundary, setBoundary] = useState(props.lastRead);
  const router = useRouter();

  const raw = useSyncExternalStore(subscribe, readRaw, () => "");
  const prefs = raw ? parsePrefs(raw) : DEFAULT_PREFS;
  const [showSettings, setShowSettings] = useState(false);

  const idx = chapters.findIndex((c) => c.number === chapter.number);
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;

  const [pct, setPct] = useState(initialPct);
  const [toast, setToast] = useState<string | null>(null);
  const finished = useRef(false);
  // Saves the position after a pause AND whenever the reader leaves (see flushProgress).
  const saver = useRef<ProgressSaver | null>(null);
  const flushProgress = useCallback(() => saver.current?.flush(), []);

  const flash = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 2200);
  }, []);

  const finishChapter = useCallback(async () => {
    if (finished.current) return;
    finished.current = true;
    const res = await markChapterRead(bookId, chapter.number, "advance");
    if (!res.ok) {
      finished.current = false;
      flash(res.error);
      return;
    }
    setBoundary(res.data.lastRead);
    if (res.data.skippedAhead) {
      flash(`Spoiler protection stays at chapter ${res.data.lastRead}: earlier chapters aren't marked read.`);
    }
  }, [bookId, chapter.number, flash]);

  // Explicit "I've read everything before this chapter".
  async function markEarlierRead() {
    const res = await markChapterRead(bookId, chapter.number - 1, "set");
    if (res.ok) {
      setBoundary(res.data.lastRead);
      finished.current = false;
      flash(`Marked chapters 1–${res.data.lastRead} as read`);
    } else {
      flash(res.error);
    }
  }

  // Restore the saved scroll position once the text is laid out.
  useEffect(() => {
    if (initialPct > 0.01) {
      requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo(0, max * initialPct);
      });
    }
    void saveProgress(bookId, chapter.number, initialPct);
  }, [bookId, chapter.number, initialPct]);

  // Track scroll → debounced save; reaching the end finishes the chapter.
  useEffect(() => {
    const s = createProgressSaver({
      initial: initialPct,
      save: (p) => void saveProgress(bookId, chapter.number, p),
    });
    saver.current = s;
    function onScroll() {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 1;
      setPct(p);
      s.update(p);
      if (p >= 0.97 && chapter.content) void finishChapter();
    }
    const onHide = () => {
      if (document.visibilityState === "hidden") s.flush();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      s.flush(); // leaving this chapter for any reason: keep the position
      saver.current = null;
    };
  }, [bookId, chapter.number, chapter.content, finishChapter, initialPct]);

  // Keyboard navigation between chapters.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t.closest("input, select, textarea, [role='dialog'], [role='listbox']") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft" && prev) router.push(`/library/${bookId}/read/${prev.number}`);
      if (e.key === "ArrowRight" && next) router.push(`/library/${bookId}/read/${next.number}`);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bookId, prev, next, router]);

  async function bookmark() {
    const res = await addBookmark(bookId, chapter.number, saver.current?.latest ?? 0, "");
    flash(res.ok ? "Bookmark saved" : res.error);
  }

  async function goNext() {
    if (!next) return;
    await finishChapter();
    router.push(`/library/${bookId}/read/${next.number}`);
  }

  const blocks = toBlocks(chapter.content ?? "");
  const button =
    "grid h-10 min-w-10 place-items-center rounded-full border border-border px-3 text-sm text-muted transition hover:text-foreground disabled:opacity-40";

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-2 px-3 sm:px-4">
          <Link
            href={`/library/${bookId}`}
            onClick={flushProgress}
            aria-label={`Back to the book page: ${bookTitle}`}
            title="Back to the book page (volumes and chapters). Your place is saved."
            data-testid="back-to-book"
            className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-border bg-surface px-3 text-sm font-medium text-foreground transition hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" />
              <path d="M4 21V5" />
            </svg>
            <span className="sm:hidden">Book</span>
            <span className="hidden sm:inline">Back to book</span>
          </Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-muted">{bookTitle}</p>
            <ChapterPicker
              chapters={chapters}
              current={chapter.number}
              onSelect={(n) => {
                flushProgress();
                router.push(`/library/${bookId}/read/${n}`);
              }}
            />
          </div>
          <button type="button" onClick={bookmark} className={button} aria-label="Add bookmark" disabled={!chapter.content}>
            ⚑
          </button>
          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            className={button}
            aria-label="Reader settings"
            aria-expanded={showSettings}
          >
            Aa
          </button>
        </div>
        <div className="h-0.5 bg-border" aria-hidden>
          <div className="h-full bg-accent transition-[width]" style={{ width: `${pct * 100}%` }} />
        </div>

        {showSettings && (
          <div className="absolute right-3 top-14 w-64 space-y-4 rounded-2xl border border-border bg-surface p-4 shadow-lg sm:right-[max(1rem,calc(50%-27rem))]">
            <div>
              <p className="mb-2 text-xs font-medium text-muted">Text size</p>
              <div className="flex items-center gap-2">
                <button type="button" className={button} onClick={() => writePrefs({ ...prefs, size: Math.max(14, prefs.size - 1) })} aria-label="Smaller text">
                  A−
                </button>
                <span className="flex-1 text-center text-sm">{prefs.size}px</span>
                <button type="button" className={button} onClick={() => writePrefs({ ...prefs, size: Math.min(28, prefs.size + 1) })} aria-label="Larger text">
                  A+
                </button>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted">Font</p>
              <div className="flex gap-2">
                {(["serif", "sans"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={prefs.font === f}
                    onClick={() => writePrefs({ ...prefs, font: f })}
                    className={`flex-1 rounded-full border px-3 py-2 text-sm ${prefs.font === f ? "border-accent bg-accent-soft text-accent" : "border-border text-muted"}`}
                  >
                    {f === "serif" ? "Serif" : "Sans"}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between text-sm">
              Wide layout
              <input type="checkbox" checked={prefs.wide} onChange={(e) => writePrefs({ ...prefs, wide: e.target.checked })} className="size-4 accent-[var(--accent)]" />
            </label>
          </div>
        )}
      </header>

      {chapter.number > boundary + 1 && (
        <div className="mx-auto max-w-xl px-5 pt-6" style={{ fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}>
          <div className="rounded-2xl bg-accent-soft px-4 py-3 text-sm">
            <p>
              You&apos;re ahead of your recorded progress (read through chapter {boundary}). The assistant still
              only knows chapters 1–{boundary}.
            </p>
            <button type="button" onClick={markEarlierRead} className="mt-2 font-medium text-accent hover:underline">
              I&apos;ve read chapters 1–{chapter.number - 1}
            </button>
          </div>
        </div>
      )}

      <article
        className={`mx-auto px-5 py-10 sm:py-14 ${prefs.wide ? "max-w-3xl" : "max-w-xl"}`}
        style={{
          fontSize: prefs.size,
          lineHeight: 1.75,
          fontFamily: prefs.font === "serif" ? "Georgia, 'Times New Roman', serif" : "var(--font-geist-sans), system-ui, sans-serif",
        }}
      >
        <p className="text-xs font-medium uppercase tracking-wider text-muted" style={{ fontSize: 12 }}>
          Chapter {chapter.number}
        </p>
        <h1 className="mt-1 text-balance font-bold leading-tight" style={{ fontSize: "1.6em" }}>
          {chapter.title}
        </h1>

        {chapter.content ? (
          <div className="mt-8 space-y-[1em]">
            {blocks.map((b, i) => {
              if (b.type === "text") return <p key={i}>{b.text}</p>;
              const img = images[b.id];
              return (
                <figure key={i} className="my-[1.5em]">
                  <ChapterImage
                    src={img ? imageUrl(bookId, img.id) : null}
                    alt={img?.alt ?? null}
                    width={img?.width ?? null}
                    height={img?.height ?? null}
                    eager={i < 3}
                  />
                </figure>
              );
            })}
          </div>
        ) : (
          <div className="mt-8 rounded-2xl border border-dashed border-border bg-surface p-6 text-center" style={{ fontSize: 15, fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}>
            <p className="font-medium">No text for this chapter yet</p>
            <p className="mt-2 text-sm text-muted">
              Add the text from the book page, or read it on the original site and mark it finished here to keep your
              progress in sync.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Link href={`/library/${bookId}`} className="rounded-full border border-border px-4 py-2 text-sm hover:bg-accent-soft">
                Add text
              </Link>
              {bookSourceUrl && (
                <a href={bookSourceUrl} target="_blank" rel="noopener noreferrer" className="rounded-full border border-border px-4 py-2 text-sm hover:bg-accent-soft">
                  Open original site ↗
                </a>
              )}
              <button
                type="button"
                onClick={async () => {
                  await finishChapter();
                  flash("Marked as read");
                }}
                className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground"
              >
                {boundary >= chapter.number ? "Marked as read ✓" : "Mark as read"}
              </button>
            </div>
          </div>
        )}

        <nav
          className="mt-14 flex items-center justify-between gap-3 border-t border-border pt-6"
          style={{ fontSize: 14, fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}
          aria-label="Chapter navigation"
        >
          {prev ? (
            <Link href={`/library/${bookId}/read/${prev.number}`} className={button}>
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <button type="button" onClick={goNext} className="rounded-full bg-accent px-5 py-2.5 font-medium text-accent-foreground hover:opacity-90">
              Next chapter →
            </button>
          ) : (
            boundary >= chapter.number ? (
              <Link href={`/library/${bookId}#assistant`} className="rounded-full bg-accent px-5 py-2.5 font-medium text-accent-foreground">
                Finished · Ask the assistant
              </Link>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  await finishChapter();
                  flash("Chapter finished");
                }}
                className="rounded-full bg-accent px-5 py-2.5 font-medium text-accent-foreground hover:opacity-90"
              >
                Mark chapter finished
              </button>
            )
          )}
        </nav>
      </article>

      {toast && (
        <div role="status" className="fixed inset-x-0 bottom-6 z-30 mx-auto w-fit rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
