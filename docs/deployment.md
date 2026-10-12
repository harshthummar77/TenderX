# Deployment

Three hosted pieces, all on free tiers, no Docker anywhere: the API on Render,
the client on Vercel, Postgres on Neon. A fresh clone needs `npm i` and a filled
`server/.env` — nothing else (plan 19 §1).

## Environments

| Env | Client | API | Database | Files | Mail |
|---|---|---|---|---|---|
| local | Vite `:5173` | `:4000` | Neon `dev` branch | Cloudinary (dev folder) | console transport when SMTP is unset |
| test / CI | — | in-process (supertest) | Neon `test` branch | in-memory adapter | in-memory adapter |
| production | Vercel | Render | Neon `main` branch | Cloudinary (prod folder) | Gmail SMTP |

The client never needs a `.env` locally: Vite proxies `/api` to `:4000`, which
also keeps the refresh cookie first-party in development. In production the
client is on a different origin, so `VITE_API_URL` has to be set on Vercel.

## Neon

```
DATABASE_URL = postgresql://…@ep-xxxx-pooler.<region>.aws.neon.tech/neondb?sslmode=require&pgbouncer=true&connect_timeout=15&connection_limit=10
DIRECT_URL   = postgresql://…@ep-xxxx.<region>.aws.neon.tech/neondb?sslmode=require
```

Pooled for the app, direct for migrations; `schema.prisma` has `directUrl`, so
Prisma picks between them on its own.

If `prepared statement "s0" already exists` or an interactive-transaction error
shows up, point `DATABASE_URL` at the **direct** endpoint with
`connection_limit=5`. One Render instance makes that safe. This is a pgbouncer
interaction, not a bug in the app.

