import { describe, expect, it } from "vitest";
import {
  MAX_CHAPTER_CHARS,
  MAX_UPLOAD_BYTES,
  markdownToText,
  prepareTextFile,
  validateChapterText,
} from "@/lib/text-file";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("prepareTextFile", () => {
  it("reads plain UTF-8 and normalises line endings", () => {
    const r = prepareTextFile("ch1.txt", utf8("Line one.\r\n\r\n\r\n\r\nLine two."));
    expect(r).toMatchObject({ ok: true, encoding: "UTF-8", text: "Line one.\n\nLine two." });
  });

  it("strips a UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("Hello")]);
    expect(prepareTextFile("a.txt", bytes)).toMatchObject({ ok: true, text: "Hello" });
  });

  it("decodes UTF-16 LE with BOM", () => {
    const bytes = Buffer.from("﻿Привет, мир", "utf16le");
    expect(prepareTextFile("a.txt", new Uint8Array(bytes))).toMatchObject({
      ok: true,
      encoding: "UTF-16 LE",
      text: "Привет, мир",
    });
  });

  it("falls back to Windows-1251 for legacy Russian files, with a note", () => {
    // "Привет" in cp1251
    const bytes = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const r = prepareTextFile("a.txt", bytes);
    expect(r).toMatchObject({ ok: true, encoding: "Windows-1251", text: "Привет" });
    expect(r.ok && r.notes[0]).toMatch(/Windows-1251/);
  });

  it("rejects binary data", () => {
    const r = prepareTextFile("a.txt", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01]));
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/binary/i);
  });

  it.each([".epub", ".pdf", ".docx", ".zip"])("explains unsupported %s files", (ext) => {
    const r = prepareTextFile(`book${ext}`, utf8("x"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.length).toBeGreaterThan(20);
  });

  it("rejects unknown extensions, empty and oversized files, and whitespace-only text", () => {
    expect(prepareTextFile("a.xyz", utf8("hi"))).toMatchObject({ ok: false });
    expect(prepareTextFile("noext", utf8("hi"))).toMatchObject({ ok: false });
    expect(prepareTextFile("a.txt", new Uint8Array())).toMatchObject({ ok: false });
    expect(prepareTextFile("a.txt", new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(97))).toMatchObject({ ok: false });
    expect(prepareTextFile("a.txt", utf8("   \n\n  "))).toMatchObject({ ok: false });
  });

  it("rejects chapters over the character limit with the real numbers", () => {
    const r = prepareTextFile("a.txt", utf8("a".repeat(MAX_CHAPTER_CHARS + 1)));
    expect(!r.ok && r.error).toMatch(/400,001/);
  });

  it("converts Markdown to plain text", () => {
    const r = prepareTextFile("a.md", utf8("# Title\n\nSome **bold** and *italic* with a [link](http://x.y).\n\n---\n\n> quote"));
    expect(r.ok && r.text).toBe("Title\n\nSome bold and italic with a link.\n\n* * *\n\nquote");
  });
});

describe("markdownToText", () => {
  it("keeps snake_case words and multiplication stars intact", () => {
    expect(markdownToText("use snake_case_name and 2 * 3 * 4")).toBe("use snake_case_name and 2 * 3 * 4");
  });
  it("strips front matter and images", () => {
    expect(markdownToText("---\ntitle: x\n---\nBody ![alt](i.png) end")).toBe("Body  end");
  });
});

describe("validateChapterText", () => {
  it("accepts normal text", () => expect(validateChapterText("Hello world.")).toBeNull());
  it("rejects empty, NUL, too long and garbled text", () => {
    expect(validateChapterText("  ")).toMatch(/empty/i);
    expect(validateChapterText("a\u0000b")).toMatch(/binary/i);
    expect(validateChapterText("a".repeat(MAX_CHAPTER_CHARS + 1))).toMatch(/limit/);
    expect(validateChapterText("�".repeat(50) + "text")).toMatch(/garbled/);
  });
  it("tolerates a stray replacement character", () => {
    expect(validateChapterText(`${"All good here. ".repeat(100)}� stray`)).toBeNull();
  });
});
