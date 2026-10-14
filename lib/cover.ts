import { imageUrl } from "./chapter-content";

/**
 * Which cover a book shows. Pure, so the rules are easy to test:
 *
 *  1. a cover the user chose (books.cover_image_id) always wins and is never overwritten;
 *  2. else a linked cover URL (from a metadata import);
 *  3. else the cover of the MOST RECENTLY IMPORTED volume that has one
 *     ("most recent" = latest successful import timestamp, not the highest volume number,
 *     and not the volume most recently read);
 *  4. else nothing: the UI draws its generated placeholder.
 *
 * Volumes whose import has not finished (imported_at is null) are ignored, so a failed or
 * in-progress import never changes the cover.
 */
export type CoverBook = { id: string; cover_image_id: string | null; cover_url: string | null };
export type CoverVolume = { imported_at: string | null; cover_image_id: string | null };

export function latestVolumeCoverId(volumes: CoverVolume[]): string | null {
  let best: CoverVolume | null = null;
  for (const v of volumes) {
    if (!v.imported_at || !v.cover_image_id) continue;
    if (!best || Date.parse(v.imported_at) > Date.parse(best.imported_at!)) best = v;
  }
  return best?.cover_image_id ?? null;
}

export type CoverSource = "manual" | "linked" | "volume" | "none";

export function resolveCover(book: CoverBook, volumes: CoverVolume[]): { src: string | null; source: CoverSource } {
  if (book.cover_image_id) return { src: imageUrl(book.id, book.cover_image_id), source: "manual" };
  if (book.cover_url) return { src: book.cover_url, source: "linked" };
  const fromVolume = latestVolumeCoverId(volumes);
  if (fromVolume) return { src: imageUrl(book.id, fromVolume), source: "volume" };
  return { src: null, source: "none" };
}
