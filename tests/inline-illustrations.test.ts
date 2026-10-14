import { DOMParser } from "linkedom";
import { beforeAll, describe, expect, it } from "vitest";
import { foldInlineIllustrationChapters } from "@/lib/chapter-merge";
import { parseEpub, type ParsedBlock, type ParsedChapter } from "@/lib/epub";
import { parsePdf, type PdfJsLike, type PdfOptions } from "@/lib/pdf";
import { restat } from "@/lib/pdf-structure";
import { buildInlineEpub } from "./helpers/epub-inline-fixture";
import { bodyLines, lineArt, loadPdfJsForTests, makePdf, nodeCanvas } from "./helpers/pdf-fixture";

const epub = () => parseEpub(buildInlineEpub(), { DOMParser: DOMParser as never });
const pattern = (blocks: ParsedBlock[]) => blocks.map((b) => (b.type === "text" ? "T" : `I:${b.ref.split("/").pop()!.replace(".png", "")}`));
const imageRefs = (blocks: ParsedBlock[]) => blocks.flatMap((b) => (b.type === "image" ? [b.ref.split("/").pop()!.replace(".png", "")] : []));

describe("EPUB — illustrations stay inline", () => {
  const v = epub();
  const chapter = (title: string) => v.chapters.find((c) => c.title === title)!;

  it("1. several paragraphs and several inline illustrations keep their exact order, whatever wraps the picture", () => {
    // paragraph, div, link, and a picture in the MIDDLE of a sentence (which splits that paragraph at the picture)
    expect(pattern(chapter("Chapter One").blocks).slice(0, 11)).toEqual(["T", "I:a1", "T", "I:a2", "T", "I:a3", "T", "T", "I:a4", "T", "T"]);
    // figure, CSS background, SVG: all in place; the missing file is not among them
    expect(pattern(chapter("Chapter Two").blocks).slice(0, 9)).toEqual(["T", "I:b1", "T", "T", "I:b2", "T", "I:b3", "T", "T"]);
  });

  it("2. pictures before the first chapter stay represented as front matter and a named plate section", () => {
    expect(v.chapters[0]).toMatchObject({ title: "Front matter and illustrations", frontMatter: true, imageCount: 1 });
    expect(imageRefs(chapter("Color Illustrations").blocks)).toEqual(["plate1", "plate2"]);
  });

  it("3. a genuine named image-only section is still its own chapter", () => {
    expect(chapter("Bonus Illustrations")).toMatchObject({ wordCount: 0, imageCount: 2 });
    expect(chapter("Color Illustrations").wordCount).toBe(0);
  });

  it("3b. generic 'Illustration N' pages listed like chapters are folded into the chapter they follow, in order", () => {
    expect(v.chapters.map((c) => c.title)).not.toContain("Illustration 1");
    expect(v.chapters.map((c) => c.title)).not.toContain("Illustration 2");
    expect(imageRefs(chapter("Chapter One").blocks).at(-1)).toBe("ill1");
    expect(imageRefs(chapter("Chapter Two").blocks).at(-1)).toBe("ill2");
    expect(v.warnings.join(" ")).toMatch(/2 illustration pages listed like a chapter/);
  });

  it("4. nothing is lost silently: every picture reference is kept or counted under a reason", () => {
    const r = v.imageReport!;
    const skipped = r.skipped.reduce((n, s) => n + s.count, 0);
    // 15 references in the text; 14 kept; the missing file is reported. One unused file is reported separately.
    expect(r.found).toBe(15);
    expect(r.kept).toBe(14);
    expect(r.found - r.kept).toBe(r.skipped.find((s) => s.reason === "missing from the file")!.count);
    expect(skipped).toBe(2);
    expect(r.skipped.map((s) => s.reason)).toEqual(["missing from the file", "in the file but not placed on any page"]);
    expect(v.warnings.join(" ")).toMatch(/gone\.png/);
  });

  it("4b. no picture appears twice and every kept picture is referenced exactly once", () => {
    const all = v.chapters.flatMap((c) => imageRefs(c.blocks));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(v.imageReport!.kept);
    for (const ref of v.images.keys()) {
      if (ref !== v.coverRef) expect(v.chapters.some((c) => c.blocks.some((b) => b.type === "image" && b.ref === ref))).toBe(true);
    }
  });

  it("keeps each picture's real size so the reader can reserve the right aspect ratio", () => {
    const a1 = [...v.images.values()].find((i) => i.ref.endsWith("a1.png"))!;
    expect(a1.width! / a1.height!).toBeCloseTo(604 / 404, 3);
  });
});

