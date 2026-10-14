import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { MigrationNotice } from "@/components/migration-notice";
import { schemaIsCurrent } from "@/lib/schema";
import { CoverControl } from "@/components/cover-control";
import { ChapterTools } from "@/components/chapter-tools";
import { FeatureButton } from "@/components/feature-button";
import { AssistantChat } from "@/components/assistant-chat";
import { BookCover } from "@/components/book-cover";
import { BookmarksList } from "@/components/bookmarks-list";
import { ChapterList } from "@/components/chapter-list";
import { ProgressBar } from "@/components/progress-bar";
import { SetupNotice } from "@/components/setup-notice";
import { BookSkeleton } from "@/components/skeletons";
import { readAssistantConfig } from "@/lib/assistant/config";
import { comparePositions } from "@/lib/assistant/history";
import { requireUser } from "@/lib/auth";
import { resolveCover } from "@/lib/cover";
import { summarizeProgress } from "@/lib/progress-display";
import { getBook, getBookStructure, getChat } from "@/lib/queries";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { STATUS_LABELS } from "@/lib/types";

const SAMPLE_SUGGESTIONS = ["Who is Mira?", "What is the star-gear?", "Where did Mira go?"];

export default function BookPage({ params }: PageProps<"/library/[bookId]">) {
  if (!isSupabaseConfigured) return <SetupNotice />;
  return (
    <Suspense fallback={<BookSkeleton />}>
      <BookContent params={params} />
    </Suspense>
  );
}

async function BookContent({ params }: { params: PageProps<"/library/[bookId]">["params"] }) {
  const { bookId } = await params;
  await requireUser();
  if (!(await schemaIsCurrent())) return <MigrationNotice />;
  const book = await getBook(bookId);
  if (!book) notFound();

  const [{ volumes, chapters, progress, bookmarks }, messages] = await Promise.all([
    getBookStructure(book.id),
    getChat(book.id),
  ]);

  const total = chapters.length;
  const lastRead = Math.min(progress.last_read_chapter, total);
  // Only whether a key exists and the model name are passed to the browser; the key itself never is.
  const assistant = readAssistantConfig();
  const cover = resolveCover(book, volumes);
  const summary = summarizeProgress({ chapters, lastRead, status: book.status });
  const percent = summary.percent;
  const lastReadChapter = chapters.find((c) => c.number === lastRead);
  const resumeTarget = chapters.find((c) => c.number === progress.current_chapter) ?? chapters[0];
  const started = lastRead > 0 || progress.scroll_pct > 0 || progress.current_chapter > 1;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/library" className="text-sm text-muted hover:text-foreground">
        ← Back to library
      </Link>

      <div className="mt-6 grid gap-8 md:grid-cols-[14rem_1fr]">
        <BookCover
          title={book.title}
          author={book.author}
          coverUrl={cover.src}
          className="mx-auto w-44 md:w-full"
        />
        <div>
          <p className="text-sm text-muted">
            <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
              {STATUS_LABELS[book.status]}
            </span>
            {book.is_sample && <span className="ml-2">Sample content</span>}
            <span className="ml-2 align-middle">
              <FeatureButton bookId={book.id} featured={book.is_featured} />
            </span>
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{book.title}</h1>
          {book.author && <p className="mt-1 text-muted">by {book.author}</p>}
          <p className="mt-2"><CoverControl bookId={book.id} source={cover.source} /></p>
          {book.description && (
            <p className="mt-4 max-w-2xl whitespace-pre-line leading-relaxed">{book.description}</p>
          )}
          {book.source_url && (
            <a
              href={book.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm text-accent hover:underline"
            >
              Open on the original site ↗
            </a>
          )}

          <div className="mt-6 max-w-xl rounded-2xl border border-border bg-surface p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold">Reading progress</h2>
              <span className="text-sm text-muted">{percent}%</span>
            </div>
            <ProgressBar percent={percent} label={`${book.title} reading progress`} className="mt-3" />
            <p className="mt-3 text-sm text-muted">
              {total ? `${lastRead} of ${total} chapters finished` : "No chapters yet"}
              {volumes.length > 1 && ` · ${volumes.length} volumes`}
              {summary.note && <span className="block text-xs">{summary.note}</span>}
            </p>
            <div className="mt-3 rounded-xl bg-accent-soft px-3 py-2 text-sm">
              <span className="text-muted">Last read: </span>
              <span className="font-medium">
                {lastReadChapter ? `Ch. ${lastReadChapter.number} — ${lastReadChapter.title}` : "Nothing finished yet"}
              </span>
            </div>
            {resumeTarget && (
              <Link
                href={`/library/${book.id}/read/${resumeTarget.number}`}
                className="mt-4 inline-block rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground hover:opacity-90"
              >
                {started
                  ? `Resume Ch. ${resumeTarget.number}${progress.scroll_pct > 0.02 ? ` · ${Math.round(progress.scroll_pct * 100)}%` : ""}`
                  : "Start reading"}
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="mt-12 grid gap-8 lg:grid-cols-[1fr_24rem]">
        <section aria-labelledby="chapters-heading">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 id="chapters-heading" className="text-xl font-bold tracking-tight">
              Volumes &amp; chapters
            </h2>
            <Link
              href={`/library/${book.id}/import`}
              className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90"
            >
              + Import a volume
            </Link>
          </div>
          <ChapterList
            bookId={book.id}
            volumes={volumes}
            chapters={chapters}
            lastRead={lastRead}
            current={progress.current_chapter}
          />
        </section>
        <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
          <AssistantChat
            bookId={book.id}
            initialMessages={messages.filter(
              (m) =>
                m.boundary_chapter !== null &&
                comparePositions({ chapter: m.boundary_chapter, block: m.boundary_block ?? -1 }, { chapter: progress.last_read_chapter, block: -1 }) <= 0,
            )}
            boundary={lastRead}
            suggestions={book.is_sample ? SAMPLE_SUGGESTIONS : []}
            configured={assistant.apiKey !== null}
            modelLabel={assistant.model}
          />
          <ChapterTools bookId={book.id} chapters={chapters} />
          <BookmarksList bookId={book.id} bookmarks={bookmarks} />
        </aside>
      </div>
    </div>
  );
}
