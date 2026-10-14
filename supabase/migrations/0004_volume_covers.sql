-- Recall: per-volume covers and import timestamps. Run after 0003.
--
-- Cover model (nothing about the automatic cover is stored on the book):
--   * books.cover_image_id  = a cover the user CHOSE. If set, it always wins.
--   * otherwise the book shows the cover of the volume with the latest imported_at that has a cover,
--     computed when reading (see lib/cover.ts). So it is correct after refresh, after a volume is
--     deleted, and a failed import (imported_at stays null) can never change it.

alter table public.volumes add column imported_at     timestamptz;
alter table public.volumes add column cover_image_id  uuid references public.book_images (id) on delete set null;
create index volumes_book_imported_idx on public.volumes (book_id, imported_at desc);

-- Existing volumes whose chapters all have content count as successfully imported.
update public.volumes v
   set imported_at = now()
 where exists (select 1 from public.chapters c where c.volume_id = v.id)
   and not exists (
     select 1 from public.chapters c
      where c.volume_id = v.id and c.word_count = 0 and c.image_count = 0
   );

-- delete_volume now also removes the volume's cover image row (Storage objects are removed by the caller).
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

  delete from book_images bi
   where bi.id = (select v.cover_image_id from volumes v where v.id = p_volume_id);
  delete from volumes v where v.id = p_volume_id;
end;
$$;

revoke all on function public.delete_volume(uuid) from public, anon;
grant execute on function public.delete_volume(uuid) to authenticated;
