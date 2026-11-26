-- Florae plant wiki: species profiles, health articles, staff roles and import bookkeeping.
-- Run ONCE in Supabase → SQL Editor → New query → Run, after schema.sql and 002_accounts.sql.
-- Safe to run again. It creates new tables only; it does not change or delete existing data.
--
-- Rules this schema enforces:
--   * Imported content (Wikipedia, Wikidata, GBIF, Trefle) and editorial content (written by staff)
--     live in separate rows, each with its own source, licence, attribution and dates.
--   * The importer never overwrites a row a reviewer has marked "reviewed", never touches
--     editorial rows, and never overwrites plant columns listed in plants.locked_fields.
--   * Only admins can publish or mark something reviewed. Editors can draft.
--   * A health article can only be published after a named person has reviewed it,
--     and never if it was AI-generated.

-- ---------- Normalised names ----------
-- Must match normName() in public/wiki-source.js.
create or replace function public.wiki_norm(t text)
returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select trim(regexp_replace(
    translate(lower(coalesce(t, '')), 'áàâäãåéèêëíìîïóòôöõúùûüñç×', 'aaaaaaeeeeiiiiooooouuuuncx'),
    '[^a-z0-9]+', ' ', 'g'))
$$;

-- ---------- Staff roles ----------
-- Nobody is staff until you add them (see README → Plant wiki → Staff).
create table if not exists public.staff_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('editor', 'admin')),
  granted_at timestamptz not null default now()
);
alter table public.staff_roles enable row level security;
revoke all on public.staff_roles from anon, authenticated;
grant select on public.staff_roles to authenticated;
drop policy if exists "read own role" on public.staff_roles;
create policy "read own role" on public.staff_roles for select to authenticated using (user_id = auth.uid());

create or replace function public.wiki_role()
returns text
language sql stable security definer
set search_path = ''
as $$
  select r.role from public.staff_roles r
  where r.user_id = auth.uid() and public.is_real_user()
$$;

create or replace function public.is_wiki_editor()
returns boolean language sql stable set search_path = ''
as $$ select coalesce(public.wiki_role() in ('editor', 'admin'), false) $$;

create or replace function public.is_wiki_admin()
returns boolean language sql stable set search_path = ''
as $$ select coalesce(public.wiki_role() = 'admin', false) $$;

-- Database owner / service key (the import script, the SQL editor) count as admin.
create or replace function public.wiki_privileged()
returns boolean language sql stable set search_path = ''
as $$ select current_user not in ('anon', 'authenticated') or public.is_wiki_admin() $$;

