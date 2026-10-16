-- 0008: readable book addresses (/library/classroom-of-the-elite instead of /library/<uuid>).
-- Run AFTER 0007. Adds books.slug (unique per user, set by a trigger, backfilled for existing books).
-- The slug is permanent: renaming a book later does not change its address. Old /library/<uuid> links keep
-- working (the app redirects them to the slug).

-- "Classroom of the Elite: Vol. 2" -> "classroom-of-the-elite-vol-2" (letters and digits of any script are kept).
create or replace function public.slugify(t text) returns text
language sql immutable
as $$
  select coalesce(
    nullif(trim(both '-' from left(trim(both '-' from regexp_replace(lower(coalesce(t, '')), '[^[:alnum:]]+', '-', 'g')), 60)), ''),
    'book');
$$;

-- A slug nobody else in the same user's library has. "add" is the route for adding a book, so it is never used.
create or replace function public.unique_book_slug(p_user uuid, p_title text, p_self uuid default null)
returns text
language plpgsql
as $$
declare
  base text := public.slugify(p_title);
  cand text;
  n int := 1;
begin
  if base = 'add' then base := 'add-book'; end if;
  cand := base;
  while exists (select 1 from public.books b where b.user_id = p_user and b.slug = cand and b.id is distinct from p_self) loop
    n := n + 1;
    cand := left(base, 55) || '-' || n;
  end loop;
  return cand;
end;
$$;

alter table public.books add column slug text;

-- Existing books, oldest first, so the oldest keeps the plain name when titles repeat.
do $$
declare r record;
begin
  for r in select id, user_id, title from public.books where slug is null order by created_at, id loop
    update public.books set slug = public.unique_book_slug(r.user_id, r.title, r.id) where id = r.id;
  end loop;
end $$;

alter table public.books alter column slug set not null;
alter table public.books add constraint books_slug_format check (char_length(slug) between 1 and 80 and slug !~ '[/?#[:space:]]' and slug <> 'add');
create unique index books_user_slug_idx on public.books (user_id, slug);

create or replace function public.set_book_slug() returns trigger
language plpgsql
as $$
begin
  if new.slug is null or new.slug = '' then
    new.slug := public.unique_book_slug(new.user_id, new.title, new.id);
  end if;
  return new;
end;
$$;

create trigger books_set_slug before insert on public.books
  for each row execute function public.set_book_slug();
