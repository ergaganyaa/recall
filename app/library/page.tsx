import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { addSampleBook } from "@/app/actions/library";
import { MigrationNotice } from "@/components/migration-notice";
import { schemaIsCurrent } from "@/lib/schema";
import { LibraryGrid } from "@/components/library-grid";
import { SetupNotice } from "@/components/setup-notice";
import { LibrarySkeleton } from "@/components/skeletons";
import { requireUser } from "@/lib/auth";
import { listLibrary } from "@/lib/queries";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Library" };

export default function LibraryPage() {
  if (!isSupabaseConfigured) return <SetupNotice />;
  return (
    <Suspense fallback={<LibrarySkeleton />}>
      <LibraryContent />
    </Suspense>
  );
}

async function LibraryContent() {
  await requireUser();
  if (!(await schemaIsCurrent())) return <MigrationNotice />;
  const books = await listLibrary();

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Your library</h1>
          <p className="mt-2 text-muted">
            {books.length === 0 ? "Nothing here yet." : `${books.length} ${books.length === 1 ? "novel" : "novels"}`}
          </p>
        </div>
        <Link
          href="/library/add"
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground hover:opacity-90"
        >
          + Add a novel
        </Link>
      </div>

      {books.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-border bg-surface p-10 text-center">
          <h2 className="text-lg font-semibold">Start your library</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Add a novel by link or by hand, or try the bundled sample story to see reading, progress and
            spoiler-safe questions in action.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link href="/library/add" className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground">
              Add a novel
            </Link>
            <form action={addSampleBook}>
              <button className="rounded-full border border-border px-5 py-2.5 text-sm font-medium hover:bg-accent-soft">
                Try the sample novel
              </button>
            </form>
          </div>
        </div>
      ) : (
        <LibraryGrid books={books} />
      )}
    </div>
  );
}
