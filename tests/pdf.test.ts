import { beforeAll, describe, expect, it } from "vitest";
import { inspectPdf, parsePdf, PdfError, PDF_MAX_BYTES, type PdfOptions, type PdfJsLike } from "@/lib/pdf";
import { sniffImage } from "@/lib/image-sniff";
import { artPng, bodyLines, loadPdfJsForTests, makePdf, nodeCanvas } from "./helpers/pdf-fixture";

let pdfjs: PdfJsLike;
const opts = (): PdfOptions => ({ pdfjs, canvas: nodeCanvas });
beforeAll(async () => {
  pdfjs = await loadPdfJsForTests();
});

const texts = (blocks: { type: string; text?: string }[]) => blocks.filter((b) => b.type === "text").map((b) => b.text);
const kinds = (blocks: { type: string }[]) => blocks.map((b) => b.type);

// Original sample sentences (no third-party text).
const P = (n: number) => [
  `This is sample paragraph ${n} written for the automated tests.`,
  `It wraps over a second line so that line joining is exercised too.`,
];

describe("1. text PDF with several chapters", () => {
  it("detects chapter headings, keeps order, and removes running headers and page numbers", async () => {
    const page = (title: string, n: number, pageNo: number) => ({
      lines: [
        { text: "Sample Series - Volume 1", y: 575, size: 9 },
        { text: title, y: 520, size: 26, bold: true },
        ...bodyLines([...P(n), "", ...P(n + 1)].filter(Boolean), 470),
        { text: String(pageNo), x: 195, y: 20, size: 9 },
      ],
    });
    const bytes = await makePdf([page("Chapter 1", 1, 1), page("Chapter 2", 3, 2), page("Chapter 3", 5, 3), page("Chapter 4", 7, 4)], {
      title: "Sample Volume",
      author: "Test Author",
    });

    const v = await parsePdf(bytes, opts());
    expect(v.structure).toBe("headings");
    expect(v.chapters.map((c) => c.title)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"]);
    expect(v.title).toBe("Sample Volume");
    expect(v.author).toBe("Test Author");
    expect(v.pageCount).toBe(4);

    const all = v.chapters.flatMap((c) => texts(c.blocks)).join("\n");
    expect(all).not.toMatch(/Sample Series - Volume/); // running header
    expect(texts(v.chapters[0].blocks).join(" ")).toContain("sample paragraph 1");
    expect(texts(v.chapters[2].blocks).join(" ")).toContain("sample paragraph 5");
    expect(texts(v.chapters[0].blocks).some((t) => /^\d$/.test(t ?? ""))).toBe(false); // page number
    expect(v.chapters.every((c) => c.pageStart !== undefined && c.pageEnd !== undefined)).toBe(true);
    expect(v.chapters[1].pageStart).toBe(2);
  });

  it("falls back to one chapter when no headings exist", async () => {
    const bytes = await makePdf([{ lines: bodyLines(P(1)) }, { lines: bodyLines(P(2)) }]);
    const v = await parsePdf(bytes, opts());
    expect(v.structure).toBe("single");
    expect(v.chapters).toHaveLength(1);
    expect(v.warnings.join(" ")).toMatch(/one chapter/);
  });

  it("joins a paragraph that continues across a page break", async () => {
    const bytes = await makePdf([
      { lines: [{ text: "A sentence that is split across two pages and continues", y: 90 }] },
      { lines: [{ text: "onto the next page without any break.", y: 540 }] },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(texts(v.chapters[0].blocks)).toEqual([
      "A sentence that is split across two pages and continues onto the next page without any break.",
    ]);
  });
});

describe("2. text with illustrations between paragraphs", () => {
  it("places the picture exactly between the paragraphs, keeping its aspect ratio", async () => {
    const bytes = await makePdf([
      {
        lines: [
          ...bodyLines(["Paragraph before the picture sits above it."], 520),
          { text: "Paragraph after the picture sits below it.", y: 200 },
        ],
        images: [{ png: artPng(600, 400, 1), x: 100, y: 300, width: 240, height: 160 }],
      },
    ]);
    const v = await parsePdf(bytes, opts());
    const blocks = v.chapters[0].blocks;
    expect(kinds(blocks)).toEqual(["text", "image", "text"]);
    const img = blocks[1] as { ref: string };
    const stored = v.images.get(img.ref)!;
    expect(stored.width! / stored.height!).toBeCloseTo(240 / 160, 1); // 3:2 preserved
    expect(sniffImage(stored.bytes)).toMatchObject({ mime: expect.stringMatching(/image\/(png|jpeg)/) });
  });

  it("keeps a picture that really is used on two different pages (repeats in the body are the book's own layout)", async () => {
    const same = artPng(400, 300, 2);
    const page = (t: string) => ({
      lines: bodyLines([t], 540),
      images: [{ png: same, x: 80, y: 250, width: 240, height: 180 }],
    });
    const v = await parsePdf(await makePdf([page("First page text with a picture."), page("Second page text, same picture.")]), opts());
    expect(v.chapters.flatMap((c) => c.blocks).filter((b) => b.type === "image")).toHaveLength(2);
    expect(v.imageStats).toMatchObject({ found: 2, kept: 2, duplicates: 0 });
  });

  it("imports a picture painted twice in the same place only once", async () => {
    const art = artPng(400, 300, 3);
    const bytes = await makePdf([
      {
        lines: bodyLines(["A paragraph above the doubled picture."], 540),
        images: [
          { png: art, x: 80, y: 250, width: 240, height: 180 },
          { png: art, x: 80, y: 250, width: 240, height: 180 },
        ],
      },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(v.chapters[0].blocks.filter((b) => b.type === "image")).toHaveLength(1);
    expect(v.imageStats).toMatchObject({ found: 2, kept: 1, duplicates: 1 });
  });

  it("skips a page-sized scan layer only when it sits behind a FULL page of selectable text, and says so", async () => {
    const fullPage = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a dense page of text produced for the automated tests here.`);
    const bytes = await makePdf([
      { images: [{ png: artPng(400, 600, 3), x: 0, y: 0, width: 400, height: 600 }], lines: bodyLines(fullPage, 560, 14) },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(kinds(v.chapters[0].blocks)).toEqual(["text"]);
    expect(v.warnings.join(" ")).toMatch(/background/i);
    expect(v.imageStats).toMatchObject({ found: 1, kept: 0, backgrounds: 1 });
  });

  it("keeps a page-sized illustration that has only a short caption", async () => {
    const bytes = await makePdf([
      { lines: bodyLines(["Text before the full page illustration."], 520) },
      { images: [{ png: artPng(400, 600, 3), x: 0, y: 0, width: 400, height: 600 }], lines: [{ text: "A short caption printed on the picture", y: 40 }] },
      { lines: bodyLines(["Text after the full page illustration."], 520) },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(kinds(v.chapters[0].blocks)).toEqual(["text", "image", "text", "text"]);
    expect(v.imageStats).toMatchObject({ found: 1, kept: 1, backgrounds: 0 });
  });

  it("ignores tiny decorations such as bullets and rules", async () => {
    const bytes = await makePdf([
      { lines: bodyLines(P(1), 500), images: [{ png: artPng(30, 30, 4), x: 20, y: 300, width: 12, height: 12 }] },
    ]);
    expect(kinds((await parsePdf(bytes, opts())).chapters[0].blocks)).toEqual(["text"]);
  });
});

describe("3. first page is the cover", () => {
  it("uses the first-page picture as the cover with its aspect ratio", async () => {
    const bytes = await makePdf([
      { images: [{ png: artPng(400, 600, 5), x: 0, y: 0, width: 400, height: 600 }] },
      { lines: [{ text: "Chapter 1", y: 520, size: 26, bold: true }, ...bodyLines(P(1), 470)] },
      { lines: [{ text: "Chapter 2", y: 520, size: 26, bold: true }, ...bodyLines(P(2), 470)] },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(v.coverRef).toBeTruthy();
    const cover = v.images.get(v.coverRef!)!;
    expect(cover.width! / cover.height!).toBeCloseTo(400 / 600, 1);
    expect(cover.width).toBeLessThanOrEqual(900); // thumbnail-sized
    expect(v.coverCandidates![0].label).toMatch(/page 1/i);
    // The cover page also remains in the reading content as front matter, with its own image copy.
    expect(v.chapters[0].frontMatter).toBe(true);
    expect(v.chapters[0].imageCount).toBe(1);
    expect(v.coverRef).not.toBe((v.chapters[0].blocks[0] as { ref: string }).ref);
  });
});

describe("4. image-only pages are kept", () => {
  it("renders a picture-only page as an image between the text around it", async () => {
    const bytes = await makePdf([
      { lines: [{ text: "Chapter 1", y: 520, size: 26, bold: true }, ...bodyLines(P(1), 470)] },
      { images: [{ png: artPng(400, 600, 1), x: 0, y: 0, width: 400, height: 600 }] },
      { lines: bodyLines(P(2), 520) },
    ]);
    const v = await parsePdf(bytes, opts());
    const ch = v.chapters.find((c) => c.title === "Chapter 1")!;
    expect(kinds(ch.blocks)).toEqual(["text", "image", "text"]);
    const img = ch.blocks[1] as { ref: string; alt: string; page: number };
    expect(img.page).toBe(2);
    expect(img.alt).toBe("Page 2");
    expect(v.images.get(img.ref)!.width! / v.images.get(img.ref)!.height!).toBeCloseTo(400 / 600, 1);
  });

  it("does not turn a plate into text and does not extract it twice", async () => {
    const bytes = await makePdf([
      { lines: bodyLines(P(1), 520) },
      { images: [{ png: artPng(400, 600, 2), x: 0, y: 0, width: 400, height: 600 }] },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(v.chapters.flatMap((c) => c.blocks).filter((b) => b.type === "image")).toHaveLength(1);
  });
});

describe("5. scanned PDF without selectable text", () => {
  const scanned = async () =>
    makePdf(Array.from({ length: 5 }, (_, i) => ({ images: [{ png: artPng(400, 600, i), x: 0, y: 0, width: 400, height: 600 }] })));

  it("is detected, explained, and never imported as blank text", async () => {
    const bytes = await scanned();
    const info = await inspectPdf(bytes, opts());
    expect(info).toMatchObject({ pageCount: 5, textPages: 0, picturePages: 5, scanned: true });

    const err = await parsePdf(bytes, opts()).catch((e) => e);
    expect(err).toBeInstanceOf(PdfError);
    expect(err.code).toBe("needs_ocr");
    expect(err.message).toMatch(/OCR/);
    expect(err.message).toMatch(/import the pages as images/i);
  });

  it("can be imported as page images when explicitly requested, with no invented text", async () => {
    const v = await parsePdf(await scanned(), { ...opts(), mode: "pages-as-images" });
    expect(v.scanned).toBe(true);
    expect(v.ocrAvailable).toBe(false);
    const blocks = v.chapters.flatMap((c) => c.blocks);
    expect(blocks).toHaveLength(5);
    expect(blocks.every((b) => b.type === "image")).toBe(true);
    expect(v.chapters.reduce((n, c) => n + c.wordCount, 0)).toBe(0);
    expect(blocks.map((b) => b.page)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("6. empty or unsuitable first page", () => {
  it("skips a blank first page and a logo-only page when choosing the cover", async () => {
    const bytes = await makePdf([
      {}, // blank
      { images: [{ png: artPng(80, 80, 4), x: 160, y: 260, width: 60, height: 60 }] }, // small publisher-style logo
      { images: [{ png: artPng(300, 400, 0), x: 50, y: 100, width: 300, height: 400 }] }, // real illustration
      { lines: [{ text: "Chapter 1", y: 520, size: 26, bold: true }, ...bodyLines(P(1), 470)] },
    ]);
    const v = await parsePdf(bytes, opts());
    expect(v.coverCandidates![0].label).toMatch(/page 3/i);
    const cover = v.images.get(v.coverRef!)!;
    expect(cover.width! / cover.height!).toBeCloseTo(300 / 400, 1); // the illustration's own shape
    expect(v.warnings.join(" ")).toMatch(/empty page|blank/i);
  });

  it("falls back to a rendered page when no picture qualifies as a cover", async () => {
    const v = await parsePdf(await makePdf([{ lines: bodyLines(P(1), 520) }]), opts());
    expect(v.coverRef).toBeTruthy();
    expect(v.coverCandidates![0].label).toMatch(/rendered/i);
  });
});

describe("errors", () => {
  it("reports a damaged file", async () => {
    const err = await parsePdf(new TextEncoder().encode("this is definitely not a pdf at all, just words"), opts()).catch((e) => e);
    expect(err).toBeInstanceOf(PdfError);
    expect(err.code).toBe("corrupt");
  });

  it("reports an empty file and an all-blank PDF without crashing", async () => {
    expect(await parsePdf(new Uint8Array(), opts()).catch((e) => e)).toBeInstanceOf(PdfError);
    const blank = await parsePdf(await makePdf([{}, {}]), opts()).catch((e) => e);
    expect(blank).toBeInstanceOf(PdfError);
    expect(blank.message).toMatch(/blank|no readable/i);
  });

  it("rejects an oversized file before reading it", async () => {
    const fake = { byteLength: PDF_MAX_BYTES + 1 } as unknown as Uint8Array;
    const err = await parsePdf(fake, opts()).catch((e) => e);
    expect(err.code).toBe("too_large");
    expect(err.message).toMatch(/limit/);
  });

  it("explains password-protected PDFs", async () => {
    const fakePdfjs: PdfJsLike = {
      OPS: {},
      getDocument: () => ({
        promise: Promise.reject(Object.assign(new Error("No password given"), { name: "PasswordException" })),
        destroy: async () => {},
      }),
    };
    const err = await parsePdf(new Uint8Array(10), { ...opts(), pdfjs: fakePdfjs }).catch((e) => e);
    expect(err.code).toBe("encrypted");
    expect(err.message).toMatch(/password/i);
  });

  it("stops promptly when cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await parsePdf(await makePdf([{ lines: bodyLines(P(1)) }]), { ...opts(), signal: ac.signal }).catch((e) => e);
    expect(err.code).toBe("cancelled");
  });
});
