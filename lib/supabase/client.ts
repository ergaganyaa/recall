"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabaseKey, supabaseUrl } from "./config";

/** Browser client, used only to upload illustrations straight to private Storage. */
export function createBrowserSupabase() {
  if (!supabaseUrl || !supabaseKey) throw new Error("Supabase is not configured.");
  return createBrowserClient(supabaseUrl, supabaseKey);
}
