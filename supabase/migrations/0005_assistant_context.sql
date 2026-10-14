-- Recall: context retrieval for the AI assistant. Run after 0004.
--
-- assistant_context() is the ONLY thing the assistant uses to read book text. It keeps the exact guarantees of
-- search_passages() and adds what answers need:
--   * the reading boundary is read from the CALLER'S OWN reading_progress row inside this function
--     (a caller cannot pass, raise or inflate it), and every passage is filtered by it in SQL;
--   * ownership is verified: a book the caller does not own yields boundary = NULL and no passages;
--   * the boundary and the passages come from ONE statement (one snapshot), so they cannot disagree;
--   * each passage carries volume and chapter metadata for citations;
--   * at most p_per_chapter passages per chapter, so one chapter cannot crowd out the others.
-- SECURITY INVOKER keeps row level security on every table it touches.

alter table public.chat_messages add column sources jsonb;
create index chat_user_time_idx on public.chat_messages (user_id, created_at desc);

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
  boundary as (
    select case
             when exists (select 1 from owned) then coalesce(
               (select rp.last_read_chapter
                  from reading_progress rp
                 where rp.book_id = p_book_id and rp.user_id = auth.uid()),
               0)
           end as n
  ),
  q as (
    select to_tsquery('simple', array_to_string(p_terms, ' | ')) as tsq
     where coalesce(array_length(p_terms, 1), 0) > 0
  ),
  hits as (
    select c.id            as chunk_id,
           c.chapter_id,
           c.chapter_number,
           ch.title        as chapter_title,
           v.number        as volume_number,
           v.title         as volume_title,
           v.arc           as arc,
           c.content,
           ts_rank_cd(c.fts, q.tsq) as rank,
           row_number() over (partition by c.chapter_id order by ts_rank_cd(c.fts, q.tsq) desc, c.idx) as rn
      from chunks c
      join chapters ch on ch.id = c.chapter_id
      left join volumes v on v.id = ch.volume_id
      cross join boundary b
      cross join q
     where c.book_id = p_book_id
       and c.user_id = auth.uid()
       and b.n is not null
       and c.chapter_number <= b.n           -- the spoiler boundary, applied BEFORE anything is returned
       and c.fts @@ q.tsq
  ),
  top as (
    select * from hits
     where rn <= least(greatest(p_per_chapter, 1), 4)
     order by rank desc, chapter_number desc
     limit least(greatest(p_limit, 1), 12)
  )
  select jsonb_build_object(
    'boundary', (select n from boundary),
    'passages', coalesce((select jsonb_agg(to_jsonb(top) order by top.rank desc, top.chapter_number desc) from top), '[]'::jsonb)
  );
$$;

revoke all on function public.assistant_context(uuid, text[], int, int) from public, anon;
grant execute on function public.assistant_context(uuid, text[], int, int) to authenticated;
