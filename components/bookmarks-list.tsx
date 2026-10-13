"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { deleteBookmark } from "@/app/actions/reading";
import type { Bookmark } from "@/lib/types";

export function BookmarksList({ bookId, bookmarks }: { bookId: string; bookmarks: Bookmark[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <section className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="font-semibold">Bookmarks</h2>
      {bookmarks.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Tap the bookmark icon in the reader to save a spot.</p>
      ) : (
        <ul className={`mt-3 divide-y divide-border ${pending ? "opacity-60" : ""}`}>
          {bookmarks.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <Link
                href={`/library/${bookId}/read/${b.chapter_number}?p=${b.scroll_pct.toFixed(3)}`}
                className="min-w-0 flex-1 hover:text-accent"
              >
                <span className="block font-medium">
                  Ch. {b.chapter_number} · {Math.round(b.scroll_pct * 100)}%
                </span>
                {b.note && <span className="block truncate text-xs text-muted">{b.note}</span>}
              </Link>
              <button
                type="button"
                disabled={pending}
                aria-label="Remove bookmark"
                onClick={() =>
                  startTransition(async () => {
                    const res = await deleteBookmark(b.id);
                    if (res.ok) router.refresh();
                  })
                }
                className="text-xs text-muted hover:text-danger"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
