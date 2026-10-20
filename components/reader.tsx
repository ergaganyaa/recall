"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { addBookmark, markChapterRead, recordReadingCheckpoint, saveProgress } from "@/app/actions/reading";
import type { Citation } from "@/lib/assistant/types";
import { imageUrl, leadingImageIds, toBlocks } from "@/lib/chapter-content";
import { createProgressSaver, type ProgressSaver } from "@/lib/progress-saver";
import type { ChatMessage } from "@/lib/types";
import { selectionRange, tidyQuote } from "@/lib/selection";
import { AssistantChat, type ChatContext, type ChatSelection } from "./assistant-chat";
import { ChapterImage } from "./chapter-image";
import { ChapterPicker } from "./chapter-picker";
import { useScrollBoundary } from "./use-block-tracking";
import { bookPath } from "@/lib/book-slug";


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

// "Is this a phone-sized screen?" (the chat is a bottom sheet there, a side panel on wide screens)
const MOBILE_QUERY = "(max-width: 1023px)";
const subscribeMedia = (cb: () => void) => {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

type ChapterRef = { number: number; title: string };

export type ReaderChatProps = { initialMessages: ChatMessage[]; configured: boolean; modelLabel: string };

export function Reader(props: {
  bookId: string;
  bookTitle: string;
  /** the book's address name: links are /library/<bookSlug>/... */
  bookSlug: string;
  chapter: { number: number; title: string; content: string | null; rev: number };
  /** Illustrations of this chapter by id. Markers that aren't listed here are ignored. */
  images: Record<string, { id: string; width: number | null; height: number | null; alt: string | null; ext?: string }>;
  chapters: ChapterRef[];
  initialPct: number;
  bookSourceUrl: string | null;
  /** Chapters 1..lastRead are finished: the chapter-level spoiler boundary. */
  lastRead: number;
  /** Blocks 0..partialBlock of chapter lastRead+1 are read (-1 = none; already checked against this text revision). */
  partialBlock: number;
  /** Paragraph at the top of the screen when the reader last left THIS chapter (null = unknown) */
  resumeBlock: number | null;
  /** Chapter where the reader last left off (for the way back from a citation visit) */
  resumeChapter: number;
  /** ?block= : a paragraph to scroll to (a citation) */
  focusBlock: number | null;
  /** Opened from a citation: nothing about reading progress is saved or advanced in this visit. */
  visit: boolean;
  volumeLabel: string | null;
  chat: ReaderChatProps;
}) {
  const base = bookPath({ slug: props.bookSlug }); // the book's readable address
  const { bookId, bookTitle, chapter, chapters, initialPct, bookSourceUrl, images, focusBlock, visit, resumeChapter } = props;
  const [boundary, setBoundary] = useState(props.lastRead);
  const router = useRouter();

  const raw = useSyncExternalStore(subscribe, readRaw, () => "");
  const prefs = raw ? parsePrefs(raw) : DEFAULT_PREFS;
  const [showSettings, setShowSettings] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const isMobile = useSyncExternalStore(subscribeMedia, () => window.matchMedia(MOBILE_QUERY).matches, () => false);

  const idx = chapters.findIndex((c) => c.number === chapter.number);
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;

  const blocks = useMemo(() => toBlocks(chapter.content ?? ""), [chapter.content]);
  const lastBlock = blocks.length - 1;

  // The progress bar is updated straight in the DOM: a state update on every scroll event would re-render the
  // whole chapter (hundreds of paragraphs) many times a second.
  const barRef = useRef<HTMLDivElement>(null);
  const [navigating, setNavigating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<number | null>(focusBlock);
  const [canGoBack, setCanGoBack] = useState(false);
  // "Ask about this passage": the text the reader has highlighted right now (just paragraph numbers and a short quote)
  // and, once they chose to ask, the passage the chat will send along. The server re-reads the paragraphs itself.
  const [picked, setPicked] = useState<{ from: number; to: number; quote: string; clipped: boolean } | null>(null);
  const [askSelection, setAskSelection] = useState<ChatSelection | null>(null);

  // The chapter body is rebuilt only when the text, pictures or the highlighted paragraph change, not on every
  // unrelated state change (chat panel, toast, settings, "Opening…"): a long chapter is hundreds of paragraphs.
  const eagerImages = useMemo(
    () => new Set(leadingImageIds(chapter.content ?? "", focusBlock ?? props.resumeBlock ?? Math.floor(initialPct * blocks.length), 2)),
    [chapter.content, focusBlock, props.resumeBlock, initialPct, blocks.length],
  );
  const body = useMemo(
    () =>
      blocks.map((b, i) => {
        const litClass = highlight === i ? "rounded-md bg-accent-soft outline outline-2 outline-offset-4 outline-accent transition" : "";
        if (b.type === "text") {
          return (
            <p key={`b${i}`} data-block={i} id={`block-${i}`} className={`scroll-mt-24 ${litClass}`}>
              {b.text}
            </p>
          );
        }
        const img = images[b.id];
        return (
          <figure key={`b${i}`} data-block={i} id={`block-${i}`} className={`my-[1.5em] scroll-mt-24 ${litClass}`}>
            <ChapterImage
              src={img ? imageUrl(bookId, img.id, img.ext) : null}
              alt={img?.alt ?? null}
              width={img?.width ?? null}
              height={img?.height ?? null}
              eager={eagerImages.has(b.id)}
            />
          </figure>
        );
      }),
    [blocks, images, highlight, bookId, eagerImages],
  );
  const finished = useRef(false);
  const returnY = useRef(0);
  // Saves the resume position after a pause AND whenever the reader leaves (see flushProgress).
  const saver = useRef<ProgressSaver | null>(null);
  const flushProgress = useCallback(() => saver.current?.flush(), []);
  // Checkpoints of the tracked position go to the server one at a time, in order.
  const checkpointChain = useRef<Promise<unknown>>(Promise.resolve());

  const flash = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const finishChapter = useCallback(async () => {
    if (visit || finished.current) return;
    if (boundary >= chapter.number) return; // already finished earlier: nothing to save (and no network wait)
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
  }, [bookId, chapter.number, flash, visit, boundary]);

  // ----- reading boundary: everything above the top of the screen is read, the rest is not -----
  const trackingEnabled = !visit && !!chapter.content && chapter.number === boundary + 1;
  const sendBoundary = useCallback(
    (n: number) => {
      // One request at a time, in order, so the server always ends up with the latest position.
      const run = checkpointChain.current.then(() => recordReadingCheckpoint(bookId, chapter.number, n, chapter.rev));
      checkpointChain.current = run.catch(() => undefined);
      return run;
    },
    [bookId, chapter.number, chapter.rev],
  );
  const tracking = useScrollBoundary({
    enabled: trackingEnabled,
    initialBoundary: props.partialBlock,
    onChange: (n) => void sendBoundary(n),
  });
  const trackingRef = useRef(tracking);
  useEffect(() => {
    trackingRef.current = tracking;
  });
  const { captureAnchor, restoreAnchor, scrollToBlock, suspend, release } = tracking;

  // Keep the reader on the same paragraph when the layout changes (text size, font, width, chat panel).
  useLayoutEffect(() => {
    restoreAnchor();
  }, [raw, chatOpen, restoreAnchor]);
  const changePrefs = (nextPrefs: Prefs) => {
    captureAnchor();
    writePrefs(nextPrefs);
  };
  const toggleChat = () => {
    captureAnchor();
    setChatOpen((o) => !o);
  };

  // Explicit "Mark earlier chapters read".
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

  // Before a question is sent, the server gets the boundary as it is RIGHT NOW (it never takes one from the
  // question). If that cannot be confirmed the question is not sent, so an older, further boundary is never used.
  const beforeAsk = useCallback(async () => {
    flushProgress();
    if (!trackingEnabled) return;
    const n = trackingRef.current.reportNow();
    const res = await sendBoundary(n);
    if (!res.ok || !res.data.applied) {
      trackingRef.current.setReported(Number.NaN);
      const why = !res.ok
        ? res.error
        : res.data.reason === "stale_revision"
          ? "This chapter's text changed. Reload the page and try again."
          : "Couldn't save your reading position.";
      throw new Error(`${why} Your question was not sent.`);
    }
  }, [flushProgress, trackingEnabled, sendBoundary]);

  // Citation inside the chapter being read: scroll to that paragraph, highlight it, and offer a way back.
  const jumpTo = useCallback(
    (c: Citation) => {
      if (c.block === null || c.chapter !== chapter.number) return false;
      returnY.current = window.scrollY;
      if (isMobile) setChatOpen(false); // the sheet covers the text
      const ok = scrollToBlock(c.block, true);
      if (!ok) return false;
      setHighlight(c.block);
      setCanGoBack(true);
      window.setTimeout(() => setHighlight((h) => (h === c.block ? null : h)), 3500);
      return true;
    },
    [chapter.number, isMobile, scrollToBlock],
  );
  const goBack = () => {
    suspend(1800);
    window.scrollTo({ top: returnY.current, behavior: "smooth" });
    setCanGoBack(false);
    setHighlight(null);
  };

  // Put the reader back: at a cited paragraph, else at the paragraph where they stopped (so a different font size
  // or window width still lands on the same words), else at the saved scroll fraction.
  useEffect(() => {
    if (!chapter.content) return;
    suspend(2000);
    if (focusBlock !== null) {
      scrollToBlock(focusBlock);
    } else if (props.resumeBlock !== null && !visit) {
      scrollToBlock(Math.min(props.resumeBlock, lastBlock));
    } else if (initialPct > 0.01) {
      requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo(0, max * initialPct);
      });
    }
    // A citation visit must not change where the reader is considered to be reading.
    if (!visit) void saveProgress(bookId, chapter.number, initialPct, props.resumeBlock);
    // From here on the boundary follows the scroll position (the restore above must have settled first).
    const settle = window.setTimeout(release, 500);
    return () => window.clearTimeout(settle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per chapter visit
  }, [bookId, chapter.number]);

  // Scroll → progress bar, and the debounced resume position.
  useEffect(() => {
    if (visit) return;
    const s = createProgressSaver({
      initial: initialPct,
      save: (p) => void saveProgress(bookId, chapter.number, p, trackingRef.current?.getTopBlock() ?? null),
    });
    saver.current = s;
    function onScroll() {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 1;
      if (barRef.current) barRef.current.style.width = `${p * 100}%`;
      // Right after a citation jump the resume position stays where the reader WAS until they scroll by themselves.
      if (trackingRef.current?.hasUserMovedSinceJump() !== false) s.update(p);
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
  }, [bookId, chapter.number, initialPct, visit]);

  // Watch the text selection. Only a highlight inside the chapter text counts; highlighting in the chat box does not.
  useEffect(() => {
    if (!chapter.content) return;
    const blockOf = (node: Node | null): number | null => {
      const el = node instanceof Element ? node : (node?.parentElement ?? null);
      const holder = el?.closest<HTMLElement>("[data-block]");
      if (!holder || !holder.closest('[data-testid="chapter-body"]')) return null;
      const n = Number(holder.dataset.block);
      return Number.isInteger(n) ? n : null;
    };
    let raf = 0;
    let forget = 0;
    // Phones clear the highlight the moment you tap anything, including our button, BEFORE the tap is delivered.
    // So when the highlight disappears we keep the last one for a moment instead of dropping it at once.
    const scheduleForget = () => {
      if (!forget) forget = window.setTimeout(() => setPicked(null), 3000);
    };
    const read = () => {
      raf = 0;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return scheduleForget();
      const range = selectionRange(blockOf(sel.anchorNode), blockOf(sel.focusNode));
      const quote = tidyQuote(sel.toString());
      if (!range || quote.length < 2) return scheduleForget();
      window.clearTimeout(forget);
      forget = 0;
      setPicked({ ...range, quote });
    };
    const onChange = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(forget);
    };
  }, [chapter.content]);

  function askAboutPicked() {
    if (!picked) return;
    if (!chatOpen) captureAnchor(); // opening the chat must not move the page
    setAskSelection({ chapter: chapter.number, from: picked.from, to: picked.to, rev: chapter.rev, quote: picked.quote, clipped: picked.clipped });
    setChatOpen(true);
    setPicked(null);
  }

  // Keyboard navigation between chapters; Escape closes the chat.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (e.key === "Escape" && chatOpen) {
        toggleChat();
        return;
      }
      if (t.closest("input, select, textarea, [role='dialog'], [role='listbox']") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft" && prev) router.push(`${base}/read/${prev.number}`);
      if (e.key === "ArrowRight" && next) router.push(`${base}/read/${next.number}`);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toggleChat is recreated every render and only reads fresh state
  }, [bookId, prev, next, router, chatOpen]);

  async function bookmark() {
    const res = await addBookmark(bookId, chapter.number, saver.current?.latest ?? 0, "");
    flash(res.ok ? "Bookmark saved" : res.error);
  }

  async function goNext() {
    if (!next || navigating) return;
    setNavigating(true); // immediate feedback; the button cannot be double-clicked
    const t0 = performance.now();
    // The next page reads your progress, so the "finished" write has to land first; start loading its shell meanwhile.
    router.prefetch(`${base}/read/${next.number}`);
    try {
      await finishChapter();
    } catch {
      // Network failure: say so, and do not move on as if your progress had been saved.
      flash("Couldn't save your progress. Check your connection and try again.");
      setNavigating(false);
      return;
    }
    if (process.env.NEXT_PUBLIC_RECALL_TIMING === "1") console.log(`[timing] next: click to navigate ${(performance.now() - t0).toFixed(0)} ms`);
    router.push(`${base}/read/${next.number}`);
  }

  // Warm up the neighbouring chapters (the page shell only; their data is fetched when you open them).
  useEffect(() => {
    if (next) router.prefetch(`${base}/read/${next.number}`);
    if (prev) router.prefetch(`${base}/read/${prev.number}`);
  }, [router, base, next, prev]);

  const button =
    "grid h-10 min-w-10 place-items-center rounded-full border border-border px-3 text-sm text-muted transition hover:text-foreground disabled:opacity-40";

  const context: ChatContext = {
    book: bookTitle,
    volume: props.volumeLabel,
    chapter: chapter.number,
    chapterTitle: chapter.title,
    readTo:
      boundary === 0 && chapter.number !== 1
        ? "nothing yet"
        : boundary === 0
          ? "only the text above your current position"
          : `chapters 1–${boundary}${chapter.number === boundary + 1 ? " and the text above your current position" : ""}`,
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-2 px-3 sm:px-4">
          <Link
            href={base}
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
                router.push(`${base}/read/${n}`);
              }}
            />
          </div>
          <button
            type="button"
            onClick={toggleChat}
            aria-expanded={chatOpen}
            aria-controls="reader-chat"
            data-testid="open-chat"
            title="Ask the assistant about what you've read"
            className={`flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent ${
              chatOpen ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-foreground hover:border-accent hover:text-accent"
            }`}
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12z" />
            </svg>
            <span className="hidden sm:inline">Ask</span>
            <span className="sr-only sm:hidden">Ask the assistant</span>
          </button>
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
          <div ref={barRef} className="h-full bg-accent" style={{ width: `${initialPct * 100}%` }} />
        </div>

        {showSettings && (
          <div className="absolute right-3 top-14 w-64 space-y-4 rounded-2xl border border-border bg-surface p-4 text-foreground shadow-lg sm:right-[max(1rem,calc(50%-27rem))]">
            <div>
              <p className="mb-2 text-xs font-medium text-muted">Text size</p>
              <div className="flex items-center gap-2">
                <button type="button" className={button} onClick={() => changePrefs({ ...prefs, size: Math.max(14, prefs.size - 1) })} aria-label="Smaller text">
                  A−
                </button>
                <span className="flex-1 text-center text-sm">{prefs.size}px</span>
                <button type="button" className={button} onClick={() => changePrefs({ ...prefs, size: Math.min(28, prefs.size + 1) })} aria-label="Larger text">
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
                    onClick={() => changePrefs({ ...prefs, font: f })}
                    className={`flex-1 rounded-full border px-3 py-2 text-sm ${prefs.font === f ? "border-accent bg-accent-soft text-accent" : "border-border text-muted"}`}
                  >
                    {f === "serif" ? "Serif" : "Sans"}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between text-sm">
              Wide layout
              <input type="checkbox" checked={prefs.wide} onChange={(e) => changePrefs({ ...prefs, wide: e.target.checked })} className="size-4 accent-[var(--accent)]" />
            </label>
          </div>
        )}
      </header>

      {visit && (
        <div className="mx-auto max-w-xl px-5 pt-6" style={{ fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }} data-testid="visit-banner">
          <div className="rounded-2xl bg-accent-soft px-4 py-3 text-sm">
            <p>Viewing a passage the assistant cited. Your reading position is unchanged.</p>
            <Link href={`${base}/read/${resumeChapter}`} className="mt-2 inline-block font-medium text-accent hover:underline" data-testid="visit-back">
              ← Back to where you were reading (chapter {resumeChapter})
            </Link>
          </div>
        </div>
      )}

      {!visit && chapter.number > boundary + 1 && (
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

      <div className={chatOpen ? "lg:mr-[24rem]" : ""}>
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
            <div className="mt-8 space-y-[1em]" data-testid="chapter-body">
              {body}
            </div>
          ) : (
            <div className="mt-8 rounded-2xl border border-dashed border-border bg-surface p-6 text-center" style={{ fontSize: 15, fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}>
              <p className="font-medium">No text for this chapter yet</p>
              <p className="mt-2 text-sm text-muted">
                Add the text from the book page, or read it on the original site and mark it finished here to keep your
                progress in sync.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Link href={base} className="rounded-full border border-border px-4 py-2 text-sm hover:bg-accent-soft">
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
                  disabled={visit}
                  className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:opacity-50"
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
              <Link href={`${base}/read/${prev.number}`} className={button}>
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <button
                type="button"
                onClick={goNext}
                disabled={navigating}
                aria-busy={navigating}
                className="rounded-full bg-accent px-5 py-2.5 font-medium text-accent-foreground hover:opacity-90 disabled:opacity-70"
              >
                {navigating ? "Opening…" : "Next chapter →"}
              </button>
            ) : boundary >= chapter.number ? (
              <button type="button" onClick={() => setChatOpen(true)} className="rounded-full bg-accent px-5 py-2.5 font-medium text-accent-foreground">
                Finished · Ask the assistant
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  await finishChapter();
                  flash("Chapter finished");
                }}
                disabled={visit}
                className="rounded-full bg-accent px-5 py-2.5 font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
              >
                Mark chapter finished
              </button>
            )}
          </nav>
        </article>
      </div>

      {/* The chat stays mounted while closed so the conversation and any unsent question survive. */}
      {chatOpen && isMobile && (
        <button type="button" aria-label="Close chat" tabIndex={-1} onClick={toggleChat} className="fixed inset-0 z-30 cursor-default bg-foreground/30 lg:hidden" />
      )}
      <aside
        id="reader-chat"
        aria-label="Ask about the story"
        aria-hidden={!chatOpen}
        data-testid="reader-chat"
        className={`${chatOpen ? "" : "hidden"} fixed inset-x-0 bottom-0 z-40 h-[78vh] overflow-hidden rounded-t-2xl border-t border-border bg-surface text-foreground shadow-2xl lg:inset-x-auto lg:right-0 lg:top-[58px] lg:h-auto lg:w-[24rem] lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-none`}
      >
        <AssistantChat
          variant="panel"
          bookId={bookId}
          initialMessages={props.chat.initialMessages}
          boundary={boundary}
          configured={props.chat.configured}
          modelLabel={props.chat.modelLabel}
          context={context}
          currentChapter={chapter.number}
          onJump={jumpTo}
          beforeAsk={beforeAsk}
          onClose={toggleChat}
          selection={askSelection}
          onClearSelection={() => setAskSelection(null)}
        />
      </aside>

      {picked && !(chatOpen && isMobile) && (
        <button
          type="button"
          // Act on PRESS (before a phone clears the highlight); keep the highlight while the button is pressed.
          // The click handler covers the keyboard (Enter / Space), which has no press event.
          onPointerDown={(e) => {
            e.preventDefault();
            askAboutPicked();
          }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={askAboutPicked}
          data-testid="ask-about-passage"
          className="fixed bottom-16 left-1/2 z-30 -translate-x-1/2 rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground shadow-lg hover:opacity-90 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
        >
          ✦ Ask AI about this passage
        </button>
      )}
      {canGoBack && (
        <button
          type="button"
          onClick={goBack}
          data-testid="jump-back"
          className="fixed bottom-20 left-1/2 z-30 -translate-x-1/2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground shadow-lg hover:border-accent hover:text-accent"
        >
          ↩ Back to where I was
        </button>
      )}
      {toast && (
        <div role="status" className="fixed inset-x-0 bottom-6 z-30 mx-auto w-fit max-w-[90vw] rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
