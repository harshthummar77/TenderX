# Security review

The ten-point review from plan 19 §5, run on **2026-10-09** against the local
API (`localhost:4000`) on the Neon **dev** branch with the demo dataset from
[demo-credentials.md](demo-credentials.md).

**Result: 10 of 10 passed.** The run is reproducible:

```bash
npm run dev:server > api.log 2>&1                          # one terminal
REVIEW_LOG=api.log node server/scripts/security-review.mjs # another
```

The script is the evidence generator, not a replacement for reading it — every
check asserts on a real HTTP response or a real database effect, and prints the
status codes it saw so a reader can disagree with the conclusion.

## What ran, and what it proved

    PASS  1. vendor token on buyer endpoints
          10 endpoints -> 403, 403, 403, 403, 403, 403, 403, 403, 403, 403
    PASS  2. cross-tenant ids return 404, not 403 (no existence leak)
          7 ids owned by another vendor -> 404
    PASS  4. documents belonging to another tenant
          8 documents -> 403
    PASS  3. sealed-bid leakage across buyer endpoints
          TND/2026-27/000003 (PUBLISHED, seal intact): 4 endpoints x 3 figures -> 0 hits
    PASS  6. HTML renamed to .pdf is rejected
          422 document.content_mismatch SVG and markup files are never accepted — they can carry executable script
    PASS  7. SQL metacharacters are treated as text
          search -> 200, users table intact (8 rows)
    PASS  9. audit log rejects UPDATE
          UPDATE affected 0 rows
    PASS  10. no password, bearer token or bank number in the log
          73 log lines scanned for 3 secrets, 0 hits
    PASS  5. 15 rapid logins hit the limiter
          codes 401,401,401,401,401,401,401,429,429,429,429,429,429,429,429 | retry-after/reset: 869
    PASS  8. security headers present, no unsafe-eval, no X-Powered-By
          CSP set; XFO=DENY; HSTS=max-age=31536000; includeSubDomains; X-Powered-By=absent

    10/10 checks passed

## Check by check

**1. A vendor token against buyer endpoints — all 403.**
Ten endpoints: `/approvals`, `/payments/payable`, `/organizations/me`,
`/organizations/me/members`, `/reports/spend`, `/platform/stats`,
`/platform/organizations`, `/platform/system`, `/vendors?status=APPROVED`,
`/activity`. Every one 403.

Two endpoints that *look* like they belong on that list are deliberately not:
`/invoices` and `/grns`. Both are dual-scope by design — `scopeToParty()` gives
a vendor its own rows, because a supplier is entitled to see the receipt of its
own goods and its own invoices. They answer 200 with the vendor's own data, not
the buyer's. Putting them in the list would have produced a "failure" that was
really a misreading of the permission model.

**2. Cross-tenant ids — all 404, never 403.** Gamma Systems' token asking for 7
records owned by Acme Networks (quotations, invoices, purchase orders,
deliveries). All 404. The direction matters: Acme owns most of the dataset, so
probing *from* Gamma is the direction with enough foreign ids to be worth
running. 404 rather than 403 is the point — a 403 would confirm the record
exists.

The plan asked for 10 ids; the dev dataset only holds 7 of those types for one
vendor. With check 4's 8 documents that is 15 cross-tenant probes, all denied.

**3. Sealed bids — zero leaks.** `TND/2026-27/000003` was published with a
deadline three days out and one sealed bid (`QTN/2026-27/000004`, grand total
₹14,07,350). Four buyer endpoints — the tender, its quotations, the bid summary
and the comparison — were fetched with the buyer's own token and grepped for the
bid's subtotal, tax and grand total. Zero hits on all four.

This is the check worth the most: the buyer who owns the tender cannot see the
amount, which is the entire promise of a sealed bid.

**4. Another tenant's documents — all 403.** 8 document ids owned by other
parties, fetched with Gamma's token. All 403. (Documents answer 403 rather than
404 because ownership is checked against the owner record, not scoped in the
query — the id is already known to the caller in a signed-URL flow.)

**5. Fifteen rapid logins — 429 after 8.** Eight 401s, then seven 429s, with a
reset of 870 seconds. The 401s are constant-shape: a wrong password on a real
account and an unknown email are indistinguishable.

**6. HTML renamed to `.pdf` — rejected.** `payload.pdf` containing
`<html><script>alert(1)</script></html>`, declared as `application/pdf`, was
refused with 422 `document.content_mismatch`: *"SVG and markup files are never
accepted — they can carry executable script"*. The extension and the declared
MIME type are both ignored; the magic bytes decide.

**7. SQL metacharacters — literal text.** `'; DROP TABLE users;--` through the
vendor search returned 200 with no matches and the `users` table intact at 8
rows. Prisma parameterised it; nothing was concatenated.

**9. `UPDATE` on the audit log — 0 rows.** Through the application's own
connection, with its own credentials: `UPDATE activity_logs SET summary =
'tampered'` affected 0 rows. Append-only is enforced at the database, not by
convention in the service layer.

**10. Secrets in the log — none.** 73 log lines from a full review run, grepped
for three secrets: the demo password, `Bearer ey`, and a real bank account
number read out of the vendor table. Zero hits.
pino's redaction list covers the paths; `lib/audit.ts` redacts bank fields
before hashing, so not even the audit row holds the value.

**8. Response headers — correct.** From `curl -I` on the local API:

```
Content-Security-Policy: default-src 'self';base-uri 'self';font-src 'self' https://fonts.gstatic.com data:;
  form-action 'self';frame-ancestors 'none';img-src 'self' data: blob: https://res.cloudinary.com;
  object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' 'unsafe-inline';
  connect-src 'self' http://localhost:4000
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Access-Control-Allow-Origin: http://localhost:5173
RateLimit-Policy: 300;w=900
```

No `unsafe-eval`, no `unsafe-inline` in `script-src`, no `X-Powered-By`, and
CORS is one exact origin rather than `*`. `upgrade-insecure-requests` is absent
locally on purpose — it is added only when `NODE_ENV=production`.

## Not covered by this run

Honest limits, because a review that overstates itself is worth nothing:

- **Run against local HTTP, not the deployed URL.** HSTS is present in the
  header but means nothing without TLS. Re-run check 8 against the Render URL
  once deployed; the other nine are transport-independent.
- **The dev database, not production.** The dataset is the demo dataset, so the
  sample sizes are small (7 foreign records, 8 documents) and the chain check in
  check 9 touched one row.
- **Check 10 scanned 73 lines from one review run**, not a full end-to-end log,
  and it only runs when `REVIEW_LOG` points at the API's captured stdout.
  The redaction list is verified by inspection as well as by this grep.
- **No dependency audit.** `npm audit` is not part of this review and no
  advisory check runs in CI.
- **Graceful shutdown was not exercised.** Windows has no real SIGTERM, so the
  drain path in `server.ts` is verified by reading it, not by running it. It
  matters on Render (Linux), where it has not yet been observed.
