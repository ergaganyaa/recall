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


### Asking while you read (scroll-position boundary)

**Migrations:** run `0006_reading_position.sql` and then `0007_scroll_boundary.sql` in the SQL editor, after 0001–0005 (order: 0001 → 0002 → 0003 → 0004 → 0005 → 0006 → 0007). Both only add columns/functions (0007 just replaces one function); existing imports, bookmarks, progress and chats are kept. Old chat messages have no paragraph position and are treated as chapter-level.

**The rule:** everything above the top edge of the reading area is read; the first paragraph that is still (even partly) visible, and everything below it, is unread. A small margin (24 px) keeps a paragraph that has only just scrolled off from counting. It applies the same way when you open a chapter for the first time, jump to the middle, or come back to a saved position: once the saved position is restored, the boundary is derived from where the page actually is. Nothing needs confirming, and opening, closing or focusing the chat never changes it.

**Details:** a paragraph ("block") is one non-empty line of the chapter text, numbered from 0; the app and the database number them identically (tested). Positions are paragraph numbers, never pixels, so font size, width, the chat panel and pictures loading cannot corrupt them (the page re-anchors to the paragraph you were on). Only the chapter right after your last finished one gets a partial position; chapters further ahead stay fully hidden, and a chapter is only finished by "Next chapter"/"Mark chapter finished" (nothing finishes automatically).

**Enforcement:** the browser reports only "the last paragraph above the screen" via `record_reading_checkpoint`, in either direction. The database checks that the book is yours, the chapter is the next in line, it has text, the paragraph exists and the text revision matches. `assistant_context` takes no boundary argument: it reads your progress row and returns chapters you finished plus frontier-chapter paragraphs up to the stored boundary, so later text never leaves the database. If no position is stored, or the chapter text changed since (`content_rev`), none of the current chapter is used. Before each question the reader sends its boundary as it is at that moment and the question is not sent if that fails, so a stale, further boundary is never used. Chat history and the chat shown in the UI are filtered by `(chapter, paragraph)`, so scrolling back removes later messages on the next request.

**Citations:** `[n]` markers are validated against the supplied passages and link to `/library/<book>/read/<chapter>?cite=1&block=<n>`. In the chapter you are reading the chat scrolls there and highlights it, with "Back to where I was" (the jump moves the top of the screen, so it also lowers the boundary until you go back). From another chapter it opens a *visit*: your resume position and progress are not touched.

**Known limits:** the book owner can still edit their own `reading_progress` row through the Supabase API (it only widens what *they* can see), and the browser's report is trusted for position within the next chapter (it cannot open other chapters). Verified only against in-process Postgres (PGlite) with the real migrations and row-level security, not a live Supabase project.

## Importing volumes (PDF / EPUB / TXT / Markdown)

**PDF** (parsed in your browser with pdf.js): text is rebuilt in reading order (running headers and page numbers dropped); chapters come from the PDF's bookmarks, else detected headings, else the whole file as one chapter, and you can rename, merge, split at a page, or take everything as one chapter before saving. Pictures between paragraphs are cropped from the rendered page and kept in place with their aspect ratio; picture-only pages are kept as page images. **Scanned PDFs (no selectable text) are detected and explained; Recall has no OCR**, so they can only be imported as page images (readable, not searchable) unless you run OCR first. Encrypted, damaged, blank, very large (>150 MB or >1500 pages) files get a clear message.

**Covers:** each imported volume gets its own cover (the first meaningful picture, else a rendered first page; you can pick another or upload your own in the preview). In your library and on Home, a book shows the cover you pinned yourself; otherwise the cover of **the volume you are reading** (from your own saved reading position, per account), falling back to the nearest volume that has a cover (an earlier one wins a tie), then to a linked cover image, then to a generated placeholder. With no progress yet it is the first volume. A failed or cancelled import never supplies a cover. The book page shows the cover of the volume you are reading; **click it to open the covers full screen** and swipe (or use the arrows, number chips or left/right keys) through every volume. It only browses: it never changes your progress, and its button links to the right chapter of the selected volume (your saved chapter for the volume you are reading, the next unfinished chapter for a partly read one, the first chapter otherwise).

