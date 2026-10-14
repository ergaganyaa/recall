-- 0007: the reading boundary follows the reader's scroll position.
-- Run AFTER 0006. Replaces record_reading_checkpoint only; no table changes.
--
-- Rule: everything above the top edge of the reading viewport is read; what is visible, and everything
-- below it, is not. The reader reports the paragraph ("block") just above that edge (-1 = none).
--
-- The database does not try to verify HOW the reader got there (jumping to the middle of a chapter is
-- legitimate), but it validates WHAT is reported against the real data:
--   * the book belongs to the caller (RLS + explicit check);
--   * only the frontier chapter (last_read_chapter + 1) can have a partial position - any other chapter is
--     refused, so the report can never open a chapter that is not next in line;
--   * the chapter has text, the block number exists in it, and the text revision matches;
--   * the position may move in BOTH directions, so scrolling back takes effect on the next request.
-- assistant_context (unchanged) is what actually limits retrieval; it takes no boundary argument.

drop function if exists public.record_reading_checkpoint(uuid, int, int, int, text);

create or replace function public.record_reading_checkpoint(
  p_book_id uuid,
  p_chapter int,
  p_block   int,
  p_rev     int
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
begin
  select * into rp from reading_progress where book_id = p_book_id and user_id = auth.uid() for update;
  if not found then
    if not exists (select 1 from books b where b.id = p_book_id and b.user_id = auth.uid()) then
      raise exception 'Book not found' using errcode = 'P0002';
    end if;
    insert into reading_progress (book_id) values (p_book_id);
    select * into rp from reading_progress where book_id = p_book_id and user_id = auth.uid() for update;
  end if;

  if p_chapter <> rp.last_read_chapter + 1 then
    return jsonb_build_object('applied', false, 'reason', 'not_frontier',
                              'last_read_chapter', rp.last_read_chapter,
                              'partial_read_block', rp.partial_read_block);
  end if;

  select c.id, c.content, c.content_rev into ch
    from chapters c where c.book_id = p_book_id and c.number = p_chapter;
  if not found or ch.content is null then
    return jsonb_build_object('applied', false, 'reason', 'no_text');
  end if;
  if ch.content_rev <> p_rev then
    return jsonb_build_object('applied', false, 'reason', 'stale_revision', 'rev', ch.content_rev);
  end if;

  select count(*) into nblocks from chapter_block_lines(ch.content);
  if p_block < -1 or p_block >= nblocks then
    return jsonb_build_object('applied', false, 'reason', 'block_out_of_range');
  end if;

  update reading_progress
     set partial_read_block = p_block, partial_rev = ch.content_rev, updated_at = now()
   where book_id = p_book_id and user_id = auth.uid();

  return jsonb_build_object('applied', true, 'last_read_chapter', rp.last_read_chapter, 'partial_read_block', p_block);
end;
$$;

revoke all on function public.record_reading_checkpoint(uuid, int, int, int) from public, anon;
grant execute on function public.record_reading_checkpoint(uuid, int, int, int) to authenticated;
