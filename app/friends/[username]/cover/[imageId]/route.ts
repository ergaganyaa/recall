import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { validateUsername } from "@/lib/profile";
import { isUuid } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

const notFound = () => new NextResponse(null, { status: 404 });

/**
 * Streams a FRIEND's book or volume cover. friend_cover is a database function that answers only for a confirmed
 * friend who shares their library, and only for cover images (never chapter illustrations); the private Storage
 * bucket enforces the same rule on the file itself. For anyone else this is a plain 404.
 */
export async function GET(_req: Request, ctx: RouteContext<"/friends/[username]/cover/[imageId]">) {
  const { username, imageId } = await ctx.params;
  const name = validateUsername(decodeURIComponent(username));
  if (!name.ok || !isUuid(imageId)) return notFound();

  const user = await getUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const supabase = await createClient();
  const { data } = await supabase.rpc("friend_cover", { p_username: name.username, p_image_id: imageId });
  const found = data as { path?: string; mime?: string } | null;
  if (!found?.path || !found.mime) return notFound();

  const { data: blob, error } = await supabase.storage.from("book-images").download(found.path);
  if (error || !blob) return notFound();
  return new NextResponse(blob, {
    headers: {
      "Content-Type": found.mime,
      "Cache-Control": "private, max-age=86400", // not immutable: access can end when the friendship does
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });
}
