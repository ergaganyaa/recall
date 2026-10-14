import { describe, expect, it } from "vitest";
import { chaptersFromTextSources, splitByHeadings } from "@/lib/text-import";

const texts = (c: { blocks: { type: string; text?: string }[] }) => c.blocks.map((b) => b.text);

describe("chaptersFromTextSources — several files", () => {
  it("orders files naturally (ch2 before ch10) and keeps one chapter per file", () => {
    const { chapters } = chaptersFromTextSources([
      { name: "ch10.txt", text: "Ten." },
      { name: "ch2.txt", text: "Two." },
      { name: "ch1.txt", text: "One." },
    ]);
    expect(chapters.map((c) => c.title)).toEqual(["ch1", "ch2", "ch10"]);
    expect(texts(chapters[1])).toEqual(["Two."]);
  });

  it("uses a leading Markdown heading as the title, otherwise the filename", () => {
    const { chapters } = chaptersFromTextSources([
      { name: "a.md", text: "# The Real Title\n\nBody one.\nBody two." },
      { name: "b_second_part.txt", text: "Plain body." },
    ]);
    expect(chapters[0].title).toBe("The Real Title");
    expect(texts(chapters[0])).toEqual(["Body one.", "Body two."]);
    expect(chapters[1].title).toBe("b second part");
  });
});

describe("chaptersFromTextSources — one file", () => {
  it("splits at Markdown headings and keeps text before the first one as front matter", () => {
    const { chapters } = chaptersFromTextSources([
      { name: "book.md", text: "Preface line.\n\n# One\nAlpha.\n\n## Two\nBeta.\nGamma." },
    ]);
    expect(chapters.map((c) => c.title)).toEqual(["Front matter", "One", "Two"]);
    expect(texts(chapters[2])).toEqual(["Beta.", "Gamma."]);
    expect(chapters[2].wordCount).toBe(2);
  });

  it("recognises 'Chapter N' and 'Глава N' lines in plain text", () => {
    const { chapters } = chaptersFromTextSources([
      { name: "b.txt", text: "Chapter 1 The Start\nHello there.\nГлава 2\nПривет мир." },
    ]);
    expect(chapters.map((c) => c.title)).toEqual(["Chapter 1 The Start", "Глава 2"]);
  });

  it("treats a file with no headings as a single chapter and says so", () => {
    const { chapters, warnings } = chaptersFromTextSources([{ name: "story.txt", text: "Just one block.\nAnd another." }]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("story");
    expect(warnings.join(" ")).toMatch(/single chapter/);
  });

  it("returns nothing for no sources, and drops empty chapters", () => {
    expect(chaptersFromTextSources([]).chapters).toEqual([]);
    expect(splitByHeadings("# Empty\n\n# Full\nText.")?.map((c) => c.title)).toEqual(["Full"]);
    expect(splitByHeadings("no headings here")).toBeNull();
  });

  it("never invents content: every block is a line from the source", () => {
    const src = "# A\nline one\nline two";
    const all = chaptersFromTextSources([{ name: "x.md", text: src }]).chapters.flatMap(texts);
    expect(all.every((t) => src.includes(t as string))).toBe(true);
  });
});
