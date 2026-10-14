/**
 * Pure layout analysis for text extracted from PDFs: items → lines → paragraphs,
 * running header/footer removal, and chapter-heading detection. No pdf.js here,
 * so it is deterministic and unit-testable. Coordinates are TOP-DOWN (y grows
 * downward, like a screen), which is how reading order works.
 */

export type RawItem = { str: string; x: number; y: number; width: number; height: number };
export type Line = { text: string; x: number; xEnd: number; y: number; height: number };
export type Paragraph = { text: string; y: number; height: number; x: number; heading: boolean };

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿＀-￯]/;
const TERMINAL = /[.!?…。！？」』"”’)\]]\s*$/;

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};

/** Joins two text fragments, adding a space only where one belongs. */
function joinFragments(a: string, b: string, gap: number, height: number): string {
  if (!a) return b;
  if (!b) return a;
  const last = a[a.length - 1];
  const first = b[0];
  if (CJK.test(last) || CJK.test(first)) return a + b;
  if (/\s$/.test(a) || /^\s/.test(b)) return a + b;
  return gap > height * 0.2 ? `${a} ${b}` : a + b;
}

/** Groups positioned text fragments into lines in reading order (top→bottom, left→right). */
export function buildLines(items: RawItem[]): Line[] {
  const usable = items.filter((i) => i.str.trim() !== "" || i.str === " ");
  const sorted = [...usable].sort((a, b) => a.y - b.y || a.x - b.x);

  type Acc = { y: number; height: number; items: RawItem[] };
  const rows: Acc[] = [];
  for (const it of sorted) {
    const h = it.height || 10;
    const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(1.5, 0.45 * Math.min(h, r.height)));
    if (row) {
      row.items.push(it);
      row.height = Math.max(row.height, h);
    } else rows.push({ y: it.y, height: h, items: [it] });
  }

  const lines: Line[] = [];
  for (const row of rows.sort((a, b) => a.y - b.y)) {
    const parts = row.items.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd = parts[0].x;
    for (const p of parts) {
      text = joinFragments(text, p.str, p.x - prevEnd, row.height);
      prevEnd = Math.max(prevEnd, p.x + p.width);
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push({ text, x: parts[0].x, xEnd: prevEnd, y: row.y, height: row.height });
  }
  return lines;
}

// ----------------------------------------------------------------- headers / footers
const PAGE_NUMBER = /^[\s\-–—]*(\d{1,4}|[ivxlcdm]{1,7})[\s\-–—]*$/i;

/**
 * Finds lines that repeat in the top/bottom margin of many pages (running titles,
 * page numbers). Returns, per page, the set of line indexes to drop.
 */
export function findRunningLines(pages: { lines: Line[]; height: number }[]): Set<number>[] {
  const zone = 0.08;
  const keyOf = (t: string) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const inZone = (l: Line, h: number) => l.y < h * zone || l.y > h * (1 - zone);

  const counts = new Map<string, number>();
  for (const p of pages) {
    const seen = new Set<string>();
    p.lines.forEach((l) => {
      if (inZone(l, p.height)) seen.add(keyOf(l.text));
    });
    seen.forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1));
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));

  return pages.map((p) => {
    const drop = new Set<number>();
    p.lines.forEach((l, i) => {
      if (!inZone(l, p.height)) return;
      if (PAGE_NUMBER.test(l.text) || (counts.get(keyOf(l.text)) ?? 0) >= threshold) drop.add(i);
    });
    return drop;
  });
}

// ----------------------------------------------------------------- paragraphs
export type ParagraphOptions = {
  /** y positions (top-down) of images on the page; paragraphs never span one. */
  breaks?: number[];
};

function joinLines(lines: Line[]): string {
  let text = "";
  for (const l of lines) {
    if (!text) {
      text = l.text;
      continue;
    }
    if (/[-­]$/.test(text) && /^[a-z]/.test(l.text) && !/\s-$/.test(text)) text = text.slice(0, -1) + l.text; // de-hyphenate
    else if (CJK.test(text[text.length - 1]) || CJK.test(l.text[0])) text += l.text;
    else text += ` ${l.text}`;
  }
  return text.trim();
}

/**
 * Turns one page's lines into paragraphs. A new paragraph starts on a larger
 * vertical gap, a first-line indent, or after a short line that ends a sentence.
 * Lines set noticeably larger than body text become their own "heading" paragraph.
 */
