/**
 * Keeps story illustrations INLINE instead of letting them become stand-alone chapters.
 *
 * Some books list every illustration page in the table of contents or bookmarks ("Illustration 3",
 * "Insert 2"). Those are pages inside a chapter, not chapters. When such an image-only entry sits
 * after real story text, it is folded into the chapter before it, at the end, which keeps the exact
 * reading order (it already came after that chapter's text and before the next chapter).
 *
 * Deliberately conservative: only generic, numbered labels are folded. A named section such as
 * "Color Illustrations" or "Bonus Illustrations", and anything before the first story chapter
 * (front matter), stays a chapter of its own.
 */
import type { ParsedChapter } from "./epub";
import { restat } from "./pdf-structure";

const GENERIC_ILLUSTRATION_TITLE =
  /^(?:(?:illustration|illust\.?|insert|image|picture|pic|plate|figure|иллюстрация|вставка|картинка|挿絵)\s*[#№.:-]?\s*\d+|section\s+\d+|untitled)$/iu;

export function foldInlineIllustrationChapters(chapters: ParsedChapter[]): { chapters: ParsedChapter[]; folded: number } {
  const out: ParsedChapter[] = [];
  let folded = 0;
  for (const c of chapters) {
    const prev = out[out.length - 1];
    const imageOnly = c.wordCount === 0 && c.imageCount > 0;
    if (prev && imageOnly && !c.frontMatter && !prev.frontMatter && prev.wordCount > 0 && GENERIC_ILLUSTRATION_TITLE.test(c.title.trim())) {
      out[out.length - 1] = restat({ ...prev, blocks: [...prev.blocks, ...c.blocks] });
      folded++;
      continue;
    }
    out.push(c);
  }
  return { chapters: out, folded };
}

export const foldedNotice = (n: number) =>
  `${n} illustration page${n === 1 ? "" : "s"} listed like a chapter (for example “Illustration 3”) ${n === 1 ? "was" : "were"} placed inside the chapter before ${n === 1 ? "it" : "them"}, in reading order. Use “Split at page” to separate ${n === 1 ? "it" : "them"} if that's wrong.`;

/** Counts pictures kept and reports them with the reasons others were skipped. */
export type ImageReport = { found: number; kept: number; skipped: { reason: string; count: number }[] };

export function buildImageReport(found: number, chapters: ParsedChapter[], skipped: Record<string, number>): ImageReport {
  return {
    found,
    kept: chapters.reduce((n, c) => n + c.blocks.filter((b) => b.type === "image").length, 0),
    skipped: Object.entries(skipped)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => ({ reason, count })),
  };
}
