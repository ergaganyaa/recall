-- Recall: initial schema.
-- Run in the Supabase SQL editor (or `supabase db push`). Every table is
-- protected by row level security so users can only touch their own rows.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- books
create table public.books (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 300),
  author      text,
  description text,
  cover_url   text,
  source_url  text,
  status      text not null default 'reading'
              check (status in ('plan_to_read', 'reading', 'completed', 'on_hold', 'dropped')),
  is_sample   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index books_user_idx on public.books (user_id, created_at desc);

-- -------------------------------------------------------------- volumes
create table public.volumes (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  book_id uuid not null references public.books (id) on delete cascade,
  number  int  not null check (number > 0),
  title   text,
  unique (book_id, number)
);

-- ------------------------------------------------------------- chapters
-- `number` is the series-wide reading order (1, 2, 3 ...). It is the unit the
-- spoiler boundary is expressed in.
create table public.chapters (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  book_id    uuid not null references public.books (id) on delete cascade,
  volume_id  uuid references public.volumes (id) on delete set null,
  number     int  not null check (number > 0),
  title      text not null check (char_length(title) between 1 and 300),
  source_url text,
  content    text,
  word_count int  not null default 0,
  unique (book_id, number)
);
create index chapters_book_idx on public.chapters (book_id, number);

-- ----------------------------------------------------- reading_progress
-- last_read_chapter: the last chapter the reader FINISHED. This is the hard
-- spoiler boundary: nothing after it may reach search or the assistant.
-- current_chapter / scroll_pct: where to resume.
create table public.reading_progress (
  book_id           uuid primary key references public.books (id) on delete cascade,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  last_read_chapter int  not null default 0 check (last_read_chapter >= 0),
  current_chapter   int  not null default 1 check (current_chapter >= 1),
  scroll_pct        real not null default 0 check (scroll_pct between 0 and 1),
  updated_at        timestamptz not null default now()
);

-- ------------------------------------------------------------ bookmarks
create table public.bookmarks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  book_id        uuid not null references public.books (id) on delete cascade,
  chapter_number int  not null check (chapter_number > 0),
  scroll_pct     real not null default 0 check (scroll_pct between 0 and 1),
  note           text check (char_length(note) <= 500),
  created_at     timestamptz not null default now()
);
create index bookmarks_book_idx on public.bookmarks (book_id, chapter_number);

-- --------------------------------------------------------------- chunks
-- Passage index for retrieval. chapter_number is denormalised so the spoiler
-- filter is a cheap indexed comparison.
create table public.chunks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  book_id        uuid not null references public.books (id) on delete cascade,
  chapter_id     uuid not null references public.chapters (id) on delete cascade,
  chapter_number int  not null,
  idx            int  not null,
  content        text not null,
  fts            tsvector generated always as (to_tsvector('simple', content)) stored,
  unique (chapter_id, idx)
);
create index chunks_book_chapter_idx on public.chunks (book_id, chapter_number);
create index chunks_fts_idx on public.chunks using gin (fts);

-- -------------------------------------------------------- chat_messages
create table public.chat_messages (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  book_id        uuid not null references public.books (id) on delete cascade,
  role           text not null check (role in ('user', 'assistant')),
  content        text not null,
  -- boundary the answer was produced under, for auditing
  boundary_chapter int,
  created_at     timestamptz not null default now()
);
create index chat_book_idx on public.chat_messages (book_id, created_at);

-- ------------------------------------------------------------------ RLS
alter table public.books            enable row level security;
alter table public.volumes          enable row level security;
alter table public.chapters         enable row level security;
alter table public.reading_progress enable row level security;
alter table public.bookmarks        enable row level security;
alter table public.chunks           enable row level security;
alter table public.chat_messages    enable row level security;

create policy "own books" on public.books
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Child tables: the row must belong to the user AND point at one of their books.
do $$
declare t text;
begin
  foreach t in array array['volumes', 'chapters', 'reading_progress', 'bookmarks', 'chunks', 'chat_messages']
  loop
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using (user_id = auth.uid())
         with check (user_id = auth.uid()
           and exists (select 1 from public.books b where b.id = book_id and b.user_id = auth.uid()))',
      t);
  end loop;
end $$;

-- --------------------------------------------------- spoiler-safe search
-- The boundary is read from the caller's own reading_progress row INSIDE this
-- function. Callers cannot pass (or inflate) it. SECURITY INVOKER keeps RLS on.
create or replace function public.search_passages(
  p_book_id uuid,
  p_terms   text[],
  p_limit   int default 6
)
returns table (
  chunk_id       uuid,
  chapter_number int,
  chapter_title  text,
  content        text,
  rank           real
)
language sql
stable
security invoker
set search_path = public
as $$
  with boundary as (
    select coalesce(
      (select rp.last_read_chapter
         from public.reading_progress rp
        where rp.book_id = p_book_id and rp.user_id = auth.uid()),
      0) as max_chapter
  ),
  q as (
    select to_tsquery('simple', array_to_string(p_terms, ' | ')) as tsq
     where coalesce(array_length(p_terms, 1), 0) > 0
  )
  select c.id, c.chapter_number, ch.title, c.content,
         ts_rank_cd(c.fts, q.tsq) as rank
    from public.chunks c
    join public.chapters ch on ch.id = c.chapter_id
    cross join boundary b
    cross join q
   where c.book_id = p_book_id
     and c.user_id = auth.uid()
     and c.chapter_number <= b.max_chapter
     and c.fts @@ q.tsq
   order by rank desc, c.chapter_number desc
   limit least(greatest(p_limit, 1), 12);
$$;

revoke all on function public.search_passages(uuid, text[], int) from public, anon;
grant execute on function public.search_passages(uuid, text[], int) to authenticated;
