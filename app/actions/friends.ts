"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
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
