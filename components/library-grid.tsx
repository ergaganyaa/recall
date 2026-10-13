"use client";

import { useState } from "react";
import type { LibraryItem } from "@/lib/queries";
import { BOOK_STATUSES, STATUS_LABELS, type BookStatus } from "@/lib/types";
import { BookCard } from "./book-card";

export function LibraryGrid({ books }: { books: LibraryItem[] }) {
  const [filter, setFilter] = useState<BookStatus | "all">("all");
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const visible = books.filter(
    (b) =>
      (filter === "all" || b.status === filter) &&
      (!q || `${b.title} ${b.author ?? ""}`.toLowerCase().includes(q)),
  );

  return (
    <>
      <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0" role="group" aria-label="Filter by status">
          {(["all", ...BOOK_STATUSES] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition ${
                filter === f
                  ? "bg-accent text-accent-foreground"
                  : "border border-border text-muted hover:text-foreground"
              }`}
            >
              {f === "all" ? "All" : STATUS_LABELS[f]}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="library-search">
          Search library
        </label>
        <input
          id="library-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title or author…"
          className="w-full rounded-full border border-border bg-surface px-4 py-2 text-sm outline-none focus:border-accent lg:w-72"
        />
      </div>

      {visible.length === 0 ? (
        <p className="mt-16 text-center text-muted">No books match your filters.</p>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((b) => (
            <BookCard key={b.id} book={b} />
          ))}
        </div>
      )}
    </>
  );
}
