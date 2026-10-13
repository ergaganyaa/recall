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
export function chunkText(text: string): string[] {
  const paragraphs = cleanText(text)
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= HARD_MAX) {
      pieces.push(p);
      continue;
    }
    // Oversized paragraph: split on sentence ends, then hard-cut as a last resort.
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
  }

  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur && cur.length + piece.length + 2 > TARGET) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${piece}` : piece;
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
