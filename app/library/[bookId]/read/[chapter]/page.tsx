import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Reader } from "@/components/reader";
import { SetupNotice } from "@/components/setup-notice";
import { ReaderSkeleton } from "@/components/skeletons";
import { requireUser } from "@/lib/auth";
import { getBook, getBookStructure, getChapter } from "@/lib/queries";
import { isSupabaseConfigured } from "@/lib/supabase/config";

type Props = PageProps<"/library/[bookId]/read/[chapter]">;

export default function ReadPage({ params, searchParams }: Props) {
  if (!isSupabaseConfigured) return <SetupNotice />;
  return (
    <Suspense fallback={<ReaderSkeleton />}>
      <ReadContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function ReadContent({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const { bookId, chapter: chapterParam } = await params;
  const { p } = await searchParams;
  await requireUser();

  const number = Number(chapterParam);
  if (!Number.isInteger(number) || number < 1) notFound();

  const book = await getBook(bookId);
  if (!book) notFound();

  const [chapter, structure] = await Promise.all([getChapter(book.id, number), getBookStructure(book.id)]);
  if (!chapter) notFound();

  // A bookmark link carries ?p=; otherwise resume the saved position for this chapter.
  const fromLink = typeof p === "string" ? Number(p) : NaN;
  const saved = structure.progress.current_chapter === number ? structure.progress.scroll_pct : 0;
  const initialPct = Number.isFinite(fromLink) ? Math.min(1, Math.max(0, fromLink)) : saved;

  return (
    <Reader
      // Remount per chapter so scroll/progress state resets cleanly.
      key={chapter.id}
      bookId={book.id}
      bookTitle={book.title}
      chapter={{ number: chapter.number, title: chapter.title, content: chapter.content }}
      chapters={structure.chapters.map((c) => ({ number: c.number, title: c.title }))}
      initialPct={initialPct}
      lastRead={structure.progress.last_read_chapter}
      bookSourceUrl={book.source_url}
    />
  );
}