Open a book → **Import a volume**. Pick one PDF or EPUB (a whole volume) or one or more .txt/.md files. The file is read in your browser; you review what was found, then it is saved to your private account.

- **Volumes** keep a decimal-safe number (4.5, 7.5), a title, an optional arc/school year with an order, and the source language. A volume is placed in the correct reading-order slot, so volumes can be imported in any order; later chapters are renumbered and your progress, bookmarks and passages move with them.
- **Illustrations** are stored in a private Storage bucket and kept in place inside the chapter, with their pixel size so the reader reserves the right aspect ratio. Image-only chapters (colour plates, wordless pages) are kept. Images and alt text are never indexed or searchable.
- Every chapter is labelled **Full text**, **Illustrations only** or **Not imported** (catalog entry only). Nothing is generated for chapters without content, and progress never shows 100% unless everything is finished, everything has content, and the book is marked *Completed*.
- Chapter text is **not** downloaded from any website. Only import files you have the right to use.

## Importing novels

Only public book-page metadata is requested from Ranobelib (host allowlist, no redirects off-site, 8s timeout, 1.5 MB cap). Chapter pages are never fetched: Ranobelib's `robots.txt` disallows them. Chapter text comes from local files or paste, never from the site: paste or `.txt`/`.md` upload (UTF-8, UTF-16 and Windows-1251 are detected; Markdown is flattened to plain text). If the importer finds nothing, the link is kept and every field is editable. Chapter lists can be pasted in bulk: `# Volume 2` (or `Volume 2: Title`) starts a volume, every other line is a chapter title.

## Performance notes

Almost all of the time in Recall goes to **network round trips to Supabase** (about 0.35–0.45 s each when the project is in a distant region), so the code is organised to keep them few and parallel: the session is verified locally (`getClaims`, no Auth-server call), the reader loads everything in one parallel round, illustrations are fetched with one Storage call, and imports save 3 chapters and 4 pictures at a time.

- `RECALL_TIMING=1 npm run dev` logs server stage timings; `NEXT_PUBLIC_RECALL_TIMING=1` adds browser-side timings (Next chapter, import parse/upload). They log labels and durations only.
- `RECALL_BENCH=1 npx vitest run tests/perf.bench.test.ts` runs the real server code against a stub Supabase client that sleeps `RECALL_RTT` ms (default 380) per call, and prints round-trip counts and wall time. It measures code structure, not your database's speed.

## Readable book addresses

Books live at `/library/<slug>` (for example `/library/classroom-of-the-elite`). Run `supabase/migrations/0008_book_slugs.sql` after 0007: it adds `books.slug` (unique per user, set by a trigger from the title when a book is created, filled in for existing books, permanent even if the title changes). Repeated titles get `-2`, `-3`; `add` is reserved because `/library/add` is the add-a-book page. Older `/library/<id>` links, bookmarks and saved citations still work and redirect to the slug. Until the migration is run, the app shows its "database is out of date" notice.

A PDF is scanned once on import (a scanned PDF is only inspected a second time to describe it), the first pictures of a chapter are preloaded from the page head (`react-dom` `preload`) and marked high priority, and the chapter body is memoised so UI state changes do not rebuild it. `RECALL_BENCH=1 npx vitest run tests/perf-pdf.bench.test.ts` times the PDF stages in Node (CPU only, not a browser).

## Reading recap and "Ask about this passage"

Run `supabase/migrations/0009_recap_and_selection.sql` after 0008 (two read-only functions, no table changes). Both features reuse the existing Gemini setup and the spoiler boundary; if the migration is missing the app says which file to run.

