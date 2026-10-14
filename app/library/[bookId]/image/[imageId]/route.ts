import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { isUuid } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

const notFound = () => new NextResponse(null, { status: 404 });

/**
 * Streams a private illustration to its owner. Access is checked twice: the
 * book_images row is only visible through row level security to its owner, and
 * the Storage object is only readable under the owner's folder.
 */
export async function GET(_req: Request, ctx: RouteContext<"/library/[bookId]/image/[imageId]">) {
  const { bookId, imageId } = await ctx.params;
  if (!isUuid(bookId) || !isUuid(imageId)) return notFound();

  const user = await getUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const supabase = await createClient();
  const { data: row } = await supabase
    .from("book_images")
    .select("storage_path,mime_type")
    .eq("id", imageId)
    .eq("book_id", bookId)
    .maybeSingle();
  if (!row) return notFound();

  const { data: blob, error } = await supabase.storage.from("book-images").download(row.storage_path as string);
  if (error || !blob) return notFound();

  return new NextResponse(blob, {
    headers: {
      "Content-Type": row.mime_type as string,
      // Image ids are unique and never reused, so the bytes behind a URL never change.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });
}
