import { notFound } from "next/navigation";
import { Suspense } from "react";
import { MigrationNotice } from "@/components/migration-notice";
import { schemaIsCurrent } from "@/lib/schema";
import { Reader } from "@/components/reader";
import { SetupNotice } from "@/components/setup-notice";
import { ReaderSkeleton } from "@/components/skeletons";
import { requireUser } from "@/lib/auth";
import { readAssistantConfig } from "@/lib/assistant/config";
import { comparePositions } from "@/lib/assistant/history";
import { formatVolume } from "@/lib/assistant/prompt";
import { getBook, getBookStructure, getChapter, getChat } from "@/lib/queries";
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
  const { p, block: blockParam, cite } = await searchParams;
  await requireUser();
  if (!(await schemaIsCurrent())) return <MigrationNotice />;

  const number = Number(chapterParam);
  if (!Number.isInteger(number) || number < 1) notFound();

  const book = await getBook(bookId);
  if (!book) notFound();

  const [chapter, structure, messages] = await Promise.all([
    getChapter(book.id, number),
    getBookStructure(book.id),
    getChat(book.id),
  ]);
  if (!chapter) notFound();

  const progress = structure.progress;
  // The saved in-chapter position only counts for the frontier chapter AND the text revision it was recorded on.
  const isFrontier = number === progress.last_read_chapter + 1;
  const partialBlock = isFrontier && progress.partial_rev === chapter.content_rev ? progress.partial_read_block : -1;
  const resumeBlock = progress.current_chapter === number ? progress.resume_block : null;
  const focus = typeof blockParam === "string" && /^\d{1,6}$/.test(blockParam) ? Number(blockParam) : null;
  const visit = cite === "1";

  // Conversation shown in the panel: never anything produced under a position later than the current one.
  const here = { chapter: progress.last_read_chapter, block: isFrontier ? partialBlock : -1 };
  const visibleMessages = messages.filter(
    (m) => m.boundary_chapter !== null && comparePositions({ chapter: m.boundary_chapter, block: m.boundary_block ?? -1 }, here) <= 0,
  );
  const assistant = readAssistantConfig();
  const volume = structure.volumes.find((v) => v.id === chapter.volume_id);

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
      chapter={{ number: chapter.number, title: chapter.title, content: chapter.content, rev: chapter.content_rev }}
      chapters={structure.chapters.map((c) => ({ number: c.number, title: c.title }))}
      images={chapter.images}
      initialPct={initialPct}
      lastRead={progress.last_read_chapter}
      partialBlock={partialBlock}
      resumeBlock={resumeBlock}
      resumeChapter={progress.current_chapter}
      focusBlock={focus}
      visit={visit}
      volumeLabel={volume ? `Vol. ${formatVolume(volume.number)}${volume.title ? ` — ${volume.title}` : ""}` : null}
      bookSourceUrl={book.source_url}
      chat={{ initialMessages: visibleMessages, configured: !!assistant.apiKey, modelLabel: assistant.model }}
    />
  );
}
