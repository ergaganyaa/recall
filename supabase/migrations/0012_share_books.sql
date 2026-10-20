-- 0012: share a novel with friends, and add a friend's novel to your own library. Run AFTER 0011.
--
-- Every book is PRIVATE by default. An owner switches sharing on for a single book (books.shared_with_friends). Only
-- then can a confirmed friend (who also has library sharing on) add it. "Adding" makes an independent COPY owned by
-- the friend: text, chapter structure, search index, illustrations and covers. The copy starts with fresh progress and
-- none of the owner's bookmarks, notes, chat or reading position. Nothing is linked, so deleting either copy never
-- affects the other.
--
--   copy_friend_book()      copies the rows inside the database, atomically, and returns which image files to copy
--   friend_library()        now also says which of a friend's books are shareable, and which you already added
--   storage policy          friends may read the chapter pictures of SHARED books too (so the server can copy them)

alter table public.books add column shared_with_friends boolean not null default false;
-- Where a copy came from (just the source book's id, so the same book is not added twice).
alter table public.books add column copied_from uuid;
create index books_copied_from_idx on public.books (user_id, copied_from) where copied_from is not null;

-- ------------------------------------------------------------------------------------------------ storage policy
create or replace function public.friend_can_read_object(p_name text) returns boolean
language plpgsql stable security definer
set search_path = public, storage
as $$
declare owner uuid;
begin
  begin
    owner := ((storage.foldername(p_name))[1])::uuid;
  exception when others then
    return false;
  end;
  if owner is null or not public.is_friend_of(owner) then return false; end if;
  if p_name like owner::text || '/avatar/%' then return true; end if;
  -- covers: any friend of someone who shares their library. Chapter pictures: only books marked as shared.
  return exists (
    select 1 from public.book_images bi
      join public.books b on b.id = bi.book_id
      join public.profiles p on p.id = bi.user_id
     where bi.storage_path = p_name and bi.user_id = owner and p.share_library
       and (bi.chapter_id is null or b.shared_with_friends)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------- friend_library
create or replace function public.friend_library(p_username text) returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare them uuid; shared boolean;
begin
  select p.id, p.share_library into them, shared from public.profiles p where p.username = lower(trim(p_username));
  if them is null or not public.is_friend_of(them) then return null; end if;
  if not shared then return jsonb_build_object('shared', false, 'books', '[]'::jsonb); end if;
  return jsonb_build_object('shared', true, 'books', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'title', b.title, 'author', b.author, 'status', b.status,
      'cover_image_id', b.cover_image_id, 'cover_url', b.cover_url,
      'volumes', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', v.id, 'number', v.number, 'arc_order', v.arc_order, 'imported_at', v.imported_at,
                    'cover_image_id', v.cover_image_id) order by v.arc_order, v.number)
                   from public.volumes v where v.book_id = b.id), '[]'::jsonb),
      'current_chapter', rp.current_chapter,
      'finished', coalesce(rp.last_read_chapter, 0),
      'total', (select count(*) from public.chapters c where c.book_id = b.id),
      'reading_volume_id', (select c.volume_id from public.chapters c
                             where c.book_id = b.id and c.volume_id is not null and c.number <= coalesce(rp.current_chapter, 0)
                             order by c.number desc limit 1),
      'shareable', b.shared_with_friends,
      -- the signed-in user's own copy of this book, if they already added it
      'my_slug', (select m.slug from public.books m where m.user_id = auth.uid() and m.copied_from = b.id limit 1)
    ) order by b.created_at desc)
      from public.books b
      left join public.reading_progress rp on rp.book_id = b.id and rp.user_id = b.user_id
     where b.user_id = them), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------- copy_friend_book
-- Returns {book_id, slug, images:[{from, to, mime}]} on success, or {error: not_signed_in | not_found | already_added |
-- too_large}. "not_found" covers every reason you are not allowed (not a friend, not shared, library hidden, no such
-- book), so it reveals nothing. The caller's own limits: a book of at most 3000 chapters and 400 pictures.
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
  create temp table copy_imap on commit drop as
    select bi.id as old_id, gen_random_uuid() as new_id, bi.storage_path as old_path, bi.mime_type as mime,
           cm.new_id as new_chapter, ''::text as new_path
      from public.book_images bi
      left join copy_cmap cm on cm.old_id = bi.chapter_id
     where bi.book_id = src.id;
  update copy_imap set new_path = me::text || '/' || newbook::text || '/' || new_id::text || '.' || regexp_replace(old_path, '^.*\.', '');

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
