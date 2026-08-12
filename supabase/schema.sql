-- ---------------------------------------------------------------------------
-- Chat Room — Supabase schema
--
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It is safe to re-run: every object is created with "if not exists" or
-- dropped first.
--
-- What it sets up:
--   * profiles  — the display name attached to each account
--   * messages  — the room's history
--   * row level security so the rules live in the database, not the browser
--   * a trigger that stamps the author on each message (clients cannot forge it)
--   * a rate limit trigger
--   * realtime broadcasting on new messages
-- ---------------------------------------------------------------------------

-- Profiles ------------------------------------------------------------------

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null,
  created_at timestamptz not null default now(),

  constraint username_format check (
    char_length(username) between 3 and 20
    and username ~ '^[A-Za-z0-9_-]+$'
  )
);

-- Case-insensitive uniqueness: "Alice" and "alice" are the same name.
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- Messages ------------------------------------------------------------------

create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  -- Denormalised so a realtime INSERT payload is self-contained; a trigger
  -- below fills it in, so what the client sends here is ignored.
  username   text not null default '',
  body       text not null,
  created_at timestamptz not null default now(),

  constraint body_length check (char_length(body) between 1 and 2000)
);

create index if not exists messages_id_desc_idx on public.messages (id desc);

-- Row level security --------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.messages enable row level security;

drop policy if exists "profiles readable by members" on public.profiles;
create policy "profiles readable by members"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "users insert their own profile" on public.profiles;
create policy "users insert their own profile"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "messages readable by members" on public.messages;
create policy "messages readable by members"
  on public.messages for select
  to authenticated
  using (true);

drop policy if exists "users send messages as themselves" on public.messages;
create policy "users send messages as themselves"
  on public.messages for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Deliberately no update or delete policies: with RLS on, that means nobody
-- can edit or remove messages through the API, including their own.

-- Give each new account a profile -------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data ->> 'username');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Username availability check -----------------------------------------------
-- Signup happens before the account exists, so the sign-up form has no way to
-- read the profiles table. This lets it ask about one specific name without
-- being able to enumerate the others.

create or replace function public.username_available(candidate text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select not exists (
    select 1 from public.profiles where lower(username) = lower(candidate)
  );
$$;

grant execute on function public.username_available(text) to anon, authenticated;

-- Stamp the author server-side ----------------------------------------------

create or replace function public.set_message_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  author text;
begin
  select username into author from public.profiles where id = new.user_id;

  if author is null then
    raise exception 'no profile for user %', new.user_id;
  end if;

  new.username := author;
  return new;
end;
$$;

drop trigger if exists messages_set_author on public.messages;
create trigger messages_set_author
  before insert on public.messages
  for each row execute function public.set_message_author();

-- Rate limit ----------------------------------------------------------------
-- The old Node server capped sending at 10 messages per 10 seconds. Same rule,
-- enforced in the database now that there is no server in front of it.

create or replace function public.enforce_message_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent integer;
begin
  select count(*) into recent
  from public.messages
  where user_id = new.user_id
    and created_at > now() - interval '10 seconds';

  if recent >= 10 then
    raise exception 'Slow down a moment.' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists messages_rate_limit on public.messages;
create trigger messages_rate_limit
  before insert on public.messages
  for each row execute function public.enforce_message_rate_limit();

-- Realtime ------------------------------------------------------------------
-- Let subscribed clients hear about new messages.

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
end;
$$;
