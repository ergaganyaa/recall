import Link from "next/link";
import { BookCard } from "@/components/book-card";
import { ContinueReadingCard } from "@/components/continue-reading-card";
import { books, getContinueReadingBook } from "@/lib/mock-data";

const features = [
  {
    title: "Spoiler-safe answers",
    body: "Ask about characters, plot and lore. The assistant only knows what you've already read.",
  },
  {
    title: "Pick up where you left off",
    body: "Your last-read chapter is tracked across every volume, so long series never lose you.",
  },
  {
    title: "Built for huge series",
    body: "Volumes, arcs and hundreds of chapters organised in one clean library.",
  },
];

export default function Home() {
  const current = getContinueReadingBook();

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div
          className="absolute inset-0 -z-10 opacity-60"
          style={{
            backgroundImage:
              "radial-gradient(60rem 28rem at 80% -10%, var(--accent-soft), transparent), radial-gradient(40rem 20rem at 0% 0%, var(--accent-soft), transparent)",
          }}
          aria-hidden
        />
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="inline-block rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
              AI reading companion · frontend preview
            </p>
            <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight sm:text-5xl">
              Never lose the plot of a long series again.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
              Lorekeeper tracks your progress through light novels and book series, and lets you
              ask questions about the story without spoilers.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/library"
                className="rounded-full bg-accent px-6 py-3 text-sm font-medium text-accent-foreground transition hover:opacity-90"
              >
                Browse the library
              </Link>
              <Link
                href={`/library/${current.slug}#assistant`}
                className="rounded-full border border-border px-6 py-3 text-sm font-medium transition hover:bg-accent-soft"
              >
                Try the assistant
              </Link>
            </div>
          </div>
          <ContinueReadingCard book={current} />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-2xl border border-border bg-surface p-6">
              <h2 className="font-semibold">{f.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="mb-6 flex items-end justify-between">
          <h2 className="text-2xl font-bold tracking-tight">From your library</h2>
          <Link href="/library" className="text-sm font-medium text-accent hover:underline">
            View all
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {books.slice(0, 4).map((b) => (
            <BookCard key={b.slug} book={b} />
          ))}
        </div>
      </section>
    </>
  );
}
