"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteBook, updateBookStatus } from "@/app/actions/library";
import { summarizeProgress } from "@/lib/progress-display";
import type { LibraryItem } from "@/lib/queries";
import { BOOK_STATUSES, STATUS_LABELS, type BookStatus } from "@/lib/types";
import { BookCover } from "./book-cover";
import { ProgressBar } from "./progress-bar";

export function BookCard({ book }: { book: LibraryItem }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const summary = summarizeProgress({ chapters: book.chapters, lastRead: book.last_read_chapter, status: book.status });
  const percent = summary.percent;

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else router.refresh();
    });
  }

  return (
    <div
      className={`flex flex-col rounded-2xl border border-border bg-surface p-3 transition ${
        pending ? "opacity-60" : "hover:shadow-md"
      }`}
    >
      <Link href={`/library/${book.id}`} className="group flex flex-col gap-3">
        <BookCover title={book.title} author={book.author} coverUrl={book.cover_src} />
        <div className="px-1">
          <h3 className="line-clamp-2 font-semibold leading-snug group-hover:text-accent">{book.title}</h3>
          <p className="mt-1 text-xs text-muted">
            {book.chapter_count
              ? `${summary.finished} / ${book.chapter_count} chapters${book.content_count < book.chapter_count ? " · partly imported" : ""}`
              : "No chapters yet"}
            {book.is_sample && " · Sample"}
          </p>
          <ProgressBar percent={percent} label={`${book.title} reading progress`} className="mt-2" />
        </div>
      </Link>

      <div className="mt-3 flex items-center gap-2 px-1">
        <label className="sr-only" htmlFor={`status-${book.id}`}>
          Reading status
        </label>
        <select
          id={`status-${book.id}`}
          value={book.status}
          disabled={pending}
          onChange={(e) => run(() => updateBookStatus(book.id, e.target.value as BookStatus))}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
        >
          {BOOK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending}
          aria-label={`Remove ${book.title}`}
          onClick={() => {
            if (window.confirm(`Remove “${book.title}” and its progress from your library?`)) {
              run(() => deleteBook(book.id));
            }
          }}
          className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:border-danger hover:text-danger"
        >
          Remove
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 px-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
