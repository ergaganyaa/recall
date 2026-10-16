import "server-only";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { createClient } from "./supabase/server";

export type SessionUser = { id: string; email: string | null };

/**
 * Returns the signed-in user, or null.
 *
 * The access token is verified LOCALLY with the project's public signing keys (`getClaims`): signature and
 * expiry are checked, with no network round trip. (`getUser` asks the Auth server every time, about 0.4 s from
 * a distant region, and it used to run three times per page.) This is as strong as the database's own check:
 * PostgREST and Storage validate the same JWT for every query, so row level security is unchanged. The only
 * difference is that a session revoked server-side keeps working until its token expires (default 1 hour).
 * Projects that still use a shared-secret JWT make `getClaims` fall back to the Auth server automatically.
 *
 * Cached per request, so the layout, the page and the actions of one request verify the token once.
 */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  // The Supabase client reads the clock (token expiry). That is fine per request, but Next.js flags
  // Date.now() during prerendering, so mark this as request-time work before it runs.
  await connection();
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
});

/** Data-access-layer guard: every authenticated page/action starts here. */
export async function requireUser() {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}
