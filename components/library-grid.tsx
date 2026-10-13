"use client";

import { useState } from "react";
import type { Book } from "@/lib/types";
import { BookCard } from "./book-card";

const FILTERS = ["All", "Ongoing", "Completed"] as const;

export function LibraryGrid({ books }: { books: Book[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const visible = books.filter(
    (b) =>
      (filter === "All" || b.status === filter) &&
      (!q || `${b.title} ${b.author} ${b.genres.join(" ")}`.toLowerCase().includes(q)),
  );

  return (
    <>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2" role="group" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                filter === f
                  ? "bg-accent text-accent-foreground"
                  : "border border-border text-muted hover:text-foreground"
              }`}
            >
              {f}
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
          placeholder="Search title, author or genre…"
          className="w-full rounded-full border border-border bg-surface px-4 py-2 text-sm outline-none focus:border-accent sm:w-72"
        />
      </div>

      {visible.length === 0 ? (
        <p className="mt-16 text-center text-muted">No books match your filters.</p>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((b) => (
            <BookCard key={b.slug} book={b} />
          ))}
        </div>
      )}
    </>
  );
}
