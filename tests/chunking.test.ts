import { describe, expect, it } from "vitest";
import { chunkText, cleanText, countWords, extractTerms } from "@/lib/chunking";

describe("chunkText", () => {
  it("returns nothing for blank text", () => expect(chunkText("   \n ")).toEqual([]));

  it("keeps chunks near the target size and loses no words", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ` + "word ".repeat(40)).join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 1500)).toBe(true);
    expect(countWords(chunks.join(" "))).toBe(countWords(text));
  });

  it("splits oversized paragraphs and hard-cuts unbroken text", () => {
    expect(chunkText("Sentence one. ".repeat(300)).every((c) => c.length <= 1500)).toBe(true);
    expect(chunkText("x".repeat(5000)).every((c) => c.length <= 1400)).toBe(true);
  });

  it("handles Cyrillic and CJK punctuation", () => {
    expect(chunkText("Привет мир. Как дела? ".repeat(200)).length).toBeGreaterThan(1);
    expect(chunkText("これは文です。".repeat(300)).length).toBeGreaterThan(0);
  });
});

describe("cleanText", () => {
  it("normalises newlines, NULs and blank-line runs", () => {
    expect(cleanText("a\r\n\r\n\r\n\r\nb\u0000 \n")).toBe("a\n\nb");
  });
});

describe("extractTerms", () => {
  it("keeps only letters/digits (safe to embed in a tsquery) and drops stopwords", () => {
    const t = extractTerms("Who is Mira's teacher; DROP TABLE x -- 'quoted' & | ! ( )?");
    expect(t).toEqual(["mira", "teacher", "drop", "table", "quoted"]);
    expect(t.every((w) => /^[\p{L}\p{N}]+$/u.test(w))).toBe(true);
  });
  it("caps the number of terms and de-duplicates", () => {
    const q = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ") + " word1 word1";
    const t = extractTerms(q);
    expect(t.length).toBe(12);
    expect(new Set(t).size).toBe(12);
  });
  it("supports non-Latin scripts", () => {
    expect(extractTerms("Кто такая Мира?")).toContain("мира");
  });
});
