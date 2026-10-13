import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";

/** Returns the signed-in user, or null. Verifies the token with Supabase. */
export async function getUser() {
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
