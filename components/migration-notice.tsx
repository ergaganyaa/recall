/** Shown instead of a generic error when the database hasn't had the latest migrations applied. */
export function MigrationNotice() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <div className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
        <h1 className="text-xl font-bold">Your database needs updating</h1>
        <p className="mt-2 text-muted">
          This version of Recall uses tables and columns that aren&apos;t in your Supabase project yet, so your data
          can&apos;t be loaded. Nothing is lost: run the missing migrations once.
        </p>
        <ol className="mt-5 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
          <li>
            Open your Supabase project → <strong>SQL Editor</strong> → <strong>New query</strong>.
          </li>
          <li>
            Paste and run{" "}
            <code className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs">supabase/migrations/0002_volumes_images_featured.sql</code>
            , then
          </li>
          <li>
            paste and run{" "}
            <code className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs">supabase/migrations/0003_storage_book_images.sql</code>
            .
          </li>
          <li>Refresh this page.</li>
        </ol>
        <p className="mt-4 text-xs text-muted">
          Run each file once, in order, after <code className="font-mono">0001_init.sql</code>. Running 0002 twice fails safely.
        </p>
      </div>
    </div>
  );
}
