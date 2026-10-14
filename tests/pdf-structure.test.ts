import { describe, expect, it } from "vitest";
import type { ParsedChapter } from "@/lib/epub";
import { mergeAll, mergeWithPrevious, renameChapter, restat, splitAtPage } from "@/lib/pdf-structure";

const text = (t: string, page: number) => ({ type: "text" as const, text: t, page });
const image = (ref: string, page: number) => ({ type: "image" as const, ref, alt: null, page });

const base = (): ParsedChapter[] => [
  restat({ title: "Chapter 1", frontMatter: false, blocks: [text("one two", 1), image("i1", 2), text("three", 3)] }),
  restat({ title: "Chapter 2", frontMatter: false, blocks: [text("four five six", 4), text("seven", 5)] }),
];

describe("restat", () => {
  it("recomputes words, images and the page range", () => {
    expect(base()[0]).toMatchObject({ wordCount: 3, imageCount: 1, pageStart: 1, pageEnd: 3 });
  });
});

describe("editing the detected structure", () => {
  it("renames without touching the rest, and never mutates the input", () => {
    const input = base();
    const out = renameChapter(input, 1, "The Real Title");
    expect(out[1].title).toBe("The Real Title");
    expect(out[0].title).toBe("Chapter 1");
    expect(input[1].title).toBe("Chapter 2");
  });

  it("merges a chapter onto the previous one, keeping order, images and the combined page range", () => {
    const out = mergeWithPrevious(base(), 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Chapter 1", wordCount: 7, imageCount: 1, pageStart: 1, pageEnd: 5 });
    expect(out[0].blocks.map((b) => b.type)).toEqual(["text", "image", "text", "text", "text"]);
  });

  it("ignores merging the first chapter or an invalid index", () => {
    expect(mergeWithPrevious(base(), 0)).toHaveLength(2);
    expect(mergeWithPrevious(base(), 9)).toHaveLength(2);
  });

  it("imports the whole file as one chapter on request", () => {
    const out = mergeAll(base(), "Whole volume");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Whole volume", wordCount: 7, imageCount: 1 });
  });

  it("splits at a page boundary, keeping every block exactly once and in order", () => {
    const r = splitAtPage(base(), 0, 3, "Part two");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chapters.map((c) => c.title)).toEqual(["Chapter 1", "Part two", "Chapter 2"]);
    expect(r.chapters[0].blocks.map((b) => b.page)).toEqual([1, 2]);
    expect(r.chapters[1].blocks.map((b) => b.page)).toEqual([3]);
    const all = r.chapters.flatMap((c) => c.blocks);
    expect(all).toHaveLength(base().flatMap((c) => c.blocks).length);
    expect(r.chapters[0]).toMatchObject({ imageCount: 1, wordCount: 2 });
  });

  it("gives a default title for the new part", () => {
    const r = splitAtPage(base(), 1, 5);
    expect(r.ok && r.chapters[2].title).toBe("Chapter 2 (continued)");
  });

  it("refuses splits that make no sense, with a helpful message", () => {
    const msg = (r: ReturnType<typeof splitAtPage>) => (r.ok ? "" : r.error);
    expect(msg(splitAtPage(base(), 0, 1))).toMatch(/between 2 and 3/); // at the very first page
    expect(msg(splitAtPage(base(), 0, 9))).toMatch(/between 2 and 3/);
    expect(msg(splitAtPage(base(), 0, 2.5))).toMatch(/whole page/);
    expect(msg(splitAtPage(base(), 7, 2))).toMatch(/doesn't exist/);
    const noPages = [restat({ title: "EPUB chapter", frontMatter: false, blocks: [{ type: "text", text: "no page info" }] })];
    expect(msg(splitAtPage(noPages, 0, 2))).toMatch(/no page information/);
  });
});
