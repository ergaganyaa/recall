import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { ALLOWED_IMAGE_TYPES, EXTENSION_FOR } from "@/lib/image-sniff";
import { isUuid } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { timed } from "@/lib/timing";

const notFound = () => new NextResponse(null, { status: 404 });
const MIME_FOR_EXT = new Map(ALLOWED_IMAGE_TYPES.map((m) => [EXTENSION_FOR[m], m]));

const respond = (blob: Blob, mime: string) =>
  new NextResponse(blob, {
    headers: {
      "Content-Type": mime,
      // Image ids are unique and never reused, so the bytes behind a URL never change.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });

/**
 * Streams a private illustration to its owner. Access is enforced by row level security on book_images and by
 * the Storage policy (an object is only readable under the owner's folder), never by this code alone.
 *
 * Fast path: the reader already knows each picture's file type and passes it as ?e=. The object path is then
 * built from the VERIFIED user id (never from the request), so the only possible target is the caller's own
 * folder, and one Storage download is the only network call. Without it (covers), the type is looked up first.
 */
export async function GET(req: Request, ctx: RouteContext<"/library/[bookId]/image/[imageId]">) {
  const { bookId, imageId } = await ctx.params;
  if (!isUuid(bookId) || !isUuid(imageId)) return notFound();

  const user = await getUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const supabase = await createClient();
  const ext = new URL(req.url).searchParams.get("e");
  const mime = ext ? MIME_FOR_EXT.get(ext) : undefined;

  if (mime) {
    const { data: blob, error } = await timed("image: download", () =>
      supabase.storage.from("book-images").download(`${user.id}/${bookId}/${imageId}.${ext}`),
    );
    if (!error && blob) return respond(blob, mime);
    // Not there under that type (stale link): fall through to the lookup below.
  }

  const { data: row } = await timed("image: lookup", async () =>
    supabase.from("book_images").select("storage_path,mime_type").eq("id", imageId).eq("book_id", bookId).maybeSingle(),
  );
  if (!row) return notFound();

  const { data: blob, error } = await timed("image: download", () => supabase.storage.from("book-images").download(row.storage_path as string));
  if (error || !blob) return notFound();
  return respond(blob, row.mime_type as string);
}
