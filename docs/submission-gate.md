# Submission gate

Plan 20 §7. The checklist to pass before the project goes in.

Tick each box in order. Nothing here is optional; nothing here is "I'll check
on the day".

## Code

- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run check:conventions` passes (silent, exit 0).
- [ ] `npm run test:unit` passes.
- [ ] `npm run test:integration` passes against the Neon `test` branch.
- [ ] `npm run build` succeeds for shared, server and client.
- [ ] The client bundle is under 300 kB gzipped (recorded in
      `docs/performance.md`).

## Seed and data

- [ ] `npm run db:seed -- --reset` produces the full dataset from empty **in
      under 60 seconds**.
- [ ] Running `npm run db:seed` immediately after produces no new rows — exit 0,
      every tender count unchanged.
- [ ] The four demo logins all work on the **deployed** URL, not just local.

## Demo

- [ ] The 10-minute script in `docs/demo.md` runs end to end **on production**,
      three times, each time without touching the database between runs.
- [ ] A screen recording of the demo exists.

## Security

- [ ] `docs/security-review.md` records a 10/10 run of the ten-point review.
      Re-run the script against production with `REVIEW_API` pointed at the
      Render URL and record the output.
- [ ] `GET /platform/activity/verify` returns `valid: true` against the
      production database.

## Documentation

- [ ] Every doc in `docs/` referenced by the README exists.
- [ ] `docs/api.md` was regenerated after the last router change
      (`npm run docs:api`).
- [ ] `docs/business-rules.md` lists ≥ 30 rules, each naming an existing passing
      test — spot-check three at random.
- [ ] Both ER diagrams export cleanly (`docs/er-diagram.png`,
      `docs/er-chain.png`) and read on an A4 page.
- [ ] Someone else has cloned the repo and reached a running app from the
      README alone, with no spoken help.

## Deployment

- [ ] The Render service is in the same region as the Neon branch
      (ADR-005). `curl -s /api/v1/ready` returns `responseTimeMs` under 50.
- [ ] `curl -I https://<prod>/api/v1/health` shows `Strict-Transport-Security`,
      a CSP, `X-Frame-Options: DENY`, no `X-Powered-By`.
- [ ] The deployed Vercel origin and the Render `APP_URL` match exactly, no
      trailing slash.
- [ ] A Neon PITR drill has been performed and recorded in
      `docs/runbook.md` (date filled in).

Once every box is ticked, submit.
