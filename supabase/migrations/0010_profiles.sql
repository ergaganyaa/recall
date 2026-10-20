-- 0010: profiles and usernames. Run AFTER 0009.
--
--   public.profiles          one row per account: username, display name, bio, avatar. Only its owner can read or change it.
--   username_available()     is a username free and allowed? (callable before signing in, for the sign-up form)
--   handle_new_user()        trigger: creates the profile from the username given at sign-up
--   login_email()            username -> email, so people can sign in with a username. Guarded by a SERVER-SIDE
--                            secret (see below): without it the function returns nothing, so no one can look up
--                            another account's email, and no service-role key is needed.
--
-- One manual step to turn on username sign-in (details in the README):
--   1. choose a long random string and put it in .env.local as LOGIN_LOOKUP_SECRET=...
--   2. in the Supabase SQL editor run:   select public.set_login_lookup_secret('the same string');
-- Until then everything else works and signing in with an email is unchanged.

-- ---------------------------------------------------------------- username rules
-- 3-20 characters: lowercase letters, digits, underscore. A few names are kept back because they are routes or
-- look official.
create or replace function public.username_valid(u text) returns boolean
language sql immutable
as $$
  select u is not null
     and u ~ '^[a-z0-9_]{3,20}$'
     and u not in ('admin', 'administrator', 'root', 'support', 'recall', 'system', 'moderator', 'staff', 'official',
                   'null', 'undefined', 'anonymous', 'api', 'login', 'logout', 'signup', 'profile', 'profiles',
                   'library', 'settings', 'help', 'about', 'user', 'users', 'me', 'you', 'add');
$$;

-- ---------------------------------------------------------------------- profiles
create table public.profiles (
  id           uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  username     text not null check (public.username_valid(username)),
  display_name text check (char_length(display_name) <= 60),
  bio          text check (char_length(bio) <= 300),
  -- object path in the private Storage bucket `book-images`: <user id>/avatar/<uuid>.<ext>
  avatar_path  text check (char_length(avatar_path) <= 400),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index profiles_username_idx on public.profiles (username);

alter table public.profiles enable row level security;
create policy "own profile" on public.profiles
  for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- An avatar must live in the owner's own folder (Storage policies enforce the same for the object itself).
alter table public.profiles add constraint profiles_avatar_owner
  check (avatar_path is null or avatar_path like id::text || '/avatar/%');

-- ------------------------------------------------------------- username_available
-- True when the name is allowed and nobody has it. Returns only a yes/no, never who has it.
create or replace function public.username_available(p_username text) returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.username_valid(lower(trim(p_username)))
     and not exists (select 1 from public.profiles p where p.username = lower(trim(p_username)));
$$;
revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- ------------------------------------------------------------------ handle_new_user
-- Creates the profile when an account is created with a username in its sign-up data. A missing or invalid
-- username creates no profile (the person is asked to choose one after signing in), so sign-up never fails here.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer
set search_path = public
as $$
declare u text := lower(trim(coalesce(new.raw_user_meta_data ->> 'username', '')));
begin
  if public.username_valid(u) then
    insert into public.profiles (id, username) values (new.id, u) on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------- login by username
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.app_secret (name text primary key, value text not null);
revoke all on private.app_secret from public, anon, authenticated;

-- Run from the SQL editor only (nobody else can execute it).
create or replace function public.set_login_lookup_secret(p text) returns void
language sql security definer
set search_path = private
as $$
  insert into private.app_secret (name, value) values ('login_lookup', p)
  on conflict (name) do update set value = excluded.value;
$$;
revoke all on function public.set_login_lookup_secret(text) from public, anon, authenticated;

-- username -> email, ONLY when the request carries the server's secret in the x-recall-login-secret header.
-- Without the right header (or before the secret is set) it returns null for everyone.
create or replace function public.login_email(p_username text) returns text
language plpgsql stable security definer
set search_path = public, private
as $$
declare
  want text;
  got  text;
  hdr  json;
begin
  select value into want from private.app_secret where name = 'login_lookup';
  begin
    hdr := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    hdr := null;
  end;
  got := coalesce(hdr ->> 'x-recall-login-secret', '');
  if want is null or got = '' or got <> want then
    return null;
  end if;
  return (
    select u.email::text
      from auth.users u
      join public.profiles p on p.id = u.id
     where p.username = lower(trim(p_username))
     limit 1
  );
end;
$$;
revoke all on function public.login_email(text) from public;
grant execute on function public.login_email(text) to anon, authenticated;
