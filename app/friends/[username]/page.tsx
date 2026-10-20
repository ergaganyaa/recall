import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Avatar } from "@/components/avatar";
import { FriendBookCard } from "@/components/friend-book-card";
import { RemoveFriendButton } from "@/components/friends-manager";
import { MigrationNotice } from "@/components/migration-notice";
import { SetupNotice } from "@/components/setup-notice";
import { ProfileSkeleton } from "@/components/skeletons";
import { requireUser } from "@/lib/auth";
import { getFriendLibrary, getFriendProfile } from "@/lib/friends";
import { validateUsername } from "@/lib/profile";
import { schemaIsCurrent } from "@/lib/schema";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Friend" };

export default function FriendPage({ params }: PageProps<"/friends/[username]">) {
  if (!isSupabaseConfigured) return <SetupNotice />;
  return (
    <Suspense fallback={<ProfileSkeleton />}>
      <FriendContent params={params} />
    </Suspense>
  );
}

const month = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });

async function FriendContent({ params }: { params: PageProps<"/friends/[username]">["params"] }) {
  const { username: raw } = await params;
  await requireUser();
  if (!(await schemaIsCurrent())) return <MigrationNotice />;

  // Anyone who is not a confirmed friend gets the same page as a name that does not exist.
  const name = validateUsername(decodeURIComponent(raw));
  if (!name.ok) notFound();
  const [profile, library] = await Promise.all([getFriendProfile(name.username), getFriendLibrary(name.username)]);
  if (!profile) notFound();

  return (
    <div className="mx-auto max-w-6xl space-y-10 px-4 py-10 sm:px-6 sm:py-14">
      <Link href="/friends" className="text-sm text-muted hover:text-foreground">
        ← Back to friends
      </Link>

      <section className="flex flex-col items-center gap-5 rounded-2xl border border-border bg-surface p-6 text-center sm:flex-row sm:text-left" data-testid="friend-header">
        <Avatar profile={profile} owner={profile.username} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-3xl font-bold tracking-tight">{profile.display_name || `@${profile.username}`}</h1>
          <p className="text-muted">@{profile.username}</p>
          {profile.bio && <p className="mt-2 max-w-2xl whitespace-pre-line text-sm">{profile.bio}</p>}
          <p className="mt-2 text-xs text-muted">Member since {month.format(new Date(profile.created_at))}</p>
        </div>
        {profile.friendship_id && <RemoveFriendButton friendshipId={profile.friendship_id} username={profile.username} />}
      </section>

      <section aria-labelledby="their-library">
        <h2 id="their-library" className="text-2xl font-bold tracking-tight">
          {profile.display_name || `@${profile.username}`}&apos;s library
        </h2>
        {!library || !library.shared ? (
          <p className="mt-4 rounded-2xl border border-dashed border-border bg-surface p-8 text-center text-sm text-muted" data-testid="library-hidden">
            @{profile.username} isn&apos;t sharing their library with friends.
          </p>
        ) : library.books.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-dashed border-border bg-surface p-8 text-center text-sm text-muted">Nothing in their library yet.</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted">
              {library.books.length} {library.books.length === 1 ? "novel" : "novels"}
            </p>
            <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" data-testid="friend-books">
              {library.books.map((b) => (
                <li key={b.id}>
                  <FriendBookCard book={b} owner={profile.username} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
