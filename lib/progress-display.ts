import { contentKind } from "./chapter-content";

export type ProgressSummary = {
  finished: number;
  total: number;
  /** Chapters that actually have text or illustrations (the rest are catalog entries only). */
  withContent: number;
  /** 0–100. Reaches 100 only when the data really supports "completed". */
  percent: number;
  /** True only when every chapter is finished, every chapter has content, and the reader marked the book completed. */
  complete: boolean;
  /** Short explanation shown next to the number, or null when none is needed. */
  note: string | null;
};

/**
 * Honest progress. Percentages are measured against the chapters Recall actually
 * knows about, and never claim 100% unless that is justified:
 *  - chapters without any content (metadata-only) mean the catalog is not fully imported;
 *  - an "ongoing" or unmarked book may have volumes that were not imported at all.
 * So 100% needs: all chapters finished + all have content + status "completed".
 */
export function summarizeProgress(args: {
  chapters: { word_count: number; image_count: number }[];
  lastRead: number;
  status: string;
}): ProgressSummary {
  const total = args.chapters.length;
  const withContent = args.chapters.filter((c) => contentKind(c) !== "metadata_only").length;
  const finished = Math.min(Math.max(0, Math.trunc(args.lastRead)), total);

  if (total === 0) {
    return { finished: 0, total: 0, withContent: 0, percent: 0, complete: false, note: "No chapters imported yet" };
  }

  const raw = (finished / total) * 100;
  const allFinished = finished === total;
  const allHaveContent = withContent === total;
  const complete = allFinished && allHaveContent && args.status === "completed";

  const percent = complete ? 100 : Math.min(99, Math.floor(raw));

  let note: string | null = "of imported chapters";
  if (allFinished && !allHaveContent) note = `All listed chapters read · ${total - withContent} not imported yet`;
  else if (allFinished && !complete) note = "All imported chapters read · more volumes may exist";
  else if (!allHaveContent) note = `of listed chapters · ${total - withContent} not imported yet`;

  return { finished, total, withContent, percent, complete, note };
}
