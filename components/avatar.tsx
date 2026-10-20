"use client";

import { useState } from "react";
import { avatarVersion, initialsOf } from "@/lib/profile";

const SIZES = { sm: "size-9 text-sm", md: "size-14 text-lg", lg: "size-28 text-3xl" } as const;

/**
 * The account picture: the uploaded avatar, or the person's initials. The picture is the user's own file, served by
 * /profile/avatar; ?v= changes with every new avatar, so a new picture shows at once and old ones stay cached.
 */
export function Avatar({
  profile,
  size = "sm",
  className = "",
  owner,
}: {
  profile: { username?: string | null; display_name?: string | null; avatar_path?: string | null } | null;
  size?: keyof typeof SIZES;
  className?: string;
  /** a FRIEND's username: their picture is fetched with ?u= (omit for your own) */
  owner?: string;
}) {
  const version = avatarVersion(profile?.avatar_path ?? null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const label = profile?.display_name || profile?.username || "Your account";
  const base = `relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-accent-soft font-semibold text-accent ${SIZES[size]} ${className}`;

  if (version && failedFor !== version) {
    return (
      <span className={base} data-testid="avatar">
        {/* The picture is private and served by an auth-checked route, so next/image does not apply. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/profile/avatar?${owner ? `u=${encodeURIComponent(owner)}&` : ""}v=${version}`}
          alt={`${label}'s picture`}
          className="size-full object-cover"
          onError={() => setFailedFor(version)}
        />
      </span>
    );
  }
  return (
    <span className={base} data-testid="avatar" role="img" aria-label={`${label}'s picture`}>
      {initialsOf(profile)}
    </span>
  );
}
