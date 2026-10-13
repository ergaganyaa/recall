/**
 * Reading and validating chapter text files (.txt / .md). Pure functions with
 * no server-only imports, so the browser (instant feedback) and the server
 * action (authoritative check) share the same rules.
 */

export const MAX_CHAPTER_CHARS = 400_000;
export const MAX_UPLOAD_BYTES = 2_000_000;

const ALLOWED_EXT = [".txt", ".md", ".markdown"];

const UNSUPPORTED: Record<string, string> = {
  ".epub": "EPUB files aren't supported yet. For now, export the chapter as .txt or paste it.",
  ".pdf": "PDF files can't be read reliably. Copy the text into a .txt file or paste it.",
  ".doc": "Word files aren't supported. Save the chapter as .txt and upload that.",
  ".docx": "Word files aren't supported. Save the chapter as .txt and upload that.",
  ".rtf": "RTF files aren't supported. Save the chapter as .txt and upload that.",
  ".html": "HTML files aren't supported. Save the chapter as .txt or paste the text.",
  ".htm": "HTML files aren't supported. Save the chapter as .txt or paste the text.",
  ".zip": "Archives aren't supported. Extract them and upload one .txt file per chapter.",
};

export type PreparedText =
  | { ok: true; text: string; encoding: string; notes: string[] }
  | { ok: false; error: string };

const fmt = (n: number) => n.toLocaleString("en-US");

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/** Decodes bytes → text, handling BOMs and the common Russian legacy encoding. */
function decode(bytes: Uint8Array): { text: string; encoding: string; notes: string[] } | { error: string } {
  const notes: string[] = [];

  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "UTF-16 LE", notes };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "UTF-16 BE", notes };
  }

  // NUL bytes in a non-UTF-16 file mean binary data (images, zip, docx...).
  if (bytes.includes(0)) {
    return { error: "This doesn't look like a plain-text file (it contains binary data). Upload a .txt or .md file." };
  }

  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start));
    return { text, encoding: "UTF-8", notes };
  } catch {
    // Not valid UTF-8: many Russian-language files are Windows-1251.
    try {
      const text = new TextDecoder("windows-1251").decode(bytes);
      notes.push(
        "This file isn't UTF-8, so it was read as Windows-1251. If the text looks wrong, re-save it as UTF-8 and upload again.",
      );
      return { text, encoding: "Windows-1251", notes };
    } catch {
      return { error: "Couldn't read this file's text encoding. Re-save it as UTF-8 and try again." };
    }
  }
}

/** Light Markdown → plain text so the reader doesn't show raw markup. */
export function markdownToText(md: string): string {
  return md
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "") // YAML front matter
    .replace(/^ {0,3}(?:[-*_][ \t]*){3,}$/gm, "* * *") // scene breaks / horizontal rules
    .replace(/^ {0,3}```.*$/gm, "") // code-fence lines (content kept)
    .replace(/^ {0,3}#{1,6}\s+/gm, "")
    .replace(/^ {0,3}>\s?/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n");
}

/**
 * Shared content rules, used for uploads, pasted text and by the server action.
 * Returns an error message, or null when the text is acceptable.
 */
export function validateChapterText(text: string): string | null {
  if (text.includes("\u0000")) return "The text contains binary data and can't be saved.";
  if (!text.trim()) return "The text is empty. Paste or upload some text first.";
  if (text.length > MAX_CHAPTER_CHARS) {
    return `This chapter has ${fmt(text.length)} characters; the limit is ${fmt(MAX_CHAPTER_CHARS)}. Split it into several chapters.`;
  }
  const replacements = (text.match(/�/g) ?? []).length;
  if (replacements > 5 && replacements / text.length > 0.005) {
    return "The text looks garbled (many unreadable characters). Re-save the file as UTF-8 and try again.";
  }
  return null;
}

/** Validates and decodes an uploaded file's bytes. */
export function prepareTextFile(name: string, bytes: Uint8Array): PreparedText {
  const ext = extensionOf(name);
  if (UNSUPPORTED[ext]) return { ok: false, error: UNSUPPORTED[ext] };
  if (!ALLOWED_EXT.includes(ext)) {
    return { ok: false, error: `“${name}” isn't a supported type. Upload a .txt or .md file, or paste the text.` };
  }
  if (bytes.byteLength === 0) return { ok: false, error: `“${name}” is empty.` };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `“${name}” is ${(bytes.byteLength / 1e6).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1e6} MB.` };
  }

  const decoded = decode(bytes);
  if ("error" in decoded) return { ok: false, error: decoded.error };

  let text = decoded.text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (ext !== ".txt") text = markdownToText(text);
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  const problem = validateChapterText(text);
  if (problem) return { ok: false, error: problem };

  return { ok: true, text, encoding: decoded.encoding, notes: decoded.notes };
}
