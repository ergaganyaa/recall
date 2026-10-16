import "server-only";
import { cache } from "react";
import { createClient } from "./supabase/server";

/** Postgres / PostgREST codes meaning "a column, table or relationship the app expects isn't there". */
const SCHEMA_ERROR_CODES = new Set(["42703", "42P01", "PGRST200", "PGRST204", "PGRST205"]);

export const isSchemaErrorCode = (code: string | null | undefined) => !!code && SCHEMA_ERROR_CODES.has(code);

/**
 * True unless the database is missing objects from the migrations in supabase/migrations.
 * Other failures (network, permissions) are NOT treated as "outdated", so they still surface normally.
 * Once it has passed, the check is not repeated until the server restarts (it used to cost 4 queries per page).
 */
let verified = false; // migrations only ever add objects, so once the schema is complete it stays complete

export const schemaIsCurrent = cache(async (): Promise<boolean> => {
  if (verified) return true;
  const supabase = await createClient();
  const probes = await Promise.all([
    supabase.from("books").select("is_featured,language,cover_image_id,slug").limit(1),
    supabase.from("chapters").select("image_count").limit(1),
    supabase.from("volumes").select("arc,arc_order,language").limit(1),
    supabase.from("book_images").select("id").limit(1),
  ]);
  const missing = probes.find((p) => isSchemaErrorCode(p.error?.code));
  if (missing) console.error("[recall] Database schema is out of date:", missing.error?.message);
  verified = !missing;
  return !missing;
});
