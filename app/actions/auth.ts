"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { BAD_LOGIN, safeNext } from "@/lib/auth-redirect";
import { looksLikeEmail, normalizeUsername, validateUsername } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";
import { lookupEmail } from "@/lib/supabase/lookup";

export type AuthState = { error?: string; message?: string };

const password = z.string().min(8, "Password must be at least 8 characters.").max(200);

/** Sign in with an email address OR a username. */
export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = z
    .object({ identifier: z.string().trim().min(1, "Enter your username or email.").max(254), password: z.string().min(1, "Enter your password.").max(200) })
    .safeParse({ identifier: formData.get("identifier") ?? formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { identifier } = parsed.data;

  let email = identifier;
  if (!looksLikeEmail(identifier)) {
    if (!validateUsername(identifier).ok) return { error: BAD_LOGIN };
    const found = await lookupEmail(normalizeUsername(identifier));
    if (found.status === "unconfigured") {
      return { error: "Signing in with a username isn't set up on this server yet. Use your email address (see the README to turn it on)." };
    }
    if (found.status === "missing_migration") return { error: "Run migration 0010_profiles.sql in the Supabase SQL editor, then try again." };
    if (found.status === "error") return { error: "Couldn't check that username. Please try again, or use your email address." };
    if (found.status === "none") return { error: BAD_LOGIN };
    email = found.email;
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password: parsed.data.password });
  if (error) return { error: BAD_LOGIN };

  redirect(safeNext(formData.get("next")));
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = z
    .object({ email: z.string().trim().email("Enter a valid email address."), password })
    .safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const name = validateUsername(String(formData.get("username") ?? ""));
  if (!name.ok) return { error: name.error };

  const supabase = await createClient();
  // A yes/no from the database: is the name allowed and free? (It never says who has it.)
  const { data: free, error: freeErr } = await supabase.rpc("username_available", { p_username: name.username });
  if (freeErr) {
    return { error: freeErr.code === "PGRST202" || freeErr.code === "42883" ? "Run migration 0010_profiles.sql in the Supabase SQL editor, then try again." : "Couldn't check that username. Please try again." };
  }
  if (free !== true) return { error: "That username is taken or not available. Try another." };

  // The username rides along as sign-up data; the database creates the profile from it.
  const { data, error } = await supabase.auth.signUp({ ...parsed.data, options: { data: { username: name.username } } });
  if (error) return { error: error.message };

  // With email confirmation on, there is no session yet.
  if (!data.session) {
    return { message: "Check your inbox to confirm your email, then sign in with your username or email." };
  }
  redirect("/profile");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
