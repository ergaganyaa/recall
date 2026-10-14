-- Recall: reading position INSIDE a chapter (paragraph-level spoiler boundary). Run after 0005.
--
-- Position model. Progress advances chapter by chapter, so only ONE chapter can be partly read: the
-- frontier chapter, number last_read_chapter + 1. The boundary the assistant may use is:
--     chapters 1..last_read_chapter completely  +  blocks 0..partial_read_block of the frontier chapter.
-- A "block" is one non-empty line of chapters.content (a paragraph or an image marker), numbered from 0 in
-- reading order: exactly what the reader renders (see chapter_block_lines and lib/chapter-content.ts toBlocks).

-- A counter that changes whenever a chapter's text changes. A saved position only counts for the text
-- revision it was recorded against, so re-importing a chapter can never leave a stale paragraph boundary.
alter table public.chapters add column content_rev int not null default 0;

create or replace function public.bump_content_rev() returns trigger
language plpgsql as $$
begin
  if new.content is distinct from old.content then
    new.content_rev := old.content_rev + 1;
  end if;
  return new;
end;
$$;
create trigger chapters_content_rev before update of content on public.chapters
  for each row execute function public.bump_content_rev();

alter table public.reading_progress
  add column partial_read_block int not null default -1 check (partial_read_block >= -1),
  add column partial_rev        int not null default 0,
  add column resume_block       int check (resume_block >= 0);

-- Block range of each indexed passage (null for passages indexed before this migration; those are only
-- ever used for COMPLETE chapters, where the whole chapter is allowed anyway).
alter table public.chunks add column block_first int, add column block_last int;

-- The reading position an answer was produced under, so old messages can be checked against today's position.
alter table public.chat_messages add column boundary_block int;

-- --------------------------------------------------------------- chapter_block_lines
-- Splits chapter text into blocks the same way the reader does: split on "\n", trim spaces/tabs/CR,
-- drop empty lines, number from 0.
create or replace function public.chapter_block_lines(p_content text)
returns table (idx int, line text)
language sql
immutable
as $$
  select (row_number() over (order by s.o) - 1)::int, s.l
    from (
      select btrim(t.x, E' \t\r') as l, t.o
        from unnest(string_to_array(coalesce(p_content, ''), E'\n')) with ordinality as t(x, o)
    ) s
   where s.l <> '';
$$;

