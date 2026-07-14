# BD Command Center

Business development and Allied Response Plan tool for Team Allied — Allied Restoration Company and Allied Rental Company.

Static site, no build step. Same pattern as the other Team Allied properties: push to `main`, GitHub Pages serves it. Data and shutoff photos live in Supabase.

```
index.html          the whole app (React + Babel from CDN, no bundler)
js/config.js        <- the only file you normally edit
js/store.js         data layer: Supabase, or this-browser-only if unconfigured
supabase/schema.sql run once in the Supabase SQL editor
```

---

## Two modes

**Standalone.** Leave `js/config.js` empty. No sign-in, no server, everything stays in the browser it was typed into. Fine for trying it out. Photos are downscaled and stored inline, and the browser will run out of room after a few dozen — this mode is not for the field.

**Shared.** Fill in the Supabase keys. Google Sign-In, one board for the whole team, photos in real storage. This is what the reps use.

---

## Standing it up (about 20 minutes)

### 1. Supabase project

1. Create a free project at supabase.com. Any region near California.
2. **SQL Editor → New query.** Paste all of `supabase/schema.sql`. **Edit the `insert into public.members` line to your real email first.** Run it.
3. **Authentication → Providers → Google.** Enable it. It'll ask for a client ID and secret — you get those from the Google Cloud console (APIs & Services → Credentials → OAuth client ID → Web application). Paste Supabase's callback URL into the "Authorized redirect URIs" box on the Google side.
4. **Authentication → URL Configuration.** Set Site URL to your Pages URL, and add it under Redirect URLs too:
   ```
   https://<user>.github.io/<repo>/
   ```
   If you point a subdomain at it later (`bd.teamallied.co`), add that as well.
5. **Project Settings → API.** Copy the Project URL and the `anon` `public` key.

### 2. Config

`js/config.js`:

```js
SUPABASE_URL:      'https://xxxxxxxx.supabase.co',
SUPABASE_ANON_KEY: 'eyJhbGciOi...',
```

The anon key is meant to be public — it identifies the project, it doesn't grant access. Access is decided by row-level security and the `members` allowlist. **Never put the `service_role` key in this file.** It bypasses all of that.

### 3. Deploy

```bash
git init
git add .
git commit -m "BD Command Center"
git remote add origin git@github.com:<user>/<repo>.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → `main` / root.** Live in about a minute.

### 4. Add your reps

**Table Editor → members → Insert row.** Email, name, role (`rep`, `manager`, or `admin`). Signing in with Google gets someone to the door; this table decides whether it opens. Anyone not listed sees a clear "you're not on the members list" screen instead of an empty board.

---

## How the data is laid out

**`accounts`** — one row per account, the whole account (buildings, shutoffs, contact tree, vulnerability findings) in a JSONB `payload`. Writes are scoped to one account and debounced ~700ms, so two reps working different accounts never overwrite each other, and typing into a building record doesn't hammer the network.

**`weeks`** — one row per rep per week. Reps see their own numbers; managers and admins can read the team's.

**`arp-photos`** — private storage bucket. Photos are downscaled to 1600px / ~72% JPEG on the phone before upload (a raw camera file is 8MB; nobody needs that to find a valve). They're served through signed URLs that expire in an hour — no public links to the inside of a client's mechanical room.

## Field use

The photo buttons use `capture="environment"`, so on a phone they open the rear camera directly. A tech standing in front of a valve taps *Take photo*, shoots it, and it's on the plan. That's the whole point of the migration.

Stage 1 will not reach 100% until **every** shutoff is tagged *and* photographed. Completion is earned, not self-reported.

## Backups

*Back up* exports the entire board as JSON; *Restore* reads it back. Do it monthly. Supabase's own backups are on the paid tiers.

## Cost

Free tier covers this comfortably: 500MB database, 1GB file storage, 50k monthly signed-in users. At ~250KB a photo, 1GB is roughly 4,000 shutoff photos. If it fills up, the Pro tier is $25/mo.
