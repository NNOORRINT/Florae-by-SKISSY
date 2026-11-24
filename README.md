# 🌱 Planty by Skissy

Take a photo of a plant and Planty tells you what it is, its growth stage, anything wrong with it, and exactly what to do next. People sign in with an account; their checks are saved to "My plants" on every device, and they can share and ask questions in the Community.

## How it works

```
Browser (public/)  ──photo + login token──▶  server.js (Vercel function)  ──▶  Claude AI (vision)
   sign in, scan,                              checks the login and the
   My plants, community ◀──── Supabase ────▶   daily limit, keeps the API key secret
```

- **Supabase**: accounts, profiles, saved checks (`scans`, private photo bucket), community (posts, replies, likes, reports), daily limit.
- **Vercel**: hosts `public/` and runs `server.js` as `/api/diagnose`.

## Launch checklist (once)

### 1. Supabase database
Supabase dashboard → **SQL Editor** → New query. Run these two files, in order:
1. `supabase/schema.sql`
2. `supabase/002_accounts.sql`

### 2. Supabase sign-in settings
- **Authentication → URL Configuration**
  - **Site URL**: your live Vercel address, e.g. `https://your-app.vercel.app`
  - **Redirect URLs**: add the same address plus `http://localhost:3000`
- **Authentication → Sign In / Providers**: Email on, "Confirm email" on, anonymous sign-ins **off**.
- **Authentication → Emails → SMTP Settings**: before a public launch, connect your own email sender (e.g. Resend, Postmark, SendGrid). Supabase's built-in sender only sends a few emails per hour, which is not enough for real sign-ups.
- Optional Google sign-in: enable Google under Providers, then set `GOOGLE_SIGN_IN = true` in `public/config.js`.

### 3. Vercel
Project → **Settings → Environment Variables**: add `ANTHROPIC_API_KEY` (Production and Preview), then redeploy.

## Run it locally

1. Node.js 22 or newer.
2. Copy `.env.example` to `.env` and paste your key after `ANTHROPIC_API_KEY=`.
3. `npm install`, then `npm run dev` (restarts on changes) or `npm start`.
4. Open <http://localhost:3000>.

## Daily limit and cost

Each check is one AI request, roughly 3–7 US cents with Claude Opus 5.5. Every account gets **10 free checks per day**. To change it, edit the number in `public.daily_scan_limit()` in `supabase/002_accounts.sql` and run that function again in the SQL Editor. To lower the cost per check, change `MODEL` in `server.js` to `claude-sonnet-5-5`.

## Moderation

Reported posts appear in Supabase → **Table Editor → reports**. Delete a bad post from the `posts` table (its replies, likes and reports go with it).

## Files

| File | What it does |
|---|---|
| `server.js` | Checks the login and daily limit, asks Claude for a diagnosis, returns it |
| `api/diagnose.js` | Vercel entry point for `server.js` |
| `public/index.html` | Sign-in screen, app shell, tabs and sheets |
| `public/app.js` | Start-up, navigation, scan flow |
| `public/auth.js` | Sign in / sign up / password reset, profile, account sheet |
| `public/result.js` | The diagnosis page |
| `public/garden.js` | My plants (saved checks) |
| `public/community.js` | Feed, posts with photos, likes, replies, reports |
| `public/ui.js` | Shared helpers and icons |
| `public/config.js` | Supabase address/key and the Google sign-in switch |
| `public/style.css` | The design |
| `public/privacy.html` | Privacy notice |
| `supabase/*.sql` | Database tables, security rules and storage |
