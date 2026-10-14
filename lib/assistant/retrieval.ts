import { extractTerms } from "../chunking";
import type { SourcePassage } from "./types";

const MAX_PASSAGE_CHARS = 1_500;
const MIN_USEFUL_CHARS = 300;

const tokens = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
};

/**
 * Picks what goes to the model from what the database returned (already inside the reading boundary):
 *  - best-ranked first, up to a passage count and a total character budget;
 *  - near-duplicates dropped;
 *  - each passage capped in length;
 *  - then put in reading order so the numbering [1], [2]… follows the story.
 * Never reads anything the database did not return, so it cannot widen the boundary.
 */
export function selectPassages(
  passages: SourcePassage[],
  opts: { maxPassages: number; contextChars: number },
): SourcePassage[] {
  const kept: { p: SourcePassage; t: Set<string> }[] = [];
  let used = 0;

  for (const p of [...passages].sort((a, b) => b.rank - a.rank)) {
    if (kept.length >= opts.maxPassages) break;
    const content = p.content.trim().slice(0, MAX_PASSAGE_CHARS);
    if (!content) continue;
    const t = tokens(content);
    if (kept.some((k) => jaccard(k.t, t) >= 0.8)) continue; // near-duplicate

    const remaining = opts.contextChars - used;
    if (remaining < MIN_USEFUL_CHARS && kept.length > 0) break;
    const fitted = content.length > remaining ? content.slice(0, Math.max(remaining, MIN_USEFUL_CHARS)).trimEnd() : content;
    kept.push({ p: { ...p, content: fitted }, t });
    used += fitted.length;
  }

  return kept.map((k) => k.p).sort((a, b) => a.chapter_number - b.chapter_number || b.rank - a.rank);
}

// Words that carry no subject on their own ("what happened next?"): a question made only of these is a follow-up.
const WEAK_TERMS = new Set(
  "happened happen happens next then after afterwards later before did does done make made says said say tell told explain describe happen going goes went would could still also really actually exactly".split(" "),
);

/** How many words of real subject a question has (names, objects, places…). */
export const subjectTermCount = (question: string) => extractTerms(question).filter((t) => !WEAK_TERMS.has(t)).length;

/**
 * Search terms for a question. A follow-up such as "What happened to her next?" has no subject words of its
 * own, so the previous questions' words are used instead, and retrieval runs again for the new question.
 * (The terms only select passages inside the reading boundary; they are never shown to the model.)
 */
export function buildSearchTerms(question: string, previousQuestions: string[] = []): string[] {
  const own = extractTerms(question);
  const strong = own.filter((t) => !WEAK_TERMS.has(t));
  if (strong.length >= 2 || previousQuestions.length === 0) return own;

  const seen = new Set(strong);
  for (const prev of [...previousQuestions].reverse()) {
    for (const t of extractTerms(prev)) {
      if (seen.size >= 12) break;
      if (!WEAK_TERMS.has(t)) seen.add(t);
    }
    if (seen.size >= 4) break;
  }
  return seen.size > 0 ? [...seen] : own;
}
