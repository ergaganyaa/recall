import Link from "next/link";
import { BookCover } from "@/components/book-cover";
import { ProgressBar } from "@/components/progress-bar";
import { VolumeBrowser } from "@/components/volume-browser";
import { resolveCover } from "@/lib/cover";
import { FEATURED_SERIES } from "@/lib/featured";
import { summarizeProgress } from "@/lib/progress-display";
import type { Book, ChapterSummary, Progress, Volume } from "@/lib/types";
import { STATUS_LABELS } from "@/lib/types";
import { bookPath } from "@/lib/book-slug";

/** Home page hero for the user's featured book, followed by its volume browser. */
export function FeaturedHero({
  book,
  volumes,
  chapters,
  progress,
}: {
  book: Book;
  volumes: Volume[];
  chapters: ChapterSummary[];
  progress: Progress;
}) {
  const summary = summarizeProgress({ chapters, lastRead: progress.last_read_chapter, status: book.status });
  const currentChapter = chapters.find((c) => c.number === progress.current_chapter) ?? chapters[0];
  const currentVolume = currentChapter ? volumes.find((v) => v.id === currentChapter.volume_id) : undefined;
  const lastFinished = chapters.find((c) => c.number === Math.min(progress.last_read_chapter, chapters.length));
  const started = progress.last_read_chapter > 0 || progress.scroll_pct > 0.02 || progress.current_chapter > 1;
  const importHref = `${bookPath(book)}/import`;
  const altTitle = book.title === FEATURED_SERIES.title ? FEATURED_SERIES.altTitle : null;

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div
          className="absolute inset-0 -z-10 opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(55rem 26rem at 85% -10%, var(--accent-soft), transparent), radial-gradient(36rem 18rem at 0% 100%, var(--accent-soft), transparent)",
          }}
          aria-hidden
        />
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 sm:py-16 md:grid-cols-[15rem_1fr] md:items-center">
          <BookCover title={book.title} author={book.author} coverUrl={resolveCover(book, volumes, { chapters, currentChapter: progress.current_chapter }).src} className="mx-auto w-44 md:w-full" />

          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-accent">Featured · {STATUS_LABELS[book.status]}</p>
            <h1 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-5xl">{book.title}</h1>
            {altTitle && <p className="mt-1 text-sm text-muted sm:text-base">{altTitle}</p>}
            {book.author && <p className="mt-2 text-muted">by {book.author}</p>}

            {chapters.length > 0 ? (
              <div className="mt-6 max-w-xl rounded-2xl border border-border bg-surface/90 p-5 backdrop-blur">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm">
                    <span className="text-muted">{started ? "Continue at " : "Start at "}</span>
                    <span className="font-medium">
                      {currentVolume ? `Volume ${currentVolume.number} · ` : ""}Chapter {currentChapter?.number}
                      {currentChapter ? ` — ${currentChapter.title}` : ""}
                    </span>
                  </p>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{summary.percent}%</span>
                </div>
                <ProgressBar percent={summary.percent} label={`${book.title} reading progress`} className="mt-3" />
                <p className="mt-2 text-xs text-muted">
                  {summary.finished} of {summary.total} chapters finished
                  {summary.note ? ` · ${summary.note}` : ""}
                </p>
                {lastFinished && (
                  <p className="mt-1 text-xs text-muted">
                    Last finished: Ch. {lastFinished.number} — {lastFinished.title}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link
                    href={`${bookPath(book)}/read/${currentChapter?.number ?? 1}`}
                    className="rounded-full bg-accent px-6 py-3 text-sm font-medium text-accent-foreground transition hover:opacity-90"
                  >
                    {started ? "Continue reading" : "Start reading"}
                  </Link>
                  <Link href={`${bookPath(book)}#assistant`} className="rounded-full border border-border px-5 py-3 text-sm font-medium transition hover:bg-accent-soft">
                    Ask about the story
                  </Link>
                </div>
              </div>
            ) : (
              <div className="mt-6 max-w-xl rounded-2xl border border-dashed border-border bg-surface/90 p-5">
                <p className="font-medium">Nothing imported yet</p>
                <p className="mt-1 text-sm text-muted">
                  Import a volume from an EPUB, TXT or Markdown file you own to start reading. Progress will appear here.
                </p>
                <Link href={importHref} className="mt-4 inline-block rounded-full bg-accent px-6 py-3 text-sm font-medium text-accent-foreground hover:opacity-90">
                  Import a volume
                </Link>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6" aria-labelledby="volumes-heading">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="volumes-heading" className="text-2xl font-bold tracking-tight">
              Volumes
            </h2>
            <p className="mt-1 text-sm text-muted">Only imported volumes are listed. They appear in reading order, including side volumes like 4.5.</p>
          </div>
          <Link href={bookPath(book)} className="text-sm font-medium text-accent hover:underline">
            Open full book page →
          </Link>
        </div>
        <VolumeBrowser basePath={bookPath(book)} volumes={volumes} chapters={chapters} lastRead={progress.last_read_chapter} current={progress.current_chapter} />
      </section>
    </>
  );
}
