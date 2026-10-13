/**
 * Plain-text chapter outline format (pure; used by the browser preview and the server):
 *
 *   # Volume 1: The Broken Gear      <- "#" heading starts a volume
 *   Volume 2 - Tides of Brass        <- "Volume N", "Vol. N", "Book N", "Том N" also work
 *   An Apprentice in the Lower Ward  <- every other non-empty line is a chapter title
 *   - Bullets are fine too           <- leading "- " / "* " / "• " is stripped
 *
 * Chapters before the first heading belong to no volume (or to the book's last
 * volume when appending to an existing book).
 */

export const MAX_TITLE_LENGTH = 300;
export const MAX_OUTLINE_CHAPTERS = 3000;
export const MAX_OUTLINE_CHARS = 200_000;

export type OutlineGroup = {
  /** true when the group came from an explicit volume heading */
  heading: boolean;
  title: string | null;
  chapters: string[];
};

export type OutlineAnalysis = {
  groups: OutlineGroup[];
  chapterCount: number;
  volumeCount: number;
  warnings: string[];
};

const VOLUME_LINE = /^(?:volume|vol\.?|book|том|часть)\s*\d+\b\s*[:.\-–—]?\s*(.*)$/i;
const BULLET = /^[-*•]\s+/;

export function analyzeOutline(text: string): OutlineAnalysis {
  const groups: OutlineGroup[] = [];
  const warnings: string[] = [];
  let current: OutlineGroup | null = null;
  let truncated = 0;

  const clip = (s: string) => {
    if (s.length <= MAX_TITLE_LENGTH) return s;
    truncated++;
    return s.slice(0, MAX_TITLE_LENGTH);
  };

  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;

    let heading: string | null | undefined; // undefined = not a heading
    if (line.startsWith("#")) {
      heading = line.replace(/^#+\s*/, "").trim() || null;
    } else {
      const m = line.match(VOLUME_LINE);
      if (m) heading = m[1].trim() || null;
    }

    if (heading !== undefined) {
      current = { heading: true, title: heading === null ? null : clip(heading), chapters: [] };
      groups.push(current);
      continue;
    }

    if (!current) {
      current = { heading: false, title: null, chapters: [] };
      groups.push(current);
    }
    const title = line.replace(BULLET, "").trim();
    if (title) current.chapters.push(clip(title));
  }

  const kept: OutlineGroup[] = [];
  for (const g of groups) {
    if (g.chapters.length > 0) kept.push(g);
    else if (g.heading) warnings.push(`Volume heading “${g.title ?? "(untitled)"}” has no chapters and was skipped.`);
  }

  if (truncated) warnings.push(`${truncated} title(s) were longer than ${MAX_TITLE_LENGTH} characters and were shortened.`);

  const chapterCount = kept.reduce((n, g) => n + g.chapters.length, 0);
  if (chapterCount > MAX_OUTLINE_CHAPTERS) {
    warnings.push(`That is ${chapterCount} chapters; the limit is ${MAX_OUTLINE_CHAPTERS} at a time.`);
  }

  return { groups: kept, chapterCount, volumeCount: kept.filter((g) => g.heading).length, warnings };
}

/** Human summary for form previews, e.g. "2 volumes · 12 chapters". */
export function describeOutline(a: OutlineAnalysis): string {
  if (a.chapterCount === 0) return "No chapters found yet.";
  const vols = a.volumeCount ? `${a.volumeCount} ${a.volumeCount === 1 ? "volume" : "volumes"} · ` : "";
  return `${vols}${a.chapterCount} ${a.chapterCount === 1 ? "chapter" : "chapters"}`;
}
