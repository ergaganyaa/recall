import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { MigrationNotice } from "@/components/migration-notice";
import { schemaIsCurrent } from "@/lib/schema";
import { SetupNotice } from "@/components/setup-notice";
import { VolumeImporter } from "@/components/volume-importer";
import { requireUser } from "@/lib/auth";
import { getBook, getBookStructure } from "@/lib/queries";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Import a volume" };

export default function ImportPage({ params }: PageProps<"/library/[bookId]/import">) {
  if (!isSupabaseConfigured) return <SetupNotice />;
  return (
    <Suspense fallback={<div className="skeleton mx-auto mt-16 h-64 max-w-2xl" aria-busy="true" />}>
      <ImportContent params={params} />
    </Suspense>
  );
}

async function ImportContent({ params }: { params: PageProps<"/library/[bookId]/import">["params"] }) {
  const { bookId } = await params;
  await requireUser();
  if (!(await schemaIsCurrent())) return <MigrationNotice />;
  const book = await getBook(bookId);
  if (!book) notFound();
  const { volumes } = await getBookStructure(book.id);

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <Link href={`/library/${book.id}`} className="text-sm text-muted hover:text-foreground">
        ← Back to {book.title}
      </Link>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">Import a volume</h1>
      <p className="mt-2 text-muted">
        Add a volume from files you own: EPUB (with illustrations), TXT or Markdown. It slots into the right place in
        reading order, so you can import volumes in any order.
      </p>
      <div className="mt-8">
        <VolumeImporter
          bookId={book.id}
          bookTitle={book.title}
          hasManualCover={Boolean(book.cover_image_id)}
          existing={volumes.map((v) => ({ number: v.number, arc: v.arc, arc_order: v.arc_order, title: v.title }))}
        />
      </div>
    </div>
  );
}
