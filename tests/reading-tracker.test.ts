import { describe, expect, it } from "vitest";
import { pickAnchor, scrollBoundary, scrollDeltaToRestore, type BlockRect } from "@/lib/reading-tracker";

// Ten 100px paragraphs with 20px gaps, starting 200px below the top of the page.
const page = (scrollY: number): BlockRect[] =>
  Array.from({ length: 10 }, (_, i) => ({ index: i, top: 200 + i * 120 - scrollY, bottom: 300 + i * 120 - scrollY }));
const TOP = 58; // sticky header

describe("scrollBoundary: what is above the top edge is read, the rest is not", () => {
  it("at the top of the chapter nothing is read", () => {
    expect(scrollBoundary(page(0), TOP)).toBe(-1);
  });

  it("a paragraph fully above the edge is read; the one crossing the edge and everything below are not", () => {
    // scrollY 440: block 2 spans 0..100-ish (top 0,bottom 100) -> crosses the edge; blocks 0 and 1 are above
    const rects = page(440);
    expect(rects[1].bottom).toBeLessThan(TOP);
    expect(rects[2].bottom).toBeGreaterThan(TOP);
    expect(scrollBoundary(rects, TOP)).toBe(1);
  });

  it("opening a chapter halfway: only the preceding blocks count", () => {
    expect(scrollBoundary(page(200 + 5 * 120 - TOP), TOP)).toBe(4); // block 5 starts at the edge
  });

  it("the safety margin keeps a just-scrolled-off paragraph out", () => {
    const rects = page(200 + 3 * 120 - TOP + 100 + 10); // block 3 ended 10px above the edge... block 2 well above
    expect(scrollBoundary(rects, TOP, 0)).toBe(3);
    expect(scrollBoundary(rects, TOP, 24)).toBe(2);
  });

  it("scrolling back lowers the boundary, forward raises it", () => {
    expect(scrollBoundary(page(700), TOP)).toBeGreaterThan(scrollBoundary(page(300), TOP));
    expect(scrollBoundary(page(300), TOP)).toBeLessThan(scrollBoundary(page(700), TOP));
  });

  it("past the end of the text everything is read; nothing measured fails closed", () => {
    expect(scrollBoundary(page(5000), TOP)).toBe(9);
    expect(scrollBoundary([], TOP)).toBe(-1);
  });

  it("depends on block order, not on the order the rectangles were measured", () => {
    expect(scrollBoundary([...page(440)].reverse(), TOP)).toBe(scrollBoundary(page(440), TOP));
  });

  it("a layout change that pushes content down can only lower the boundary (never advance it)", () => {
    const before = scrollBoundary(page(600), TOP);
    const taller = page(600).map((r) => ({ ...r, top: r.top + 80, bottom: r.bottom + 80 })); // e.g. an image loaded above
    expect(scrollBoundary(taller, TOP)).toBeLessThanOrEqual(before);
  });
});

describe("anchors keep the reader on the same paragraph when the layout changes", () => {
  it("picks the first block that reaches below the edge, with its offset", () => {
    expect(pickAnchor(page(440), TOP)).toEqual({ index: 2, offset: page(440)[2].top - TOP });
    expect(pickAnchor([], TOP)).toBeNull();
  });

  it("computes the scroll needed to put that block back", () => {
    const a = pickAnchor(page(440), TOP)!;
    expect(scrollDeltaToRestore(a, a.offset + TOP + 90, TOP)).toBe(90);
  });
});
