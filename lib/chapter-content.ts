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

import { chunkText, countWords } from "./chunking";
import { MAX_CHAPTER_CHARS } from "./text-file";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MARKER_LINE = new RegExp(`^\\[\\[image:(${UUID})\\]\\]$`, "i");

export const imageMarker = (id: string) => `[[image:${id}]]`;

export type ContentBlock = { type: "text"; text: string } | { type: "image"; id: string };

/** Splits content into ordered text/image blocks. */
export function toBlocks(content: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(MARKER_LINE);
    blocks.push(m ? { type: "image", id: m[1].toLowerCase() } : { type: "text", text: line });
  }
  return blocks;
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

  return {
    ok: true,
    value: {
      content: toBlocks(lines)
        .map((b) => (b.type === "image" ? imageMarker(b.id) : b.text))
        .join("\n"),
      plainText,
      chunks: plainText ? chunkText(plainText) : [],
      wordCount: countWords(plainText),
      imageIds: inText,
    },
  };
}

/** Where a stored image is served from (see app/library/[bookId]/image/[imageId]/route.ts). */
export const imageUrl = (bookId: string, imageId: string) => `/library/${bookId}/image/${imageId}`;

/** A book's cover: an uploaded/EPUB cover when present, else a linked cover URL. */
export function coverSrc(book: { id: string; cover_image_id: string | null; cover_url: string | null }): string | null {
  return book.cover_image_id ? imageUrl(book.id, book.cover_image_id) : book.cover_url;
}
