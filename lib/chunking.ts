const TARGET = 900;
const HARD_MAX = 1400;

export function countWords(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/** Normalises pasted/uploaded text: unified newlines, trimmed, no runaway blank lines. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Splits chapter text into passages of roughly TARGET characters on paragraph
 * boundaries (falling back to sentences for oversized paragraphs).
 */
/** One paragraph → one or more pieces no longer than HARD_MAX (sentence split, then a hard cut as a last resort). */
function splitParagraph(p: string): string[] {
  if (p.length <= HARD_MAX) return [p];
  const pieces: string[] = [];
  let buf = "";
  for (const s of p.split(/(?<=[.!?…。！？])\s+/)) {
    if (buf && buf.length + s.length > TARGET) {
      pieces.push(buf);
      buf = "";
    }
    buf = buf ? `${buf} ${s}` : s;
    while (buf.length > HARD_MAX) {
      pieces.push(buf.slice(0, HARD_MAX));
      buf = buf.slice(HARD_MAX);
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

export function chunkText(text: string): string[] {
  const paragraphs = cleanText(text)
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return chunkBlocks(paragraphs.map((t, i) => ({ index: i, text: t }))).map((c) => c.text);
}

export type RangedChunk = { text: string; /** first paragraph (block) index in the chunk */ first: number; /** last paragraph (block) index */ last: number };

/**
 * Splits paragraphs into passages of roughly TARGET characters, recording which paragraphs (block indexes,
 * as numbered by the reader) each passage covers. A paragraph is never split across a boundary between
 * passages unless it is longer than HARD_MAX; pieces of one paragraph all carry that paragraph's index.
 */
export function chunkBlocks(blocks: { index: number; text: string }[]): RangedChunk[] {
  const pieces = blocks.flatMap((b) => splitParagraph(b.text.trim()).map((text) => ({ text, index: b.index }))).filter((p) => p.text);

  const chunks: RangedChunk[] = [];
  let cur: RangedChunk | null = null;
  for (const piece of pieces) {
    if (cur && cur.text.length + piece.text.length + 2 > TARGET) {
      chunks.push(cur);
      cur = null;
    }
    cur = cur
      ? { text: `${cur.text}\n\n${piece.text}`, first: Math.min(cur.first, piece.index), last: Math.max(cur.last, piece.index) }
      : { text: piece.text, first: piece.index, last: piece.index };
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Search terms for the Postgres OR-query: letters/digits only, so they are safe to embed. */
export function extractTerms(question: string): string[] {
  const seen = new Set<string>();
  for (const m of question.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (m[0].length >= 3 && !STOPWORDS.has(m[0])) seen.add(m[0]);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

const STOPWORDS = new Set(
  "the and for are but not you all can was were with that this what who whom whose which when where why how does did has had have from about into than then they them their there his her she him its our out too any been being tell me explain who's what's".split(
    " ",
  ),
);
