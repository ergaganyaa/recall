/**
 * Plain-text / Markdown sources → the same structure the EPUB parser produces,
 * so one import pipeline handles all three formats.
 *
 *  - Several files: each file is one chapter, in natural filename order
 *    ("ch2" before "ch10").
 *  - One file: split into chapters at headings (`# Title` / `## Title`, or
 *    "Chapter 12" / "Глава 12" lines); with no headings it is a single chapter.
 */
import type { ParsedChapter } from "./epub";

export type TextSource = { name: string; text: string };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const HEADING = /^(#{1,2})\s+(\S.*)$/;
const CHAPTER_LINE = /^(?:chapter|ch\.?|глава|章)\s*\d+[^\n]{0,100}$/i;

function titleFromFilename(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim() || "Untitled";
}

function toChapter(title: string, lines: string[]): ParsedChapter {
  const blocks = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text) => ({ type: "text" as const, text }));
  return {
    title: title.slice(0, 300) || "Untitled",
    blocks,
    wordCount: blocks.reduce((n, b) => n + (b.text.match(/\S+/g)?.length ?? 0), 0),
    imageCount: 0,
    frontMatter: false,
  };
}

/** Splits one document into chapters; returns null when it has no chapter headings. */
export function splitByHeadings(text: string): ParsedChapter[] | null {
  const lines = text.split("\n");
  const marks: { at: number; title: string }[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const h = line.match(HEADING);
    if (h) marks.push({ at: i, title: h[2].trim() });
    else if (CHAPTER_LINE.test(line)) marks.push({ at: i, title: line });
  });
  if (marks.length === 0) return null;

  const chapters: ParsedChapter[] = [];
  if (marks[0].at > 0) {
    const head = lines.slice(0, marks[0].at);
    if (head.some((l) => l.trim())) chapters.push(toChapter("Front matter", head));
  }
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : lines.length;
    chapters.push(toChapter(m.title, lines.slice(m.at + 1, end)));
  });
  return chapters.filter((c) => c.blocks.length > 0);
}

export function chaptersFromTextSources(sources: TextSource[]): { chapters: ParsedChapter[]; warnings: string[] } {
  const warnings: string[] = [];
  if (sources.length === 0) return { chapters: [], warnings };

  if (sources.length === 1) {
    const [only] = sources;
    const split = splitByHeadings(only.text);
    if (split && split.length > 0) return { chapters: split, warnings };
    warnings.push("No chapter headings were found, so the file was imported as a single chapter.");
    return { chapters: [toChapter(titleFromFilename(only.name), only.text.split("\n"))], warnings };
  }

  const sorted = [...sources].sort((a, b) => collator.compare(a.name, b.name));
  const chapters = sorted.map((s) => {
    const lines = s.text.split("\n");
    const firstIdx = lines.findIndex((l) => l.trim());
    const h = firstIdx >= 0 ? lines[firstIdx].trim().match(HEADING) : null;
    // A leading "# Title" becomes the chapter title; otherwise use the filename.
    return h ? toChapter(h[2].trim(), lines.slice(firstIdx + 1)) : toChapter(titleFromFilename(s.name), lines);
  });
  warnings.push("Each file was imported as one chapter, ordered by file name.");
  return { chapters, warnings };
}
