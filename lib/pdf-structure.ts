/**
 * Editing the detected chapter structure before an import (pure; works on the
 * ParsedChapter list for any source, though page splitting needs PDF page info).
 * Every function returns a new array and never touches the input.
 */
import type { ParsedBlock, ParsedChapter } from "./epub";

const words = (b: ParsedBlock) => (b.type === "text" ? (b.text.match(/\S+/g)?.length ?? 0) : 0);

/** Recomputes counts and page range after blocks changed. */
export function restat(c: Omit<ParsedChapter, "wordCount" | "imageCount" | "pageStart" | "pageEnd"> & Partial<ParsedChapter>): ParsedChapter {
  const pages = c.blocks.map((b) => b.page).filter((p): p is number => p !== undefined);
  return {
    ...c,
    wordCount: c.blocks.reduce((n, b) => n + words(b), 0),
    imageCount: c.blocks.filter((b) => b.type === "image").length,
    pageStart: pages.length ? Math.min(...pages) : undefined,
    pageEnd: pages.length ? Math.max(...pages) : undefined,
  };
}

export function renameChapter(chapters: ParsedChapter[], index: number, title: string): ParsedChapter[] {
  return chapters.map((c, i) => (i === index ? { ...c, title: title.slice(0, 300) } : c));
}

/** Joins chapter `index` onto the one before it (removing a wrong boundary). */
export function mergeWithPrevious(chapters: ParsedChapter[], index: number): ParsedChapter[] {
  if (index <= 0 || index >= chapters.length) return chapters;
  const prev = chapters[index - 1];
  const cur = chapters[index];
  const merged = restat({ ...prev, blocks: [...prev.blocks, ...cur.blocks], frontMatter: prev.frontMatter && cur.frontMatter });
  return [...chapters.slice(0, index - 1), merged, ...chapters.slice(index + 1)];
}

/** The whole file as one chapter (the fallback when detection is unreliable). */
export function mergeAll(chapters: ParsedChapter[], title: string): ParsedChapter[] {
  if (chapters.length === 0) return chapters;
  return [restat({ title: title.slice(0, 300) || "Full text", blocks: chapters.flatMap((c) => c.blocks), frontMatter: false })];
}

export type SplitResult = { ok: true; chapters: ParsedChapter[] } | { ok: false; error: string };

/**
 * Splits chapter `index` so that everything from `page` onwards becomes a new chapter.
 * `page` must fall inside the chapter, after its first page.
 */
export function splitAtPage(chapters: ParsedChapter[], index: number, page: number, title?: string): SplitResult {
  const c = chapters[index];
  if (!c) return { ok: false, error: "That chapter doesn't exist." };
  if (c.pageStart === undefined || c.pageEnd === undefined) {
    return { ok: false, error: "This chapter has no page information, so it can't be split by page." };
  }
  if (!Number.isInteger(page)) return { ok: false, error: "Enter a whole page number." };
  if (page <= c.pageStart || page > c.pageEnd) {
    return { ok: false, error: `Choose a page between ${c.pageStart + 1} and ${c.pageEnd} (this chapter covers pages ${c.pageStart}–${c.pageEnd}).` };
  }
  const head = c.blocks.filter((b) => (b.page ?? 0) < page);
  const tail = c.blocks.filter((b) => (b.page ?? 0) >= page);
  if (head.length === 0 || tail.length === 0) {
    return { ok: false, error: "Splitting there would leave one part empty." };
  }
  const first = restat({ ...c, blocks: head });
  const second = restat({ title: (title?.trim() || `${c.title} (continued)`).slice(0, 300), blocks: tail, frontMatter: false });
  return { ok: true, chapters: [...chapters.slice(0, index), first, second, ...chapters.slice(index + 1)] };
}
