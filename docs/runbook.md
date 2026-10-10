# Runbook

What to do when something is wrong, in the order you would actually do it.
Written for one operator with dashboard access to Render, Vercel and Neon.

## First look

```bash
curl -s https://<api-host>/api/v1/health      # process alive; does NOT touch the DB
curl -s https://<api-host>/api/v1/ready       # 200 + dbResponseMs, or 503
```

Then `GET /api/v1/platform/system` with a platform-admin token — the same four
numbers the admin dashboard shows:

| Field | Means | Act when |
|---|---|---|
| `unsentNotifications` | queued mail that has never been attempted, counting **only** the notification types that send email | climbing over minutes — delivery is not running at all |
| `failedEmails24h` | mail the provider refused | > 0 — check the SMTP credentials |
| `auditChainValid` | the hash chain verifies over the last 500 rows | **false — stop and investigate** |
| `dbResponseMs` | round trip to Neon | > 2000 consistently — the compute is cold or the region is wrong |

`auditChainValid: false` is the only one that should stop the day. Confirm with
the unbounded check at `GET /api/v1/platform/activity/verify`, which walks every
row and names the first broken link.

## Warming up before a demo

A cold stack costs 30–40 seconds: Render's free instance sleeps after 15 minutes
idle, and the Neon compute sleeps after a few.

```bash
curl -s https://<api-host>/api/v1/ready   # wakes BOTH: Render to serve, Neon to answer
```

Run it a minute before presenting, twice, and check the second one comes back
in under a second. `/health` alone wakes only Render — it never queries the
database, which is exactly why it is the health-check path.

For an unattended demo window, point a free uptime monitor at `/ready` every 10
minutes **and turn it off afterwards**: keeping the compute awake around the
clock will exhaust Neon's free monthly compute hours.

## Rolling back

The API and the client roll back independently, which is usually what you want.

1. **Render**: Deploys → pick the previous successful deploy → Rollback. It
   re-runs the pre-deploy command, so `prisma migrate deploy` runs again and
   does nothing (migrations are idempotent).
2. **Vercel**: Deployments → the previous production deployment → Promote.

**A rollback does not undo a migration.** Prisma has no down-migrations here on
purpose. If the new release added a column, rolling back the code is safe — the
old build ignores it. If a release *dropped* something, rolling back the code
will not bring the data back; that is the whole reason destructive changes are
split across two deploys ([deployment.md](deployment.md#migrations)).

If a migration itself fails, the deploy stops at the pre-deploy step and the old
instance keeps serving traffic. Fix the migration, commit a new one, deploy
again. Never edit the failed migration in place.

## Re-running a failed job

Four sweeps share one 15-minute timer (`server/src/jobs/index.ts`):
`deadline-sweep`, `po-response`, `email-retry`, `vendor-stats`.

- **Mail stuck in the queue**: the email-retry sweep picks it up on the next
  tick, up to `MAX_EMAIL_ATTEMPTS`. Nothing to do but watch
  `unsentNotifications` fall. If it does not, the SMTP credentials are wrong —
  the per-row `emailError` says why.
- **A tender past its deadline still shows as open**: reading the tender closes
  it (close-on-read), so opening the tender in the app is the fix. The sweep
  only exists for tenders nobody looked at.
- **Forcing a sweep**: there is no production endpoint for this, deliberately —
  a public "run this job" button is an obvious abuse target. In development and
  test, `POST /api/v1/_test/run-job/:name` runs one directly; it is mounted only
  when `NODE_ENV=test`. In production, restarting the service runs nothing on
  boot, so the honest answer is to wait for the tick or run the sweep from a
  local shell pointed at the production `DIRECT_URL`.

## Resetting a locked account

Five failed logins lock an account for 15 minutes (plan 03). The lock is a
timestamp on the user row, so it clears by itself. To clear it now, against the
production database:

```sql
-- Prisma maps tables to snake_case but leaves column names alone, so the
-- columns need quoting.
UPDATE users SET "failedLoginCount" = 0, "lockedUntil" = NULL
WHERE email = 'person@example.com';
```

A password nobody remembers is a different problem: the account holder uses
*Forgot password* and gets a one-time link valid for an hour. An operator cannot
set a password for somebody else, by design — there is no endpoint for it.

If the single platform admin is locked out, that SQL is the only way back in,
which is why the credentials for it live outside this repository.

## Restoring from Neon PITR

Neon keeps a history window (7 days on the free plan). Restore into a **new
branch** and point a local API at it before touching production.

1. Neon console → Branches → *New branch* → from `main`, *at a point in time*,
   pick the timestamp.
2. Copy the new branch's pooled and direct connection strings.
3. Locally: put them in `server/.env` as `DATABASE_URL` / `DIRECT_URL`, run
   `npm run dev:server`, then `curl localhost:4000/api/v1/ready`.
4. Verify the data is actually there — log in and open a known tender, and run
   `GET /api/v1/platform/activity/verify` to confirm the audit chain still
   verifies on the restored copy.
5. To promote: in Neon, make the restored branch the primary, then update
   `DATABASE_URL` and `DIRECT_URL` on Render and redeploy.

Step 4 is the point of the exercise. **Record the date of the last drill here:**

| Date | Restored to | Booted? | Notes |
|---|---|---|---|
| _not yet performed_ | | | run once before submission |

## When the demo machine has no internet

Everything is hosted, so there is no offline mode. The fallback, in order:

1. **Phone hotspot.** The whole stack is a few hundred kB of JavaScript and
   JSON; it works fine on a phone tether.
2. **Local stack, cached dependencies.** `npm run dev` needs no network *except*
   for the database. It will not start without one.
3. **A local Postgres.** If one is installed, point `DATABASE_URL` and
   `DIRECT_URL` at it, `npx prisma migrate deploy`, then seed. This is the only
   genuinely offline path and it has to be prepared **before** the day — not
   during it.
4. **Screen recording.** Record a full source-to-pay walkthrough the night
   before and keep it on the machine. Unglamorous, and it has saved more
   demonstrations than any of the above.

## Secret rotation

If a secret reaches git: **rotate first, rewrite history second.** Rotating is
what actually protects anything; the history rewrite is tidying up.

| Secret | Rotate where | Blast radius |
|---|---|---|
| `JWT_*_SECRET` | Render → regenerate → redeploy | everyone is logged out |
| `SMTP_PASS` | Google account → App passwords | mail stops until updated |
| `CLOUDINARY_API_SECRET` | Cloudinary dashboard | uploads and signed URLs fail until updated |
| Neon password | Neon → Roles → reset | update both URLs, redeploy |
