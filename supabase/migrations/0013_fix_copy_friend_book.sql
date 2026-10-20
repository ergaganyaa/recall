-- 0013: fix adding a friend's novel on Supabase. Run AFTER 0012.
--
-- Supabase loads the pg-safeupdate extension for API requests: it refuses any UPDATE or DELETE that has no WHERE
-- clause, even inside a database function. copy_friend_book (0012) had one such statement (filling in the new picture
-- file paths), so adding a novel failed with "UPDATE requires a WHERE clause" (error 21000). This replaces the
-- function with one that computes the paths while building the table instead. Nothing else changes.

create or replace function public.copy_friend_book(p_owner_username text, p_book_id uuid) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  owner uuid;
  src public.books%rowtype;
  existing record;
  newbook uuid := gen_random_uuid();
  n_img int;
  n_ch int;
  r record;
  files jsonb;
begin
  if me is null then return jsonb_build_object('error', 'not_signed_in'); end if;

  select p.id into owner from public.profiles p where p.username = lower(trim(p_owner_username)) and p.share_library;
  if owner is null or not public.is_friend_of(owner) then return jsonb_build_object('error', 'not_found'); end if;
  select * into src from public.books b where b.id = p_book_id and b.user_id = owner and b.shared_with_friends;
  if not found then return jsonb_build_object('error', 'not_found'); end if;

  select b.id, b.slug into existing from public.books b where b.user_id = me and b.copied_from = src.id limit 1;
  if found then return jsonb_build_object('error', 'already_added', 'book_id', existing.id, 'slug', existing.slug); end if;

  select count(*) into n_img from public.book_images where book_id = src.id;
  select count(*) into n_ch from public.chapters where book_id = src.id;
  if n_img > 400 or n_ch > 3000 then return jsonb_build_object('error', 'too_large'); end if;

  -- the book itself: public details only; the copy is yours, unread, and not featured
  insert into public.books (id, user_id, title, author, description, cover_url, status, language, copied_from)
  values (newbook, me, src.title, src.author, src.description, src.cover_url, 'plan_to_read', src.language, src.id);
  insert into public.reading_progress (book_id, user_id) values (newbook, me);

  -- old id -> new id maps
  drop table if exists pg_temp.copy_vmap; drop table if exists pg_temp.copy_cmap; drop table if exists pg_temp.copy_imap;
  create temp table copy_vmap on commit drop as
    select v.id as old_id, gen_random_uuid() as new_id from public.volumes v where v.book_id = src.id;
  create temp table copy_cmap on commit drop as
    select c.id as old_id, gen_random_uuid() as new_id from public.chapters c where c.book_id = src.id;
  -- The new file path is computed here, in the same statement (Supabase's pg-safeupdate refuses an UPDATE without
  -- a WHERE clause, which is what this used to be).
  create temp table copy_imap on commit drop as
    select s.old_id, s.new_id, s.old_path, s.mime, s.new_chapter,
           me::text || '/' || newbook::text || '/' || s.new_id::text || '.' || regexp_replace(s.old_path, '^.*\.', '') as new_path
      from (
        select bi.id as old_id, gen_random_uuid() as new_id, bi.storage_path as old_path, bi.mime_type as mime,
               cm.new_id as new_chapter
          from public.book_images bi
          left join copy_cmap cm on cm.old_id = bi.chapter_id
         where bi.book_id = src.id
      ) s;

  insert into public.volumes (id, user_id, book_id, number, title, arc, arc_order, language, imported_at)
    select m.new_id, me, newbook, v.number, v.title, v.arc, v.arc_order, v.language, v.imported_at
      from public.volumes v join copy_vmap m on m.old_id = v.id;

  insert into public.chapters (id, user_id, book_id, volume_id, number, title, content, word_count, image_count)
    select m.new_id, me, newbook, vm.new_id, c.number, c.title, c.content, c.word_count, c.image_count
      from public.chapters c
      join copy_cmap m on m.old_id = c.id
      left join copy_vmap vm on vm.old_id = c.volume_id
     where c.book_id = src.id;

  insert into public.book_images (id, user_id, book_id, chapter_id, position, storage_path, mime_type, width, height, bytes, alt)
    select m.new_id, me, newbook, m.new_chapter, bi.position, m.new_path, bi.mime_type, bi.width, bi.height, bi.bytes, bi.alt
      from public.book_images bi join copy_imap m on m.old_id = bi.id;

  -- the text points at pictures by id ([[image:<id>]]): point each at the copy's own picture
  for r in select old_id, new_id, new_chapter from copy_imap where new_chapter is not null loop
    update public.chapters set content = replace(content, r.old_id::text, r.new_id::text) where id = r.new_chapter;
  end loop;

  -- covers
  update public.volumes v set cover_image_id = im.new_id
    from public.volumes ov
    join copy_vmap vm on vm.old_id = ov.id
    join copy_imap im on im.old_id = ov.cover_image_id
   where v.id = vm.new_id;
  update public.books set cover_image_id = (select im.new_id from copy_imap im where im.old_id = src.cover_image_id) where id = newbook;

  -- the search index, so the copy works with the assistant straight away
  insert into public.chunks (user_id, book_id, chapter_id, chapter_number, idx, content, block_first, block_last)
    select me, newbook, cm.new_id, c.chapter_number, c.idx, c.content, c.block_first, c.block_last
      from public.chunks c join copy_cmap cm on cm.old_id = c.chapter_id
     where c.book_id = src.id;

  select coalesce(jsonb_agg(jsonb_build_object('from', old_path, 'to', new_path, 'mime', mime)), '[]'::jsonb) into files from copy_imap;
  return jsonb_build_object('book_id', newbook, 'slug', (select slug from public.books where id = newbook), 'images', files);
end;
$$;
revoke all on function public.copy_friend_book(text, uuid) from public, anon;
grant execute on function public.copy_friend_book(text, uuid) to authenticated;
