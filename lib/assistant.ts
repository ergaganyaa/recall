import type { Passage } from "./types";

/**
 * The answer step. Today it is EXTRACTIVE: it shows the best-matching passages
 * the reader has already read, with chapter citations, and invents nothing.
 *
 * To add an LLM later, replace the body of this function with a server-side
 * call that is given ONLY `passages` (already filtered to the reading
 * boundary by the database) and instructed to answer from them or say it
 * cannot. Nothing else in the pipeline needs to change.
 */
export function composeAnswer(args: {
  passages: Passage[];
  boundary: number;
  hasAnyText: boolean;
}): string {
  const { passages, boundary, hasAnyText } = args;

  if (boundary === 0) {
    return "You haven't finished any chapters yet, so I have nothing I can safely draw on. Finish a chapter (or use “Mark read through here”) and ask again.";
  }
  if (!hasAnyText) {
    return "This book has no chapter text in Recall yet. Add chapter text (paste or upload) so I can search what you've read.";
  }
  if (passages.length === 0) {
    return `I couldn't find anything relevant in the chapters you've read (through chapter ${boundary}). It may not have come up yet — or try different keywords.`;
  }

  const lines = passages.map(
    (p) => `Ch. ${p.chapter_number} — ${p.chapter_title}\n“${trim(p.content, 420)}”`,
  );
  return [
    `Here are the most relevant passages from chapters 1–${boundary} (nothing later is searched):`,
    ...lines,
  ].join("\n\n");
}

function trim(s: string, max: number) {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}