- **Remind me what happened** (book page, and in the reader's chat panel): a short "story so far" for the story just before your place: where things stand, who is involved, and open threads, with links to the chapters and paragraphs it came from. `recap_context` reads **your own** reading progress inside the database and returns the most recent text inside your boundary only (the last chunks of your latest finished chapters plus the last few paragraphs read of the current one). The browser sends only the book id. No recap is stored or reused as a summary, so moving backward can never bring back a longer one; with no valid boundary the result is "nothing to recap yet" (or an error), never an unrestricted summary. The exchange is saved in the chat like any question (so it counts toward the per-user limits) at the position it was written for.
- **Ask AI about this passage** (reader): highlight one to three paragraphs and press the button; the chat opens with the passage attached and suggested questions. The browser sends only paragraph numbers, the chapter text version and a short quote. `selection_context` re-reads the paragraphs from the chapter itself and refuses a chapter you have not reached, paragraphs further ahead than about one screen past your boundary, a changed chapter text, or more than three paragraphs. The passage on screen is by the reading rule "not yet read", so it is allowed as the *selection only*: retrieval, history and recaps still stop at the boundary, and the quote is used only if it really occurs in the server's text. An answer that used a passage beyond your boundary is stored at **that** later position, so it disappears from the model's history and from the chat shown whenever you are before it. Book text (including the passage) is passed as data, and tag-like text in it cannot close the block.

Limits: the recap looks only at recent text (it is not a full-book summary) and was not run against live Gemini; the on-screen allowance trusts the browser's reported boundary within the chapter you are reading, like the rest of the in-chapter tracking.

## Profiles and usernames

Run `supabase/migrations/0010_profiles.sql` after 0009. Each account gets a **profile** (`/profile`): username, display name, bio, a profile picture, simple reading stats, password change, and **your library** (the old `/library` address now redirects to it). Accounts created before this existed see a "Choose your username" box on their profile.

- **Username rules:** 3–20 characters, lowercase letters, digits and underscores; a few names (such as `admin` or `library`) are kept back. Usernames are unique; the database enforces it.
- **Privacy:** a profile row can only be read or changed by its owner (row level security). The picture is cropped to 256 px in your browser and stored in your own folder of the private `book-images` bucket; it is served only to you.
- **Signing in:** the sign-in box accepts an **email or a username**; sign-up asks for a username, an email and a password. Wrong password, unknown username and unknown email all show the same message, so nothing reveals who has an account.
- **Turning on username sign-in (one-time, optional):** Supabase signs people in with an email, so a username has to be turned into its email first. That lookup is a database function that answers **only** a request carrying a secret that lives on your server, so nobody else can find an account's email, and no service-role key is needed. Put a long random string in `.env.local` as `LOGIN_LOOKUP_SECRET=...`, restart the server, and run `select public.set_login_lookup_secret('the same string');` once in the Supabase SQL editor. Until then username sign-in says it isn't set up and email sign-in works as before. Treat the secret like a password; to rotate it, change both places.

## Friends

Run `supabase/migrations/0011_friends.sql` after 0010. **Friends** (`/friends`): add someone by username, accept or decline requests, unfriend. Once accepted, friends can open each other's **profile** (`/friends/<username>`) and a thin view of each other's **library**.

- **What a friend sees:** your username, name, bio and picture; and, for each book, its title, author, status, cover (the volume you are reading, or your pinned cover) and how far you are as counts ("12 / 40 chapters"). **Never** chapter text or titles, bookmarks, notes, chat questions, source links or your reading position inside a chapter, and a friend cannot open your books. Switch library sharing off under *Profile settings → Privacy* and friends see only your profile.
- **How it is enforced:** the `friendships` table can only be changed through database functions that check who is asking (you can only answer a request sent *to* you; either friend can unfriend; a declined request cannot be re-sent by the asker and is not reported to them, so declining is quiet). Friends cannot read your rows in `books`, `chapters`, `bookmarks`, `chat_messages` or `reading_progress`: they get the thin view only through `friend_library`, which answers `null` for anyone who is not a confirmed friend, the same as for a name that does not exist. Friends can read your avatar and your **cover** images in private storage (a storage rule, not an app check); chapter illustrations stay private. Ending a friendship removes all access at once.
- **Limits:** you can have 30 open requests at a time. People only learn that a username exists when they send a request (the same as the sign-up form).
