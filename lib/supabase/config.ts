export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

// Supabase's dashboard now calls this the "publishable key"; older projects
// call it the "anon key". Either name works. Keep these as static
// `process.env.NEXT_PUBLIC_*` reads so Next.js can inline them.
export const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey);