**Autosuspend.** The Neon compute sleeps after a few minutes idle and the free
Render instance sleeps after 15. A cold demo therefore costs 30–40 seconds.
The warm-up procedure is in [the runbook](runbook.md#warming-up-before-a-demo).
Keeping the database awake around the clock with a pinger will exhaust the free
monthly compute hours, so the pinger goes on for demo day and off afterwards.

**Backups** are Neon point-in-time restore. There is no `pg_dump` job on
purpose; the restore drill is in the runbook, and a restore nobody has performed
is not a backup.

## Migrations

| Where | Command | When |
|---|---|---|
| development | `npx prisma migrate dev` | against the `dev` branch, by hand |
| CI | `npx prisma migrate deploy` | every push, against the `test` branch — proves the migrations apply from zero |
| production | `npx prisma migrate deploy` | Render's **pre-deploy command**, before the new instance takes traffic |

Rules that matter more than the commands:

- **Never migrate at application boot.** One restart overlap and two instances
  race the same migration. That is why it is a pre-deploy command.
- **Never** `prisma db push` outside prototyping.
- **Never edit an applied migration.** Fix a bad one by writing a new one.
- Destructive changes go in two deploys: (1) add the new column and backfill,
  (2) drop the old one. A single deploy that drops a column breaks every
  instance still running the previous build.

## Render

`render.yaml` at the repo root is the blueprint. The parts worth knowing:

- `buildCommand` builds `shared` before `server`, because the server imports
  the built `@tb/shared` types.
- `preDeployCommand` runs the migrations.
- `healthCheckPath` is `/api/v1/health`, which deliberately does **not** touch
  the database — a sleeping Neon compute must not fail the health check.
  `/api/v1/ready` is the one that probes the database and answers 503 when it
  is unreachable.
- `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` use `generateValue: true`, so
  Render mints two different 32-byte secrets and nobody ever sees them.
  Everything else secret is `sync: false` — set once in the dashboard, never in
  git.

Rotating a JWT secret logs everybody out. That is the intended behaviour and is
the correct response to a leak.

`SENTRY_DSN` is optional: unset, the app boots with error reporting off and says
so in the startup line (`"sentry":false`). Set it on Render to turn it on; see
[security.md](security.md#observability) for what is and is not sent.

## Vercel

Root directory `client`, with `client/vercel.json` committed:

- `rewrites` sends everything that is not under `/assets/` to `/index.html`,
  which is what makes a deep link like `/tenders/<id>` survive a refresh.
- `/assets/*` is immutable for a year — the filenames are content-hashed.
- `VITE_API_URL` is set per environment in the Vercel dashboard; it is baked
  into the bundle at build time, so changing it needs a redeploy.

`APP_URL` on Render must be exactly the Vercel origin. CORS uses it as the one
allowed origin, and every link in an outgoing email is built from it.

## Step by step, first release

Repository: `https://github.com/harshthummar77/TenderX`, branch `main`. The
repo root is the `Tender X` folder, so `render.yaml` and `client/vercel.json`
are already where both platforms look for them.

Nothing below needs Docker, a credit card, or a paid plan.

### 0. Push what is on disk

Render and Vercel both deploy from GitHub, so they can only see committed code.
Run this yourself (version control is yours):

```bash
cd "C:/Users/HARSH/Desktop/se project ldrp sem 5/Tender X"
git status                    # confirm no .env file is listed — .gitignore covers them
git add -A
git commit -m "chore(deploy): render + vercel + neon production, security headers, observability, runbook"
git push origin main
```

If `git status` shows `server/.env`, stop and fix `.gitignore` before pushing.

### 1. Neon: create the production branch

1. Neon console → your project → **Branches** → **New branch**.
2. Name it `main`, create it from `main`/`production` (an empty parent is fine —
   the migrations build the schema).
3. Open the new branch → **Connection details** and copy **two** strings:
   - the **pooled** one (host contains `-pooler`) → this is `DATABASE_URL`
   - the **direct** one (no `-pooler`) → this is `DIRECT_URL`
4. Append the parameters to the pooled string:

```
?sslmode=require&pgbouncer=true&connect_timeout=15&connection_limit=10
```

Keep both strings somewhere safe for the next two steps. They are passwords.

### 2. Apply the migrations to it, once, by hand

Do this **before** the first Render deploy: a free Render service ignores
`preDeployCommand`, so otherwise the API starts against an empty database.

The Prisma CLI only ever reads `.env` from the working directory, so do **not**
pass connection strings on the command line (that does not work in PowerShell
anyway) and do **not** edit `server/.env`, which still points at `dev`. Use the
wrapper the repo already has.

Create `server/.env.production` — `.gitignore` already covers `.env.*`:

```
DATABASE_URL=<pooled string from step 1, with the parameters appended>
DIRECT_URL=<direct string from step 1>
```

Then:

```powershell
cd "C:\Users\HARSH\Desktop\se project ldrp sem 5\Tender X\server"
node scripts/prisma-env.mjs .env.production migrate deploy
```

The wrapper prints the host it is about to touch before it runs:

```
[prisma-env] .env.production -> ep-xxxx.ap-southeast-1.aws.neon.tech
```

**Read that line.** If the host is the `dev` or test endpoint, stop — the file
has the wrong strings in it. Expect `All migrations have been successfully
applied`, then confirm:

```powershell
node scripts/prisma-env.mjs .env.production migrate status
```

Keep the file for future migrations, or delete it and recreate it when needed.
It is a password in a text file either way, so do not copy it anywhere else.

### 3. Create the platform admin

There is **no seed script yet** (plan 20), and no endpoint creates a platform
admin — by design, since that account is the most powerful one in the system.
Two honest options:

- **Register an organization through the app** once it is deployed
  (`/register/organization`) and work as an org admin. A platform admin is only
  needed to approve organizations and vendors.
- **Insert one directly**, with a bcrypt hash you generate locally:

```bash
node -e "require('bcryptjs').hash(process.argv[1],12).then(console.log)" "<your password>"
```

then, against the production branch:

```sql
INSERT INTO users (id, email, "fullName", "passwordHash", role, status, "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'harshthummar77@gmail.com', 'Platform Admin',
        '$2a$12$/ay8pRcjffAAtnRnZdOQXOWz2joPdX1XIhJFSX/Z7g22qrhv1.7wy', 'PLATFORM_ADMIN', 'ACTIVE', now(), now());
```

Never reuse the demo password from `docs/demo-credentials.md` here.

### 4. Render: the API

1. **New** → **Blueprint** → connect the `TenderX` repo → Render reads
   `render.yaml` and proposes the `tenderbridge-api` service.
2. It will ask for every variable marked `sync: false`. Fill in:

| Key | Value |
|---|---|
| `DATABASE_URL` | the pooled Neon string from step 1 |
| `DIRECT_URL` | the direct Neon string from step 1 |
| `APP_URL` | leave a placeholder for now, e.g. `https://example.vercel.app` — step 6 corrects it |
| `API_URL` | the Render URL, once it exists: `https://tenderbridge-api.onrender.com` |
| `CLOUDINARY_*` | from the Cloudinary dashboard, or leave blank to run without file uploads |
| `SMTP_USER` | `harshthummar77@gmail.com` |
| `SMTP_PASS` | the Gmail **app password**, no spaces |
| `MAIL_FROM` | `TenderBridge <harshthummar77@gmail.com>` |
| `SENTRY_DSN` | leave blank unless you want error reporting |

   `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are generated by Render — do not
   type your own, and never reuse the development ones.

3. Deploy. Watch the log for `"msg":"API up"` with `"sentry":false`.
4. Verify, replacing the host with yours:

```bash
curl -s https://tenderbridge-api.onrender.com/api/v1/health
curl -s https://tenderbridge-api.onrender.com/api/v1/ready    # 200 + dbResponseMs
curl -I https://tenderbridge-api.onrender.com/api/v1/health   # CSP, HSTS, no X-Powered-By
```

If `/ready` returns 503, the database URLs are wrong. If `/health` works and
`/ready` is slow on the first call, that is the Neon compute waking up.

### 5. Vercel: the client

1. **Add New** → **Project** → import `TenderX`.
2. **Root Directory**: `client`. Vercel then picks up `client/vercel.json`,
   which carries the build command, the SPA rewrite and the static headers.
3. **Environment Variables** → add:

```
VITE_API_URL = https://tenderbridge-api.onrender.com/api/v1
```

   **Include the `/api/v1`.** `client/src/lib/api.ts` uses this value as the
   whole base URL and falls back to a relative `/api/v1` when it is unset — so
   omitting the suffix produces 404s on every call, and omitting the variable
   makes the client call *itself*.

4. Deploy, and copy the production URL.

### 6. Close the loop

Back on Render, set `APP_URL` to the exact Vercel URL (no trailing slash) and
redeploy. Until this is done, every login fails CORS — `APP_URL` is the single
allowed origin and the base for every link in an outgoing email.

### 7. Verify the deployment

```bash
curl -I https://tenderbridge-api.onrender.com/api/v1/health | grep -iE "strict-transport|content-security|x-frame|x-powered"
```

Then in the browser, on the Vercel URL:

1. Register an organization, or log in as the platform admin from step 3.
2. **Reload the page.** This is the check that matters most: it exercises
   `POST /auth/refresh` cross-site, which is why the refresh cookie is
   `SameSite=None` in production. If you are thrown back to the login screen,
   the cookie is not making the hop — check `APP_URL`, and that the API is
   actually on HTTPS.
3. Leave the tab for 15 minutes and act again, so an access token expires and
   gets refreshed.
4. Invite a user and confirm the email arrives with a link to the Vercel host,
   not `localhost`.

### Deploying again, later

`git push origin main` redeploys both apps. One extra step whenever a migration
is involved, because the free plan ignores `preDeployCommand`:

```powershell
cd "C:\Users\HARSH\Desktop\se project ldrp sem 5\Tender X\server"
node scripts/prisma-env.mjs .env.production migrate deploy
```

Run it **before** the push for an additive migration, and follow
[the two-deploy rule](#migrations) for a destructive one. If you upgrade to a
paid instance type, Render runs `preDeployCommand` itself and this step
disappears.

### If something fails

| Symptom | Cause |
|---|---|
| Render build fails on `@tb/shared` | `build:shared` did not run first; it is in `buildCommand` already, so check the log for an earlier npm error |
| `/health` 200 but `/ready` 503 | `DATABASE_URL` / `DIRECT_URL` wrong, or the Neon branch was never migrated |
| Login fails with a CORS error | `APP_URL` on Render is not exactly the Vercel origin (step 6) |
| Every API call 404s from the client | `VITE_API_URL` is missing the `/api/v1` suffix |
| Logged out on reload, or after 15 minutes | the refresh cookie is not making the cross-site hop — the API must be on HTTPS and `APP_URL` must match |
| Invitation emails link to `localhost` | `APP_URL` still has its placeholder value |
| First request after idle takes 30–40 s | expected: Render and Neon both suspend. See [the runbook](runbook.md#warming-up-before-a-demo) |
