import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { validateUsername } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";

const MIME: Record<string, string> = { webp: "image/webp", jpg: "image/jpeg" };

/**
 * Streams an avatar: the signed-in user's own, or (with ?u=<username>) a FRIEND's.
 *
 * Your own comes from your profile row. A friend's path comes from friend_avatar_path, a database function that
 * answers only for confirmed friends, and the private Storage bucket only lets friends read each other's avatar
 * files, so there is no way to fetch a stranger's picture. The page adds ?v=<file id>, which changes with every new
 * avatar, so the browser can keep each one for a year.
 */
export async function GET(req: Request) {
  const user = await getUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const supabase = await createClient();
  const asked = new URL(req.url).searchParams.get("u");
  let path: string | null | undefined;
  if (asked) {
    const name = validateUsername(asked);
    if (!name.ok) return new NextResponse(null, { status: 404 });
    const { data } = await supabase.rpc("friend_avatar_path", { p_username: name.username });
    path = typeof data === "string" ? data : null;
  } else {
    const { data: row } = await supabase.from("profiles").select("avatar_path").eq("id", user.id).maybeSingle();
    path = row?.avatar_path as string | null | undefined;
  }
  if (!path) return new NextResponse(null, { status: 404 });

  const { data: blob, error } = await supabase.storage.from("book-images").download(path);
  if (error || !blob) return new NextResponse(null, { status: 404 });

  const ext = path.split(".").pop() ?? "";
  return new NextResponse(blob, {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });
}
