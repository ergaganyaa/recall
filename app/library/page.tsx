import type { Metadata } from "next";
import { LibraryGrid } from "@/components/library-grid";
import { books } from "@/lib/mock-data";

export const metadata: Metadata = { title: "Library" };

export default function LibraryPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-3xl font-bold tracking-tight">Your library</h1>
      <p className="mt-2 text-muted">
        {books.length} example series. Pick one to see its volumes and your progress.
      </p>
      <LibraryGrid books={books} />
    </div>
  );
}
