import Link from "next/link";
import type { Book } from "@/lib/types";
import { getLastRead, getNextChapter, getProgress } from "@/lib/mock-data";
import { BookCover } from "./book-cover";
import { ProgressBar } from "./progress-bar";

/** Prominent "last read" indicator with overall progress. */
export function ContinueReadingCard({ book }: { book: Book }) {
  const progress = getProgress(book);
  const last = getLastRead(book);
  const next = getNextChapter(book);

  return (
    <div className="flex gap-4 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:gap-5 sm:p-5">
      <BookCover book={book} className="w-24 shrink-0 sm:w-32" />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="text-xs font-medium uppercase tracking-wider text-accent">
          Continue reading
        </p>
        <h3 className="mt-1 text-lg font-semibold leading-snug sm:text-xl">{book.title}</h3>

        <div className="mt-3 rounded-xl bg-accent-soft px-3 py-2 text-sm">
          <span className="text-muted">Last read: </span>
          <span className="font-medium">
            {last
              ? `Vol. ${last.volume.number}, Ch. ${last.chapter.number} — ${last.chapter.title}`
              : "Nothing yet"}
          </span>
        </div>

        <div className="mt-auto pt-4">
          <div className="mb-2 flex justify-between text-xs text-muted">
            <span>
              {progress.read} of {progress.total} chapters
            </span>
            <span>{progress.percent}%</span>
          </div>
          <ProgressBar percent={progress.percent} label={`${book.title} reading progress`} />
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href={`/library/${book.slug}`}
              className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition hover:opacity-90"
            >
              {next ? `Next: Ch. ${next.chapter.number}` : "View book"}
            </Link>
            <Link
              href={`/library/${book.slug}#assistant`}
              className="rounded-full border border-border px-4 py-2 text-sm font-medium transition hover:bg-accent-soft"
            >
              Ask assistant
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
