"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { avatarPathPattern, BIO_MAX, DISPLAY_NAME_MAX, validateUsername } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

const BUCKET = "book-images";
const TAKEN = "That username is taken or not available. Try another.";
const MIGRATE = "Run migration 0010_profiles.sql in the Supabase SQL editor, then try again.";
const isMissingTable = (code?: string) => code === "42P01" || code === "PGRST205";

/** Choose a username for an account that has no profile yet (accounts created before profiles existed). */
export async function claimUsername(username: string): Promise<ActionResult<{ username: string }>> {
  await requireUser();
  const name = validateUsername(username);
  if (!name.ok) return { ok: false, error: name.error };
  const supabase = await createClient();
  // The row id defaults to the signed-in user; row level security only lets a user write their own profile.
  const { error } = await supabase.from("profiles").insert({ username: name.username });
  if (error) {
    if (error.code === "23505") return { ok: false, error: TAKEN };
    return { ok: false, error: isMissingTable(error.code) ? MIGRATE : "Couldn't save your username. Please try again." };
  }
  revalidatePath("/profile");
  return { ok: true, data: { username: name.username } };
}

export async function changeUsername(username: string): Promise<ActionResult<{ username: string }>> {
  const user = await requireUser();
  const name = validateUsername(username);
  if (!name.ok) return { ok: false, error: name.error };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update({ username: name.username, updated_at: new Date().toISOString() })
    .eq("id", user.id)
    .select("username");
  if (error) return { ok: false, error: error.code === "23505" ? TAKEN : "Couldn't change your username. Please try again." };
  if (!data || data.length === 0) return { ok: false, error: "Choose a username first." };
  revalidatePath("/profile");
  return { ok: true, data: { username: name.username } };
}

const details = z.object({
  displayName: z.string().trim().max(DISPLAY_NAME_MAX, `Your name can be up to ${DISPLAY_NAME_MAX} characters.`),
  bio: z.string().trim().max(BIO_MAX, `Your bio can be up to ${BIO_MAX} characters.`),
});

export async function updateProfile(input: { displayName: string; bio: string }): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = details.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update({ display_name: parsed.data.displayName || null, bio: parsed.data.bio || null, updated_at: new Date().toISOString() })
    .eq("id", user.id)
    .select("id");
  if (error) return { ok: false, error: "Couldn't save your profile. Please try again." };
  if (!data || data.length === 0) return { ok: false, error: "Choose a username first." };
  revalidatePath("/profile");
  return { ok: true, data: undefined };
}

/**
 * Use an uploaded picture as the avatar. The browser uploaded it to the user's own folder of the private bucket
 * (Storage policies allow nothing else); here the path is checked to be exactly that, then saved, and the previous
 * picture is removed.
 */
export async function setAvatar(path: string): Promise<ActionResult> {
  const user = await requireUser();
  if (typeof path !== "string" || !avatarPathPattern(user.id).test(path)) return { ok: false, error: "That picture can't be used as an avatar." };
  const supabase = await createClient();
  const { data: before } = await supabase.from("profiles").select("avatar_path").eq("id", user.id).maybeSingle();
  const { data, error } = await supabase.from("profiles").update({ avatar_path: path, updated_at: new Date().toISOString() }).eq("id", user.id).select("id");
  if (error || !data || data.length === 0) {
    await supabase.storage.from(BUCKET).remove([path]); // do not leave an orphan behind
    return { ok: false, error: data?.length === 0 ? "Choose a username first." : "Couldn't save your avatar. Please try again." };
  }
  const old = before?.avatar_path as string | null | undefined;
  if (old && old !== path) await supabase.storage.from(BUCKET).remove([old]); // best effort
  revalidatePath("/profile");
  return { ok: true, data: undefined };
}

export async function removeAvatar(): Promise<ActionResult> {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: before } = await supabase.from("profiles").select("avatar_path").eq("id", user.id).maybeSingle();
  const { error } = await supabase.from("profiles").update({ avatar_path: null, updated_at: new Date().toISOString() }).eq("id", user.id);
  if (error) return { ok: false, error: "Couldn't remove your avatar. Please try again." };
  const old = before?.avatar_path as string | null | undefined;
  if (old) await supabase.storage.from(BUCKET).remove([old]);
  revalidatePath("/profile");
  return { ok: true, data: undefined };
}

export async function changePassword(newPassword: string): Promise<ActionResult> {
  await requireUser();
  const parsed = z.string().min(8, "Password must be at least 8 characters.").max(200).safeParse(newPassword);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data });
  if (error) return { ok: false, error: "Couldn't change your password. Sign in again and retry." };
  return { ok: true, data: undefined };
}
