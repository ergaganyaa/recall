import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AssistantChat } from "@/components/assistant-chat";
import { BookCover } from "@/components/book-cover";
import { ProgressBar } from "@/components/progress-bar";
import { VolumeList } from "@/components/volume-list";
import { books, getBook, getLastRead, getNextChapter, getProgress } from "@/lib/mock-data";

export function generateStaticParams() {
  return books.map((b) => ({ slug: b.slug }));
}

export async function generateMetadata({ params }: PageProps<"/library/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const book = getBook(slug);
  return book ? { title: book.title, description: book.synopsis } : {};
}

export default async function BookPage({ params }: PageProps<"/library/[slug]">) {
  const { slug } = await params;
  const book = getBook(slug);
  if (!book) notFound();

  const progress = getProgress(book);
  const last = getLastRead(book);
  const next = getNextChapter(book);
  const lastReadLabel = last
    ? `Vol. ${last.volume.number}, Ch. ${last.chapter.number}`
    : "the beginning";

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/library" className="text-sm text-muted hover:text-foreground">
        ← Back to library
      </Link>

      <div className="mt-6 grid gap-8 md:grid-cols-[14rem_1fr]">
        <BookCover book={book} className="mx-auto w-44 md:w-full" />
        <div>
          <p className="text-sm text-muted">
            {book.genres.join(" · ")} · {book.status}
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">{book.title}</h1>
          <p className="mt-1 text-muted">by {book.author}</p>
          <p className="mt-4 max-w-2xl leading-relaxed">{book.synopsis}</p>

          <div className="mt-6 max-w-xl rounded-2xl border border-border bg-surface p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold">Reading progress</h2>
              <span className="text-sm text-muted">{progress.percent}%</span>
            </div>
            <ProgressBar
              percent={progress.percent}
              label={`${book.title} reading progress`}
              className="mt-3"
            />
            <p className="mt-3 text-sm text-muted">
              {progress.read} of {progress.total} chapters across {book.volumes.length} volumes
            </p>
            <div className="mt-3 rounded-xl bg-accent-soft px-3 py-2 text-sm">
              <span className="text-muted">Last read: </span>
              <span className="font-medium">
                {last
                  ? `Vol. ${last.volume.number}, Ch. ${last.chapter.number} — ${last.chapter.title}`
                  : "You haven't started yet"}
              </span>
            </div>
            {next && (
              <p className="mt-3 text-sm text-muted">
                Up next: Ch. {next.chapter.number} — {next.chapter.title}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-12 grid gap-8 lg:grid-cols-[1fr_24rem]">
        <section aria-labelledby="chapters-heading">
          <h2 id="chapters-heading" className="mb-4 text-xl font-bold tracking-tight">
            Volumes &amp; chapters
          </h2>
          <VolumeList volumes={book.volumes} lastReadChapter={book.lastReadChapter} />
        </section>
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <AssistantChat bookTitle={book.title} lastReadLabel={lastReadLabel} />
        </aside>
      </div>
    </div>
  );
}
