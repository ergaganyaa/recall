import { DOMParser } from "linkedom";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { EpubError, parseEpub, resolvePath } from "@/lib/epub";
import { sniffImage } from "@/lib/image-sniff";
import { buildEpub, fakeJpeg, fakePng } from "./helpers/epub-fixture";

const parse = (bytes: Uint8Array) => parseEpub(bytes, { DOMParser: DOMParser as never });

describe("parseEpub — metadata", () => {
  const v = parse(buildEpub());
  it("reads title, author, language and a decimal series index", () => {
    expect(v).toMatchObject({ author: "Test Author", language: "en", seriesName: "Sample Series", seriesIndex: 4.5 });
    expect(v.title).toMatch(/Sample Volume/);
  });
  it("finds the cover image", () => {
    expect(v.coverRef).toBe("OEBPS/images/cover.png");
    expect(v.images.get("OEBPS/images/cover.png")).toMatchObject({ mime: "image/png", width: 800, height: 1200 });
  });
  it("ignores a non-numeric series index", () => {
    expect(parse(buildEpub({ seriesIndex: "abc" })).seriesIndex).toBeNull();
  });
});

describe("parseEpub — chapters and order", () => {
  const v = parse(buildEpub());
  it("keeps colour plates before chapter one as front matter, in order", () => {
    expect(v.chapters.map((c) => c.title)).toEqual([
      "Front matter and illustrations", // the cover page (before the first TOC entry)
      "Illustrations",
      "The Lantern Room",
      "Part A",
      "Part B",
      "Wordless Page",
    ]);
    expect(v.chapters[0].frontMatter).toBe(true);
  });

  it("splits one file into two chapters at TOC anchors", () => {
    const a = v.chapters.find((c) => c.title === "Part A")!;
    const b = v.chapters.find((c) => c.title === "Part B")!;
    expect(a.blocks.map((x) => (x.type === "text" ? x.text : "[img]"))).toEqual(["Alpha paragraph one.", "Alpha paragraph two."]);
    expect(b.blocks.map((x) => (x.type === "text" ? x.text : "[img]"))).toEqual(["Beta paragraph one."]);
  });

  it("drops the heading that merely repeats the chapter title", () => {
    const ch = v.chapters.find((c) => c.title === "The Lantern Room")!;
    expect(ch.blocks[0]).toEqual({ type: "text", text: "The first paragraph of the original sample chapter." });
  });

  it("removes ruby annotations but keeps the base text, and normalises nbsp", () => {
    const ch = v.chapters.find((c) => c.title === "The Lantern Room")!;
    const texts = ch.blocks.flatMap((b) => (b.type === "text" ? [b.text] : []));
    expect(texts).toContain("漢字 stays readable after the annotation is dropped.");
    expect(texts).toContain("Text that follows the sketch. It uses a non-breaking space.");
    expect(texts.join(" ")).not.toMatch(/kan\b/);
  });

  it("counts words and images per chapter", () => {
    const ch = v.chapters.find((c) => c.title === "The Lantern Room")!;
    expect(ch.imageCount).toBe(1);
    expect(ch.wordCount).toBeGreaterThan(10);
  });
});

describe("parseEpub — illustrations", () => {
  const v = parse(buildEpub());

  it("places an inline image exactly between the paragraphs around it", () => {
    const ch = v.chapters.find((c) => c.title === "The Lantern Room")!;
    expect(ch.blocks.map((b) => b.type)).toEqual(["text", "text", "image", "text"]);
    const img = ch.blocks[2];
    expect(img).toMatchObject({ type: "image", ref: "OEBPS/images/inline.png", alt: "An inline sketch" });
  });

  it("keeps SVG-wrapped and plain colour plates in reading order", () => {
    const plates = v.chapters.find((c) => c.title === "Illustrations")!;
    expect(plates.blocks.map((b) => (b.type === "image" ? b.ref.split("/").pop() : "text"))).toEqual(["plate1.png", "plate2.jpg"]);
    const cover = v.chapters[0];
    expect(cover.blocks).toEqual([{ type: "image", ref: "OEBPS/images/cover.png", alt: null }]);
  });

  it("does not discard an image-only chapter even though it has no text", () => {
    const ch = v.chapters.find((c) => c.title === "Wordless Page")!;
    expect(ch.wordCount).toBe(0);
    expect(ch.imageCount).toBe(1);
    expect(ch.blocks).toHaveLength(1);
  });

  it("records pixel sizes so the reader keeps the aspect ratio", () => {
    expect(v.images.get("OEBPS/images/plate1.png")).toMatchObject({ width: 1200, height: 800 });
    expect(v.images.get("OEBPS/images/plate2.jpg")).toMatchObject({ mime: "image/jpeg", width: 900, height: 1300 });
  });
});

