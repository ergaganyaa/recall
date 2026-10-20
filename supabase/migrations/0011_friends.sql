-- 0011: friends. Run AFTER 0010.
--
-- Friends can see each other's PROFILE (username, name, bio, picture) and a thin view of each other's LIBRARY:
-- book title, author, status, cover, reading progress as counts. Nothing else. Never chapter text, bookmarks, notes,
-- chat history or the reading boundary. A person can switch library sharing off.
--
--   friendships             one row per pair. Nobody changes it directly: only the functions below, which check who is asking.
--   send_friend_request     by username; asking someone who already asked you simply makes you friends
--   respond_friend_request  accept or decline a request sent to you (a declined request cannot be re-sent by the asker)
--   remove_friendship       unfriend, or cancel a request you sent
--   friends_overview        your friends, requests to you, requests from you
--   friend_profile / friend_library / friend_cover / friend_avatar_path   read-only views of a FRIEND, nothing for anyone else
--   storage policy          friends may read each other's avatar and cover images (never chapter illustrations)

alter table public.profiles add column share_library boolean not null default true;

-- ------------------------------------------------------------------------------------------------ friendships
create table public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  addressee_id uuid not null references auth.users (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> addressee_id)
);
-- one row per pair, whoever asked first
create unique index friendships_pair_idx on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index friendships_addressee_idx on public.friendships (addressee_id, status);

alter table public.friendships enable row level security;
create policy "see my friendships" on public.friendships
  for select to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());
-- No insert / update / delete policy: with row level security on, the table cannot be changed directly.

-- Are the signed-in user and p_other friends? (Only ever asks about the caller, so it cannot be used to probe others.)
create or replace function public.is_friend_of(p_other uuid) returns boolean
language sql stable security definer
set search_path = public
as $$
  select auth.uid() is not null and p_other is not null and p_other <> auth.uid()
     and exists (
       select 1 from public.friendships f
        where f.status = 'accepted'
          and ((f.requester_id = auth.uid() and f.addressee_id = p_other)
            or (f.requester_id = p_other and f.addressee_id = auth.uid()))
     );
$$;
revoke all on function public.is_friend_of(uuid) from public, anon;
grant execute on function public.is_friend_of(uuid) to authenticated;

-- ------------------------------------------------------------------------------------------ send_friend_request
-- Returns: sent | accepted | already_friends | already_requested | self | not_found | need_username | too_many | not_signed_in
create or replace function public.send_friend_request(p_username text) returns text
language plpgsql security definer
set search_path = public
as $$
declare
  me   uuid := auth.uid();
  them uuid;
  f    public.friendships%rowtype;
  open_requests int;
begin
  if me is null then return 'not_signed_in'; end if;
  select id into them from public.profiles where username = lower(trim(p_username));
  if them is null then return 'not_found'; end if;
  if them = me then return 'self'; end if;
  -- the other person must be able to see who is asking
  if not exists (select 1 from public.profiles where id = me) then return 'need_username'; end if;

  select * into f from public.friendships
   where least(requester_id, addressee_id) = least(me, them) and greatest(requester_id, addressee_id) = greatest(me, them);
  if found then
    if f.status = 'accepted' then return 'already_friends'; end if;
    if f.status = 'pending' then
      if f.requester_id = me then return 'already_requested'; end if;
      update public.friendships set status = 'accepted', responded_at = now() where id = f.id;   -- they asked me first
      return 'accepted';
    end if;
    -- declined
    if f.requester_id = me then return 'already_requested'; end if;   -- they declined me: do not reveal it, do not allow re-sending
    update public.friendships set requester_id = me, addressee_id = them, status = 'pending', responded_at = null, created_at = now()
     where id = f.id;                                                 -- I declined them earlier and now I am the one asking
    return 'sent';
  end if;

  select count(*) into open_requests from public.friendships where requester_id = me and status = 'pending';
  if open_requests >= 30 then return 'too_many'; end if;
  insert into public.friendships (requester_id, addressee_id) values (me, them);
  return 'sent';
end;
$$;
revoke all on function public.send_friend_request(text) from public, anon;
grant execute on function public.send_friend_request(text) to authenticated;

-- ------------------------------------------------------------------------------------- respond_friend_request
-- Only the person the request was sent TO can answer it. Returns accepted | declined | not_found.
create or replace function public.respond_friend_request(p_id uuid, p_accept boolean) returns text
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  update public.friendships
     set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now()
   where id = p_id and addressee_id = auth.uid() and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then return 'not_found'; end if;
  return case when p_accept then 'accepted' else 'declined' end;
end;
$$;
revoke all on function public.respond_friend_request(uuid, boolean) from public, anon;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;

-- ------------------------------------------------------------------------------------------ remove_friendship
-- Unfriend (either person) or cancel a request you sent. Declined requests stay, so they cannot be re-sent.
create or replace function public.remove_friendship(p_id uuid) returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.friendships
   where id = p_id
     and ((status = 'accepted' and (requester_id = auth.uid() or addressee_id = auth.uid()))
       or (status = 'pending' and requester_id = auth.uid()));
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke all on function public.remove_friendship(uuid) from public, anon;
grant execute on function public.remove_friendship(uuid) to authenticated;

