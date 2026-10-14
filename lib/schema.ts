import "server-only";
import { cache } from "react";
import { createClient } from "./supabase/server";

/** Postgres / PostgREST codes meaning "a column, table or relationship the app expects isn't there". */
const SCHEMA_ERROR_CODES = new Set(["42703", "42P01", "PGRST200", "PGRST204", "PGRST205"]);

export const isSchemaErrorCode = (code: string | null | undefined) => !!code && SCHEMA_ERROR_CODES.has(code);

/**
 * True unless the database is missing objects from the migrations in supabase/migrations.
 * Other failures (network, permissions) are NOT treated as "outdated", so they still surface normally.
 * Cached per request.
 */
export const schemaIsCurrent = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const probes = await Promise.all([
    supabase.from("books").select("is_featured,language,cover_image_id").limit(1),
    supabase.from("chapters").select("image_count").limit(1),
    supabase.from("volumes").select("arc,arc_order,language").limit(1),
    supabase.from("book_images").select("id").limit(1),
  ]);
  const missing = probes.find((p) => isSchemaErrorCode(p.error?.code));
  if (missing) console.error("[recall] Database schema is out of date:", missing.error?.message);
  return !missing;
});
