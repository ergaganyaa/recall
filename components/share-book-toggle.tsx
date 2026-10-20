"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setBookShared } from "@/app/actions/friends";

/**
 * Lets friends add a copy of THIS novel. Off by default, per novel. A friend who adds it gets a full, independent copy
 * of the text and illustrations, so the reminder about rights is part of the switch.
 */
export function ShareBookToggle({ bookId, shared }: { bookId: string; shared: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(shared);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-4 max-w-xl rounded-2xl border border-border bg-surface px-4 py-3" data-testid="share-book">
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={on}
          disabled={pending}
          className="mt-0.5 size-4 accent-[var(--accent)]"
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            setError(null);
            start(async () => {
              const res = await setBookShared(bookId, next);
              if (!res.ok) {
                setOn(!next);
                return setError(res.error);
              }
              router.refresh();
            });
          }}
        />
        <span>
          <span className="font-medium">Let friends add this novel to their library</span>
          <span className="block text-xs text-muted">
            A friend who adds it gets their own full copy of the text and illustrations (not your progress, bookmarks or chats). Only share files you
            are allowed to share. You can switch this off at any time; copies already made stay theirs.
          </span>
        </span>
      </label>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
