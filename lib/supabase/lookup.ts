import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseKey, supabaseUrl } from "./config";

export type LookupResult = { status: "found"; email: string } | { status: "none" } | { status: "unconfigured" } | { status: "missing_migration" } | { status: "error" };

/**
 * Username -> email, for signing in with a username.
 *
 * The database function login_email returns an address ONLY for a request that carries the server's secret in a
 * header. That secret (LOGIN_LOOKUP_SECRET) lives in the server environment and in the database (set once with
 * set_login_lookup_secret); it never reaches the browser. So nobody else can turn a username into an email address,
 * and no service-role key is needed. Uses a throw-away client with no session.
 */
export async function lookupEmail(username: string, secret = process.env.LOGIN_LOOKUP_SECRET): Promise<LookupResult> {
  if (!secret || secret.trim().length < 16) return { status: "unconfigured" };
  if (!supabaseUrl || !supabaseKey) return { status: "error" };
  const client = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-recall-login-secret": secret.trim() } },
  });
  const { data, error } = await client.rpc("login_email", { p_username: username });
  if (error) return { status: error.code === "42883" || error.code === "PGRST202" ? "missing_migration" : "error" };
  return typeof data === "string" && data ? { status: "found", email: data } : { status: "none" };
}
