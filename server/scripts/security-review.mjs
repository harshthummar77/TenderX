/**
 * The ten-point security review from plan 19 §5.
 *
 * Run it, do not trust it: every check prints the status codes it actually saw,
 * so the conclusion can be disagreed with. Results go in
 * docs/security-review.md.
 *
 *   npm run dev:server > api.log 2>&1              # one terminal
 *   REVIEW_LOG=api.log node server/scripts/security-review.mjs
 *
 * Needs the demo dataset (docs/demo-credentials.md) on the dev branch. Check 5
 * exhausts the login limiter for 15 minutes, so it runs last — a second run
 * inside that window needs the API restarted.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.REVIEW_API ?? 'http://localhost:4000/api/v1';
const PASSWORD = process.env.REVIEW_PASSWORD ?? 'TenderDemo2026';
const LOG_PATH = process.env.REVIEW_LOG ?? null;

// env.ts parses these files by hand; do the same rather than add dotenv.
for (const line of readFileSync(join(serverDir, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
}

const prisma = new PrismaClient();
const results = [];
const record = (n, title, pass, detail) => {
  results.push({ n, title, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}. ${title}\n      ${detail}`);
};

async function login(email) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json();
  if (!body.success) throw new Error(`login ${email}: ${res.status} ${JSON.stringify(body.error)}`);
  return body.data.accessToken;
}

const call = async (path, token, init = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });

const vendorToken = await login('rahul@acme.test');
const buyerToken = await login('priya@meridian.test');

/* 1 — a vendor token against buyer endpoints */
{
  const endpoints = [
    '/approvals',
    '/payments/payable',
    '/organizations/me/members',
    '/reports/spend',
    '/platform/stats',
    '/platform/organizations',
    '/platform/system',
    '/organizations/me',
    '/vendors?status=APPROVED',
    '/activity',
  ];
  const codes = [];
  for (const path of endpoints) codes.push((await call(path, vendorToken)).status);
  const denied = codes.every((c) => c === 403 || c === 404);
  record(1, 'vendor token on buyer endpoints', denied, `${endpoints.length} endpoints -> ${codes.join(', ')}`);
}

/* 2 + 4 — one tenant asking for another tenant's ids.
 *
 * Probed from Gamma's side, because Acme is the vendor that owns most of the
 * dataset — this is the direction with enough foreign ids to be worth running.
 */
{
  const gammaToken = await login('neha@gamma.test');
  const acme = await prisma.vendor.findFirst({ where: { companyName: 'Acme Networks' } });
  const gamma = await prisma.vendor.findFirst({ where: { companyName: 'Gamma Systems' } });

  const mine = { vendorId: acme.id };
  const [quotations, invoices, pos, deliveries] = await Promise.all([
    prisma.quotation.findMany({ where: mine, select: { id: true }, take: 10 }),
    prisma.invoice.findMany({ where: mine, select: { id: true }, take: 10 }),
    prisma.purchaseOrder.findMany({ where: mine, select: { id: true }, take: 10 }),
    prisma.delivery.findMany({ where: mine, select: { id: true }, take: 10 }),
  ]);
  const foreignDocs = await prisma.document.findMany({
    where: { ownerId: { not: gamma.id } },
    select: { id: true },
    take: 20,
  });

  const probe = async (paths) => {
    const codes = [];
    for (const p of paths) codes.push((await call(p, gammaToken)).status);
    return codes;
  };

  const codes = [
    ...(await probe(quotations.map((r) => `/vendor/quotations/${r.id}`))),
    ...(await probe(invoices.map((r) => `/vendor/invoices/${r.id}`))),
    ...(await probe(pos.map((r) => `/vendor/purchase-orders/${r.id}`))),
    ...(await probe(deliveries.map((r) => `/vendor/deliveries/${r.id}`))),
  ];
  record(
    2,
    'cross-tenant ids return 404, not 403 (no existence leak)',
    codes.length > 0 && codes.every((c) => c === 404),
    `${codes.length} ids owned by another vendor -> ${[...new Set(codes)].join(', ')}`,
  );

  const dCodes = await probe(foreignDocs.map((d) => `/documents/${d.id}`));
  record(
    4,
    "documents belonging to another tenant",
    dCodes.length > 0 && dCodes.every((c) => c === 403 || c === 404),
    `${dCodes.length} documents -> ${[...new Set(dCodes)].join(', ') || 'none in dataset'}`,
  );
}