describe("foldInlineIllustrationChapters", () => {
  const text = (title: string): ParsedChapter => restat({ title, frontMatter: false, blocks: [{ type: "text", text: "some words here" }] });
  const pic = (title: string, frontMatter = false): ParsedChapter =>
    restat({ title, frontMatter, blocks: [{ type: "image", ref: `${title}.png`, alt: null }] });

  it("folds only generic numbered labels that follow story text", () => {
    const out = foldInlineIllustrationChapters([text("Chapter 1"), pic("Illustration 1"), text("Chapter 2"), pic("Insert 2"), pic("Color Illustrations")]);
    expect(out.folded).toBe(2);
    expect(out.chapters.map((c) => c.title)).toEqual(["Chapter 1", "Chapter 2", "Color Illustrations"]);
    expect(out.chapters[0].imageCount).toBe(1);
    expect(out.chapters[0].blocks.map((b) => b.type)).toEqual(["text", "image"]);
  });

  it("never folds front matter or a picture page that precedes any story text", () => {
    const out = foldInlineIllustrationChapters([pic("Cover", true), pic("Illustration 1"), text("Chapter 1")]);
    expect(out.folded).toBe(0);
    expect(out.chapters).toHaveLength(3);
  });

  it("handles Russian and Japanese generic labels", () => {
    const out = foldInlineIllustrationChapters([text("Глава 1"), pic("Иллюстрация 3"), pic("挿絵 4")]);
    expect(out.folded).toBe(2);
  });
});

