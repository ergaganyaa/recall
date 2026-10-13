# Recall

A reading platform for light novels and long series: keep a library, read with automatic progress tracking, and ask questions about the story **without spoilers**.

Stack: Next.js 16 (App Router, Cache Components), TypeScript, Tailwind v4, Supabase (Postgres + Auth + row level security).

## Setup

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).
3. Copy `.env.example` to `.env.local` and fill in the project URL and publishable (formerly "anon") key (Project Settings → API Keys).
   No service-role key is used; all access goes through the signed-in user and RLS.
4. For quick local testing you may turn off *Confirm email* (Authentication → Providers → Email), otherwise confirm via the emailed link.
5. `npm install && npm run dev` → http://localhost:3000

Checks: `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`.

`npm test` also runs the real SQL migration in an in-process Postgres (PGlite) and tries to read unread chapters through `search_passages` and row-level security.

## How spoiler protection works

- `reading_progress.last_read_chapter` is the boundary: the last chapter the reader **finished**. Automatic progress only advances one chapter at a time (finishing chapter 40 when you are at 35 does *not* unlock 36–39); "Read through here" is the explicit way to jump (`lib/progress.ts`).
- Chapters are split into passages (`chunks`) tagged with their chapter number.
- The `search_passages` SQL function reads the boundary from the caller's own progress row and only returns chunks with `chapter_number <= boundary`. The client can't pass or inflate it.
- The assistant only ever receives those passages. Today it quotes them (extractive); `lib/assistant.ts` is the single place to plug in an LLM later.

## Importing novels

Only public book-page metadata is requested from Ranobelib (host allowlist, no redirects off-site, 8s timeout, 1.5 MB cap). Chapter pages are never fetched: Ranobelib's `robots.txt` disallows them. Chapter text comes from paste or `.txt`/`.md` upload (UTF-8, UTF-16 and Windows-1251 are detected; Markdown is flattened to plain text). If the importer finds nothing, the link is kept and every field is editable. Chapter lists can be pasted in bulk: `# Volume 2` (or `Volume 2: Title`) starts a volume, every other line is a chapter title.
