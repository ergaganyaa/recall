/**
 * Pure geometry for the reading boundary. No DOM, so it is unit-tested.
 *
 * Core rule: everything above the top edge of the reading viewport is read; the first block that is still
 * (even partly) visible, and everything after it, is not. The boundary is the number of the last block above
 * that edge (-1 when nothing is). Positions are block numbers, never pixels, so a text-size or layout change
 * cannot corrupt them.
 */

export type BlockRect = { index: number; top: number; bottom: number };

/**
 * @param topEdge  y of the top of the reading area (below a sticky header)
 * @param margin   a block only counts as "above" once its bottom is this far above the edge, so the paragraph
 *                 that has only just scrolled off is not assumed finished
 */
export function scrollBoundary(rects: BlockRect[], topEdge: number, margin = 0): number {
  if (rects.length === 0) return -1; // nothing measured: fail closed
  const ordered = [...rects].sort((a, b) => a.index - b.index);
  const first = ordered.find((r) => r.bottom > topEdge - margin);
  // Every block is above the edge: the reader has scrolled past the end of the text.
  return first ? first.index - 1 : ordered[ordered.length - 1].index;
}

/** The block at the top of the reading area, and how far down it starts: enough to put the reader back exactly. */
export function pickAnchor(rects: BlockRect[], viewportTop: number): { index: number; offset: number } | null {
  const first = rects.filter((r) => r.bottom > viewportTop + 1).sort((a, b) => a.index - b.index)[0];
  return first ? { index: first.index, offset: first.top - viewportTop } : null;
}

/** How far to scroll so the anchor block sits where it did before the layout changed. */
export const scrollDeltaToRestore = (anchor: { offset: number }, newTop: number, viewportTop: number) => newTop - viewportTop - anchor.offset;
