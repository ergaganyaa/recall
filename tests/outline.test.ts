import { describe, expect, it } from "vitest";
import { analyzeOutline, describeOutline, MAX_OUTLINE_CHAPTERS } from "@/lib/outline";

describe("analyzeOutline", () => {
  it("parses # headings and chapter titles", () => {
    const a = analyzeOutline("# Volume 1: A\nOne\nTwo\n# Volume 2\nThree\n\n");
    expect(a.groups).toEqual([
      { heading: true, title: "Volume 1: A", chapters: ["One", "Two"] },
      { heading: true, title: "Volume 2", chapters: ["Three"] },
    ]);
    expect(a.chapterCount).toBe(3);
    expect(a.volumeCount).toBe(2);
  });

  it("treats a plain list as heading-less chapters", () => {
    const a = analyzeOutline("A\nB\r\nC");
    expect(a.groups).toEqual([{ heading: false, title: null, chapters: ["A", "B", "C"] }]);
    expect(a.volumeCount).toBe(0);
  });

  it("recognises 'Volume N' style heading lines and strips the prefix", () => {
    const a = analyzeOutline("Volume 1: The Broken Gear\nOne\nVol. 2 - Tides\nTwo\nТом 3\nThree");
    expect(a.groups.map((g) => g.title)).toEqual(["The Broken Gear", "Tides", null]);
    expect(a.groups.every((g) => g.heading)).toBe(true);
  });

  it("does not mistake chapter titles for volume headings", () => {
    const a = analyzeOutline("Volume of Secrets\nThe Book Thief\nBooks and Bones");
    expect(a.volumeCount).toBe(0);
    expect(a.chapterCount).toBe(3);
  });

  it("strips bullets and ignores blank lines, BOM and CRLF", () => {
    const a = analyzeOutline("﻿- One\r\n\r\n* Two\r\n• Three");
    expect(a.groups[0].chapters).toEqual(["One", "Two", "Three"]);
  });

  it("keeps chapters before the first heading in an implicit group", () => {
    const a = analyzeOutline("Prologue\n# Volume 1\nOne");
    expect(a.groups[0]).toEqual({ heading: false, title: null, chapters: ["Prologue"] });
    expect(a.groups[1].heading).toBe(true);
  });

  it("warns about empty volumes and drops them", () => {
    const a = analyzeOutline("# Empty\n# Real\nOne");
    expect(a.groups).toHaveLength(1);
    expect(a.warnings.join(" ")).toMatch(/Empty/);
  });

  it("shortens very long titles with a warning", () => {
    const a = analyzeOutline("x".repeat(500));
    expect(a.groups[0].chapters[0]).toHaveLength(300);
    expect(a.warnings.join(" ")).toMatch(/shortened/);
  });

  it("flags more chapters than the limit", () => {
    const text = Array.from({ length: MAX_OUTLINE_CHAPTERS + 1 }, (_, i) => `Ch ${i}`).join("\n");
    expect(analyzeOutline(text).warnings.join(" ")).toMatch(String(MAX_OUTLINE_CHAPTERS));
  });

  it("describes the result", () => {
    expect(describeOutline(analyzeOutline(""))).toMatch(/No chapters/);
    expect(describeOutline(analyzeOutline("# V\nA\nB"))).toBe("1 volume · 2 chapters");
    expect(describeOutline(analyzeOutline("A"))).toBe("1 chapter");
  });
});
