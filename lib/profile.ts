/**
 * Profile rules shared by the forms and the server actions. Pure, so they are unit-tested. The database enforces
 * the same username rules (public.username_valid), so these only give a friendly message before a round trip.
 */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const DISPLAY_NAME_MAX = 60;
export const BIO_MAX = 300;

/** Kept back because they are routes or look official. Must match public.username_valid in migration 0010. */
export const RESERVED_USERNAMES = [
  "admin", "administrator", "root", "support", "recall", "system", "moderator", "staff", "official",
  "null", "undefined", "anonymous", "api", "login", "logout", "signup", "profile", "profiles",
  "library", "settings", "help", "about", "user", "users", "me", "you", "add",
] as const;

export type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_path: string | null;
  /** friends may see this person's library */
  share_library: boolean;
  created_at: string;
};

export const normalizeUsername = (raw: string) => raw.trim().toLowerCase();

export function validateUsername(raw: string): { ok: true; username: string } | { ok: false; error: string } {
  const username = normalizeUsername(raw);
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return { ok: false, error: `A username is ${USERNAME_MIN}–${USERNAME_MAX} characters long.` };
  }
  if (!/^[a-z0-9_]+$/.test(username)) return { ok: false, error: "Use only letters, numbers and underscores." };
  if ((RESERVED_USERNAMES as readonly string[]).includes(username)) return { ok: false, error: "That username isn't available." };
  return { ok: true, username };
}

/** An email address, as opposed to a username, in the sign-in box. */
export const looksLikeEmail = (s: string) => /^[^@\s]+@[^@\s]+$/.test(s.trim());

/** Where a user's avatar may live: their own folder in the private bucket. Mirrors the database constraint. */
export const avatarPathPattern = (userId: string) =>
  new RegExp(`^${userId}/avatar/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(webp|jpg)$`, "i");

/** The unique part of the avatar file name: it changes with every new avatar, so the browser can cache it forever. */
export function avatarVersion(path: string | null): string | null {
  const m = path ? /\/avatar\/([0-9a-f-]{36})\.[a-z]+$/i.exec(path) : null;
  return m ? m[1] : null;
}

/** "Mira Odell" -> "MO", "mira_o" -> "M" */
export function initialsOf(profile: { display_name?: string | null; username?: string | null } | null, fallback = "?"): string {
  const name = (profile?.display_name?.trim() || profile?.username || fallback).replace(/[_\s]+/g, " ").trim();
  const words = name.split(" ").filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? fallback).slice(0, 1);
  return letters.toUpperCase();
}
