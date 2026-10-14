import { describe, expect, it } from "vitest";
import {
  bodyHeightOf,
  buildLines,
  buildParagraphs,
  classifyHeading,
  findRunningLines,
  looksLikeChapterHeading,
  type Line,
  type RawItem,
} from "@/lib/pdf-layout";

const item = (str: string, x: number, y: number, h = 12, w = str.length * 6): RawItem => ({ str, x, y, width: w, height: h });

describe("buildLines", () => {
  it("orders top to bottom, left to right and joins fragments on one line", () => {
    const lines = buildLines([item("world", 60, 100), item("second line", 10, 130), item("Hello", 10, 100)]);
    expect(lines.map((l) => l.text)).toEqual(["Hello world", "second line"]);
  });
  it("does not insert a space inside CJK text", () => {
    expect(buildLines([item("これは", 10, 50, 12, 36), item("文です", 46, 50, 12, 36)])[0].text).toBe("これは文です");
  });
  it("ignores empty fragments", () => {
    expect(buildLines([item("", 0, 10), item("  ", 0, 30)])).toEqual([]);
  });
});

describe("buildParagraphs", () => {
  const L = (text: string, y: number, x = 50, xEnd = 350, height = 12): Line => ({ text, x, xEnd, y, height });

  it("joins wrapped lines and starts a paragraph on a bigger gap", () => {
    const p = buildParagraphs([L("first line of one", 100), L("second line of one.", 114), L("A new paragraph.", 150)], 12);
    expect(p.map((x) => x.text)).toEqual(["first line of one second line of one.", "A new paragraph."]);
  });
  it("starts a paragraph on a first-line indent", () => {
    const p = buildParagraphs([L("Full line one ends here.", 100), L("Indented start of next.", 114, 70), L("continues.", 128)], 12);
    expect(p).toHaveLength(2);
  });
  it("de-hyphenates words split across lines", () => {
    const p = buildParagraphs([L("a long exam-", 100), L("ple of wrapping", 114)], 12);
    expect(p[0].text).toBe("a long example of wrapping");
  });
  it("treats much larger text as its own heading paragraph", () => {
    const p = buildParagraphs([L("Chapter 2", 100, 50, 200, 26), L("Body text starts here and goes on.", 140)], 12);
    expect(p[0]).toMatchObject({ text: "Chapter 2", heading: true });
    expect(p[1].heading).toBe(false);
  });
  it("never lets a paragraph span an illustration", () => {
    const p = buildParagraphs([L("Before the picture continues", 100), L("after the picture", 214)], 12, { breaks: [150] });
    expect(p).toHaveLength(2);
  });
});

describe("running headers, footers and page numbers", () => {
  const page = (n: number): { lines: Line[]; height: number } => ({
    height: 600,
    lines: [
      { text: "Sample Title - Volume 1", x: 50, xEnd: 300, y: 20, height: 9 },
      { text: "Real content here", x: 50, xEnd: 300, y: 300, height: 12 },
      { text: String(n), x: 190, xEnd: 200, y: 580, height: 9 },
    ],
  });
  it("drops repeated margin lines and numbers but keeps body text", () => {
    const drops = findRunningLines([1, 2, 3, 4, 5].map(page));
    for (const d of drops) expect([...d].sort()).toEqual([0, 2]);
  });
  it("drops a lone page number even with few pages", () => {
    const [d] = findRunningLines([page(7)]);
    expect(d.has(2)).toBe(true);
    expect(d.has(1)).toBe(false);
  });
});

describe("chapter headings", () => {
  it.each(["Chapter 1", "Chapter 12: The Lantern Room", "Prologue", "Epilogue", "Afterword", "Глава 3. Новый день", "第三章 旅立ち", "Interlude"])(
    "recognises %s",
    (t) => expect(looksLikeChapterHeading(t)).toBe(true),
  );
  it.each(["The chapter was long and tedious, and nobody enjoyed it.", "He said hello.", "", "Chapters of my life are many and varied across the years"])(
    "rejects %s",
    (t) => expect(looksLikeChapterHeading(t)).toBe(false),
  );
  it("does not mistake ordinary sentences that begin with a section word for headings", () => {
    for (const sentence of ["Opening text of the chapter.", "Ending the call, she sighed.", "Introduction to the sample.", "Preface was never read by anyone."]) {
      expect(looksLikeChapterHeading(sentence), sentence).toBe(false);
    }
  });
  it("still accepts real section titles, with or without a subtitle or number", () => {
    for (const title of ["Prologue", "Prologue.", "Epilogue: The Last Day", "Interlude 2", "Afterword", "Side Story - The Rooftop"]) {
      expect(looksLikeChapterHeading(title), title).toBe(true);
    }
  });
  it("accepts a short large-font first-on-page title but not a sentence or body-size text", () => {
    const big = { text: "The Lantern Room", y: 80, height: 24, x: 50, heading: true };
    expect(classifyHeading(big, { bodyHeight: 12, firstOnPage: true })).toBe("large-font");
    expect(classifyHeading(big, { bodyHeight: 12, firstOnPage: false })).toBeNull();
    expect(classifyHeading({ ...big, height: 12, heading: false }, { bodyHeight: 12, firstOnPage: true })).toBeNull();
    expect(classifyHeading({ ...big, text: "This is a whole sentence." }, { bodyHeight: 12, firstOnPage: true })).toBeNull();
  });
  it("computes body size as the median line height", () => {
    const l = (height: number): Line => ({ text: "x", x: 0, xEnd: 1, y: 0, height });
    expect(bodyHeightOf([l(12), l(12), l(30)])).toBe(12);
  });
});
