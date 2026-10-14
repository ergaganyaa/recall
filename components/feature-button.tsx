"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setFeaturedBook } from "@/app/actions/import";

/** Makes this book the one featured on the Home page. */
export function FeatureButton({ bookId, featured }: { bookId: string; featured: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (featured) {
    return <span className="rounded-full bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent">★ Featured on Home</span>;
  }
  return (
    <span>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await setFeaturedBook(bookId);
            if (res.ok) router.refresh();
            else setError(res.error);
          })
        }
        className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted hover:border-accent hover:text-accent disabled:opacity-50"
      >
        {pending ? "Saving…" : "☆ Feature on Home"}
      </button>
      {error && <span role="alert" className="ml-2 text-xs text-danger">{error}</span>}
    </span>
  );
}
