import type { FriendBook } from "@/lib/friends";
import { STATUS_LABELS, type BookStatus } from "@/lib/types";
import { BookCover } from "./book-cover";
import { ProgressBar } from "./progress-bar";

/**
 * One of a friend's books, read-only: cover, title, author, status and how far they are. It is not a link: a friend's
 * books are theirs, and nothing inside them (chapters, notes, text) is shared.
 */
export function FriendBookCard({ book, owner }: { book: FriendBook; owner: string }) {
  const percent = book.total > 0 ? Math.min(100, Math.round((book.finished / book.total) * 100)) : 0;
  const cover = book.coverImageId ? `/friends/${encodeURIComponent(owner)}/cover/${book.coverImageId}` : book.coverUrl;
  const status = STATUS_LABELS[book.status as BookStatus] ?? book.status;
  return (
    <article className="flex h-full flex-col gap-3 rounded-2xl border border-border bg-surface p-3" data-testid="friend-book">
      <BookCover title={book.title} author={book.author} coverUrl={cover} />
      <div className="px-1">
        <h3 className="line-clamp-2 font-semibold leading-snug">{book.title}</h3>
        {book.author && <p className="mt-0.5 truncate text-xs text-muted">by {book.author}</p>}
        <p className="mt-1 text-xs text-muted">
          {status}
          {book.total > 0 && ` · ${book.finished} / ${book.total} chapters`}
        </p>
        <ProgressBar percent={percent} label={`${book.title}: ${percent}% read`} className="mt-2" />
      </div>
    </article>
  );
}
