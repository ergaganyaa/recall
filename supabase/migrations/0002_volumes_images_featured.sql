-- Recall: decimal volumes + arcs, illustrations, featured book, ordered volume import.
-- Run after 0001_init.sql.

-- ------------------------------------------------------------- volumes
-- number is numeric so side-story volumes like 4.5 / 7.5 work. (arc_order, number)
-- is the reading order: arcs such as school years restart volume numbering.
alter table public.volumes drop constraint if exists volumes_book_id_number_key;
alter table public.volumes drop constraint if exists volumes_number_check;
alter table public.volumes alter column number type numeric(7, 2) using number::numeric;
alter table public.volumes add constraint volumes_number_positive check (number > 0);
alter table public.volumes add column arc       text check (char_length(arc) <= 120);
alter table public.volumes add column arc_order int  not null default 1 check (arc_order between 1 and 99);
alter table public.volumes add column language  text check (char_length(language) <= 20);
alter table public.volumes add constraint volumes_position_key unique (book_id, arc_order, number);

-- ------------------------------------------------------------- chapters
-- image_count lets us tell "illustrations only" apart from "metadata only".
alter table public.chapters add column image_count int not null default 0 check (image_count >= 0);
-- Deferred so a whole range can be renumbered in one statement.
alter table public.chapters drop constraint chapters_book_id_number_key;
alter table public.chapters
  add constraint chapters_book_number_key unique (book_id, number) deferrable initially deferred;

-- ---------------------------------------------------------------- books
alter table public.books add column is_featured boolean not null default false;
alter table public.books add column language text check (char_length(language) <= 20);
create unique index books_one_featured_per_user on public.books (user_id) where is_featured;

-- ---------------------------------------------------------- book_images
-- One row per stored image. chapter_id is null for a book cover. The bytes live
-- in the private Storage bucket `book-images` at storage_path.
create table public.book_images (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  book_id      uuid not null references public.books (id) on delete cascade,
  chapter_id   uuid references public.chapters (id) on delete cascade,
  position     int  not null default 0 check (position >= 0),
  storage_path text not null check (char_length(storage_path) <= 400),
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif')),
  width        int  check (width > 0),
  height       int  check (height > 0),
  bytes        int  check (bytes >= 0),
  alt          text check (char_length(alt) <= 500),
  created_at   timestamptz not null default now()
);
create index book_images_chapter_idx on public.book_images (chapter_id, position);
create index book_images_book_idx on public.book_images (book_id);

alter table public.books add column cover_image_id uuid references public.book_images (id) on delete set null;

alter table public.book_images enable row level security;
create policy "own rows" on public.book_images
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
    and exists (select 1 from public.books b where b.id = book_id and b.user_id = auth.uid()));

