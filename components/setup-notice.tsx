/** Shown instead of data pages when Supabase env vars are missing. */
export function SetupNotice() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <div className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
        <h1 className="text-xl font-bold">Connect Supabase to continue</h1>
        <p className="mt-2 text-muted">
          Recall stores accounts, libraries and reading progress in Supabase. It isn&apos;t configured yet.
        </p>
        <ol className="mt-5 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
          <li>Create a free project at supabase.com.</li>
          <li>
            Run <code className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs">supabase/migrations/0001_init.sql</code>{" "}
            in the SQL editor.
          </li>
          <li>
            Copy <code className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs">.env.example</code> to{" "}
            <code className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs">.env.local</code> and fill in the
            project URL and anon key.
          </li>
          <li>Restart <code className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs">npm run dev</code>.</li>
        </ol>
      </div>
    </div>
  );
}
