import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { getUser } from "@/lib/auth";
import { getProfile } from "@/lib/queries";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { Avatar } from "./avatar";

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

  const profile = await getProfile();
  const name = profile ? `@${profile.username}` : (user.email ?? "Your profile");

  return (
    <div className="flex items-center gap-2">
      <Link
        href="/profile"
        aria-label={`Your profile: ${name}`}
        data-testid="account-link"
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm font-medium transition hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
      >
        <Avatar profile={profile} size="sm" />
        <span className="hidden max-w-32 truncate text-muted md:inline">{name}</span>
      </Link>
      <form action={signOut}>
        <button className="rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-accent-soft">Sign out</button>
      </form>
    </div>
  );
}

export function AccountMenuFallback() {
  return <div className="skeleton h-9 w-24" aria-hidden />;
}
