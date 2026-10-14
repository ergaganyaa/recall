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
- The assistant only ever receives passages returned by `assistant_context` (see below). Nothing from unread chapters is retrieved, so none can reach a prompt, a citation, the conversation history or a suggestion.

## AI assistant (Google Gemini, free tier)

**Setup (about 3 minutes, no billing):**
1. Run `supabase/migrations/0005_assistant_context.sql` in the Supabase SQL editor (after 0001–0004).
2. Create a free API key in [Google AI Studio](https://aistudio.google.com/).
3. Add `GEMINI_API_KEY=...` to `.env.local` (see `.env.example` for optional settings), then restart `npm run dev`.
   Without a key the chat shows a setup message instead of failing.
4. Optional: `npm run smoke:gemini` sends one tiny request with made-up passages using your key (about one request of quota) to confirm the key and model work. `npm test` never calls Google.

**Model:** default `gemini-3.5-flash-lite`, which Google's docs listed as stable and free of charge when this was written. Set `GEMINI_MODEL` (for example `gemini-3.8-flash`) to change it. Model names, free-tier availability and the exact per-minute/per-day limits are set by Google and shown per project in AI Studio; they can change.

**Privacy and cost.** Each question sends the question, up to a few short passages you have already read, and a little recent conversation to Google. On the free tier, Google's terms allow using that content to improve its products; check Google's current policy before using private or sensitive text. Cost controls: answer length cap, passage count and size caps, bounded history, per-user limits (`ASSISTANT_MAX_PER_MINUTE` / `ASSISTANT_MAX_PER_DAY`), no retries, and no model call at all when nothing relevant is inside your reading boundary. Nothing here enables billing or a paid service.

**How it works:** the server authenticates you, then calls the database function `assistant_context`. That function reads *your* reading position itself, verifies you own the book, and returns only passages from chapters you have finished, with volume and chapter details. The prompt puts those passages in a `<source>` data block (book text is treated as data, never as instructions); the model must cite `[n]` and Recall keeps only citations that match supplied passages, shown as links to the chapters. Earlier chat messages are included only if they were produced at or below your current position, so moving backward immediately removes them. The AI vendor sits behind one interface (`lib/assistant/provider.ts`); `lib/assistant/gemini.ts` is the only Gemini-specific file.

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
