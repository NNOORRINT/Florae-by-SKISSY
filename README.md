# Florae by Skissy

Take a photo of a plant and Florae tells you what it is, how healthy it looks and what to do next. People sign in with an account; their checks are saved to "My plants" on every device, and they can share and ask questions in the Community. The **plant wiki** (`/wiki`) is open to everyone and holds sourced plant profiles that the photo check also draws on.

## How it works

```
Browser (public/)  ──photo + login token──▶  server.js (Vercel function)  ──▶  Claude (vision + wiki tools)
   sign in, identify,                          checks login and daily limit,        │ lookup_plants
   My plants, community,                       runs the wiki tool loop,             │ find_health_articles
   plant wiki ◀─────────── Supabase ─────────▶ links the result to a stored plant ◀─┘ (read-only, published only)

scripts/import-wiki.mjs (your machine, secret key) ──▶ GBIF · Wikidata · Wikipedia · Commons · Trefle ──▶ Supabase
```

- **Supabase**: accounts, profiles, saved checks, community, daily limit, and the wiki (plants, names, ids, content, images, health articles, staff roles, import runs).
- **Vercel**: hosts `public/` and runs `server.js` as `/api/diagnose`. `vercel.json` routes `/wiki/...` and `/admin`.

## Launch checklist (once)

### 1. Supabase database
Supabase dashboard → **SQL Editor** → New query. Run these files, in order:
1. `supabase/schema.sql`
2. `supabase/002_accounts.sql`
3. `supabase/003_wiki.sql` (plant wiki; adds tables only, changes nothing that exists)

### 2. Supabase sign-in settings
- **Authentication → URL Configuration**
  - **Site URL**: your live Vercel address, e.g. `https://your-app.vercel.app`
  - **Redirect URLs**: add the same address plus `http://localhost:3000`
- **Authentication → Sign In / Providers**: Email on, "Confirm email" on, anonymous sign-ins **off**.
- **Authentication → Emails → SMTP Settings**: before a public launch, connect your own email sender (e.g. Resend, Postmark, SendGrid). Supabase's built-in sender only sends a few emails per hour.
- Optional Google sign-in: enable Google under Providers, then set `GOOGLE_SIGN_IN = true` in `public/config.js`.

### 3. Vercel
Project → **Settings → Environment Variables**: add `ANTHROPIC_API_KEY` (Production and Preview), then redeploy.

### 4. Plant wiki
1. Copy `.env.example` to `.env` and fill in:
   - `SUPABASE_SERVICE_KEY`: Supabase → Project Settings → API Keys → **secret** key (`sb_secret_…`). Only on your machine, never in `public/`, never committed.
   - `WIKI_USER_AGENT`: your app name, site and a contact address. Wikimedia requires it.
   - `TREFLE_TOKEN` (optional): create a free account at trefle.io and copy the token from your profile.
2. Preview without writing anything: `npm run import-wiki:dry` (writes `data/import-preview.json`).
3. Import: `npm run import-wiki`. It prints a summary and records the run in `wiki_import_runs`. If it stops part-way, run it again: it resumes from `data/.import-checkpoint.json`. Use `--fresh` to start over, `--only "Aloe vera"` for one plant, `--draft` to import new plants unpublished.
4. Make yourself staff. In the SQL editor (use your account's email):
   ```sql
   insert into public.staff_roles (user_id, role)
   select id, 'admin' from auth.users where email = 'you@example.com'
   on conflict (user_id) do update set role = excluded.role;
   ```
   Use `'editor'` for people who may draft but not review or publish. Then open `/admin`.

## Plant wiki

**Sources and licences.** Each content row stores its own source, URL, licence, attribution and retrieval date, and the wiki page shows them.

| Source | What we take | Licence |
|---|---|---|
| GBIF Backbone Taxonomy | accepted name, synonyms, classification, common names | CC BY 4.0 |
| Wikidata | common names, ids (NCBI, POWO, iNaturalist) | CC0 |
| English Wikipedia | article text, as plain text, reference lists left out | CC BY-SA 4.0 (attributed, linked to the revision) |
| Wikimedia Commons | one photo per plant, only if the file's own licence is free | per file (creator and licence stored) |
| Trefle (optional) | habitat indicators (light, humidity, soil), temperature, sowing, native range, toxicity | CC BY 4.0 data; images **not** used (their licences aren't documented) |

Trefle's light/humidity/soil numbers are Ellenberg-style indicators of the plant's natural habitat, not care instructions; the wiki says so next to them. When no source covers a field (e.g. watering), the page says it's empty rather than filling it in.

**Imported vs editorial.** Imported rows and staff-written rows are separate. Re-imports update imported rows but never touch editorial rows, rows marked *reviewed*, or plant columns listed in `locked_fields`. Plants are matched by GBIF/Wikidata/Trefle id, then accepted name, then synonym, so re-running never duplicates.

**Roles.** `editor`: draft editorial content and health articles, edit names. `admin`: also review and publish. The database enforces this (RLS, column grants and triggers), not just the admin page. The import function can only be called with the secret key. A health article can only be published after an admin reviews it, and never if it's marked as AI-drafted.

**Photo checks.** During a check, Claude can call `lookup_plants` and `find_health_articles` (read-only, published content only, as the signed-in user). It must keep its own observations separate from `sourced_facts`, and each fact must cite a reference id the server gave it; facts with unknown ids are dropped. The server, not the model, decides whether the result links to a stored plant: it links only when the identification is confident and resolves to one stored plant (by name, synonym or GBIF id). Otherwise it shows likely matches.

## Run it locally

1. Node.js 22 or newer.
2. Copy `.env.example` to `.env` and add `ANTHROPIC_API_KEY`.
3. `npm install`, then `npm run dev` (restarts on changes) or `npm start`.
4. Open <http://localhost:3000>. The wiki is at <http://localhost:3000/wiki>, staff tools at `/admin`.

## Daily limit and cost

Each check is one AI request with up to a few wiki lookups, roughly 3–8 US cents with Claude Opus 5.5. Every account gets **10 free checks per day**. To change it, edit `public.daily_scan_limit()` in `supabase/002_accounts.sql` and run that function again in the SQL Editor.

## Moderation

Reported posts appear in Supabase → **Table Editor → reports**. Delete a bad post from the `posts` table (its replies, likes and reports go with it).

## Files

| File | What it does |
|---|---|
| `server.js` | Login and daily limit, the diagnosis with wiki tools, page routes |
| `wiki-context.js` | Wiki tools for Claude, fact checking, matching a result to a stored plant |
| `api/diagnose.js` | Vercel entry point for `server.js` |
| `vercel.json` | Routes for `/wiki/...` and `/admin` |
| `public/index.html`, `app.js` | Sign-in screen, app shell, identify flow |
| `public/auth.js` | Sign in / sign up / password reset, profile, account sheet |
| `public/result.js` | The diagnosis page |
| `public/garden.js`, `community.js` | My plants; community feed |
| `public/wiki.html`, `wiki.js` | Plant wiki: directory, search, filters, plant pages |
| `public/wiki-source.js` | Fetches and normalises open data (shared by the browser and the importer) |
| `public/admin.html`, `admin.js` | Staff tools: review, publish, editorial content, health articles, import runs |
| `public/style.css` | The design |
| `scripts/import-wiki.mjs` | The import command |
| `data/wiki-plants.txt` | The plants to import, grouped |
| `supabase/*.sql` | Database tables, security rules and storage |
