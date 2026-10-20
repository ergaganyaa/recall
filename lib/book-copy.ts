import { mapLimit } from "./concurrency";

export type FileToCopy = { from: string; to: string; mime: string };

/** The slice of Supabase Storage this needs, so it can be tested with a stand-in. */
export type StorageLike = {
  download(path: string): Promise<{ data: Blob | null; error: unknown }>;
  upload(path: string, body: Blob, options: { contentType: string; upsert: boolean }): Promise<{ error: unknown }>;
  remove(paths: string[]): Promise<unknown>;
};

export const COPY_CONCURRENCY = 4;

/**
 * Copies picture files from a friend's folder to your own, a few at a time. The paths come from the database
 * function that already checked the friendship and that the book is shared; storage permissions apply on top.
 * If any file fails, every file already written is removed again and the caller deletes the copied book, so a
 * failed add leaves nothing behind.
 */
export async function copyFiles(
  storage: StorageLike,
  files: FileToCopy[],
  limit = COPY_CONCURRENCY,
): Promise<{ ok: true } | { ok: false; uploaded: string[] }> {
  const uploaded: string[] = [];
  const settled = await mapLimit(files, limit, async (f) => {
    const { data, error } = await storage.download(f.from);
    if (error || !data) throw new Error("download failed");
    const up = await storage.upload(f.to, data, { contentType: f.mime, upsert: false });
    if (up.error) throw new Error("upload failed");
    uploaded.push(f.to);
  });
  if (settled.some((s) => s.status === "rejected")) {
    if (uploaded.length) await storage.remove(uploaded).catch(() => undefined);
    return { ok: false, uploaded };
  }
  return { ok: true };
}
