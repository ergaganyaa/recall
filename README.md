# Recall

A reading platform for light novels and long series: keep a library, read with automatic progress tracking, and ask questions about the story **without spoilers**.

Stack: Next.js 16 (App Router, Cache Components), TypeScript, Tailwind v4, Supabase (Postgres + Auth + row level security).

## Setup

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, run the migrations **in order**: [`0001_init.sql`](supabase/migrations/0001_init.sql), [`0002_volumes_images_featured.sql`](supabase/migrations/0002_volumes_images_featured.sql) (decimal volumes, arcs, illustrations, featured book, ordered volume import), [`0003_storage_book_images.sql`](supabase/migrations/0003_storage_book_images.sql) (private image bucket) and [`0004_volume_covers.sql`](supabase/migrations/0004_volume_covers.sql) (per-volume covers and import timestamps).
   `npm install` / `npm run dev` / `npm run build` also copy pdf.js's worker into `public/` (`scripts/copy-pdf-worker.mjs`); that copy is generated and git-ignored.
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

## Importing volumes (PDF / EPUB / TXT / Markdown)

**PDF** (parsed in your browser with pdf.js): text is rebuilt in reading order (running headers and page numbers dropped); chapters come from the PDF's bookmarks, else detected headings, else the whole file as one chapter, and you can rename, merge, split at a page, or take everything as one chapter before saving. Pictures between paragraphs are cropped from the rendered page and kept in place with their aspect ratio; picture-only pages are kept as page images. **Scanned PDFs (no selectable text) are detected and explained; Recall has no OCR**, so they can only be imported as page images (readable, not searchable) unless you run OCR first. Encrypted, damaged, blank, very large (>150 MB or >1500 pages) files get a clear message.

**Covers:** each imported volume gets its own cover (the first meaningful picture, else a rendered first page; you can pick another or upload your own in the preview). The book shows a cover you pinned yourself; otherwise the cover of the most recently *successfully imported* volume that has one. A failed or cancelled import never changes it.

Open a book → **Import a volume**. Pick one PDF or EPUB (a whole volume) or one or more .txt/.md files. The file is read in your browser; you review what was found, then it is saved to your private account.

- **Volumes** keep a decimal-safe number (4.5, 7.5), a title, an optional arc/school year with an order, and the source language. A volume is placed in the correct reading-order slot, so volumes can be imported in any order; later chapters are renumbered and your progress, bookmarks and passages move with them.
- **Illustrations** are stored in a private Storage bucket and kept in place inside the chapter, with their pixel size so the reader reserves the right aspect ratio. Image-only chapters (colour plates, wordless pages) are kept. Images and alt text are never indexed or searchable.
- Every chapter is labelled **Full text**, **Illustrations only** or **Not imported** (catalog entry only). Nothing is generated for chapters without content, and progress never shows 100% unless everything is finished, everything has content, and the book is marked *Completed*.
- Chapter text is **not** downloaded from any website. Only import files you have the right to use.

## Importing novels

Only public book-page metadata is requested from Ranobelib (host allowlist, no redirects off-site, 8s timeout, 1.5 MB cap). Chapter pages are never fetched: Ranobelib's `robots.txt` disallows them. Chapter text comes from local files or paste, never from the site: paste or `.txt`/`.md` upload (UTF-8, UTF-16 and Windows-1251 are detected; Markdown is flattened to plain text). If the importer finds nothing, the link is kept and every field is editable. Chapter lists can be pasted in bulk: `# Volume 2` (or `Volume 2: Title`) starts a volume, every other line is a chapter title.
