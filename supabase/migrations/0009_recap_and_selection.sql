-- 0009: Reading recap and "Ask about this passage". Run AFTER 0008. Two read-only functions, no table changes.
--
-- Both are SECURITY INVOKER (row level security applies) and read the caller's OWN reading_progress row inside
-- the function, exactly like assistant_context. Neither takes a boundary as an argument, so a caller cannot raise it.
--
--   recap_context      the most RECENT text inside the boundary (the last chunks of the latest finished chapters
--                      plus the last few paragraphs read of the current chapter), in reading order.
--   selection_context  the text of a few paragraphs the reader selected, read from chapters.content here in SQL
--                      (the browser's own copy of the text is never used). Anything beyond the boundary is rejected,
--                      except a small "on screen" allowance in the chapter being read (see below).

-- ----------------------------------------------------------------------------------------------- recap_context
create or replace function public.recap_context(
  p_book_id  uuid,
  p_chapters int default 3,
  p_chunks   int default 2,
  p_blocks   int default 6
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with owned as (
    select 1 as ok from books b where b.id = p_book_id and b.user_id = auth.uid()
  ),
  prog as (
    select case
             when exists (select 1 from owned) then coalesce(
               (select rp.last_read_chapter from reading_progress rp
                 where rp.book_id = p_book_id and rp.user_id = auth.uid()), 0)
           end as n,
           (select rp.partial_read_block from reading_progress rp
             where rp.book_id = p_book_id and rp.user_id = auth.uid()) as pb,
           (select rp.partial_rev from reading_progress rp
             where rp.book_id = p_book_id and rp.user_id = auth.uid()) as prev
  ),
  -- the chapter being read now, only if a position was recorded for its CURRENT text revision
  cur as (
    select ch.id as chapter_id, ch.number, ch.title, ch.content,
           v.number as volume_number, v.title as volume_title, v.arc, p.pb
      from prog p
      join chapters ch on ch.book_id = p_book_id and ch.number = p.n + 1
      left join volumes v on v.id = ch.volume_id
     where p.n is not null
       and coalesce(p.pb, -1) >= 0
       and ch.content is not null
       and ch.content_rev = p.prev
  ),
  cur_last as (
    select cur.chapter_id, cur.number, cur.title, cur.volume_number, cur.volume_title, cur.arc, b.idx, b.line
      from cur
      cross join lateral chapter_block_lines(cur.content) b
     where b.idx <= cur.pb                                              -- the paragraph-level boundary
       and b.line !~ '^\[\[image:[0-9a-fA-F-]{36}\]\]$'
     order by b.idx desc
     limit greatest(least(p_blocks, 12), 1)
  ),
  cur_passage as (
    select (chapter_id::text || ':recap') as chunk_id, chapter_id, number as chapter_number, title as chapter_title,
           volume_number, volume_title, arc,
           string_agg(line, E'\n' order by idx) as content,
           1.0::float8 as rank, min(idx) as block_first, max(idx) as block_last, max(idx) as ord
      from cur_last
     group by chapter_id, number, title, volume_number, volume_title, arc
  ),
  recent_chapters as (
    select distinct c.chapter_number
      from chunks c
      cross join prog p
     where c.book_id = p_book_id and c.user_id = auth.uid()
       and p.n is not null
       and c.chapter_number <= p.n                                      -- COMPLETE chapters only
     order by c.chapter_number desc
     limit greatest(least(p_chapters, 6), 1)
  ),
  chunk_last as (
    select c.id::text as chunk_id, c.chapter_id, c.chapter_number, ch.title as chapter_title,
           v.number as volume_number, v.title as volume_title, v.arc, c.content,
           1.0::float8 as rank, c.block_first, c.block_last, c.idx as ord,
           row_number() over (partition by c.chapter_id order by c.idx desc) as rn
      from chunks c
      join chapters ch on ch.id = c.chapter_id
      left join volumes v on v.id = ch.volume_id
      cross join prog p
     where c.book_id = p_book_id and c.user_id = auth.uid()
       and p.n is not null
       and c.chapter_number <= p.n
       and c.chapter_number in (select chapter_number from recent_chapters)
  ),
  picked as (
    select chunk_id, chapter_id, chapter_number, chapter_title, volume_number, volume_title, arc, content,
           rank, block_first, block_last, ord
      from chunk_last where rn <= greatest(least(p_chunks, 4), 1)
    union all
    select chunk_id, chapter_id, chapter_number, chapter_title, volume_number, volume_title, arc, content,
           rank, block_first, block_last, ord
      from cur_passage
  )
  select jsonb_build_object(
    'boundary', (select n from prog),
    'partial_block', case when exists (select 1 from cur) then (select pb from prog) else -1 end,
    'passages', coalesce(
      (select jsonb_agg(to_jsonb(x) - 'ord' order by x.chapter_number, x.ord) from picked x),
      '[]'::jsonb)
  );
$$;

revoke all on function public.recap_context(uuid, int, int, int) from public, anon;
grant execute on function public.recap_context(uuid, int, int, int) to authenticated;

-- ------------------------------------------------------------------------------------------ selection_context
-- What the reader selected: paragraphs p_from..p_to (at most 3) of chapter p_chapter, for the chapter text revision
-- p_rev. The TEXT is read here from chapters.content; nothing the browser sends is used as text.
--
-- Allowed:
--   * any chapter the reader has finished (re-reading);
--   * in the chapter being read (the one after the last finished): paragraphs up to the recorded boundary PLUS an
--     "on screen" allowance of 20 paragraphs, because the paragraph a reader selects is, by the reading rule, the
--     one they are looking at right now and so not yet counted as read. The allowance is only for the selection
--     itself: retrieval, history and recaps still stop at the boundary.
-- Rejected: a later chapter, paragraphs further ahead than the allowance, a different text revision, or a
-- selection of more than 3 paragraphs. Returns {ok:false, reason} instead of raising, so nothing leaks via errors.
create or replace function public.selection_context(
  p_book_id uuid,
  p_chapter int,
  p_from    int,
  p_to      int,
  p_rev     int
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  n   int;
  pb  int;
  prv int;
  ch  record;
  eff int;          -- the recorded boundary for THIS chapter's current revision (-1 = none)
  allowed_max int;
  to_eff int;
  texts jsonb;
  screen constant int := 20;
  span   constant int := 2;   -- p_to - p_from at most 2 = three paragraphs
begin
  if not exists (select 1 from books b where b.id = p_book_id and b.user_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select rp.last_read_chapter, rp.partial_read_block, rp.partial_rev into n, pb, prv
    from reading_progress rp where rp.book_id = p_book_id and rp.user_id = auth.uid();
  n := coalesce(n, 0);

  if p_chapter is null or p_from is null or p_to is null or p_rev is null
     or p_from < 0 or p_to < p_from or p_to - p_from > span or p_chapter < 1 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_chapter > n + 1 then
    return jsonb_build_object('ok', false, 'reason', 'ahead');
  end if;

  select c.id as chapter_id, c.number, c.title, c.content, c.content_rev,
         v.number as volume_number, v.title as volume_title
    into ch
    from chapters c left join volumes v on v.id = c.volume_id
   where c.book_id = p_book_id and c.number = p_chapter;
  if not found or ch.content is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if ch.content_rev <> p_rev then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;

  eff := case when p_chapter = n + 1 and prv = ch.content_rev then coalesce(pb, -1) else -1 end;
  allowed_max := case when p_chapter <= n then 2147483647 else eff + screen end;
  if p_from > allowed_max then
    return jsonb_build_object('ok', false, 'reason', 'far');
  end if;
  to_eff := least(p_to, allowed_max);

  select jsonb_agg(jsonb_build_object('idx', b.idx, 'line', left(b.line, 1500)) order by b.idx) into texts
    from chapter_block_lines(ch.content) b
   where b.idx between p_from and to_eff
     and b.line !~ '^\[\[image:[0-9a-fA-F-]{36}\]\]$';
  if texts is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  return jsonb_build_object(
    'ok', true,
    'chapter_number', ch.number,
    'chapter_title', ch.title,
    'volume_number', ch.volume_number,
    'volume_title', ch.volume_title,
    'block_first', p_from,
    'block_last', to_eff,
    'clipped', to_eff < p_to,
    'texts', texts,
    'boundary', n,
    'partial_block', eff,
    'is_current_chapter', p_chapter = n + 1
  );
end;
$$;

revoke all on function public.selection_context(uuid, int, int, int, int) from public, anon;
grant execute on function public.selection_context(uuid, int, int, int, int) to authenticated;
