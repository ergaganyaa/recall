/**
 * Chapter content is plain text, one block per line. An illustration is a line
 * holding only an image marker, so images keep their exact position in the
 * reading order:
 *
 *   First paragraph.
 *   [[image:6f1c0a2e-....]]
 *   Next paragraph.
 *
 * Markers are display-only: they are removed before text is chunked, counted or
 * searched, so image ids/alt text can never reach the assistant.
 */

import { chunkBlocks, countWords } from "./chunking";
import { MAX_CHAPTER_CHARS } from "./text-file";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MARKER_LINE = new RegExp(`^\\[\\[image:(${UUID})\\]\\]$`, "i");

export const imageMarker = (id: string) => `[[image:${id}]]`;

export type ContentBlock = { type: "text"; text: string } | { type: "image"; id: string };

/**
 * Blocks are numbered by their position in the list `toBlocks` returns (0, 1, 2…). The database numbers them
 * the same way (chapter_block_lines, migration 0006): split on "\n", trim ONLY spaces/tabs/CR, drop empty
 * lines. Keep the two definitions identical, or paragraph-level reading positions would drift.
 */
export const BLOCK_TRIM = /^[ \t\r]+|[ \t\r]+$/g;

/** Splits content into ordered text/image blocks. */
export function toBlocks(content: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(BLOCK_TRIM, "");
    if (!line) continue;
    const m = line.match(MARKER_LINE);
    blocks.push(m ? { type: "image", id: m[1].toLowerCase() } : { type: "text", text: line });
  }
  return blocks;
}

/**
 * The first `count` illustrations at or after block `fromBlock` (reading order). The reader page uses it to start
 * downloading the pictures the reader will see first, before the page's code has even run.
 */
export function leadingImageIds(content: string, fromBlock: number, count: number): string[] {
  const out: string[] = [];
  const blocks = toBlocks(content);
  for (let i = Math.max(0, fromBlock); i < blocks.length && out.length < count; i++) {
    const b = blocks[i];
    if (b.type === "image") out.push(b.id);
  }
  return out;
}

/** Content with all image markers removed: the only form that is indexed or counted. */
export function stripImageMarkers(content: string): string {
  return content
    .split("\n")
    .filter((line) => !MARKER_LINE.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function imageIdsIn(content: string): string[] {
  return toBlocks(content).flatMap((b) => (b.type === "image" ? [b.id] : []));
}

export type ContentKind = "full_text" | "illustrations_only" | "metadata_only";

/** What a chapter actually contains. `metadata_only` = a catalog entry with no content at all. */
export function contentKind(chapter: { word_count: number; image_count: number }): ContentKind {
  if (chapter.word_count > 0) return "full_text";
  if (chapter.image_count > 0) return "illustrations_only";
  return "metadata_only";
}

export const CONTENT_KIND_LABEL: Record<ContentKind, string> = {
  full_text: "Full text",
  illustrations_only: "Illustrations only",
  metadata_only: "Not imported",
};

// ---------------------------------------------------------------- import prep
export type PreparedChapter = {
  /** Display content (text lines + image markers, in order). */
  content: string;
  /** What is searchable: text only, markers removed. */
  plainText: string;
  chunks: string[];
  /** For each chunk, the first/last block index (paragraph) it covers, in the reader's numbering */
  chunkRanges: { first: number; last: number }[];
  wordCount: number;
  imageIds: string[];
};

/**
 * Validates and prepares a chapter that may contain illustrations.
 * - Image-only chapters are valid (a wordless page is real content).
 * - Every marker must have a matching image and vice versa, with no repeats.
 * - Only the marker-free text is chunked/counted, so image ids never reach search.
 */
export function prepareChapter(
  content: string,
  imageIds: string[],
): { ok: true; value: PreparedChapter } | { ok: false; error: string } {
  const lines = content.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  const inText = imageIdsIn(lines);
  const declared = new Set(imageIds.map((i) => i.toLowerCase()));

  if (new Set(inText).size !== inText.length) return { ok: false, error: "The same illustration appears twice in one chapter." };
  for (const id of inText) if (!declared.has(id)) return { ok: false, error: "A chapter refers to an illustration that was not uploaded." };
  for (const id of declared) if (!inText.includes(id)) return { ok: false, error: "An uploaded illustration is not placed in the chapter." };

  const plainText = stripImageMarkers(lines);
  if (plainText.length > MAX_CHAPTER_CHARS) {
    return { ok: false, error: `This chapter has ${plainText.length.toLocaleString("en-US")} characters; the limit is ${MAX_CHAPTER_CHARS.toLocaleString("en-US")}.` };
  }
  if (!plainText && inText.length === 0) return { ok: false, error: "This chapter has no text and no illustrations." };

  const blocks = toBlocks(lines);
  // Chunk the TEXT blocks only (pictures are never searchable), keeping each block's index from the full list.
  const ranged = chunkBlocks(blocks.flatMap((b, index) => (b.type === "text" ? [{ index, text: b.text }] : [])));

  return {
    ok: true,
    value: {
      content: blocks.map((b) => (b.type === "image" ? imageMarker(b.id) : b.text)).join("\n"),
      plainText,
      chunks: ranged.map((c) => c.text),
      chunkRanges: ranged.map((c) => ({ first: c.first, last: c.last })),
      wordCount: countWords(plainText),
      imageIds: inText,
    },
  };
}

/** Where a stored image is served from (the optional file extension lets the route skip a database lookup) (see app/library/[bookId]/image/[imageId]/route.ts). */
export const imageUrl = (bookId: string, imageId: string, ext?: string | null) =>
  `/library/${bookId}/image/${imageId}${ext ? `?e=${ext}` : ""}`;

/** A book's cover: an uploaded/EPUB cover when present, else a linked cover URL. */
export function coverSrc(book: { id: string; cover_image_id: string | null; cover_url: string | null }): string | null {
  return book.cover_image_id ? imageUrl(book.id, book.cover_image_id) : book.cover_url;
}
