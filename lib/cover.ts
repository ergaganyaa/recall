import { imageUrl } from "./chapter-content";

/**
 * Which cover a book shows (Home, library and the book page). Pure, so the rules are easy to test.
 *
 *  1. a cover the user chose (books.cover_image_id) always wins and is never overwritten;
 *  2. else the cover of the volume the user is reading (see readingVolumeIndex), or the nearest volume that has one;
 *  3. else a linked cover URL (from a metadata import);
 *  4. else nothing: the UI draws its generated placeholder.
 *
 * "The volume the user is reading" comes from THEIR OWN reading_progress.current_chapter, the chapter they last
 * opened to read, mapped to its volume through chapters.volume_id. It is not the most recently imported volume and
 * not the highest volume number. reading_progress has one row per user and book (row level security), so two
 * people reading the same book at different places each get their own cover. With no progress (or a progress that
 * points at nothing), the first volume in reading order is used.
 *
 * Volumes whose import has not finished (imported_at is null) never supply a cover, so a failed or in-progress
 * import cannot change it.
 */
export type CoverBook = { id: string; cover_image_id: string | null; cover_url: string | null };
export type CoverVolume = { id: string; number: number; arc_order: number; imported_at: string | null; cover_image_id: string | null };
export type CoverChapter = { number: number; volume_id: string | null };
/** Where the user is: their chapters (number and volume) and the chapter they last opened (null = no progress yet). */
export type ReadingPlace = { chapters: CoverChapter[]; currentChapter: number | null };

/** Reading order: arcs first, then volume number (4.5 sorts between 4 and 5). */
export const inReadingOrder = <V extends { arc_order: number; number: number }>(volumes: V[]) =>
  [...volumes].sort((a, b) => a.arc_order - b.arc_order || a.number - b.number);

/**
 * Index (in reading order) of the volume the user is reading, or 0 (the first volume) when there is no usable
 * progress. A chapter that belongs to no volume (or to a deleted one) uses the nearest EARLIER chapter that does.
 */
export function readingVolumeIndex(ordered: { id: string }[], place: ReadingPlace | undefined): number {
  if (!place || place.currentChapter === null || ordered.length === 0) return 0;
  const byId = new Map(ordered.map((v, i) => [v.id, i]));
  const earlier = place.chapters
    .filter((c) => c.number <= place.currentChapter!)
    .sort((a, b) => b.number - a.number);
  for (const c of earlier) {
    const i = c.volume_id ? byId.get(c.volume_id) : undefined;
    if (i !== undefined) return i;
  }
  return 0;
}

/**
 * The cover image id to show by default: the reading volume's, else the NEAREST volume that has one
 * (a tie goes to the earlier volume, so "preceding" is preferred over "following").
 */
export function defaultVolumeCoverId(volumes: CoverVolume[], place?: ReadingPlace): string | null {
  const ordered = inReadingOrder(volumes);
  if (ordered.length === 0) return null;
  const at = readingVolumeIndex(ordered, place);
  let best: { id: string; distance: number } | null = null;
  ordered.forEach((v, i) => {
    if (!v.imported_at || !v.cover_image_id) return;
    const distance = Math.abs(i - at);
    if (!best || distance < best.distance) best = { id: v.cover_image_id, distance }; // strict <: the earlier volume wins ties
  });
  return (best as { id: string } | null)?.id ?? null;
}

export type CoverSource = "manual" | "volume" | "linked" | "none";

/** Which cover applies, as an image id (for the caller to turn into a URL) or a linked URL. Same rules for everyone. */
export function chooseCover(
  book: CoverBook,
  volumes: CoverVolume[],
  place?: ReadingPlace,
): { imageId: string | null; url: string | null; source: CoverSource } {
  if (book.cover_image_id) return { imageId: book.cover_image_id, url: null, source: "manual" };
  const fromVolume = defaultVolumeCoverId(volumes, place);
  if (fromVolume) return { imageId: fromVolume, url: null, source: "volume" };
  if (book.cover_url) return { imageId: null, url: book.cover_url, source: "linked" };
  return { imageId: null, url: null, source: "none" };
}

export function resolveCover(
  book: CoverBook,
  volumes: CoverVolume[],
  place?: ReadingPlace,
): { src: string | null; source: CoverSource } {
  const c = chooseCover(book, volumes, place);
  return { src: c.imageId ? imageUrl(book.id, c.imageId) : c.url, source: c.source };
}

// ------------------------------------------------------------------ browsing volume covers

export type BrowserVolume = {
  id: string;
  number: number;
  arc_order: number;
  title: string | null;
  arc: string | null;
  imported_at: string | null;
  cover_image_id: string | null;
};
export type BrowserChapter = { number: number; volume_id: string | null };

export type VolumeCard = {
  id: string;
  number: number;
  title: string | null;
  arc: string | null;
  /** the volume's own cover image id (null = show the placeholder) */
  coverImageId: string | null;
  chapterCount: number;
  finishedCount: number;
  /** the volume the user is reading */
  isCurrent: boolean;
  /** where "Continue / Open volume" goes, and how to word it */
  target: { chapter: number | null; kind: "continue" | "resume" | "start" | "reread" | "empty" };
};

/**
 * One card per volume, in reading order, for the cover browser on the book page. Pure and read-only: choosing a
 * card in the browser never writes anything. The button only LINKS to a chapter, so the reader's normal rules
 * (progress, spoiler boundary) apply when it opens.
 *
 *  - the volume being read: its target is the saved chapter (the reader restores the exact position);
 *  - a volume partly finished: the first unfinished chapter in it;
 *  - a volume entirely finished: its first chapter ("read again");
 *  - a volume not started: its first chapter.
 */
export function volumeCards(args: {
  volumes: BrowserVolume[];
  chapters: BrowserChapter[];
  currentChapter: number | null;
  lastRead: number;
}): { cards: VolumeCard[]; currentIndex: number } {
  const ordered = inReadingOrder(args.volumes);
  const place: ReadingPlace = { chapters: args.chapters, currentChapter: args.currentChapter };
  const currentIndex = readingVolumeIndex(ordered, place);
  const started = args.currentChapter !== null && (args.lastRead > 0 || args.currentChapter > 1);

  const cards = ordered.map((v, i): VolumeCard => {
    const own = args.chapters.filter((c) => c.volume_id === v.id).sort((a, b) => a.number - b.number);
    const finished = own.filter((c) => c.number <= args.lastRead).length;
    const isCurrent = i === currentIndex && started;
    let target: VolumeCard["target"];
    if (own.length === 0) target = { chapter: null, kind: "empty" };
    else if (isCurrent && own.some((c) => c.number === args.currentChapter)) target = { chapter: args.currentChapter, kind: "continue" };
    else if (finished === own.length) target = { chapter: own[0].number, kind: "reread" };
    else if (finished > 0) target = { chapter: own[finished].number, kind: "resume" };
    else target = { chapter: own[0].number, kind: "start" };
    return {
      id: v.id,
      number: v.number,
      title: v.title,
      arc: v.arc,
      coverImageId: v.imported_at ? v.cover_image_id : null,
      chapterCount: own.length,
      finishedCount: finished,
      isCurrent,
      target,
    };
  });
  return { cards, currentIndex };
}
