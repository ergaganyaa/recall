"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { copyFiles } from "@/lib/book-copy";
import { validateUsername } from "@/lib/profile";
import { isUuid } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

const MIGRATE = "Run migration 0011_friends.sql in the Supabase SQL editor, then try again.";
const missing = (code?: string) => code === "42883" || code === "PGRST202";

/** What the database said when a friend request was sent, in words. */
const SENT: Record<string, { ok: boolean; message: string }> = {
  sent: { ok: true, message: "Friend request sent." },
  accepted: { ok: true, message: "You're now friends." },
  already_friends: { ok: true, message: "You're already friends." },
  already_requested: { ok: true, message: "A request is already open with that person." },
  self: { ok: false, message: "That's you." },
  not_found: { ok: false, message: "No one has that username." },
  need_username: { ok: false, message: "Choose a username on your profile first, so people can see who is asking." },
  too_many: { ok: false, message: "You have too many open requests. Wait for some to be answered." },
};

/** Ask someone to be friends, by username. Asking someone who already asked you makes you friends. */
export async function sendFriendRequest(username: string): Promise<ActionResult<{ message: string }>> {
  await requireUser();
  const name = validateUsername(username);
  if (!name.ok) return { ok: false, error: "No one has that username." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("send_friend_request", { p_username: name.username });
  if (error) return { ok: false, error: missing(error.code) ? MIGRATE : "Couldn't send the request. Please try again." };
  const answer = SENT[String(data)] ?? { ok: false, message: "Couldn't send the request. Please try again." };
  if (!answer.ok) return { ok: false, error: answer.message };
  revalidatePath("/friends");
  return { ok: true, data: { message: answer.message } };
}

/** Accept or decline a request that was sent to you. */
export async function respondToRequest(friendshipId: string, accept: boolean): Promise<ActionResult> {
  await requireUser();
  if (!isUuid(friendshipId)) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("respond_friend_request", { p_id: friendshipId, p_accept: accept === true });
  if (error) return { ok: false, error: missing(error.code) ? MIGRATE : "Couldn't answer the request. Please try again." };
  if (data === "not_found") return { ok: false, error: "That request is no longer open." };
  revalidatePath("/friends");
  return { ok: true, data: undefined };
}

/** Unfriend someone, or cancel a request you sent. Access to your profile and library ends at once. */
export async function removeFriend(friendshipId: string): Promise<ActionResult> {
  await requireUser();
  if (!isUuid(friendshipId)) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("remove_friendship", { p_id: friendshipId });
  if (error) return { ok: false, error: missing(error.code) ? MIGRATE : "Couldn't remove that. Please try again." };
  if (data !== true) return { ok: false, error: "That friendship no longer exists." };
  revalidatePath("/friends");
  revalidatePath("/friends/[username]", "page");
  return { ok: true, data: undefined };
}

/** Let friends see your library (titles, covers, progress counts), or hide it. Your profile stays visible to friends. */
export async function setLibrarySharing(share: boolean): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = z.boolean().safeParse(share);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("profiles").update({ share_library: parsed.data, updated_at: new Date().toISOString() }).eq("id", user.id).select("id");
  if (error) return { ok: false, error: error.code === "42703" ? MIGRATE : "Couldn't save that. Please try again." };
  if (!data || data.length === 0) return { ok: false, error: "Choose a username first." };
  revalidatePath("/profile");
  return { ok: true, data: undefined };
}

// ------------------------------------------------------------------------------------- sharing and adding novels
const MIGRATE_SHARE = "Run migration 0012_share_books.sql in the Supabase SQL editor, then try again.";

/** Allow friends to add a copy of one of YOUR novels (off by default), or stop allowing it. Existing copies stay theirs. */
export async function setBookShared(bookId: string, shared: boolean): Promise<ActionResult> {
  await requireUser();
  if (!isUuid(bookId) || typeof shared !== "boolean") return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  // Row level security: only the owner's own book can be updated.
  const { data, error } = await supabase.from("books").update({ shared_with_friends: shared }).eq("id", bookId).select("id");
  if (error) return { ok: false, error: error.code === "42703" ? MIGRATE_SHARE : "Couldn't save that. Please try again." };
  if (!data || data.length === 0) return { ok: false, error: "That novel wasn't found." };
  revalidatePath("/library/[bookId]", "page");
  revalidatePath("/profile");
  return { ok: true, data: undefined };
}

const copyShape = z.union([
  z.object({ error: z.string(), book_id: z.string().optional(), slug: z.string().optional() }),
  z.object({
    book_id: z.string(),
    slug: z.string(),
    images: z.array(z.object({ from: z.string(), to: z.string(), mime: z.string() })),
  }),
]);

const COPY_ERRORS: Record<string, string> = {
  not_found: "That novel isn't available to add. Ask your friend to share it.",
  too_large: "That novel is too large to add (over 3000 chapters or 400 pictures).",
  not_signed_in: "Sign in again to add novels.",
};

/**
 * Add a friend's SHARED novel to your own library as an independent copy. The database function checks the
 * friendship and the owner's consent and copies the rows (text, chapters, search index) in one step; this then copies
 * the picture files into your own folder. If a file cannot be copied, the new book and any files written are removed,
 * so a failed add leaves nothing behind.
 */
export async function addFriendBook(username: string, bookId: string): Promise<ActionResult<{ slug: string; alreadyAdded: boolean }>> {
  await requireUser();
  const name = validateUsername(username);
  if (!name.ok || !isUuid(bookId)) return { ok: false, error: COPY_ERRORS.not_found };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("copy_friend_book", { p_owner_username: name.username, p_book_id: bookId });
  if (error) {
    // Only the database's error code and message are logged (they describe the failing statement, never book text).
    console.error("[friends] copy_friend_book failed:", error.code, error.message);
    const why = String(error.message ?? "").replace(/\s+/g, " ").slice(0, 200); // describes the failing statement, not book text
    return { ok: false, error: missing(error.code) ? MIGRATE_SHARE : `Couldn't add that novel (database error ${error.code ?? "unknown"}: ${why}). Please try again.` };
  }
  const parsed = copyShape.safeParse(data);
  if (!parsed.success) {
    console.error("[friends] copy_friend_book returned an unexpected result");
    return { ok: false, error: "Couldn't add that novel (unexpected answer from the database). Please try again." };
  }

  const result = parsed.data;
  if ("error" in result) {
    if (result.error === "already_added" && result.slug) return { ok: true, data: { slug: result.slug, alreadyAdded: true } };
    return { ok: false, error: COPY_ERRORS[result.error] ?? "Couldn't add that novel. Please try again." };
  }

  const copied = await copyFiles(supabase.storage.from("book-images"), result.images);
  if (!copied.ok) {
    await supabase.from("books").delete().eq("id", result.book_id); // cascades to the copied chapters, pictures and index
    return { ok: false, error: "Couldn't copy the pictures, so nothing was added. Please try again." };
  }
  revalidatePath("/profile");
  revalidatePath("/library/[bookId]", "page");
  return { ok: true, data: { slug: result.slug, alreadyAdded: false } };
}