-- ---------- Plants ----------
create table if not exists public.plants (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  scientific_name      text not null,                 -- the accepted name
  scientific_name_norm text not null unique,
  authorship           text,
  rank                 text,
  kingdom              text,
  plant_order          text,
  family               text,
  genus                text,
  common_name          text not null,
  short_description    text,                          -- e.g. Wikipedia's "Edible berry"
  collection           text,                          -- our own grouping, e.g. Houseplants
  status               text not null default 'draft' check (status in ('draft', 'published')),
  locked_fields        text[] not null default '{}',  -- columns the importer must not overwrite
  editor_note          text,
  last_reviewed_at     timestamptz,
  reviewed_by          uuid references auth.users(id) on delete set null,
  imported_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists plants_family_idx on public.plants (family);
create index if not exists plants_collection_idx on public.plants (collection);
create index if not exists plants_status_idx on public.plants (status);

-- Accepted names, synonyms and common names, each with where it came from.
create table if not exists public.plant_names (
  id        bigint generated always as identity primary key,
  plant_id  uuid not null references public.plants(id) on delete cascade,
  name      text not null check (char_length(name) between 1 and 200),
  name_norm text not null,
  kind      text not null check (kind in ('accepted', 'synonym', 'common')),
  language  text not null default 'en',
  source    text not null,                 -- gbif, wikidata, wikipedia, trefle, editor
  origin    text not null default 'import' check (origin in ('import', 'editorial')),
  unique (plant_id, kind, name_norm)
);
create index if not exists plant_names_norm_idx on public.plant_names (name_norm);
create index if not exists plant_names_plant_idx on public.plant_names (plant_id);

-- Stable identifiers in other databases. One plant per (source, id).
create table if not exists public.plant_external_ids (
  plant_id    uuid not null references public.plants(id) on delete cascade,
  source      text not null check (source in ('gbif', 'wikidata', 'wikipedia', 'trefle', 'ncbi', 'powo', 'inaturalist')),
  external_id text not null,
  url         text,
  primary key (source, external_id)
);
create index if not exists plant_external_ids_plant_idx on public.plant_external_ids (plant_id);

-- Every piece of text or structured fact, with provenance per row.
create table if not exists public.plant_content (
  id               uuid primary key default gen_random_uuid(),
  plant_id         uuid not null references public.plants(id) on delete cascade,
  field            text not null check (field in (
                     'overview', 'description', 'habitat', 'distribution', 'taxonomy',
                     'light', 'watering', 'soil', 'humidity', 'temperature', 'propagation',
                     'toxicity', 'section')),
  section_key      text not null default '',
  title            text,
  body             text not null default '',
  data             jsonb,
  position         int not null default 0,
  origin           text not null check (origin in ('import', 'editorial')),
  source           text not null,          -- wikipedia, wikidata, gbif, trefle, planty
  source_url       text,
  source_record_id text,
  license          text,
  license_url      text,
  attribution      text,
  retrieved_at     timestamptz,
  status           text not null default 'published' check (status in ('draft', 'published')),
  review_status    text not null default 'unreviewed' check (review_status in ('unreviewed', 'reviewed')),
  reviewed_at      timestamptz,
  reviewed_by      uuid references auth.users(id) on delete set null,
  ai_generated     boolean not null default false,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (plant_id, origin, source, field, section_key),
  check (origin = 'editorial' or status = 'published'),
  check (not (ai_generated and review_status = 'reviewed')),
  check (review_status = 'unreviewed' or reviewed_at is not null)
);
create index if not exists plant_content_plant_idx on public.plant_content (plant_id, field);

create table if not exists public.plant_images (
  id           uuid primary key default gen_random_uuid(),
  plant_id     uuid not null references public.plants(id) on delete cascade,
  source       text not null check (source in ('commons', 'editor')),
  source_id    text not null,                 -- e.g. "File:Tomato je.jpg"
  url          text not null,
  thumb_url    text,
  page_url     text,
  creator      text,                          -- null: named on the file page
  license      text not null,
  license_url  text,
  attribution  text,
  is_primary   boolean not null default false,
  hidden       boolean not null default false,
  retrieved_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (plant_id, source, source_id)
);
create index if not exists plant_images_plant_idx on public.plant_images (plant_id);

-- Reviewed symptom and care articles, separate from species profiles.
create table if not exists public.health_articles (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title            text not null,
  summary          text not null default '',
  body             text not null default '',
  symptoms         text[] not null default '{}',   -- e.g. {yellow leaves, leaf drop}
  categories       text[] not null default '{}',   -- disease, pest, nutrient, watering, light, temperature, physical_damage, other
  plant_ids        uuid[] not null default '{}',   -- empty: applies to plants in general
  sources          jsonb not null default '[]',    -- [{ "title": "...", "url": "...", "license": "..." }]
  status           text not null default 'draft' check (status in ('draft', 'published')),
  review_status    text not null default 'unreviewed' check (review_status in ('unreviewed', 'reviewed')),
  last_reviewed_at timestamptz,
  reviewed_by      uuid references auth.users(id) on delete set null,
  ai_generated     boolean not null default false,
  author_id        uuid references auth.users(id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (status = 'draft' or (review_status = 'reviewed' and last_reviewed_at is not null and not ai_generated)),
  check (not (ai_generated and review_status = 'reviewed'))
);

-- Import bookkeeping.
create table if not exists public.wiki_import_runs (
  id          uuid primary key default gen_random_uuid(),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running', 'completed', 'partial', 'failed')),
  sources     text[] not null default '{}',
  total       int not null default 0,
  created     int not null default 0,
  updated     int not null default 0,
  failed      int not null default 0,
  preserved   int not null default 0,              -- reviewed rows left untouched
  summary     jsonb not null default '{}'
);
create table if not exists public.wiki_import_failures (
  id         bigint generated always as identity primary key,
  run_id     uuid not null references public.wiki_import_runs(id) on delete cascade,
  input_name text not null,
  stage      text,
  error      text not null,
  created_at timestamptz not null default now()
);

-- ---------- Timestamps and publishing rules ----------
create or replace function public.wiki_touch()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists plants_touch on public.plants;
create trigger plants_touch before update on public.plants for each row execute function public.wiki_touch();
drop trigger if exists plant_content_touch on public.plant_content;
create trigger plant_content_touch before update on public.plant_content for each row execute function public.wiki_touch();
drop trigger if exists health_articles_touch on public.health_articles;
create trigger health_articles_touch before update on public.health_articles for each row execute function public.wiki_touch();

-- Publishing and reviewing are admin-only; editors may draft. Stamps who reviewed.
create or replace function public.wiki_guard_publish()
returns trigger language plpgsql set search_path = ''
as $$
declare
  was_status text := case when tg_op = 'UPDATE' then old.status else 'draft' end;
  was_review text;
begin
  if tg_table_name in ('plant_content', 'health_articles') then
    was_review := case when tg_op = 'UPDATE' then old.review_status else 'unreviewed' end;
    if new.review_status = 'reviewed' and was_review <> 'reviewed' then
      if not public.wiki_privileged() then
        raise exception 'Only admins can mark content as reviewed' using errcode = '42501';
      end if;
      new.reviewed_by := coalesce(auth.uid(), new.reviewed_by);
      if tg_table_name = 'plant_content' then
        new.reviewed_at := coalesce(new.reviewed_at, now());
      else
        new.last_reviewed_at := coalesce(new.last_reviewed_at, now());
      end if;
    end if;
  end if;

  if tg_table_name = 'plants' and tg_op = 'UPDATE' then
    if (new.last_reviewed_at is distinct from old.last_reviewed_at or new.status is distinct from old.status)
       and not public.wiki_privileged() then
      raise exception 'Only admins can review, publish or unpublish a plant' using errcode = '42501';
    end if;
    if new.last_reviewed_at is distinct from old.last_reviewed_at then
      new.reviewed_by := coalesce(auth.uid(), new.reviewed_by);
    end if;
  end if;

  if new.status = 'published' and was_status <> 'published' and not public.wiki_privileged() then
    -- Imported content rows are "published" by definition; the plant's own status gates them.
    -- (read origin via jsonb: plpgsql doesn't short-circuit, and other tables have no origin column)
    if not (tg_table_name = 'plant_content' and to_jsonb(new) ->> 'origin' = 'import') then
      raise exception 'Only admins can publish' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists plants_guard on public.plants;
create trigger plants_guard before insert or update on public.plants for each row execute function public.wiki_guard_publish();
drop trigger if exists plant_content_guard on public.plant_content;
create trigger plant_content_guard before insert or update on public.plant_content for each row execute function public.wiki_guard_publish();
drop trigger if exists health_articles_guard on public.health_articles;
create trigger health_articles_guard before insert or update on public.health_articles for each row execute function public.wiki_guard_publish();

-- ---------- Row Level Security ----------
alter table public.plants               enable row level security;
alter table public.plant_names          enable row level security;
alter table public.plant_external_ids   enable row level security;
alter table public.plant_content        enable row level security;
alter table public.plant_images         enable row level security;
alter table public.health_articles      enable row level security;
alter table public.wiki_import_runs     enable row level security;
alter table public.wiki_import_failures enable row level security;

create or replace function public.wiki_plant_visible(p uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.plants where id = p and (status = 'published' or public.is_wiki_editor())) $$;

revoke all on public.plants, public.plant_names, public.plant_external_ids, public.plant_content,
  public.plant_images, public.health_articles, public.wiki_import_runs, public.wiki_import_failures
  from anon, authenticated;

grant select on public.plants, public.plant_names, public.plant_external_ids, public.plant_content,
  public.plant_images, public.health_articles to anon, authenticated;
grant select on public.wiki_import_runs, public.wiki_import_failures to authenticated;

-- Staff edits go through these column grants plus the policies below.
grant update (common_name, short_description, collection, status, locked_fields, editor_note, last_reviewed_at) on public.plants to authenticated;
grant insert (plant_id, name, name_norm, kind, language, source, origin) on public.plant_names to authenticated;
grant delete on public.plant_names to authenticated;
grant insert (plant_id, field, section_key, title, body, data, position, origin, source, source_url, license, license_url, attribution, status, review_status, ai_generated, created_by)
  on public.plant_content to authenticated;
grant update (title, body, data, position, status, review_status, source_url, license, license_url, attribution) on public.plant_content to authenticated;
grant update (is_primary, hidden) on public.plant_images to authenticated;
grant insert (slug, title, summary, body, symptoms, categories, plant_ids, sources, status, review_status, ai_generated)
  on public.health_articles to authenticated;
grant update (slug, title, summary, body, symptoms, categories, plant_ids, sources, status, review_status, ai_generated)
  on public.health_articles to authenticated;

drop policy if exists "read plants" on public.plants;
drop policy if exists "staff edit plants" on public.plants;
create policy "read plants" on public.plants for select using (status = 'published' or public.is_wiki_editor());
create policy "staff edit plants" on public.plants for update to authenticated using (public.is_wiki_editor()) with check (public.is_wiki_editor());

drop policy if exists "read names" on public.plant_names;
drop policy if exists "staff add names" on public.plant_names;
drop policy if exists "staff remove editorial names" on public.plant_names;
create policy "read names" on public.plant_names for select using (public.wiki_plant_visible(plant_id));
create policy "staff add names" on public.plant_names for insert to authenticated
  with check (public.is_wiki_editor() and origin = 'editorial' and source = 'editor');
create policy "staff remove editorial names" on public.plant_names for delete to authenticated
  using (public.is_wiki_editor() and origin = 'editorial');

drop policy if exists "read ids" on public.plant_external_ids;
create policy "read ids" on public.plant_external_ids for select using (public.wiki_plant_visible(plant_id));

drop policy if exists "read content" on public.plant_content;
drop policy if exists "staff add content" on public.plant_content;
drop policy if exists "staff edit content" on public.plant_content;
create policy "read content" on public.plant_content for select
  using (public.wiki_plant_visible(plant_id) and (status = 'published' or public.is_wiki_editor()));
create policy "staff add content" on public.plant_content for insert to authenticated
  with check (public.is_wiki_editor() and origin = 'editorial' and source = 'planty' and created_by = auth.uid());
-- Editors may edit editorial rows; on imported rows only review_status changes stick
-- (the column grant allows title/body too, so the trigger below reverts those).
create policy "staff edit content" on public.plant_content for update to authenticated
  using (public.is_wiki_editor()) with check (public.is_wiki_editor());

create or replace function public.wiki_keep_import_text()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.origin = 'import' and current_user in ('anon', 'authenticated') then
    new.title := old.title; new.body := old.body; new.data := old.data; new.position := old.position;
    new.source_url := old.source_url; new.license := old.license; new.license_url := old.license_url;
    new.attribution := old.attribution; new.status := old.status;
  end if;
  return new;
end $$;
drop trigger if exists plant_content_keep_import on public.plant_content;
create trigger plant_content_keep_import before update on public.plant_content for each row execute function public.wiki_keep_import_text();

drop policy if exists "read images" on public.plant_images;
drop policy if exists "staff edit images" on public.plant_images;
create policy "read images" on public.plant_images for select using (public.wiki_plant_visible(plant_id) and (not hidden or public.is_wiki_editor()));
create policy "staff edit images" on public.plant_images for update to authenticated using (public.is_wiki_editor()) with check (public.is_wiki_editor());

drop policy if exists "read articles" on public.health_articles;
drop policy if exists "staff add articles" on public.health_articles;
drop policy if exists "staff edit articles" on public.health_articles;
create policy "read articles" on public.health_articles for select using (status = 'published' or public.is_wiki_editor());
create policy "staff add articles" on public.health_articles for insert to authenticated with check (public.is_wiki_editor());
create policy "staff edit articles" on public.health_articles for update to authenticated using (public.is_wiki_editor()) with check (public.is_wiki_editor());

drop policy if exists "staff read runs" on public.wiki_import_runs;
drop policy if exists "staff read failures" on public.wiki_import_failures;
create policy "staff read runs" on public.wiki_import_runs for select to authenticated using (public.is_wiki_editor());
create policy "staff read failures" on public.wiki_import_failures for select to authenticated using (public.is_wiki_editor());

-- ---------- Reading: directory, facets, one plant, name resolution ----------
create or replace function public.wiki_search(
  q text default '', p_family text default null, p_collection text default null,
  p_has_image boolean default false, p_has_care boolean default false,
  p_limit int default 24, p_offset int default 0)
returns table (slug text, scientific_name text, common_name text, family text, collection text,
               thumb_url text, matched_name text, match_kind text, total bigint)
language sql stable
set search_path = ''
as $$
  with term as (select public.wiki_norm(q) as t),
  hits as (
    select p.id,
           (select n.name from public.plant_names n, term
             where n.plant_id = p.id and term.t <> '' and n.name_norm like '%' || term.t || '%'
             order by (n.name_norm = term.t) desc, (n.name_norm like term.t || '%') desc,
                      case n.kind when 'accepted' then 0 when 'common' then 1 else 2 end
             limit 1) as matched,
           (select n.kind from public.plant_names n, term
             where n.plant_id = p.id and term.t <> '' and n.name_norm like '%' || term.t || '%'
             order by (n.name_norm = term.t) desc, (n.name_norm like term.t || '%') desc,
                      case n.kind when 'accepted' then 0 when 'common' then 1 else 2 end
             limit 1) as kind,
           (select min(case when n.name_norm = term.t then 0 when n.name_norm like term.t || '%' then 1 else 2 end)
              from public.plant_names n, term
             where n.plant_id = p.id and term.t <> '' and n.name_norm like '%' || term.t || '%') as score
    from public.plants p, term
    where (p.status = 'published' or public.is_wiki_editor())
      and (p_family is null or p.family = p_family)
      and (p_collection is null or p.collection = p_collection)
      and (not p_has_image or exists (select 1 from public.plant_images i where i.plant_id = p.id and not i.hidden))
      and (not p_has_care or exists (select 1 from public.plant_content c where c.plant_id = p.id
             and c.field in ('light', 'watering', 'soil', 'humidity', 'temperature', 'propagation') and c.status = 'published'))
      and (term.t = '' or p.scientific_name_norm like '%' || term.t || '%' or public.wiki_norm(p.common_name) like '%' || term.t || '%'
           or exists (select 1 from public.plant_names n where n.plant_id = p.id and n.name_norm like '%' || term.t || '%'))
  )
  select p.slug, p.scientific_name, p.common_name, p.family, p.collection,
         (select coalesce(i.thumb_url, i.url) from public.plant_images i where i.plant_id = p.id and not i.hidden
           order by i.is_primary desc, i.created_at limit 1),
         h.matched, h.kind, count(*) over ()
  from hits h join public.plants p on p.id = h.id
  order by coalesce(h.score, 3), lower(p.common_name)
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)
$$;

create or replace function public.wiki_facets()
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'total', (select count(*) from public.plants where status = 'published' or public.is_wiki_editor()),
    'families', coalesce((select jsonb_agg(jsonb_build_object('name', family, 'count', n) order by family)
       from (select family, count(*) n from public.plants where family is not null and (status = 'published' or public.is_wiki_editor()) group by family) f), '[]'),
    'collections', coalesce((select jsonb_agg(jsonb_build_object('name', collection, 'count', n) order by first_pos)
       from (select collection, count(*) n, min(created_at) first_pos from public.plants where collection is not null and (status = 'published' or public.is_wiki_editor()) group by collection) c), '[]'))
$$;

create or replace function public.wiki_plant(p_slug text)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'plant', to_jsonb(p) - 'scientific_name_norm' - 'locked_fields' - 'editor_note' - 'reviewed_by',
    'names', coalesce((select jsonb_agg(jsonb_build_object('name', n.name, 'kind', n.kind, 'source', n.source, 'origin', n.origin) order by n.kind, n.name)
                       from public.plant_names n where n.plant_id = p.id), '[]'),
    'external_ids', coalesce((select jsonb_agg(jsonb_build_object('source', e.source, 'external_id', e.external_id, 'url', e.url) order by e.source)
                       from public.plant_external_ids e where e.plant_id = p.id), '[]'),
    'content', coalesce((select jsonb_agg(to_jsonb(c) - 'created_by' - 'reviewed_by' - 'plant_id' order by c.position, c.field)
                       from public.plant_content c where c.plant_id = p.id), '[]'),
    'images', coalesce((select jsonb_agg(to_jsonb(i) - 'plant_id' order by i.is_primary desc, i.created_at)
                       from public.plant_images i where i.plant_id = p.id), '[]'))
  from public.plants p
  where p.slug = p_slug
