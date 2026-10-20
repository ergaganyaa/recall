/**
 * Turning what the reader highlighted into paragraph (block) numbers. Pure, so it is unit-tested.
 *
 * Only the NUMBERS and a short quote are sent to the server. The server re-reads the paragraphs from the chapter
 * itself (selection_context), refuses anything it should not use, and ignores the quote unless it really occurs in
 * the paragraphs it read. So nothing here grants access to anything.
 */
export const MAX_SELECTION_BLOCKS = 3;
export const MAX_QUOTE_CHARS = 500;

export type SelectionRange = { from: number; to: number; clipped: boolean };

/** The paragraphs from the one where the highlight starts to the one where it ends, at most three. */
export function selectionRange(anchorBlock: number | null, focusBlock: number | null): SelectionRange | null {
  if (anchorBlock === null || focusBlock === null || !Number.isInteger(anchorBlock) || !Number.isInteger(focusBlock)) return null;
  if (anchorBlock < 0 || focusBlock < 0) return null;
  const from = Math.min(anchorBlock, focusBlock);
  const last = Math.max(anchorBlock, focusBlock);
  const to = Math.min(last, from + MAX_SELECTION_BLOCKS - 1);
  return { from, to, clipped: to < last };
}

/** The highlighted text, tidied and shortened for the question box and the server's check. */
export const tidyQuote = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE_CHARS);
