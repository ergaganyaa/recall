"use client";

import { useState } from "react";
import type { ChapterSummary } from "@/lib/types";
import { AddChaptersForm } from "./add-chapters-form";
import { AddTextForm } from "./add-text-form";

const TABS = [
  { id: "text", label: "Chapter text" },
  { id: "list", label: "Chapter list" },
] as const;

/** One card for everything that adds content to a book: text uploads and bulk chapter lists. */
export function ChapterTools({ bookId, chapters }: { bookId: string; chapters: ChapterSummary[] }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>(chapters.length ? "text" : "list");

  return (
    <section className="rounded-2xl border border-border bg-surface p-4" aria-label="Add chapters or text">
      <h2 className="font-semibold">Add to this book</h2>
      <div role="tablist" className="mt-3 flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              tab === t.id ? "bg-accent text-accent-foreground" : "border border-border text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-4" role="tabpanel">
        {tab === "text" ? <AddTextForm bookId={bookId} chapters={chapters} /> : <AddChaptersForm bookId={bookId} />}
      </div>
    </section>
  );
}
