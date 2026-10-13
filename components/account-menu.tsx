import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { getUser } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/** Reads the session, so it must be rendered inside <Suspense>. */
export async function AccountMenu() {
  if (!isSupabaseConfigured) return null;
  const user = await getUser();

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <Link href="/login" className="rounded-full px-4 py-2 text-sm font-medium text-muted hover:text-foreground">
          Sign in
        </Link>
        <Link
          href="/signup"
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90"
        >
          Sign up
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="hidden max-w-40 truncate text-sm text-muted md:inline">{user.email}</span>
      <form action={signOut}>
        <button className="rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-accent-soft">
          Sign out
        </button>
      </form>
    </div>
  );
}

export function AccountMenuFallback() {
  return <div className="skeleton h-9 w-24" aria-hidden />;
}