$$;

-- Resolve names (and optional GBIF keys) from an identification to stored plants.
create or replace function public.wiki_resolve(p_names text[], p_gbif_keys text[] default '{}')
returns table (input text, plant_id uuid, slug text, scientific_name text, common_name text, matched_name text, match_kind text)
language sql stable
set search_path = ''
as $$
  select distinct on (x.input, p.id) x.input, p.id, p.slug, p.scientific_name, p.common_name, x.matched, x.kind
  from (
    select i.input, n.plant_id, n.name as matched, n.kind,
           case n.kind when 'accepted' then 0 when 'synonym' then 1 else 2 end as rk
      from unnest(p_names) as i(input)
      join public.plant_names n on n.name_norm = public.wiki_norm(i.input)
    union all
    select k.input, e.plant_id, e.external_id, 'gbif_id', -1
      from unnest(p_gbif_keys) as k(input)
      join public.plant_external_ids e on e.source = 'gbif' and e.external_id = k.input
  ) x
  join public.plants p on p.id = x.plant_id and (p.status = 'published' or public.is_wiki_editor())
  order by x.input, p.id, x.rk
$$;

-- Reviewed, published health articles relevant to some symptoms / problem categories.
create or replace function public.wiki_health_lookup(p_terms text[], p_categories text[] default '{}', p_plant uuid default null)
returns setof public.health_articles
language sql stable
set search_path = ''
as $$
  select a.* from public.health_articles a
  where a.status = 'published' and a.review_status = 'reviewed'
    and (p_plant is null or cardinality(a.plant_ids) = 0 or p_plant = any (a.plant_ids))
    and (a.categories && p_categories
         or exists (select 1 from unnest(a.symptoms) s, unnest(p_terms) t
                    where public.wiki_norm(t) <> '' and (public.wiki_norm(s) like '%' || public.wiki_norm(t) || '%'
                                                         or public.wiki_norm(t) like '%' || public.wiki_norm(s) || '%')))
  order by a.last_reviewed_at desc
  limit 5