-- --------------------------------------------------------------------------------------------- friends_overview
-- Friends (name, picture), requests TO me and requests FROM me. People who only asked get their username and name
-- shown, nothing else, until you accept.
create or replace function public.friends_overview() returns jsonb
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  mine as (
    select f.id, f.status, f.created_at, f.responded_at,
           case when f.requester_id = (select id from me) then f.addressee_id else f.requester_id end as other_id,
           (f.requester_id = (select id from me)) as i_asked
      from public.friendships f
     where f.requester_id = (select id from me) or f.addressee_id = (select id from me)
  )
  select jsonb_build_object(
    'friends', coalesce((
      select jsonb_agg(jsonb_build_object(
               'friendship_id', m.id, 'username', p.username, 'display_name', p.display_name,
               'avatar_path', p.avatar_path, 'since', m.responded_at) order by p.username)
        from mine m join public.profiles p on p.id = m.other_id
       where m.status = 'accepted'), '[]'::jsonb),
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object(
               'friendship_id', m.id, 'username', p.username, 'display_name', p.display_name, 'created_at', m.created_at)
               order by m.created_at)
        from mine m join public.profiles p on p.id = m.other_id
       where m.status = 'pending' and not m.i_asked), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object(
               'friendship_id', m.id, 'username', p.username, 'display_name', p.display_name, 'created_at', m.created_at)
               order by m.created_at)
        from mine m join public.profiles p on p.id = m.other_id
       where m.status = 'pending' and m.i_asked), '[]'::jsonb)
  );
$$;
revoke all on function public.friends_overview() from public, anon;
grant execute on function public.friends_overview() to authenticated;

-- ---------------------------------------------------------------------------------------------- friend_profile
-- A friend's profile, or null for anyone who is not a friend (including people who do not exist: same answer).
create or replace function public.friend_profile(p_username text) returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
           'username', p.username, 'display_name', p.display_name, 'bio', p.bio,
           'avatar_path', p.avatar_path, 'created_at', p.created_at, 'share_library', p.share_library,
           'friendship_id', (select f.id from public.friendships f
                              where f.status = 'accepted'
                                and ((f.requester_id = auth.uid() and f.addressee_id = p.id) or (f.requester_id = p.id and f.addressee_id = auth.uid()))))
    from public.profiles p
   where p.username = lower(trim(p_username)) and public.is_friend_of(p.id);
$$;
revoke all on function public.friend_profile(text) from public, anon;
grant execute on function public.friend_profile(text) to authenticated;

-- ---------------------------------------------------------------------------------------------- friend_library
-- A friend's library, thin: title, author, status, cover ids, and progress as COUNTS. No chapter titles or text,
-- no bookmarks, no notes, no chat, no source links, no reading boundary. Null for non-friends; {shared:false} when
-- the friend turned sharing off.
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
                             order by c.number desc limit 1)
    ) order by b.created_at desc)
      from public.books b
      left join public.reading_progress rp on rp.book_id = b.id and rp.user_id = b.user_id
     where b.user_id = them), '[]'::jsonb));
end;
$$;
revoke all on function public.friend_library(text) from public, anon;
grant execute on function public.friend_library(text) to authenticated;

-- ------------------------------------------------------------------------------- friend_cover / friend_avatar_path
-- Where a friend's cover image (a book or volume cover, never a chapter illustration) or avatar is stored.
create or replace function public.friend_cover(p_username text, p_image_id uuid) returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object('path', bi.storage_path, 'mime', bi.mime_type)
    from public.profiles p
    join public.book_images bi on bi.user_id = p.id
   where p.username = lower(trim(p_username)) and p.share_library and public.is_friend_of(p.id)
     and bi.id = p_image_id and bi.chapter_id is null;
$$;
revoke all on function public.friend_cover(text, uuid) from public, anon;
grant execute on function public.friend_cover(text, uuid) to authenticated;

create or replace function public.friend_avatar_path(p_username text) returns text
language sql stable security definer
set search_path = public
as $$
  select p.avatar_path from public.profiles p where p.username = lower(trim(p_username)) and public.is_friend_of(p.id);
$$;
revoke all on function public.friend_avatar_path(text) from public, anon;
grant execute on function public.friend_avatar_path(text) to authenticated;

-- ------------------------------------------------------------------------------------------------ storage policy
-- Friends may READ each other's avatar and cover images. Chapter illustrations (the book's content) stay private.
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
  return exists (
    select 1 from public.book_images bi
      join public.profiles p on p.id = bi.user_id
     where bi.storage_path = p_name and bi.user_id = owner and bi.chapter_id is null and p.share_library
  );
end;
$$;
revoke all on function public.friend_can_read_object(text) from public, anon;
grant execute on function public.friend_can_read_object(text) to authenticated;

create policy "book images: friends read covers and avatars" on storage.objects
  for select to authenticated
  using (bucket_id = 'book-images' and public.friend_can_read_object(name));
