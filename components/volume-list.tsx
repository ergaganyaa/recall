"use client";

import { useState } from "react";
import type { Volume } from "@/lib/types";

export function VolumeList({
  volumes,
  lastReadChapter,
}: {
  volumes: Volume[];
  lastReadChapter: number;
}) {
  // Open the volume containing the reader's position (or the first one).
  const initial =
    volumes.find((v) => v.chapters.some((c) => c.number === lastReadChapter + 1 || c.number === lastReadChapter))
      ?.number ?? volumes[0]?.number;
  const [openVolumes, setOpenVolumes] = useState<Set<number>>(new Set([initial]));

  const toggle = (n: number) =>
    setOpenVolumes((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  return (
    <ul className="space-y-3">
      {volumes.map((volume) => {
        const readCount = volume.chapters.filter((c) => c.number <= lastReadChapter).length;
        const isOpen = openVolumes.has(volume.number);
        const panelId = `volume-${volume.number}`;

        return (
          <li key={volume.number} className="overflow-hidden rounded-2xl border border-border bg-surface">
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => toggle(volume.number)}
              className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition hover:bg-accent-soft/50 sm:px-5"
            >
              <span>
                <span className="block text-xs font-medium uppercase tracking-wider text-muted">
                  Volume {volume.number}
                </span>
                <span className="block font-semibold">{volume.title}</span>
              </span>
              <span className="flex items-center gap-3 text-sm text-muted">
                {readCount}/{volume.chapters.length}
                <svg
                  viewBox="0 0 24 24"
                  className={`size-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>

            {isOpen && (
              <ol id={panelId} className="divide-y divide-border border-t border-border">
                {volume.chapters.map((chapter) => {
                  const isRead = chapter.number <= lastReadChapter;
                  const isLast = chapter.number === lastReadChapter;
                  return (
                    <li
                      key={chapter.number}
                      className={`flex items-center gap-3 px-4 py-3 text-sm sm:px-5 ${
                        isLast ? "bg-accent-soft" : ""
                      }`}
                    >
                      <span
                        className={`grid size-6 shrink-0 place-items-center rounded-full text-xs ${
                          isRead ? "bg-accent text-accent-foreground" : "border border-border text-muted"
                        }`}
                        aria-hidden
                      >
                        {isRead ? "✓" : ""}
                      </span>
                      <span className="w-14 shrink-0 text-muted">Ch. {chapter.number}</span>
                      <span className={`min-w-0 flex-1 ${isRead ? "" : "text-muted"}`}>
                        {chapter.title}
                      </span>
                      {isLast && (
                        <span className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-foreground">
                          Last read
                        </span>
                      )}
                      <span className="sr-only">{isRead ? "Read" : "Unread"}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </li>
        );
      })}
    </ul>
  );
}
