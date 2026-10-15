import "server-only";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { createClient } from "./supabase/server";

/** Returns the signed-in user, or null. Verifies the token with Supabase. */
export async function getUser() {
  // The Supabase client reads the clock (token expiry). That is fine per request, but Next.js flags
  // Date.now() during prerendering, so mark this as request-time work before it runs.
  await connection();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** Data-access-layer guard: every authenticated page/action starts here. */
export async function requireUser() {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}
