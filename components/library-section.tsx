import Link from "next/link";
import { addSampleBook } from "@/app/actions/library";
import type { LibraryItem } from "@/lib/queries";
import { LibraryGrid } from "./library-grid";

/** The user's books, as shown on their profile. */
export function LibrarySection({ books }: { books: LibraryItem[] }) {
  return (
    <section id="library" aria-labelledby="library-heading" className="scroll-mt-24">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="library-heading" className="text-2xl font-bold tracking-tight">
            My library
          </h2>
          <p className="mt-1 text-sm text-muted">{books.length === 0 ? "Nothing here yet." : `${books.length} ${books.length === 1 ? "novel" : "novels"}`}</p>
        </div>
        <Link href="/library/add" className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground hover:opacity-90">
          + Add a novel
        </Link>
      </div>

      {books.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-border bg-surface p-10 text-center">
          <h3 className="text-lg font-semibold">Start your library</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Add a novel by link or by hand, or try the bundled sample story to see reading, progress and spoiler-safe questions in action.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link href="/library/add" className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground">
              Add a novel
            </Link>
            <form action={addSampleBook}>
              <button className="rounded-full border border-border px-5 py-2.5 text-sm font-medium hover:bg-accent-soft">Try the sample novel</button>
            </form>
          </div>
        </div>
      ) : (
        <div className="mt-6">
          <LibraryGrid books={books} />
        </div>
      )}
    </section>
  );
}
