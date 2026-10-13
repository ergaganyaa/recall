import Link from "next/link";
import type { Book } from "@/lib/types";
import { getLastRead, getProgress } from "@/lib/mock-data";
import { BookCover } from "./book-cover";
import { ProgressBar } from "./progress-bar";

export function BookCard({ book }: { book: Book }) {
  const progress = getProgress(book);
  const last = getLastRead(book);

  return (
    <Link
      href={`/library/${book.slug}`}
      className="group flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3 transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <BookCover book={book} className="transition group-hover:shadow-xl" />
      <div className="px-1 pb-1">
        <h3 className="line-clamp-2 font-semibold leading-snug">{book.title}</h3>
        <p className="mt-1 text-xs text-muted">
          {book.genres.join(" · ")} · {book.status}
        </p>
        <ProgressBar
          percent={progress.percent}
          label={`${book.title} reading progress`}
          className="mt-3"
        />
        <p className="mt-2 text-xs text-muted">
          {last
            ? `Vol. ${last.volume.number} · Ch. ${last.chapter.number} · ${progress.percent}%`
            : "Not started"}
        </p>
      </div>
    </Link>
  );
}
