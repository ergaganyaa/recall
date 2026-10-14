"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { clearBookCover } from "@/app/actions/import";
import type { CoverSource } from "@/lib/cover";

/** Says where the book's cover comes from and lets you give up a pinned cover. */
export function CoverControl({ bookId, source }: { bookId: string; source: CoverSource }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (source === "none") return <span className="text-xs text-muted">No cover yet: import a volume to get one.</span>;
  if (source !== "manual") {
    return (
      <span className="text-xs text-muted">
        {source === "volume" ? "Cover: latest imported volume (automatic)" : "Cover: linked image"}
      </span>
    );
  }
  return (
    <span className="text-xs text-muted">
      Cover: pinned by you ·{" "}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await clearBookCover(bookId);
            if (res.ok) router.refresh();
            else setError(res.error);
          })
        }
        className="text-accent hover:underline disabled:opacity-50"
      >
        {pending ? "Resetting…" : "use the automatic cover"}
      </button>
      {error && <span role="alert" className="ml-2 text-danger">{error}</span>}
    </span>
  );
}
