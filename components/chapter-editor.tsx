"use client";

import { useState } from "react";
import type { ParsedChapter } from "@/lib/epub";
import { mergeAll, mergeWithPrevious, renameChapter, splitAtPage } from "@/lib/pdf-structure";

export type EditableStructure = { chapters: ParsedChapter[]; include: boolean[] };

/**
 * Review and fix the detected chapter structure before anything is saved:
 * rename, include/exclude, merge a wrong boundary, split at a page, or take the whole file as one chapter.
 */
export function ChapterEditor({
  value,
  onChange,
  disabled,
  wholeFileTitle,
}: {
  value: EditableStructure;
  onChange: (next: EditableStructure) => void;
  disabled?: boolean;
  wholeFileTitle: string;
}) {
  const { chapters, include } = value;
  const [splitting, setSplitting] = useState<number | null>(null);
  const [splitPage, setSplitPage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const set = (next: EditableStructure) => {
    setError(null);
    onChange(next);
  };

  function merge(i: number) {
    set({
      chapters: mergeWithPrevious(chapters, i),
      include: [...include.slice(0, i - 1), include[i - 1] || include[i], ...include.slice(i + 1)],
    });
  }

  function split(i: number) {
    const res = splitAtPage(chapters, i, Number(splitPage));
    if (!res.ok) {
      setError(res.error);
      return;
    }
    set({ chapters: res.chapters, include: [...include.slice(0, i + 1), true, ...include.slice(i + 1)] });
    setSplitting(null);
    setSplitPage("");
  }

  const hasPages = chapters.some((c) => c.pageStart !== undefined);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Chapters to import ({include.filter(Boolean).length} of {chapters.length})</h3>
        <div className="flex flex-wrap gap-3 text-xs">
          <button
            type="button"
            disabled={disabled}
            className="text-accent hover:underline disabled:opacity-50"
            onClick={() => set({ chapters, include: include.map(() => !include.every(Boolean)) })}
          >
            {include.every(Boolean) ? "Deselect all" : "Select all"}
          </button>
          {chapters.length > 1 && (
            <button
              type="button"
              disabled={disabled}
              className="text-accent hover:underline disabled:opacity-50"
              onClick={() => {
                if (window.confirm("Combine everything into one chapter?")) set({ chapters: mergeAll(chapters, wholeFileTitle), include: [true] });
              }}
            >
              Import as one chapter
            </button>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <ol className="mt-2 max-h-[28rem] divide-y divide-border overflow-y-auto rounded-xl border border-border text-sm">
        {chapters.map((c, i) => (
          <li key={i} className="px-3 py-2">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                aria-label={`Include ${c.title}`}
                checked={include[i] ?? false}
                disabled={disabled}
                onChange={(e) => set({ chapters, include: include.map((v, k) => (k === i ? e.target.checked : v)) })}
                className="size-4 shrink-0"
              />
              <input
                aria-label={`Title of chapter ${i + 1}`}
                value={c.title}
                maxLength={300}
                disabled={disabled}
                onChange={(e) => set({ chapters: renameChapter(chapters, i, e.target.value), include })}
                className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 outline-none hover:border-border focus:border-accent"
              />
              <span className="hidden shrink-0 text-xs text-muted sm:inline">
                {c.wordCount > 0 ? `${c.wordCount.toLocaleString("en-US")} words` : "no text"}
                {c.imageCount > 0 && ` · ${c.imageCount} img`}
                {c.pageStart !== undefined && ` · p. ${c.pageStart}${c.pageEnd !== c.pageStart ? `–${c.pageEnd}` : ""}`}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 pl-7 text-xs text-muted">
              <span className="sm:hidden">
                {c.wordCount.toLocaleString("en-US")} words · {c.imageCount} img
              </span>
              {i > 0 && (
                <button type="button" disabled={disabled} onClick={() => merge(i)} className="hover:text-accent disabled:opacity-50">
                  Merge with previous
                </button>
              )}
              {hasPages && c.pageStart !== undefined && c.pageEnd !== undefined && c.pageEnd > c.pageStart && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setSplitting(splitting === i ? null : i);
                    setSplitPage(String(c.pageStart! + 1));
                    setError(null);
                  }}
                  className="hover:text-accent disabled:opacity-50"
                >
                  Split at page…
                </button>
              )}
            </div>
            {splitting === i && (
              <div className="mt-2 flex items-center gap-2 pl-7 text-xs">
                <label htmlFor={`split-${i}`}>New chapter starts on page</label>
                <input
                  id={`split-${i}`}
                  type="number"
                  min={(c.pageStart ?? 1) + 1}
                  max={c.pageEnd}
                  value={splitPage}
                  onChange={(e) => setSplitPage(e.target.value)}
                  className="w-20 rounded-lg border border-border bg-background px-2 py-1 outline-none focus:border-accent"
                />
                <button type="button" onClick={() => split(i)} className="rounded-full bg-accent px-3 py-1 font-medium text-accent-foreground">
                  Split
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
