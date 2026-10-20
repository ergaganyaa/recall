import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FriendsManager } from "@/components/friends-manager";
import { MigrationNotice } from "@/components/migration-notice";
import { SetupNotice } from "@/components/setup-notice";
import { ProfileSkeleton } from "@/components/skeletons";
import { requireUser } from "@/lib/auth";
import { getFriendsOverview } from "@/lib/friends";
import { getProfile } from "@/lib/queries";
import { schemaIsCurrent } from "@/lib/schema";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Friends" };

export default function FriendsPage() {
  if (!isSupabaseConfigured) return <SetupNotice />;
  return (
    <Suspense fallback={<ProfileSkeleton />}>
      <FriendsContent />
    </Suspense>
  );
}

async function FriendsContent() {
  await requireUser();
  if (!(await schemaIsCurrent())) return <MigrationNotice />;
  const [profile, overview] = await Promise.all([getProfile(), getFriendsOverview()]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-3xl font-bold tracking-tight">Friends</h1>
      <p className="mt-2 text-muted">See what your friends are reading, and let them see your library.</p>
      {!profile ? (
        <p className="mt-6 rounded-2xl border border-dashed border-border bg-surface p-6 text-sm" data-testid="need-username">
          Choose a username on <Link className="font-medium text-accent hover:underline" href="/profile">your profile</Link> first, so your friends can find you.
        </p>
      ) : (
        <div className="mt-6">
          <p className="mb-4 text-sm text-muted">
            Your username is <strong className="text-foreground">@{profile.username}</strong>: share it so friends can send you a request.
          </p>
          <FriendsManager overview={overview} />
        </div>
      )}
    </div>
  );
}