-- ------------------------------------------------------------ record_reading_checkpoint
-- The ONLY validated way to move the in-chapter boundary.
--   'auto'     the reader's tracked position. Frontier chapter only, never backwards, at most
--              40 blocks per call. A client cannot jump ahead by claiming a large number.
--   'explicit' "I've read up to here": the reader's own statement. May move forward or back, and sets
--              the chapters before p_chapter as read.
-- Both check that the chapter exists, has text, the block is inside it, and the text revision matches.
create or replace function public.record_reading_checkpoint(
  p_book_id uuid,
  p_chapter int,
  p_block   int,
  p_rev     int,
  p_mode    text default 'auto'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  rp      reading_progress%rowtype;
  ch      record;
  nblocks int;
  base    int;
  target  int;
  max_step constant int := 40;
begin
  if p_mode not in ('auto', 'explicit') then
    raise exception 'Unknown mode' using errcode = '22023';
  end if;

  select * into rp from reading_progress where book_id = p_book_id and user_id = auth.uid() for update;
  if not found then
    if not exists (select 1 from books b where b.id = p_book_id and b.user_id = auth.uid()) then
      raise exception 'Book not found' using errcode = 'P0002';
    end if;
    insert into reading_progress (book_id) values (p_book_id);
    select * into rp from reading_progress where book_id = p_book_id and user_id = auth.uid() for update;
  end if;

  select c.id, c.content, c.content_rev into ch
    from chapters c where c.book_id = p_book_id and c.number = p_chapter;
  if not found or ch.content is null then
    return jsonb_build_object('applied', false, 'reason', 'no_text');
  end if;
  if ch.content_rev <> p_rev then
    return jsonb_build_object('applied', false, 'reason', 'stale_revision',
                              'rev', ch.content_rev);
  end if;

  select count(*) into nblocks from chapter_block_lines(ch.content);
  if p_block < 0 or p_block >= nblocks then
    return jsonb_build_object('applied', false, 'reason', 'block_out_of_range');
  end if;

  if p_mode = 'explicit' then
    update reading_progress
       set last_read_chapter = p_chapter - 1,
           partial_read_block = p_block,
           partial_rev = ch.content_rev,
           updated_at = now()
     where book_id = p_book_id and user_id = auth.uid();
  else
    if p_chapter <> rp.last_read_chapter + 1 then
      return jsonb_build_object('applied', false, 'reason', 'not_frontier',
                                'last_read_chapter', rp.last_read_chapter,
                                'partial_read_block', rp.partial_read_block);
    end if;
    base := case when rp.partial_rev = ch.content_rev then rp.partial_read_block else -1 end;
    if p_block <= base then
      return jsonb_build_object('applied', false, 'reason', 'not_forward',
                                'last_read_chapter', rp.last_read_chapter,
                                'partial_read_block', base);
    end if;
    target := least(p_block, base + max_step);
    update reading_progress
       set partial_read_block = target, partial_rev = ch.content_rev, updated_at = now()
     where book_id = p_book_id and user_id = auth.uid();
  end if;

  select * into rp from reading_progress where book_id = p_book_id and user_id = auth.uid();
  return jsonb_build_object('applied', true,
                            'last_read_chapter', rp.last_read_chapter,
                            'partial_read_block', rp.partial_read_block);
end;
$$;

revoke all on function public.record_reading_checkpoint(uuid, int, int, int, text) from public, anon;
grant execute on function public.record_reading_checkpoint(uuid, int, int, int, text) to authenticated;

-- ---------------------------------------------------------------- assistant_context
-- Replaces the chapter-level version (same signature). New: the frontier chapter contributes ONLY its
-- paragraphs up to the confirmed/tracked block, read straight from chapters.content here in SQL, so
-- nothing after the boundary ever leaves the database and nothing relies on the model ignoring it.
create or replace function public.assistant_context(
  p_book_id     uuid,
  p_terms       text[],
  p_limit       int default 8,
  p_per_chapter int default 2
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
  q as (
    select to_tsquery('simple', array_to_string(p_terms, ' | ')) as tsq
     where coalesce(array_length(p_terms, 1), 0) > 0
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
  cur_text as (
    select cur.chapter_id, cur.number, cur.title, cur.volume_number, cur.volume_title, cur.arc, b.idx, b.line
      from cur
      cross join lateral chapter_block_lines(cur.content) b
     where b.idx <= cur.pb                                              -- the paragraph-level boundary
       and b.line !~ '^\[\[image:[0-9a-fA-F-]{36}\]\]$'                 -- image markers are not text
  ),
  cur_win as (
    select t.*, lag(t.idx) over w as prev_idx, lag(t.line) over w as prev_line
      from cur_text t
    window w as (order by t.idx)
  ),
  cur_hits as (
    select (w.chapter_id::text || ':' || w.idx::text) as chunk_id, w.chapter_id, w.number as chapter_number,
           w.title as chapter_title, w.volume_number, w.volume_title, w.arc,
           case when w.prev_line is null then w.line else w.prev_line || E'\n' || w.line end as content,
           ts_rank_cd(to_tsvector('simple', w.line), q.tsq) as rank,
           coalesce(w.prev_idx, w.idx) as block_first,
           w.idx as block_last
      from cur_win w
      cross join q
     where to_tsvector('simple', w.line) @@ q.tsq
  ),
  chunk_hits as (
    select c.id::text as chunk_id, c.chapter_id, c.chapter_number, ch.title as chapter_title,
           v.number as volume_number, v.title as volume_title, v.arc, c.content,
           ts_rank_cd(c.fts, q.tsq) as rank, c.block_first, c.block_last
      from chunks c
      join chapters ch on ch.id = c.chapter_id
      left join volumes v on v.id = ch.volume_id
      cross join prog p
      cross join q
     where c.book_id = p_book_id
       and c.user_id = auth.uid()
       and p.n is not null
       and c.chapter_number <= p.n                                       -- COMPLETE chapters only
       and c.fts @@ q.tsq
  ),
  hits as (
    select * from chunk_hits
    union all
    select * from cur_hits
  ),
  ranked as (
    select h.*, row_number() over (partition by h.chapter_id order by h.rank desc, h.block_last nulls last) as rn
      from hits h
  ),
  top as (
    select * from ranked
     where rn <= least(greatest(p_per_chapter, 1), 4)
     order by rank desc, chapter_number desc
     limit least(greatest(p_limit, 1), 12)
  )
  select jsonb_build_object(
    'boundary', (select n from prog),
    'partial_block', case when exists (select 1 from cur) then (select pb from prog) else -1 end,
    'passages', coalesce((select jsonb_agg(to_jsonb(top) order by top.rank desc, top.chapter_number desc) from top), '[]'::jsonb)
  );
$$;

revoke all on function public.assistant_context(uuid, text[], int, int) from public, anon;
grant execute on function public.assistant_context(uuid, text[], int, int) to authenticated;