describe("PDF — illustrations stay inline", () => {
  let pdfjs: PdfJsLike;
  const opts = (): PdfOptions => ({ pdfjs, canvas: nodeCanvas });
  beforeAll(async () => {
    pdfjs = await loadPdfJsForTests();
  });
  const kinds = (blocks: ParsedBlock[]) => blocks.map((b) => (b.type === "text" ? "T" : "I"));
  const accounted = (s: { found: number; kept: number; decorations: number; duplicates: number; backgrounds: number; blank: number }) =>
    s.kept + s.decorations + s.duplicates + s.backgrounds + s.blank;

  it("1. a chapter with several paragraphs and several different line-art illustrations keeps order and every picture", async () => {
    const bytes = await makePdf([
      {
        lines: [
          { text: "Chapter 1", y: 540, size: 26, bold: true },
          ...bodyLines(["Paragraph one before the first picture."], 505),
          { text: "Paragraph two between the pictures.", y: 330 },
          { text: "Paragraph three after both pictures.", y: 90 },
        ],
        images: [
          { png: lineArt(600, 400, 4), x: 80, y: 380, width: 240, height: 120 },
          { png: lineArt(600, 400, 5), x: 80, y: 150, width: 240, height: 150 },
        ],
      },
      {
        lines: bodyLines(["Paragraph four on the next page, before another picture."], 540),
        images: [{ png: lineArt(500, 500, 6), x: 100, y: 250, width: 200, height: 200 }],
      },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(v.chapters).toHaveLength(1);
    expect(kinds(v.chapters[0].blocks)).toEqual(["T", "I", "T", "I", "T", "T", "I"]);
    expect(v.imageStats).toMatchObject({ found: 3, kept: 3 });
    expect(accounted(v.imageStats)).toBe(v.imageStats.found);
  });

  it("keeps every picture's own proportions", async () => {
    const bytes = await makePdf([
      { lines: bodyLines(["Intro paragraph before the wide picture."], 540), images: [{ png: lineArt(900, 300, 2), x: 50, y: 300, width: 300, height: 100 }] },
    ]);
    const v = await parsePdf(bytes, opts());
    const img = v.chapters[0].blocks.find((b) => b.type === "image") as { ref: string };
    const stored = v.images.get(img.ref)!;
    expect(stored.width! / stored.height!).toBeCloseTo(3, 1);
  });

  it("2. pictures before the first chapter are kept as front matter, and chapter pictures stay in their chapter", async () => {
    const bytes = await makePdf([
      { images: [{ png: lineArt(1200, 1800, 1), x: 0, y: 0, width: 400, height: 600 }] }, // cover page
      { images: [{ png: lineArt(1200, 1800, 2), x: 0, y: 0, width: 400, height: 600 }] }, // colour plate
      { lines: [{ text: "Chapter 1", y: 540, size: 26, bold: true }, ...bodyLines(["Opening paragraph of the first chapter here."], 505)], images: [{ png: lineArt(600, 400, 3), x: 80, y: 250, width: 240, height: 160 }] },
      { lines: [{ text: "Chapter 2", y: 540, size: 26, bold: true }, ...bodyLines(["Opening paragraph of the second chapter here."], 505)] },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(v.chapters.map((c) => c.title)).toEqual(["Front matter and illustrations", "Chapter 1", "Chapter 2"]);
    expect(v.chapters[0]).toMatchObject({ frontMatter: true, imageCount: 2, wordCount: 0 });
    expect(kinds(v.chapters[1].blocks)).toEqual(["T", "I"]);
    expect(v.chapters[2].imageCount).toBe(0);
  });

  it("3. image-only pages inside a chapter stay inside it (they do not become chapters)", async () => {
    const bytes = await makePdf([
      { lines: [{ text: "Chapter 1", y: 540, size: 26, bold: true }, ...bodyLines(["Text of the first chapter before the picture page."], 505)] },
      { images: [{ png: lineArt(1200, 1800, 4), x: 0, y: 0, width: 400, height: 600 }] },
      { lines: bodyLines(["Text of the first chapter after the picture page."], 540) },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(v.chapters).toHaveLength(1);
    expect(kinds(v.chapters[0].blocks)).toEqual(["T", "I", "T"]);
  });

  it("4. sparse line art, a spot illustration and a captioned full-page picture are all kept, none silently lost", async () => {
    const bytes = await makePdf([
      { lines: bodyLines(["Text on a page with a small spot illustration."], 540), images: [{ png: lineArt(300, 300, 2), x: 150, y: 400, width: 36, height: 36 }] },
      { images: [{ png: lineArt(1200, 1800, 3), x: 0, y: 0, width: 400, height: 600 }], lines: [{ text: "A short caption printed on the picture", y: 40 }] },
      { lines: bodyLines(["Text after the captioned illustration."], 540) },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(v.imageStats.found).toBe(2);
    expect(v.imageStats.kept).toBe(2);
    expect(accounted(v.imageStats)).toBe(v.imageStats.found);
  });

  it("4b. anything that IS skipped is counted and explained in the warnings", async () => {
    const bytes = await makePdf([
      {
        lines: bodyLines(["A paragraph with a tiny bullet picture beside it."], 540),
        images: [{ png: lineArt(60, 60, 1), x: 20, y: 300, width: 8, height: 8 }],
      },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(v.imageStats).toMatchObject({ found: 1, kept: 0, decorations: 1 });
    expect(v.warnings.join(" ")).toMatch(/tiny picture/);
    expect(accounted(v.imageStats)).toBe(v.imageStats.found);
  });

  it("does not promote an ordinary sentence that starts with a section word to a chapter title", async () => {
    const bytes = await makePdf([
      {
        lines: [
          { text: "Chapter 1", y: 540, size: 26, bold: true },
          ...bodyLines(["Opening text of the chapter."], 505),
          { text: "Introduction to the sample.", y: 470 },
        ],
      },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(v.chapters.map((c) => c.title)).toEqual(["Chapter 1"]);
    expect(texts(v.chapters[0].blocks).join(" ")).toContain("Opening text of the chapter.");
    expect(texts(v.chapters[0].blocks).join(" ")).toContain("Introduction to the sample.");
  });
});

function texts(blocks: ParsedBlock[]) {
  return blocks.flatMap((b) => (b.type === "text" ? [b.text] : []));
}