$$;

create or replace function public.wiki_my_role()
returns text language sql stable set search_path = '' as $$ select public.wiki_role() $$;

grant execute on function public.wiki_norm(text), public.wiki_search(text, text, text, boolean, boolean, int, int),
  public.wiki_facets(), public.wiki_plant(text), public.wiki_resolve(text[], text[]),
  public.wiki_health_lookup(text[], text[], uuid), public.wiki_my_role() to anon, authenticated;

-- ---------- Writing: the importer (service key only) ----------
-- Takes one validated payload from scripts/import-wiki.mjs and merges it:
--   find the plant by external id, then accepted name, then synonym; create it if new;
--   upsert names, ids, imported content and images; skip anything reviewed or locked.
create or replace function public.wiki_import_plant(p jsonb, p_status text default 'published')
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  pl jsonb := p -> 'plant';
  pid uuid;
  existing public.plants;
  action text := 'updated';
  locked text[];
  preserved int := 0;
  x jsonb;
  srcs text[];
  keep_keys text[];
  conflicts jsonb := '[]';
begin
  if pl ->> 'scientific_name' is null or pl ->> 'slug' is null then
    raise exception 'payload needs plant.scientific_name and plant.slug';
  end if;

  -- 1. Find an existing record: stable ids first, then names.
  select e.plant_id into pid from jsonb_array_elements(coalesce(p -> 'external_ids', '[]')) x2(v)
    join public.plant_external_ids e on e.source = x2.v ->> 'source' and e.external_id = x2.v ->> 'external_id'
    order by case x2.v ->> 'source' when 'gbif' then 0 when 'wikidata' then 1 when 'trefle' then 2 else 3 end
    limit 1;
  if pid is null then
    select id into pid from public.plants where scientific_name_norm = public.wiki_norm(pl ->> 'scientific_name');
  end if;
  if pid is null then
    select n2.plant_id into pid from jsonb_array_elements(coalesce(p -> 'names', '[]')) x3(v)
      join public.plant_names n2 on n2.name_norm = public.wiki_norm(x3.v ->> 'name') and n2.kind in ('accepted', 'synonym')
     where x3.v ->> 'kind' in ('accepted', 'synonym')
     limit 1;
  end if;

  -- 2. Create or update the plant row, respecting locked fields.
  if pid is null then
    action := 'created';
    insert into public.plants (slug, scientific_name, scientific_name_norm, authorship, rank, kingdom, plant_order, family, genus,
                               common_name, short_description, collection, status, imported_at)
    values (pl ->> 'slug', pl ->> 'scientific_name', public.wiki_norm(pl ->> 'scientific_name'), pl ->> 'authorship', pl ->> 'rank',
            pl ->> 'kingdom', pl ->> 'plant_order', pl ->> 'family', pl ->> 'genus',
            coalesce(pl ->> 'common_name', pl ->> 'scientific_name'), pl ->> 'description', pl ->> 'collection', p_status, now())
    returning id into pid;
  else
    select * into existing from public.plants where id = pid;
    locked := existing.locked_fields;
    update public.plants set
      authorship  = case when 'authorship'  = any (locked) then authorship  else coalesce(pl ->> 'authorship', authorship) end,
      rank        = case when 'rank'        = any (locked) then rank        else coalesce(pl ->> 'rank', rank) end,
      kingdom     = case when 'kingdom'     = any (locked) then kingdom     else coalesce(pl ->> 'kingdom', kingdom) end,
      plant_order = case when 'plant_order' = any (locked) then plant_order else coalesce(pl ->> 'plant_order', plant_order) end,
      family      = case when 'family'      = any (locked) then family      else coalesce(pl ->> 'family', family) end,
      genus       = case when 'genus'       = any (locked) then genus       else coalesce(pl ->> 'genus', genus) end,
      common_name = case when 'common_name' = any (locked) then common_name else coalesce(pl ->> 'common_name', common_name) end,
      collection  = case when 'collection'  = any (locked) then collection  else coalesce(pl ->> 'collection', collection) end,
      short_description = case when 'short_description' = any (locked) then short_description else coalesce(pl ->> 'description', short_description) end,
      imported_at = now()
    where id = pid;
  end if;

  -- 3. Names (never removes anything; editorial names are separate rows).
  insert into public.plant_names (plant_id, name, name_norm, kind, language, source, origin)
  select pid, v ->> 'name', public.wiki_norm(v ->> 'name'), v ->> 'kind', coalesce(v ->> 'language', 'en'), v ->> 'source', 'import'
    from jsonb_array_elements(coalesce(p -> 'names', '[]')) v
   where public.wiki_norm(v ->> 'name') <> ''
  on conflict (plant_id, kind, name_norm) do nothing;

  -- 4. External ids. An id already owned by another plant is reported, not moved.
  for x in select v from jsonb_array_elements(coalesce(p -> 'external_ids', '[]')) v loop
    insert into public.plant_external_ids (plant_id, source, external_id, url)
    values (pid, x ->> 'source', x ->> 'external_id', x ->> 'url')
    on conflict (source, external_id) do update set url = excluded.url
      where public.plant_external_ids.plant_id = pid;
    if exists (select 1 from public.plant_external_ids where source = x ->> 'source' and external_id = x ->> 'external_id' and plant_id <> pid) then
      conflicts := conflicts || jsonb_build_array(x);
    end if;
  end loop;

  -- 5. Imported content: upsert, but leave reviewed rows alone.
  select count(*) into preserved
    from jsonb_array_elements(coalesce(p -> 'content', '[]')) v
    join public.plant_content c on c.plant_id = pid and c.origin = 'import' and c.source = v ->> 'source'
     and c.field = v ->> 'field' and c.section_key = coalesce(v ->> 'section_key', '') and c.review_status = 'reviewed';

  insert into public.plant_content (plant_id, field, section_key, title, body, data, position, origin, source, source_url,
                                    source_record_id, license, license_url, attribution, retrieved_at, status)
  select pid, v ->> 'field', coalesce(v ->> 'section_key', ''), v ->> 'title', coalesce(v ->> 'body', ''), v -> 'data',
         coalesce((v ->> 'position')::int, 0), 'import', v ->> 'source', v ->> 'source_url', v ->> 'source_record_id',
         v ->> 'license', v ->> 'license_url', v ->> 'attribution', coalesce((v ->> 'retrieved_at')::timestamptz, now()), 'published'
    from jsonb_array_elements(coalesce(p -> 'content', '[]')) v
  on conflict (plant_id, origin, source, field, section_key) do update set
    title = excluded.title, body = excluded.body, data = excluded.data, position = excluded.position,
    source_url = excluded.source_url, source_record_id = excluded.source_record_id, license = excluded.license,
    license_url = excluded.license_url, attribution = excluded.attribution, retrieved_at = excluded.retrieved_at
  where public.plant_content.review_status <> 'reviewed';

  -- Sections a source no longer has are removed, unless reviewed.
  select array_agg(distinct v ->> 'source') into srcs from jsonb_array_elements(coalesce(p -> 'content', '[]')) v;
  select array_agg((v ->> 'source') || '|' || (v ->> 'field') || '|' || coalesce(v ->> 'section_key', '')) into keep_keys
    from jsonb_array_elements(coalesce(p -> 'content', '[]')) v;
  delete from public.plant_content c
   where c.plant_id = pid and c.origin = 'import' and c.review_status <> 'reviewed'
     and c.source = any (coalesce(srcs, '{}'))
     and not (c.source || '|' || c.field || '|' || c.section_key = any (coalesce(keep_keys, '{}')));

  -- 6. Images (metadata refreshed; hidden / primary choices kept).
  insert into public.plant_images (plant_id, source, source_id, url, thumb_url, page_url, creator, license, license_url, attribution, retrieved_at)
  select pid, v ->> 'source', v ->> 'source_id', v ->> 'url', v ->> 'thumb_url', v ->> 'page_url', v ->> 'creator',
         v ->> 'license', v ->> 'license_url', v ->> 'attribution', now()
    from jsonb_array_elements(coalesce(p -> 'images', '[]')) v
  on conflict (plant_id, source, source_id) do update set
    url = excluded.url, thumb_url = excluded.thumb_url, page_url = excluded.page_url, creator = excluded.creator,
    license = excluded.license, license_url = excluded.license_url, attribution = excluded.attribution, retrieved_at = excluded.retrieved_at;
  if not exists (select 1 from public.plant_images where plant_id = pid and is_primary) then
    update public.plant_images set is_primary = true
     where id = (select id from public.plant_images where plant_id = pid and not hidden order by created_at limit 1);
  end if;

  return jsonb_build_object('plant_id', pid, 'slug', (select slug from public.plants where id = pid),
                            'action', action, 'preserved', preserved, 'id_conflicts', conflicts);
end $$;

revoke all on function public.wiki_import_plant(jsonb, text) from public, anon, authenticated;