/* 3 — sealed bids: no amount reachable before the deadline */
{
  const sealed = await prisma.tender.findFirst({
    where: { bidOpenedAt: null, quotations: { some: {} } },
    select: { id: true, referenceNumber: true, status: true, bidSubmissionDeadline: true },
  });

  if (!sealed) {
    record(3, 'sealed-bid leakage', false, 'no live sealed tender in the dataset — check skipped');
  } else {
    const bids = await prisma.quotation.findMany({
      where: { tenderId: sealed.id },
      select: { grandTotal: true, subtotal: true, taxAmount: true },
    });
    const secrets = bids.flatMap((b) =>
      [b.grandTotal, b.subtotal, b.taxAmount].map((d) => String(d)).filter(Boolean),
    );
    const paths = [
      `/tenders/${sealed.id}`,
      `/tenders/${sealed.id}/quotations`,
      `/tenders/${sealed.id}/bid-summary`,
      `/tenders/${sealed.id}/comparison`,
    ];
    const leaks = [];
    for (const p of paths) {
      const text = await (await call(p, buyerToken)).text();
      for (const secret of secrets) {
        const bare = secret.replace(/\.00$/, '');
        if (bare.length >= 4 && text.includes(bare)) leaks.push(`${p} leaked ${secret}`);
      }
    }
    record(
      3,
      'sealed-bid leakage across buyer endpoints',
      leaks.length === 0,
      `${sealed.referenceNumber} (${sealed.status}, seal intact): ${paths.length} endpoints x ${secrets.length} figures -> ${leaks.length} hits`,
    );
  }
}

/* 6 — an HTML payload renamed .pdf */
{
  const acme = await prisma.vendor.findFirst({ where: { companyName: 'Acme Networks' } });
  const form = new FormData();
  const payload = '<html><script>alert(1)</script></html>';
  form.append('file', new Blob([payload], { type: 'application/pdf' }), 'payload.pdf');
  form.append('type', 'VENDOR_PAN');
  form.append('ownerType', 'VENDOR');
  form.append('ownerId', acme.id);

  const res = await call('/documents', vendorToken, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  record(
    6,
    'HTML renamed to .pdf is rejected',
    res.status >= 400,
    `${res.status} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`.trim(),
  );
}

/* 7 — SQL injection in a search field */
{
  const payload = "'; DROP TABLE users;--";
  const res = await call(`/vendors?q=${encodeURIComponent(payload)}`, buyerToken);
  const stillThere = await prisma.user.count();
  record(
    7,
    'SQL metacharacters are treated as text',
    res.status === 200 && stillThere > 0,
    `search -> ${res.status}, users table intact (${stillThere} rows)`,
  );
}

/* 9 — the audit log is append-only through the app's own connection */
{
  let detail;
  let pass = false;
  try {
    const changed = await prisma.$executeRawUnsafe(
      "UPDATE activity_logs SET summary = 'tampered' WHERE id = (SELECT id FROM activity_logs LIMIT 1)",
    );
    pass = changed === 0;
    detail = `UPDATE affected ${changed} rows`;
  } catch (error) {
    // A rule or trigger that raises is just as good as UPDATE 0.
    pass = true;
    detail = `refused: ${String(error).split('\n').find((l) => l.includes('ERROR')) ?? 'database rejected the update'}`;
  }
  record(9, 'audit log rejects UPDATE', pass, detail);
}

/* 10 — secrets in the log */
{
  // Point REVIEW_LOG at the API's captured stdout; without it there is nothing
  // to grep, and the check says so rather than passing silently.
  if (!LOG_PATH) {
    record(10, 'no secrets in the log', false, 'set REVIEW_LOG=<api stdout file> to run this check');
  } else {
    const log = readFileSync(LOG_PATH, 'utf8');
    const bank = await prisma.vendor.findFirst({
      where: { bankAccountNumber: { not: null } },
      select: { bankAccountNumber: true },
    });
    const needles = [PASSWORD, 'Bearer ey', bank?.bankAccountNumber].filter(Boolean);
    const hits = needles.filter((n) => log.includes(n));
    record(
      10,
      'no password, bearer token or bank number in the log',
      hits.length === 0,
      `${log.split('\n').length} log lines scanned for ${needles.length} secrets, ${hits.length} hits`,
    );
  }
}

/* 5 — rate limiting. Last, because it burns the login budget for 15 minutes. */
{
  const codes = [];
  let retryAfter = null;
  for (let i = 0; i < 15; i++) {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password-x' }),
    });
    codes.push(res.status);
    if (res.status === 429) retryAfter ??= res.headers.get('retry-after') ?? res.headers.get('ratelimit-reset');
  }
  record(
    5,
    '15 rapid logins hit the limiter',
    codes.includes(429),
    `codes ${codes.join(',')} | retry-after/reset: ${retryAfter ?? 'absent'}`,
  );
}

/* 8 — headers (local; production adds HSTS over TLS) */
{
  const res = await fetch(`${API}/health`);
  const h = res.headers;
  const csp = h.get('content-security-policy') ?? '';
  const pass =
    csp.includes("default-src 'self'") &&
    !csp.includes('unsafe-eval') &&
    h.get('x-frame-options') === 'DENY' &&
    !h.get('x-powered-by');
  record(
    8,
    'security headers present, no unsafe-eval, no X-Powered-By',
    pass,
    `CSP ${csp ? 'set' : 'MISSING'}; XFO=${h.get('x-frame-options')}; HSTS=${h.get('strict-transport-security') ?? 'absent (no TLS locally)'}; X-Powered-By=${h.get('x-powered-by') ?? 'absent'}`,
  );
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await prisma.$disconnect();
process.exitCode = passed === results.length ? 0 : 1;
