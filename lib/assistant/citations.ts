import { passageLabel } from "./prompt";
import type { Citation, SourcePassage } from "./types";

/**
 * Link to a cited chapter, optionally to one paragraph of it. `cite=1` marks it as a VISIT: the reader opens
 * there, but does not save it as where you are reading and does not track or advance any progress, so
 * following a citation never costs you your place.
 */
export const chapterHref = (bookId: string, chapter: number, block?: number | null) =>
  `/library/${bookId}/read/${chapter}?cite=1${block === null || block === undefined ? "" : `&block=${block}`}`;

const MARKER = /\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\]/g;

/**
 * Reads the [n] markers in a model answer and keeps ONLY those that refer to a passage that was actually
 * supplied. Anything else (an invented number, a number that was never given) is removed from the text, so
 * a citation can never point at something the model was not shown.
 *
 * Citations, including the paragraph they link to, are built from the retrieved passages' own metadata,
 * never from text the model wrote.
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
  const byChapter = new Map<number, Citation & { _blockFromCited: boolean }>();
  passages.forEach((p, i) => {
    const n = i + 1;
    const isCited = cited.has(n);
    const entry =
      byChapter.get(p.chapter_number) ??
      ({
        chapter: p.chapter_number,
        label: passageLabel(p),
        href: chapterHref(bookId, p.chapter_number),
        block: null,
        indices: [],
        cited: false,
        _blockFromCited: false,
      } as Citation & { _blockFromCited: boolean });
    entry.indices.push(n);
    if (isCited) entry.cited = true;
    // The paragraph to jump to: that of the first CITED passage in the chapter, else the first passage seen.
    const takeBlock = p.block_last !== null && p.block_last !== undefined && (entry.block === null || (isCited && !entry._blockFromCited));
    if (takeBlock) {
      entry.block = p.block_last;
      entry._blockFromCited = isCited;
      entry.href = chapterHref(bookId, p.chapter_number, p.block_last);
    }
    byChapter.set(p.chapter_number, entry);
  });

  const citations: Citation[] = [...byChapter.values()]
    .map((c) => ({ chapter: c.chapter, label: c.label, href: c.href, block: c.block, indices: c.indices, cited: c.cited }))
    .sort((a, b) => Number(b.cited) - Number(a.cited) || a.chapter - b.chapter);
  return { text, citations };
}
