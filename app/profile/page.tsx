import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Avatar } from "@/components/avatar";
import { LibrarySection } from "@/components/library-section";
import { MigrationNotice } from "@/components/migration-notice";
import { ClaimUsername, ProfileEditor } from "@/components/profile-editor";
import { SetupNotice } from "@/components/setup-notice";
import { ProfileSkeleton } from "@/components/skeletons";
import { requireUser } from "@/lib/auth";
import { getFriendsOverview } from "@/lib/friends";
import { getProfile, listLibrary } from "@/lib/queries";
import { schemaIsCurrent } from "@/lib/schema";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Your profile" };

export default function ProfilePage() {
  if (!isSupabaseConfigured) return <SetupNotice />;
  return (
    <Suspense fallback={<ProfileSkeleton />}>
      <ProfileContent />
    </Suspense>
  );
}

const month = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });

async function ProfileContent() {
  const user = await requireUser();
  if (!(await schemaIsCurrent())) return <MigrationNotice />;
  const [profile, books, friends] = await Promise.all([getProfile(), listLibrary(), getFriendsOverview()]);

  // Counts come from the library the page already loaded: nothing extra to fetch.
  const finishedChapters = books.reduce((n, b) => n + b.last_read_chapter, 0);
  const completed = books.filter((b) => b.status === "completed").length;
  const stats = [
    { label: books.length === 1 ? "Novel" : "Novels", value: books.length },
    { label: "Chapters finished", value: finishedChapters },
    { label: "Completed", value: completed },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-10 px-4 py-10 sm:px-6 sm:py-14">
      <section className="flex flex-col items-center gap-5 rounded-2xl border border-border bg-surface p-6 text-center sm:flex-row sm:text-left" data-testid="profile-header">
        <Avatar profile={profile} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-3xl font-bold tracking-tight">{profile?.display_name || (profile ? `@${profile.username}` : "Your profile")}</h1>
          {profile && <p className="text-muted">@{profile.username}</p>}
          {profile?.bio && <p className="mt-2 max-w-2xl whitespace-pre-line text-sm">{profile.bio}</p>}
          <p className="mt-2 text-xs text-muted">
            {user.email}
            {profile && ` · Member since ${month.format(new Date(profile.created_at))}`}
          </p>
        </div>
      </section>

      {!profile && <ClaimUsername />}

      {profile && (
        <Link
          href="/friends"
          data-testid="friends-link"
          className="flex items-center justify-between rounded-2xl border border-border bg-surface px-5 py-4 transition hover:border-accent"
        >
          <span>
            <span className="font-semibold">Friends</span>
            <span className="ml-2 text-sm text-muted">{friends.friends.length === 1 ? "1 friend" : `${friends.friends.length} friends`}</span>
          </span>
          {friends.incoming.length > 0 ? (
            <span className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground">
              {friends.incoming.length} new {friends.incoming.length === 1 ? "request" : "requests"}
            </span>
          ) : (
            <span aria-hidden className="text-muted">→</span>
          )}
        </Link>
      )}

      <section aria-label="Reading stats" className="grid grid-cols-3 gap-3" data-testid="profile-stats">
        {stats.map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-surface p-4 text-center">
            <p className="text-2xl font-bold">{s.value}</p>
            <p className="text-xs text-muted">{s.label}</p>
          </div>
        ))}
      </section>

      <LibrarySection books={books} />

      {profile && (
        <section aria-labelledby="settings-heading">
          <h2 id="settings-heading" className="mb-4 text-2xl font-bold tracking-tight">
            Profile settings
          </h2>
          <ProfileEditor profile={profile} userId={user.id} />
        </section>
      )}
    </div>
  );
}
