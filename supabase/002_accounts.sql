-- Planty: real accounts, saved checks, daily limits, reports.
-- Run this ONCE in Supabase → SQL Editor → New query → Run, after schema.sql.
-- It is safe to run again.

-- ---------- Helper: is this a real (non-anonymous) signed-in user? ----------
create or replace function public.is_real_user()
returns boolean
language sql stable
set search_path = ''
as $$
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
$$;

-- ---------- Profiles (the name shown on posts) ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "read profiles" on public.profiles;
drop policy if exists "add own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;
create policy "read profiles"      on public.profiles for select using (true);
create policy "add own profile"    on public.profiles for insert to authenticated with check (id = auth.uid() and public.is_real_user());
create policy "update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant insert (id, display_name) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Create a profile automatically for every new account.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Grower'
    ), 40)
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Profiles for accounts that already exist.
insert into public.profiles (id, display_name)
select id, left(coalesce(
         nullif(trim(raw_user_meta_data ->> 'name'), ''),
         nullif(split_part(coalesce(email, ''), '@', 1), ''),
         'Grower'), 40)
from auth.users
on conflict (id) do nothing;

-- Posts and replies always carry the author's real profile name (can't be faked).
create or replace function public.set_author_name()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.author_name := coalesce(
    (select display_name from public.profiles where id = auth.uid()),
    new.author_name
  );
  return new;
end $$;

drop trigger if exists posts_author_name on public.posts;
create trigger posts_author_name before insert on public.posts
  for each row execute function public.set_author_name();
drop trigger if exists comments_author_name on public.comments;
create trigger comments_author_name before insert on public.comments
  for each row execute function public.set_author_name();

-- Renaming yourself updates the name on your old posts and replies.
create or replace function public.sync_author_name()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.display_name is distinct from old.display_name then
    update public.posts    set author_name = new.display_name where user_id = new.id;
    update public.comments set author_name = new.display_name where user_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists profiles_sync_name on public.profiles;
create trigger profiles_sync_name after update on public.profiles
  for each row execute function public.sync_author_name();

-- ---------- Community: only real accounts can post, reply or like ----------
grant select on public.posts, public.comments, public.likes to anon, authenticated;
grant insert, delete on public.posts, public.comments, public.likes to authenticated;

drop policy if exists "add own post" on public.posts;
create policy "add own post" on public.posts for insert to authenticated
  with check (user_id = auth.uid() and public.is_real_user());

drop policy if exists "add own comment" on public.comments;
create policy "add own comment" on public.comments for insert to authenticated
  with check (user_id = auth.uid() and public.is_real_user());

drop policy if exists "add own like" on public.likes;
create policy "add own like" on public.likes for insert to authenticated
  with check (user_id = auth.uid() and public.is_real_user());

drop policy if exists "upload own post images" on storage.objects;
create policy "upload own post images" on storage.objects for insert to authenticated
  with check (bucket_id = 'post-images'
              and (storage.foldername(name))[1] = auth.uid()::text
              and public.is_real_user());

-- ---------- Saved plant checks ("My plants") ----------
create table if not exists public.scans (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  plant_name      text not null check (char_length(plant_name) between 1 and 120),
  scientific_name text check (char_length(scientific_name) <= 160),
  health_status   text not null check (char_length(health_status) <= 40),
  photo_path      text check (char_length(photo_path) <= 300),
  result          jsonb not null,
  notes           text check (char_length(notes) <= 1000),
  created_at      timestamptz not null default now()
);
create index if not exists scans_user_created_idx on public.scans (user_id, created_at desc);
alter table public.scans enable row level security;

drop policy if exists "read own scans" on public.scans;
drop policy if exists "add own scans" on public.scans;
drop policy if exists "delete own scans" on public.scans;
create policy "read own scans"   on public.scans for select to authenticated using (user_id = auth.uid());
create policy "add own scans"    on public.scans for insert to authenticated with check (user_id = auth.uid() and public.is_real_user());
create policy "delete own scans" on public.scans for delete to authenticated using (user_id = auth.uid());

revoke all on public.scans from anon, authenticated;
grant select, insert, delete on public.scans to authenticated;

-- Private photo bucket: each user can only see their own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scan-photos', 'scan-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists "read own scan photos" on storage.objects;
drop policy if exists "upload own scan photos" on storage.objects;
drop policy if exists "delete own scan photos" on storage.objects;
create policy "read own scan photos" on storage.objects for select to authenticated
  using (bucket_id = 'scan-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "upload own scan photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'scan-photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_real_user());
create policy "delete own scan photos" on storage.objects for delete to authenticated
  using (bucket_id = 'scan-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Daily AI check limit (protects your Anthropic bill) ----------
-- Change the number below to give people more or fewer free checks per day.
create or replace function public.daily_scan_limit()
returns int language sql immutable as $$ select 10 $$;

create table if not exists public.scan_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);
alter table public.scan_usage enable row level security;
-- No policies on purpose: only the two functions below can touch this table.
revoke all on public.scan_usage from anon, authenticated;

-- How many checks the signed-in user has left today (UTC).
create or replace function public.scan_quota()
returns int
language plpgsql stable security definer
set search_path = ''
as $$
declare used int;
begin
  if not public.is_real_user() then return 0; end if;
  select u.count into used from public.scan_usage u
   where u.user_id = auth.uid() and u.day = (now() at time zone 'utc')::date;
  return greatest(0, public.daily_scan_limit() - coalesce(used, 0));
end $$;

-- Count one finished check. Called by the server after a successful diagnosis.
create or replace function public.record_scan()
returns int
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_real_user() then return 0; end if;
  insert into public.scan_usage (user_id, day, count)
  values (auth.uid(), (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set count = public.scan_usage.count + 1;
  return public.scan_quota();
end $$;

revoke execute on function public.scan_quota()  from public, anon;
revoke execute on function public.record_scan() from public, anon;
grant  execute on function public.scan_quota()  to authenticated;
grant  execute on function public.record_scan() to authenticated;

-- ---------- Reports (moderation) ----------
-- Reported posts show up in Table Editor → reports. Delete bad posts from the posts table.
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  reporter_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  reason      text check (char_length(reason) <= 500),
  created_at  timestamptz not null default now(),
  unique (post_id, reporter_id)
);
alter table public.reports enable row level security;
drop policy if exists "add own report" on public.reports;
create policy "add own report" on public.reports for insert to authenticated
  with check (reporter_id = auth.uid() and public.is_real_user());
revoke all on public.reports from anon, authenticated;
grant insert (post_id, reason) on public.reports to authenticated;
