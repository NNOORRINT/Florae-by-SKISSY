-- Planty community forum: run this once in Supabase → SQL Editor → New query → Run.
-- Then run 002_accounts.sql, which requires real accounts and adds profiles, saved checks and limits.
-- Keep anonymous sign-ins OFF (Authentication → Sign In / Providers).

-- ---------- Tables ----------
create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_name text not null check (char_length(author_name) between 1 and 40),
  body        text not null check (char_length(body) between 1 and 2000),
  plant_name  text check (char_length(plant_name) <= 80),
  image_url   text check (char_length(image_url) <= 500),
  created_at  timestamptz not null default now()
);
create index if not exists posts_created_at_idx on public.posts (created_at desc);

create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_name text not null check (char_length(author_name) between 1 and 40),
  body        text not null check (char_length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index if not exists comments_post_idx on public.comments (post_id, created_at);

create table if not exists public.likes (
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- ---------- Row Level Security ----------
-- Everyone can read. Signed-in users (including anonymous ones) can write
-- only as themselves, and delete only their own things.
alter table public.posts    enable row level security;
alter table public.comments enable row level security;
alter table public.likes    enable row level security;

drop policy if exists "read posts" on public.posts;
drop policy if exists "add own post" on public.posts;
drop policy if exists "delete own post" on public.posts;
create policy "read posts"      on public.posts for select using (true);
create policy "add own post"    on public.posts for insert to authenticated with check (user_id = auth.uid());
create policy "delete own post" on public.posts for delete to authenticated using (user_id = auth.uid());

drop policy if exists "read comments" on public.comments;
drop policy if exists "add own comment" on public.comments;
drop policy if exists "delete own comment" on public.comments;
create policy "read comments"      on public.comments for select using (true);
create policy "add own comment"    on public.comments for insert to authenticated with check (user_id = auth.uid());
create policy "delete own comment" on public.comments for delete to authenticated using (user_id = auth.uid());

drop policy if exists "read likes" on public.likes;
drop policy if exists "add own like" on public.likes;
drop policy if exists "remove own like" on public.likes;
create policy "read likes"      on public.likes for select using (true);
create policy "add own like"    on public.likes for insert to authenticated with check (user_id = auth.uid());
create policy "remove own like" on public.likes for delete to authenticated using (user_id = auth.uid());

-- ---------- Photo storage ----------
-- Public bucket for post photos (max 5 MB, images only).
-- Each user may upload only into a folder named after their own user id.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-images', 'post-images', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists "upload own post images" on storage.objects;
drop policy if exists "delete own post images" on storage.objects;
create policy "upload own post images" on storage.objects for insert to authenticated
  with check (bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "delete own post images" on storage.objects for delete to authenticated
  using (bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text);
