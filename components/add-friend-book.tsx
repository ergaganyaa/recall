"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addFriendBook } from "@/app/actions/friends";

/**
 * On a friend's novel: add your own copy of it. Only offered for novels the friend chose to share. If you already
 * added it, it links to your copy instead. Copying can take a moment for a novel with many pictures.
 */
export function AddFriendBook({ username, bookId, shareable, mySlug }: { username: string; bookId: string; shareable: boolean; mySlug: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (mySlug) {
    return (
      <Link href={`/library/${encodeURIComponent(mySlug)}`} data-testid="in-library" className="mt-3 block rounded-full border border-border px-3 py-2 text-center text-xs font-medium hover:bg-accent-soft">
        In your library →
      </Link>
    );
  }
  if (!shareable) return null;

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={pending}
        aria-busy={pending}
        data-testid="add-to-library"
        onClick={() => {
          setError(null);
          start(async () => {
            try {
              const res = await addFriendBook(username, bookId);
              if (!res.ok) return setError(res.error);
              router.push(`/library/${encodeURIComponent(res.data.slug)}`);
            } catch {
              setError("Couldn't reach the server. Please try again.");
            }
          });
        }}
        className="w-full rounded-full bg-accent px-3 py-2 text-xs font-medium text-accent-foreground transition hover:opacity-90 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
      >
        {pending ? "Copying… this can take a moment" : "+ Add to my library"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