export function buildParagraphs(lines: Line[], bodyHeight: number, opts: ParagraphOptions = {}): Paragraph[] {
  if (lines.length === 0) return [];
  const left = percentile(lines.map((l) => l.x), 0.1);
  const right = percentile(lines.map((l) => l.xEnd), 0.9);
  const width = Math.max(1, right - left);
  const gaps = lines.slice(1).map((l, i) => l.y - lines[i].y).filter((g) => g > 0);
  // Lower quartile = the real line spacing, even when a few paragraph gaps are much larger.
  const spacing = percentile(gaps, 0.25) || bodyHeight * 1.3;
  const breaks = [...(opts.breaks ?? [])].sort((a, b) => a - b);

  const isHeadingLine = (l: Line) => bodyHeight > 0 && l.height >= bodyHeight * 1.3 && l.text.length <= 90;

  const out: Paragraph[] = [];
  let cur: Line[] = [];
  const flush = (heading = false) => {
    if (cur.length === 0) return;
    out.push({ text: joinLines(cur), y: cur[0].y, height: Math.max(...cur.map((c) => c.height)), x: cur[0].x, heading });
    cur = [];
  };

  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    if (isHeadingLine(l)) {
      const sameHeading = cur.length > 0 && isHeadingLine(cur[cur.length - 1]) && l.y - prev.y < l.height * 1.8;
      if (!sameHeading) flush(false);
      cur.push(l);
      return;
    }
    if (cur.length && isHeadingLine(cur[cur.length - 1])) flush(true);

    if (prev && cur.length) {
      const gap = l.y - prev.y;
      const indented = l.x - left > Math.max(bodyHeight * 0.8, 6);
      const prevShort = prev.xEnd - left < width * 0.62 && TERMINAL.test(prev.text);
      const crossesImage = breaks.some((b) => b > prev.y && b < l.y);
      if (gap > spacing * 1.45 || indented || prevShort || crossesImage) flush(false);
    }
    cur.push(l);
  });
  flush(cur.length > 0 && isHeadingLine(cur[cur.length - 1]));
  return out;
}

// ----------------------------------------------------------------- headings
const NUM_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
const HEADING_PATTERNS: RegExp[] = [
  // `(?![\p{L}\p{N}])` is a Unicode-aware word boundary: JavaScript's \b only understands ASCII letters.
  new RegExp(`^(chapter|ch\\.)\\s*(\\d+|[ivxlc]+|${NUM_WORDS})(?![\\p{L}\\p{N}])`, "iu"),
  /^(глава|пролог|эпилог|послесловие|интерлюдия|предисловие|вступление)(?![\p{L}\p{N}])/iu,
  /^第\s*[0-9０-９一二三四五六七八九十百]+\s*[章話话]/,
  /^(プロローグ|エピローグ|あとがき|序章|終章)/,
];

// Section words that often begin ordinary sentences ("Introduction to the …"), so they only count when the
// whole line reads like a title. Deliberately excludes ambiguous words such as "opening" and "ending".
const SECTION_WORDS =
  /^(prologue|epilogue|afterword|interlude|intermission|foreword|preface|introduction|postscript|short story|side story|bonus (story|chapter)|extra chapter|final chapter)(?![\p{L}\p{N}])/iu;

/** True for short standalone lines that look like "Chapter 4", "Prologue", "Глава 12 …". */
export function looksLikeChapterHeading(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 80) return false;
  const words = t.split(/\s+/).length;
  const endsLikeSentence = /[.!?…。！？]$/.test(t);
  if (endsLikeSentence && words > 6) return false; // a sentence, not a title

  if (SECTION_WORDS.test(t)) {
    // "Prologue", "Epilogue: The Last Day", "Interlude 2" are titles; "Introduction to the sample." is a sentence.
    return words <= 7 && !(endsLikeSentence && words > 2);
  }
  return HEADING_PATTERNS.some((re) => re.test(t));
}

export type HeadingKind = "pattern" | "large-font";

/**
 * Decides whether a paragraph starts a chapter.
 * - "pattern": its text looks like a chapter title.
 * - "large-font": it is set much larger than body text, is short, is the first thing
 *   on its page, and is not a sentence (kept conservative to avoid false splits).
 */
export function classifyHeading(
  p: Paragraph,
  ctx: { bodyHeight: number; firstOnPage: boolean },
): HeadingKind | null {
  if (looksLikeChapterHeading(p.text)) return "pattern";
  if (
    ctx.firstOnPage &&
    p.heading &&
    p.height >= ctx.bodyHeight * 1.4 &&
    p.text.length <= 60 &&
    !/[.!?…。！？]$/.test(p.text) &&
    !/^(contents|table of contents|copyright|title page|dedication)$/i.test(p.text.trim())
  ) {
    return "large-font";
  }
  return null;
}

/** Median text height over many lines: the body size that headings are compared against. */
export const bodyHeightOf = (lines: Line[]) => median(lines.map((l) => l.height));