-- -------------------------------------------------------- set_featured_book
create or replace function public.set_featured_book(p_book_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (select 1 from books b where b.id = p_book_id and b.user_id = auth.uid()) then
    raise exception 'Book not found' using errcode = 'P0002';
  end if;
  update books set is_featured = false where user_id = auth.uid() and is_featured;
  update books set is_featured = true where id = p_book_id and user_id = auth.uid();
end;
$$;

-- ------------------------------------------------------------ insert_volume
-- Creates a volume and its chapters in reading order. If the volume belongs
-- before existing volumes, the later chapters are renumbered and everything
-- keyed by chapter number (passages, bookmarks, reading progress) moves with
-- them, so the reader's position keeps pointing at the same chapter.
create or replace function public.insert_volume(
  p_book_id  uuid,
  p_arc      text,
  p_arc_order int,
  p_number   numeric,
  p_title    text,
  p_language text,
  p_chapters jsonb
)
returns table (volume_id uuid, chapter_id uuid, chapter_number int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  k       int;
  start_n int;
  vid     uuid;
begin
  if p_chapters is null or jsonb_typeof(p_chapters) <> 'array' then
    raise exception 'Chapters must be a list' using errcode = '22023';
  end if;
  k := jsonb_array_length(p_chapters);
  if k < 1 then
    raise exception 'A volume needs at least one chapter' using errcode = '22023';
  end if;
  if k > 3000 then
    raise exception 'Too many chapters in one volume' using errcode = '22023';
  end if;
  if not exists (select 1 from books b where b.id = p_book_id and b.user_id = auth.uid()) then
    raise exception 'Book not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from volumes v
              where v.book_id = p_book_id and v.arc_order = p_arc_order and v.number = p_number) then
    raise exception 'That volume already exists' using errcode = '23505';
  end if;

  -- First chapter that belongs to a LATER volume = where the new volume slots in.
  select min(c.number) into start_n
    from chapters c
    join volumes v on v.id = c.volume_id
   where c.book_id = p_book_id
     and (v.arc_order, v.number) > (p_arc_order, p_number);

  if start_n is null then
    select coalesce(max(c.number), 0) + 1 into start_n from chapters c where c.book_id = p_book_id;
  else
    update chapters c set number = c.number + k where c.book_id = p_book_id and c.number >= start_n;
    update chunks ch set chapter_number = ch.chapter_number + k
     where ch.book_id = p_book_id and ch.chapter_number >= start_n;
    update bookmarks bm set chapter_number = bm.chapter_number + k
     where bm.book_id = p_book_id and bm.chapter_number >= start_n;
    update reading_progress rp set
        last_read_chapter = case when rp.last_read_chapter >= start_n then rp.last_read_chapter + k
                                 else rp.last_read_chapter end,
        current_chapter   = case when rp.current_chapter >= start_n then rp.current_chapter + k
                                 else rp.current_chapter end
     where rp.book_id = p_book_id;
  end if;

  insert into volumes (book_id, number, title, arc, arc_order, language)
  values (p_book_id, p_number, left(p_title, 300), left(p_arc, 120), p_arc_order, left(p_language, 20))
  returning id into vid;

  return query
  with ins as (
    insert into chapters (book_id, volume_id, number, title, source_url)
    select p_book_id, vid, start_n + (e.ord - 1)::int,
           left(coalesce(nullif(e.item ->> 'title', ''), 'Untitled'), 300),
           nullif(e.item ->> 'source_url', '')
      from jsonb_array_elements(p_chapters) with ordinality as e(item, ord)
    returning chapters.volume_id, chapters.id, chapters.number
  )
  select ins.volume_id, ins.id, ins.number from ins order by ins.number;
end;
$$;

-- ------------------------------------------------------------ delete_volume
-- Removes a volume and its chapters (passages and image rows cascade), closes the
-- numbering gap, and moves reading progress so it keeps pointing at the same
-- chapter. Callers must delete the Storage objects for the volume's images first.
create or replace function public.delete_volume(p_volume_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  b  uuid;
  lo int;
  hi int;
  k  int;
  remaining int;
begin
  select v.book_id into b from volumes v where v.id = p_volume_id and v.user_id = auth.uid();
  if b is null then
    raise exception 'Volume not found' using errcode = 'P0002';
  end if;

  select min(c.number), max(c.number), count(*) into lo, hi, k
    from chapters c where c.volume_id = p_volume_id;

  if k > 0 then
    if hi - lo + 1 <> k then
      raise exception 'Volume chapters are not contiguous' using errcode = '22023';
    end if;

    delete from bookmarks bm where bm.book_id = b and bm.chapter_number between lo and hi;
    delete from chapters c where c.volume_id = p_volume_id;

    update chapters c set number = c.number - k where c.book_id = b and c.number > hi;
    update chunks ch set chapter_number = ch.chapter_number - k where ch.book_id = b and ch.chapter_number > hi;
    update bookmarks bm set chapter_number = bm.chapter_number - k where bm.book_id = b and bm.chapter_number > hi;

    select count(*) into remaining from chapters c where c.book_id = b;
    update reading_progress rp set
        last_read_chapter = case when rp.last_read_chapter > hi then rp.last_read_chapter - k
                                 when rp.last_read_chapter >= lo then lo - 1
                                 else rp.last_read_chapter end,
        current_chapter   = case when remaining = 0 then 1
                                 when rp.current_chapter > hi then rp.current_chapter - k
                                 when rp.current_chapter >= lo then least(greatest(lo, 1), remaining)
                                 else rp.current_chapter end
     where rp.book_id = b;
  end if;

  delete from volumes v where v.id = p_volume_id;
end;
$$;

revoke all on function public.set_featured_book(uuid) from public, anon;
revoke all on function public.insert_volume(uuid, text, int, numeric, text, text, jsonb) from public, anon;
revoke all on function public.delete_volume(uuid) from public, anon;
grant execute on function public.set_featured_book(uuid) to authenticated;
grant execute on function public.insert_volume(uuid, text, int, numeric, text, text, jsonb) to authenticated;
grant execute on function public.delete_volume(uuid) to authenticated;
