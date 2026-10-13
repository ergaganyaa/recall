/**
 * The spoiler boundary rules (pure, so they can be unit-tested).
 *
 * `existing` is the last chapter the reader FINISHED. Search and the assistant
 * may only see chapters <= that value.
 *
 * - "advance" (automatic: reached the end of a chapter / pressed Next):
 *   only moves the boundary forward by exactly one chapter. Finishing chapter
 *   40 while the boundary is 35 must NOT unlock 36–39, which the reader may
 *   have skipped, or the assistant could spoil them.
 * - "set" (explicit: "Read through here"): the reader's own statement; may go
 *   up or down.
 */
export function computeBoundary(args: {
  existing: number;
  chapter: number;
  /** highest chapter number in the book */
  max: number;
  mode: "advance" | "set";
}): { lastRead: number; changed: boolean; skippedAhead: boolean } {
  const existing = Math.max(0, args.existing);
  const target = Math.min(Math.max(0, Math.trunc(args.chapter)), Math.max(0, args.max));

  if (args.mode === "set") {
    return { lastRead: target, changed: target !== existing, skippedAhead: false };
  }
  // A chapter that doesn't exist can never finish; don't clamp it into a real advance.
  if (args.chapter > args.max) return { lastRead: existing, changed: false, skippedAhead: false };
  if (target <= existing) return { lastRead: existing, changed: false, skippedAhead: false };
  if (target === existing + 1) return { lastRead: target, changed: true, skippedAhead: false };
  return { lastRead: existing, changed: false, skippedAhead: true };
}