describe("parseEpub — other structures and failures", () => {
  it("supports EPUB 2 NCX tables of contents", () => {
    const v = parse(buildEpub({ toc: "ncx" }));
    expect(v.chapters.map((c) => c.title)).toContain("Part B");
  });

  it("falls back to one chapter per file when there is no table of contents", () => {
    const v = parse(buildEpub({ toc: "none" }));
    expect(v.chapters.length).toBeGreaterThanOrEqual(3);
    expect(v.warnings.join(" ")).toMatch(/no usable table of contents/);
  });

  it("rejects things that are not EPUBs, with readable messages", () => {
    expect(() => parse(strToU8("definitely not a zip"))).toThrow(EpubError);
    expect(() => parse(zipSync({ "hello.txt": strToU8("hi") }))).toThrow(/package file/);
  });

  it("skips unsupported or web-linked images with a warning instead of failing", () => {
    const files = {
      "META-INF/container.xml": strToU8(`<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>`),
      "c.opf": strToU8(
        `<package><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`,
      ),
      "a.xhtml": strToU8(
        `<html><body><h1>Only</h1><p>Real text here.</p><img src="http://example.com/x.png"/><img src="bad.gif"/></body></html>`,
      ),
      "bad.gif": strToU8("this is not an image at all"),
    };
    const v = parse(zipSync(files));
    // The first heading became the chapter title, so it is not repeated in the body.
    expect(v.chapters[0].title).toBe("Only");
    expect(v.chapters[0].blocks).toEqual([{ type: "text", text: "Real text here." }]);
    expect(v.warnings.join(" ")).toMatch(/linked from the web/);
    expect(v.warnings.join(" ")).toMatch(/isn't a supported image/);
  });

  it("never invents content: every block comes from the file", () => {
    const v = parse(buildEpub());
    const all = v.chapters.flatMap((c) => c.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])));
    expect(all.every((t) => t.length > 0)).toBe(true);
    expect(v.chapters.reduce((n, c) => n + c.imageCount, 0)).toBe(5);
  });
});

describe("resolvePath", () => {
  it("resolves relative references inside the archive and cannot escape it", () => {
    expect(resolvePath("OEBPS/text/ch1.xhtml", "../images/a.png")).toBe("OEBPS/images/a.png");
    expect(resolvePath("OEBPS/text/ch1.xhtml", "./b.png#frag")).toBe("OEBPS/text/b.png");
    expect(resolvePath("a/b.xhtml", "../../../../etc/passwd")).toBe("etc/passwd");
    expect(resolvePath("a/b.xhtml", "%E3%81%82.png")).toBe("a/あ.png");
  });
});

describe("sniffImage", () => {
  it("identifies by bytes, not by name, and rejects non-images", () => {
    expect(sniffImage(fakePng(10, 20))).toEqual({ mime: "image/png", width: 10, height: 20 });
    expect(sniffImage(fakeJpeg(30, 40))).toEqual({ mime: "image/jpeg", width: 30, height: 40 });
    expect(sniffImage(strToU8("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull(); // SVG is refused
    expect(sniffImage(strToU8("<html>not an image at all</html>"))).toBeNull();
  });
});
