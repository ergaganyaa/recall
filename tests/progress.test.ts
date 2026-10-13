import { describe, expect, it } from "vitest";
import { computeBoundary } from "@/lib/progress";

const adv = (existing: number, chapter: number, max = 100) => computeBoundary({ existing, chapter, max, mode: "advance" });
const set = (existing: number, chapter: number, max = 100) => computeBoundary({ existing, chapter, max, mode: "set" });

describe("computeBoundary — automatic advance", () => {
  it("moves forward by exactly one chapter", () => {
    expect(adv(35, 36)).toEqual({ lastRead: 36, changed: true, skippedAhead: false });
    expect(adv(0, 1)).toMatchObject({ lastRead: 1, changed: true });
  });

  it("never unlocks skipped chapters when the reader jumps ahead", () => {
    expect(adv(35, 40)).toEqual({ lastRead: 35, changed: false, skippedAhead: true });
    expect(adv(0, 80)).toMatchObject({ lastRead: 0, skippedAhead: true });
  });

  it("never moves backwards when re-reading older chapters", () => {
    expect(adv(35, 10)).toEqual({ lastRead: 35, changed: false, skippedAhead: false });
    expect(adv(35, 35)).toMatchObject({ lastRead: 35, changed: false });
  });

  it("ignores chapters that don't exist, and can finish the last chapter", () => {
    expect(adv(9, 99, 10)).toEqual({ lastRead: 9, changed: false, skippedAhead: false });
    expect(adv(9, 10, 10)).toMatchObject({ lastRead: 10, changed: true });
  });
});

describe("computeBoundary — explicit set", () => {
  it("can raise or lower the boundary", () => {
    expect(set(10, 40)).toMatchObject({ lastRead: 40, changed: true });
    expect(set(40, 12)).toMatchObject({ lastRead: 12, changed: true });
    expect(set(40, 0)).toMatchObject({ lastRead: 0, changed: true });
  });
  it("clamps to the book and to zero", () => {
    expect(set(0, 500, 20).lastRead).toBe(20);
    expect(set(5, -3).lastRead).toBe(0);
  });
  it("reports no change when it is already there", () => {
    expect(set(7, 7).changed).toBe(false);
  });
});
