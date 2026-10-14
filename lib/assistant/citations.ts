import { passageLabel } from "./prompt";
import type { Citation, SourcePassage } from "./types";

export const chapterHref = (bookId: string, chapter: number) => `/library/${bookId}/read/${chapter}`;

const MARKER = /\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\]/g;

/**
 * Reads the [n] markers in a model answer and keeps ONLY those that refer to a passage that was actually
 * supplied. Anything else (an invented number, a number that was never given) is removed from the text, so
 * a citation can never point at something the model was not shown.
 *
 * Citations are built from the retrieved passages' own metadata, never from text the model wrote.
 */
export function extractCitations(
  answer: string,
  passages: SourcePassage[],
  bookId: string,
): { text: string; citations: Citation[] } {
  const cited = new Set<number>();

  const text = answer
    .replace(MARKER, (_m, group: string) => {
      const valid = group
        .split(/[,;]/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= passages.length);
      valid.forEach((n) => cited.add(n));
      return valid.length ? `[${[...new Set(valid)].join(", ")}]` : "";
    })
    .replace(/[ \t]+([.,;:!?])/g, "$1") // tidy the gap a removed marker leaves
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  // One entry per chapter, in reading order; chapters the answer cites are marked, the rest were only consulted.
  const byChapter = new Map<number, Citation>();
  passages.forEach((p, i) => {
    const n = i + 1;
    const entry = byChapter.get(p.chapter_number) ?? {
      chapter: p.chapter_number,
      label: passageLabel(p),
      href: chapterHref(bookId, p.chapter_number),
      indices: [],
      cited: false,
    };
    entry.indices.push(n);
    if (cited.has(n)) entry.cited = true;
    byChapter.set(p.chapter_number, entry);
  });

  const citations = [...byChapter.values()].sort((a, b) => Number(b.cited) - Number(a.cited) || a.chapter - b.chapter);
  return { text, citations };
}
