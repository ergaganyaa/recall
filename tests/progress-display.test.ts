import { describe, expect, it } from "vitest";
import { summarizeProgress } from "@/lib/progress-display";

const full = { word_count: 500, image_count: 0 };
const pic = { word_count: 0, image_count: 3 };
const none = { word_count: 0, image_count: 0 };

const sum = (chapters: { word_count: number; image_count: number }[], lastRead: number, status = "reading") =>
  summarizeProgress({ chapters, lastRead, status });

describe("summarizeProgress — never claims 100% without support", () => {
  it("shows 100% only when all finished, all have content, and the book is marked completed", () => {
    expect(sum([full, full], 2, "completed")).toMatchObject({ percent: 100, complete: true });
  });

  it("caps at 99% when everything imported is read but the book isn't marked completed (more volumes may exist)", () => {
    const s = sum([full, full], 2, "reading");
    expect(s).toMatchObject({ percent: 99, complete: false });
    expect(s.note).toMatch(/more volumes may exist/);
  });

  it("caps at 99% when some chapters are catalog-only, even if marked completed", () => {
    const s = sum([full, none], 2, "completed");
    expect(s).toMatchObject({ percent: 99, complete: false });
    expect(s.note).toMatch(/1 not imported/);
  });

  it("floors rather than rounds, so 199/200 is 99% not 100%", () => {
    const chapters = Array.from({ length: 200 }, () => full);
    expect(sum(chapters, 199).percent).toBe(99);
    expect(sum(chapters, 100).percent).toBe(50);
  });

  it("counts illustration-only chapters as real content", () => {
    expect(sum([full, pic], 2, "completed")).toMatchObject({ percent: 100, withContent: 2 });
  });

  it("handles an empty catalog and out-of-range progress", () => {
    expect(sum([], 5)).toMatchObject({ percent: 0, total: 0, finished: 0 });
    expect(sum([full, full], 99).finished).toBe(2);
    expect(sum([full, full], -4).finished).toBe(0);
  });

  it("is 0% before any chapter is finished and explains partial imports", () => {
    const s = sum([full, none, none], 0);
    expect(s.percent).toBe(0);
    expect(s.note).toMatch(/2 not imported/);
  });
});
