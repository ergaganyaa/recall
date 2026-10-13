import Link from "next/link";

export default function BookNotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="text-2xl font-bold">We couldn&apos;t find that book</h1>
      <p className="mt-2 text-muted">It may have been removed, or it belongs to a different account.</p>
      <Link
        href="/library"
        className="mt-6 inline-block rounded-full bg-accent px-6 py-3 text-sm font-medium text-accent-foreground"
      >
        Back to library
      </Link>
    </div>
  );
}
