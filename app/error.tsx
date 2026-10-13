"use client";

import Link from "next/link";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-muted">{error.message || "An unexpected error occurred."}</p>
      <div className="mt-6 flex justify-center gap-3">
        <button onClick={reset} className="rounded-full bg-accent px-6 py-3 text-sm font-medium text-accent-foreground">
          Try again
        </button>
        <Link href="/library" className="rounded-full border border-border px-6 py-3 text-sm font-medium">
          Back to library
        </Link>
      </div>
    </div>
  );
}
